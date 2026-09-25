import { existsSync } from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { config, WORKSPACES_DIR } from './config.js';

const log = createLogger('task-processor');
import { createIssueComment, createReviewCommentReply, getReviewThreads, resolveReviewThread } from './github-api.js';
import {
  getTasksByBatchId,
  getPendingTasks,
  getRunningTasksLean,
  getOrphanCandidates,
  claimTask,
  completeTask,
  createTask,
  failTask,
  appendStreamingOutput,
  clearStreamingOutput,
  updateTaskPid,
  updateTaskRepoPath,
  updateTaskStatus,
  getTask,
  updateTaskContext,
} from './task-queue.js';
import { extractLesson, storeLearning, updateSkillIfRelevant } from './learnings.js';
import { runClaude, runClaudeStreaming, runClaudeInTerminal, claudeEmitter, steerTask, buildPromptForTask, buildPrCommentFixPrompt, buildCodeSimplifierPrompt, buildSelfReviewPrompt, buildCommentResolutionPrompt, buildMergeConflictPrompt } from './claude-runner.js';
import { getTerminalInteractiveSession } from './settings.js';
import {
  cloneRepo,
  getGitStatus,
  getCurrentBranch,
  getDefaultBranch,
  createBranch,
  stageAndCommit,
  pushBranch,
  checkoutBranch,
  discardChanges,
  createGitHubPR,
  createAdoPR,
  createWorktree,
  removeWorktree,
  checkoutPRInWorktree,
  findRemoteForRepo,
} from './git-ops.js';
import { runVideoscan, controlFileName, findLatestScanFileForDomain, readPagesScanned, readScanFileInfo, resumeBudget, getVideoscanDir, mergeScans, syncScanToSupabase, generateReport as generateVideoscanReport, type VideoscanResult } from './videoscan-runner.js';
import { createStaleTracker, decideDeadScan, freeSlots, singleFlight, withRetry } from './queue-helpers.js';
import { getProcessInfos, isPidAlive, killProcessTree, matchProcessIdentity, verifyProcessIdentity, type ExpectedProcess, type ProcessInfo } from './process-kill.js';
import { dbArchiveVideoscans } from './db/videoscans.js';
import { MACHINE_ID, isSupabaseConfigured } from './db/client.js';
import { dbSubscribeTaskChanges, type LeanTask } from './db/tasks.js';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Task } from './types.js';

let onTaskUpdate: ((taskId?: number) => void) | null = null;
let onOutputChunk: ((taskId: number, chunk: string) => void) | null = null;

export function setTaskUpdateCallback(callback: (taskId?: number) => void): void {
  onTaskUpdate = callback;
}

export function setOutputCallback(callback: (taskId: number, chunk: string) => void): void {
  onOutputChunk = callback;
}

function notifyUpdate(taskId?: number): void {
  onTaskUpdate?.(taskId);
}

export function triggerUpdate(taskId?: number): void {
  notifyUpdate(taskId);
}

// Re-export steerTask for server
export { steerTask };

async function extractAndStoreLearning(failedTask: Task, successTask: Task): Promise<void> {
  log.info(`Extracting lesson: failed #${failedTask.id} -> success #${successTask.id}`);
  const learning = await extractLesson(failedTask, successTask);
  if (!learning) return;

  storeLearning(learning, successTask.repoPath);
  await updateSkillIfRelevant(learning, successTask);
}

// Trigger learning extraction if this was a successful retry
async function triggerLearningExtraction(task: Task): Promise<void> {
  if (!task.context.retryOfTaskId) return;
  const failedTask = await getTask(task.context.retryOfTaskId);
  if (!failedTask) return;

  extractAndStoreLearning(failedTask, task).catch(err => {
    log.error('Error extracting lesson', err);
  });
}

// Wire up streaming output from claudeEmitter
claudeEmitter.on('output', (taskId: number, chunk: string) => {
  appendStreamingOutput(taskId, chunk);
  onOutputChunk?.(taskId, chunk);
});

// Wire up PID tracking
claudeEmitter.on('pid', (taskId: number, pid: number) => {
  updateTaskPid(taskId, pid).catch(err => log.error(`Failed to update PID for task #${taskId}`, err));
  log.info(`Task #${taskId} Process started with PID ${pid}`);
});

async function postGitHubPrComment(repo: string, prNumber: number, body: string): Promise<void> {
  const [owner, repoName] = repo.split('/');
  await createIssueComment(owner, repoName, prNumber, body);
}

async function postAdoPrComment(repo: string, prNumber: number, body: string): Promise<void> {
  if (!config.ado.pat || !config.ado.organization) return;

  const [project, repoName] = repo.split('/');
  const url = `https://dev.azure.com/${config.ado.organization}/${project}/_apis/git/repositories/${repoName}/pullRequests/${prNumber}/threads?api-version=7.1`;

  const auth = Buffer.from(`:${config.ado.pat}`).toString('base64');

  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      comments: [{ content: body, commentType: 1 }],
      status: 1, // Active
    }),
  });
}

async function postAdoWorkItemComment(workItemId: number, body: string): Promise<void> {
  if (!config.ado.pat || !config.ado.organization) return;

  const url = `https://dev.azure.com/${config.ado.organization}/_apis/wit/workItems/${workItemId}/comments?api-version=7.1-preview.4`;

  const auth = Buffer.from(`:${config.ado.pat}`).toString('base64');

  await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({ text: body }),
  });
}

async function replyToReviewComment(
  repo: string,
  prNumber: number,
  commentId: number,
  body: string
): Promise<void> {
  const [owner, repoName] = repo.split('/');
  await createReviewCommentReply(owner, repoName, prNumber, commentId, body);
}

async function processPrCommentFix(task: Task): Promise<void> {
  log.info(`Task #${task.id} Processing PR comment fix for ${task.repo}#${task.context.prNumber}`);
  notifyUpdate(task.id);

  const comments = task.context.reviewComments || [];
  if (comments.length === 0) {
    await completeTask(task.id, 'No review comments to fix');
    notifyUpdate(task.id);
    return;
  }

  const targetBranch = task.context.branch;
  if (!targetBranch) {
    await failTask(task.id, 'No branch specified for PR');
    notifyUpdate(task.id);
    return;
  }

  const prNumber = task.context.prNumber;
  if (!prNumber) {
    await failTask(task.id, 'No PR number specified');
    notifyUpdate(task.id);
    return;
  }

  const worktreePath = checkoutPRInWorktree(task.repoPath, prNumber, targetBranch);
  if (!worktreePath) {
    await failTask(task.id, `Failed to create worktree for PR #${prNumber}`);
    notifyUpdate(task.id);
    return;
  }

  try {
    // Step 0: Merge base branch to fix conflicts
    const baseBranch = task.context.baseBranch;
    if (baseBranch) {
      const { execFileSync } = await import('child_process');
      execFileSync('git', ['fetch', 'origin', baseBranch], { cwd: worktreePath, stdio: 'pipe' });
      try {
        execFileSync('git', ['merge', `origin/${baseBranch}`, '--no-edit'], { cwd: worktreePath, stdio: 'pipe' });
        log.info(`Task #${task.id} Step 0: Merged ${baseBranch} (no conflicts)`);
      } catch {
        log.info(`Task #${task.id} Step 0: Merge conflicts detected, letting Claude resolve`);
        const mergePrompt = buildMergeConflictPrompt(baseBranch);
        const mergeResult = await runClaudeStreaming(task.id, task, mergePrompt, { allowEdits: true, workingDir: worktreePath });
        if (mergeResult.success) {
          try {
            execFileSync('git', ['commit', '--no-edit'], { cwd: worktreePath, stdio: 'pipe' });
            log.info(`Task #${task.id} Step 0: Merge conflicts resolved and committed`);
          } catch {
            log.warn(`Task #${task.id} Merge commit failed, aborting merge`);
            try { execFileSync('git', ['merge', '--abort'], { cwd: worktreePath, stdio: 'pipe' }); } catch {}
          }
        } else {
          log.warn(`Task #${task.id} Merge conflict resolution failed, aborting merge`);
          try { execFileSync('git', ['merge', '--abort'], { cwd: worktreePath, stdio: 'pipe' }); } catch {}
        }
      }
    }

    // Step 1: Fix review comments
    log.info(`Task #${task.id} Step 1: Fixing ${comments.length} review comments`);
    const fixPrompt = buildPrCommentFixPrompt(task.context);
    const fixResult = await runClaudeStreaming(task.id, task, fixPrompt, { allowEdits: true, workingDir: worktreePath });

    if (!fixResult.success) {
      throw new Error(`Fix step failed: ${fixResult.error}`);
    }

    // Check if changes were made
    const status = getGitStatus(worktreePath);
    const modifiedFiles = [...status.staged, ...status.unstaged, ...status.untracked];

    if (modifiedFiles.length > 0) {
      // Step 2: Run code simplifier on modified files
      log.info(`Task #${task.id} Step 2: Running code simplifier on ${modifiedFiles.length} files`);
      const simplifyPrompt = buildCodeSimplifierPrompt(modifiedFiles);
      await runClaudeStreaming(task.id, task, simplifyPrompt, { allowEdits: true, workingDir: worktreePath });

      // Step 3: Self-review
      log.info(`Task #${task.id} Step 3: Self-review`);
      const reviewPrompt = buildSelfReviewPrompt();
      const reviewResult = await runClaudeStreaming(task.id, task, reviewPrompt, { allowEdits: false, workingDir: worktreePath });

      // Check if review passed
      const reviewOutput = reviewResult.output.toLowerCase();
      if (reviewOutput.includes('needs attention') && !reviewOutput.includes('approved')) {
        log.info(`Task #${task.id} Self-review flagged issues, continuing anyway`);
      }

      // Step 4: Commit and push
      log.info(`Task #${task.id} Step 4: Committing and pushing`);
      const commitMsg = `fix: address PR review comments\n\nFixed ${comments.length} review comment(s)\nGenerated by Orch task #${task.id}`;

      if (!stageAndCommit(worktreePath, commitMsg)) {
        throw new Error('Failed to commit changes');
      }

      // Determine correct remote (fork PRs push to fork remote, not origin)
      const pushRemote = task.context.headRepo
        ? findRemoteForRepo(task.repoPath, task.context.headRepo)
        : 'origin';
      log.info(`Task #${task.id} Step 4: Pushing to remote "${pushRemote}" (headRepo: ${task.context.headRepo || 'same as origin'})`);

      // Pull latest from remote branch then push (avoids non-fast-forward rejection)
      const { execFileSync } = await import('child_process');
      try {
        execFileSync('git', ['fetch', pushRemote, targetBranch], { cwd: worktreePath, stdio: 'pipe' });
        try {
          execFileSync('git', ['rebase', `${pushRemote}/${targetBranch}`], { cwd: worktreePath, stdio: 'pipe' });
        } catch {
          // Rebase conflict — abort and try merge instead
          try { execFileSync('git', ['rebase', '--abort'], { cwd: worktreePath, stdio: 'pipe' }); } catch {}
          try {
            execFileSync('git', ['merge', `${pushRemote}/${targetBranch}`, '--no-edit'], { cwd: worktreePath, stdio: 'pipe' });
          } catch (mergeErr) {
            try { execFileSync('git', ['merge', '--abort'], { cwd: worktreePath, stdio: 'pipe' }); } catch {}
            throw new Error(`Failed to merge with ${pushRemote}/${targetBranch}: ${mergeErr}`);
          }
        }
        execFileSync('git', ['push', pushRemote, `HEAD:${targetBranch}`], { cwd: worktreePath, stdio: 'pipe' });
      } catch (pushErr) {
        throw new Error(`Failed to push changes: ${pushErr}`);
      }
    }

    // Step 5: Generate per-comment resolutions
    log.info(`Task #${task.id} Step 5: Generating comment resolutions`);
    let resolutions: Array<{ index: number; resolution: string }> = [];
    try {
      const resPrompt = buildCommentResolutionPrompt(comments);
      const resResult = await runClaudeStreaming(task.id, task, resPrompt, { allowEdits: false, workingDir: worktreePath });
      if (resResult.success) {
        const jsonMatch = resResult.output.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          resolutions = JSON.parse(jsonMatch[0]);
        }
      }
    } catch (err) {
      log.error(`Task #${task.id} Failed to parse resolutions, falling back to generic reply`);
    }

    // Step 6: Reply to each review comment with resolution
    log.info(`Task #${task.id} Step 6: Replying to review comments`);
    for (let i = 0; i < comments.length; i++) {
      const comment = comments[i];
      try {
        const resolution = resolutions.find(r => r.index === i)?.resolution;
        const replyBody = resolution
          ? `✅ **Resolved:** ${resolution}\n\n_Auto-fixed by Orch task #${task.id}_`
          : `✅ Addressed in latest push.\n\n_Auto-fixed by Orch task #${task.id}_`;
        await replyToReviewComment(task.repo, task.context.prNumber!, comment.id, replyBody);
      } catch (err) {
        log.error(`Task #${task.id} Failed to reply to comment ${comment.id}`, err);
      }
    }

    // Step 7: Resolve review threads on GitHub
    if (task.context.source === 'github') {
      log.info(`Task #${task.id} Step 7: Resolving review threads`);
      try {
        const [owner, repoName] = task.repo.split('/');
        const threads = await getReviewThreads(owner, repoName, prNumber);
        const marker = `Auto-fixed by Orch task #${task.id}`;
        let resolved = 0;
        for (const thread of threads) {
          if (!thread.isResolved && thread.lastCommentBody.includes(marker)) {
            await resolveReviewThread(thread.id);
            resolved++;
          }
        }
        if (resolved > 0) {
          log.info(`Task #${task.id} Resolved ${resolved} review thread(s)`);
        }
      } catch (err) {
        log.error(`Task #${task.id} Failed to resolve threads`, err);
      }
    }

    const resultSummary = `Fixed ${comments.length} review comment(s) and pushed to ${targetBranch}\n\n${fixResult.output}`;
    await completeTask(task.id, resultSummary);
    log.info(`Task #${task.id} Completed successfully`);
    await triggerLearningExtraction(task);
    removeWorktree(task.repoPath, worktreePath);
    notifyUpdate(task.id);

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await failTask(task.id, error);
    log.error(`Task #${task.id} Error: ${error}`);
    // Keep worktree on failure so user can inspect via terminal button (retry reuses it)
    log.warn(`Task #${task.id} Worktree preserved at ${worktreePath}`);
    notifyUpdate(task.id);
  }
}

// Throws when the DB stays unreachable: guessing "not paused" could overwrite a paused
// row, while a row left running is settled later by reconcileDeadVideoscans.
// dbGetTask reports a failed read as undefined, so treat a missing row as a failure too.
async function isPaused(taskId: number): Promise<boolean> {
  const current = await withRetry(async () => {
    const t = await getTask(taskId);
    if (!t) throw new Error(`task #${taskId} not readable`);
    return t;
  }, [2_000, 10_000]);
  return current.status === 'paused';
}

async function processVideoscan(task: Task): Promise<void> {
  const ctx = task.context;
  if (!ctx.scanUrl && !ctx.urls?.length) {
    await failTask(task.id, 'No scanUrl or urls in task context');
    notifyUpdate(task.id);
    return;
  }

  clearStreamingOutput(task.id);
  notifyUpdate(task.id);

  let result: VideoscanResult;
  try {
    result = await runVideoscan(task.id, {
      scanUrl: ctx.scanUrl || ctx.urls?.[0] || '',
      maxPages: ctx.maxPages,
      resumeFile: ctx.resumeFile,
      delay: ctx.delay,
      urls: ctx.urls,
      targetFilename: ctx.targetFilename,
      batchId: ctx.batchId,
      batchLabel: ctx.batchLabel,
    });
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  // If the user paused this task while runVideoscan was in flight, the row will
  // already say 'paused'. Don't override that with completed/failed — just record
  // the JSON filename so the resume endpoint knows where to pick up from.
  if (await isPaused(task.id)) {
    if (result.jsonFile) {
      const resumePath = path.join(getVideoscanDir(), result.jsonFile);
      await updateTaskContext(task.id, { resumeFile: resumePath });
    }
    log.info(`Task #${task.id} paused; subprocess exited${result.jsonFile ? ` (resume file: ${result.jsonFile})` : ''}${result.error ? ` (${result.error})` : ''}`);
  } else if (result.success) {
    const parts = [`Scan complete`];
    if (result.jsonFile) parts.push(`JSON: ${result.jsonFile}`);
    if (result.htmlFile) parts.push(`Report: ${result.htmlFile}`);
    if (result.pdfFile) parts.push(`PDF: ${result.pdfFile}`);
    await completeTask(task.id, parts.join('\n'));
  } else {
    await failTask(task.id, result.error || 'Videoscan failed');
  }
  notifyUpdate(task.id);
  await autoMergeBatchIfDone(ctx);
}

// Auto-merge digi-import batches once every sibling task has finished.
// Note: the TERMINAL gate in tryAutoMergeBatch already excludes 'paused', so paused
// siblings naturally hold the merge until the user resumes them.
async function autoMergeBatchIfDone(ctx: Task['context']): Promise<void> {
  if (!ctx.batchId || ctx.targetFilename) return;
  try {
    await tryAutoMergeBatch(ctx.batchId);
  } catch (err) {
    log.error(`Batch auto-merge failed for ${ctx.batchId}: ${err instanceof Error ? err.message : err}`);
  }
}

// In-memory lock so concurrent task completions don't double-merge a batch on this process.
const batchMergeLocks = new Set<string>();

const JSON_LINE = /^JSON:\s*(.+\.json)\s*$/m;
const DIGI_BATCH_RE = /^digi-(.+)-\d+$/;
const URLS_BATCH_RE = /^urls-(.+)-\d+$/;

async function tryAutoMergeBatch(batchId: string): Promise<void> {
  if (batchMergeLocks.has(batchId)) return;

  // Query siblings directly by batchId — no row-cap risk for large imports.
  const siblings = (await getTasksByBatchId(batchId)).filter(t => t.type === 'videoscan');
  if (siblings.length < 2) return;

  // Only proceed once every sibling has reached a terminal state. Adding new task statuses
  // in the future will keep the gate closed until we explicitly opt them in.
  const TERMINAL: ReadonlyArray<string> = ['completed', 'failed', 'dismissed'];
  const allTerminal = siblings.every(t => TERMINAL.includes(t.status));
  if (!allTerminal) return;

  // Atomically claim the batch on this process.
  if (batchMergeLocks.has(batchId)) return;
  batchMergeLocks.add(batchId);

  let succeeded = false;
  try {
    const filenames: string[] = [];
    for (const t of siblings) {
      if (t.status !== 'completed' || !t.result) continue;
      const m = t.result.match(JSON_LINE);
      if (m) filenames.push(m[1].trim());
    }
    // Dedupe — re-runs into the same target file would otherwise list a single file twice.
    const unique = [...new Set(filenames)];
    if (unique.length < 2) {
      log.info(`Batch ${batchId}: only ${unique.length} successful scan(s), skipping auto-merge`);
      succeeded = true; // not a real failure — nothing to merge, don't retry
      return;
    }

    // Derive merge label from "digi-<slug>-<ts>" or "urls-<slug>-<ts>" → "<slug>-organisatie".
    const slugMatch = batchId.match(DIGI_BATCH_RE) ?? batchId.match(URLS_BATCH_RE);
    const label = slugMatch ? `${slugMatch[1]}-organisatie` : `${batchId}-merged`;

    log.info(`Batch ${batchId}: auto-merging ${unique.length} scans into ${label}`);
    const result = mergeScans(unique, label);
    await syncScanToSupabase(result.filename);
    if (isSupabaseConfigured()) {
      try { await dbArchiveVideoscans(unique); } catch (err) { log.warn(`dbArchiveVideoscans failed: ${err}`); }
    }

    // Generate report + PDF so the merged scan is immediately viewable.
    try {
      await generateVideoscanReport(result.filename);
    } catch (err) {
      log.warn(`Auto report generation failed for ${result.filename}: ${err}`);
    }

    log.info(`Batch ${batchId}: merged into ${result.filename}`);
    // Batch merge touches every sibling row (archived) plus a synthetic merged scan —
    // no single id captures the change, so force a full refresh.
    notifyUpdate(undefined);
    succeeded = true;
  } finally {
    // Release the lock on transient failure so the next sibling completion (or a manual
    // retrigger) can retry. On success the lock stays — merge is one-shot per process.
    if (!succeeded) batchMergeLocks.delete(batchId);
  }
}

function generateBranchName(task: Task): string {
  const prefix = task.type === 'issue-fix' ? 'bug' : task.type === 'code-gen' ? 'feat' : 'maintenance';
  const id = task.context.workItemId || task.context.issueNumber || task.id;
  const slug = (task.context.title || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 30)
    .replace(/-+$/, '');
  return `${prefix}/${id}-${slug}`;
}

async function handleCodeChanges(task: Task, output: string, worktreePath?: string): Promise<string | null> {
  const workingDir = worktreePath ?? task.repoPath;
  const status = getGitStatus(workingDir);

  if (!status.hasChanges) {
    log.info(`Task #${task.id} No code changes detected`);
    return null;
  }

  log.info(`Task #${task.id} Detected changes: ${status.unstaged.length + status.untracked.length} files`);

  const defaultBranch = getDefaultBranch(task.repoPath);
  let newBranch: string;
  let originalBranch: string | null = null;

  if (worktreePath) {
    // Worktree is already on the target branch
    newBranch = getCurrentBranch(worktreePath);
  } else {
    // No worktree: create branch in main repo
    originalBranch = getCurrentBranch(task.repoPath);
    newBranch = generateBranchName(task);
    if (!createBranch(task.repoPath, newBranch, defaultBranch)) {
      log.error(`Task #${task.id} Failed to create branch ${newBranch}`);
      discardChanges(task.repoPath);
      checkoutBranch(task.repoPath, originalBranch);
      return null;
    }
  }

  // Commit changes
  const commitMsg = `${task.type}: ${task.context.title || 'Auto-generated changes'}\n\nGenerated by Orch task #${task.id}`;
  if (!stageAndCommit(workingDir, commitMsg)) {
    log.error(`Task #${task.id} Failed to commit`);
    discardChanges(workingDir);
    if (originalBranch) checkoutBranch(task.repoPath, originalBranch);
    return null;
  }

  // Push branch
  if (!pushBranch(workingDir, newBranch)) {
    log.error(`Task #${task.id} Failed to push branch`);
    if (originalBranch) checkoutBranch(task.repoPath, originalBranch);
    return null;
  }

  // Create PR
  const prTitle = `${task.type === 'issue-fix' ? 'Fix' : 'Feat'}: ${task.context.title || 'Auto-generated'}`;
  const prBody = `## Summary\n\nAuto-generated by Orch for task #${task.id}\n\n### Claude's Analysis\n\n${output.slice(0, 2000)}${output.length > 2000 ? '...' : ''}\n\n---\n_Generated by [Orch](https://github.com/orch)_`;

  let prUrl: string | null = null;

  if (task.context.source === 'github' || task.repo.split('/').length === 2) {
    prUrl = await createGitHubPR(task.repo, newBranch, defaultBranch, prTitle, prBody);
  } else if (task.context.source === 'ado') {
    const parts = task.repo.split('/');
    const project = parts.length === 3 ? parts[1] : parts[0];
    const repoName = parts[parts.length - 1];
    prUrl = await createAdoPR(project, repoName, newBranch, defaultBranch, prTitle, prBody);
  }

  // Return to original branch only when not using worktree
  if (originalBranch) checkoutBranch(task.repoPath, originalBranch);

  if (prUrl) {
    log.info(`Task #${task.id} Created PR: ${prUrl}`);
  }

  return prUrl;
}

function deriveCloneUrl(task: Task): string | null {
  if (task.context.source === 'github') {
    return `https://github.com/${task.repo}.git`;
  }
  if (task.context.source === 'ado' && config.ado.organization) {
    const parts = task.repo.split('/');
    const repoName = parts[parts.length - 1];
    const project = parts.length >= 2 ? parts[parts.length - 2] : repoName;
    return `https://dev.azure.com/${config.ado.organization}/${project}/_git/${repoName}`;
  }
  return null;
}

function resolveOrCloneRepo(task: Task): string | null {
  const basename = path.basename(task.repoPath);
  const orchClonePath = path.join(WORKSPACES_DIR, 'clones', basename);

  if (existsSync(path.join(orchClonePath, '.git'))) {
    log.info(`Task #${task.id} Found in .workspaces/clones/: ${orchClonePath}`);
    return orchClonePath;
  }

  const cloneUrl = deriveCloneUrl(task);
  const clonedPath = cloneUrl ? cloneRepo(cloneUrl, basename) : null;
  if (clonedPath) {
    log.info(`Task #${task.id} Cloned ${cloneUrl} -> ${clonedPath}`);
  }
  return clonedPath;
}

async function processTask(task: Task): Promise<void> {
  log.info(`Processing task #${task.id} (${task.type}) for ${task.repo}`);

  // Ensure repo folder exists — check .orch-clones/, then auto-clone
  if (!existsSync(task.repoPath)) {
    const resolvedPath = resolveOrCloneRepo(task);
    if (!resolvedPath) {
      log.warn(`Task #${task.id} Repo not found and clone failed; waiting for user input`);
      await updateTaskStatus(task.id, 'needs-repo');
      notifyUpdate(task.id);
      return;
    }
    await updateTaskRepoPath(task.id, resolvedPath, false);
    task.repoPath = resolvedPath;
  }

  // Route pr-comment-fix to specialized processor
  if (task.type === 'pr-comment-fix') {
    return processPrCommentFix(task);
  }

  // Route videoscan to dedicated runner (no Claude needed)
  if (task.type === 'videoscan') {
    return processVideoscan(task);
  }

  clearStreamingOutput(task.id);
  notifyUpdate(task.id);

  // Determine if this task type should allow code edits
  const allowEdits = ['issue-fix', 'code-gen', 'pipeline-fix'].includes(task.type);

  // Testing and ADO-backed tasks need terminal mode for interactive skill use
  const isAdoTask = (task.type === 'code-gen' || task.type === 'issue-fix') && !!task.context.workItemId;
  const forceTerminal = task.type === 'testing' || isAdoTask;

  // Create worktree before Claude runs (streaming mode only)
  let worktreePath: string | null = null;
  if (allowEdits && !config.claude.terminalMode && !forceTerminal) {
    const branchName = generateBranchName(task);
    const defaultBranch = getDefaultBranch(task.repoPath);
    worktreePath = createWorktree(task.repoPath, branchName, defaultBranch);
    if (!worktreePath) {
      log.warn(`Task #${task.id} Worktree creation failed, using main repo`);
    }
  }

  try {
    const prompt = buildPromptForTask(task);

    // Terminal mode: open in separate window, task stays "running" until manually completed
    if (config.claude.terminalMode || forceTerminal || getTerminalInteractiveSession()) {
      const termResult = await runClaudeInTerminal(task.id, task, prompt, { allowEdits });
      if (!termResult.success) {
        await failTask(task.id, termResult.error || 'Failed to open terminal');
        notifyUpdate(task.id);
      }
      // Task stays "running" - user must manually complete/fail via dashboard
      return;
    }

    const result = await runClaudeStreaming(task.id, task, prompt, {
      allowEdits,
      workingDir: worktreePath ?? undefined,
    });

    if (result.success) {
      let prUrl: string | null = null;

      // For edit tasks, check for code changes and create PR
      if (allowEdits) {
        prUrl = await handleCodeChanges(task, result.output, worktreePath ?? undefined);
      }

      // Build comment
      let comment = `## 🤖 Claude ${task.type === 'pr-review' ? 'Code Review' : 'Analysis'}\n\n${result.output}`;
      if (prUrl) {
        comment += `\n\n---\n📝 **PR Created:** ${prUrl}`;
      }

      // Post result to GitHub
      if (task.context.source === 'github' && task.context.prNumber) {
        await postGitHubPrComment(task.repo, task.context.prNumber, comment);
      }

      // Post result to ADO
      if (task.context.source === 'ado') {
        if (task.context.prNumber) {
          await postAdoPrComment(task.repo, task.context.prNumber, comment);
        } else if (task.context.workItemId) {
          await postAdoWorkItemComment(task.context.workItemId, comment);
        }
      }

      const resultWithPr = prUrl ? `${result.output}\n\nPR: ${prUrl}` : result.output;
      await completeTask(task.id, resultWithPr);
      log.info(`Task #${task.id} completed${prUrl ? ` (PR: ${prUrl})` : ''}`);
      await triggerLearningExtraction(task);
      notifyUpdate(task.id);
    } else {
      await failTask(task.id, result.error || 'Unknown error');
      log.error(`Task #${task.id} failed: ${result.error}`);
      notifyUpdate(task.id);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await failTask(task.id, error);
    log.error(`Task #${task.id} error: ${error}`);
    notifyUpdate(task.id);
  } finally {
    if (worktreePath) {
      removeWorktree(task.repoPath, worktreePath);
    }
  }
}

// Tasks claimed by this process whose processTask hasn't settled. Counted as busy slots
// even before the claim is visible in a DB read, and never treated as stale.
const inFlight = new Map<number, Task['type']>();

// A row must look dead for this long before it is settled. Covers rows another instance on
// this machine is still finishing: no PID written yet, or the scan exited and that instance
// is generating the report / retrying its final write.
const deadScans = createStaleTracker(5 * 60_000);

function scanDomain(ctx: Task['context']): string {
  try { return new URL(ctx.scanUrl || ctx.urls?.[0] || '').hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Settle a videoscan row that says running while its scan process is gone: completed if
 * this run's final report is on disk, auto-resumed from its checkpoint, or failed.
 */
async function resolveDeadVideoscan(t: Task, why: string): Promise<void> {
  const domain = scanDomain(t.context);
  const latestName = domain ? findLatestScanFileForDomain(domain) : null;
  const decision = decideDeadScan({
    latest: latestName ? readScanFileInfo(latestName) : null,
    startedAtMs: t.startedAt ? Date.parse(t.startedAt) : null,
    crawlMode: !!t.context.scanUrl && !t.context.urls?.length,
    mergeTarget: t.context.targetFilename,
  });

  if (decision.action === 'complete') {
    await completeTask(t.id, `Scan complete (${why}; status recovered from scan file)\nJSON: ${decision.file}`);
    log.warn(`Videoscan #${t.id} (${domain}): ${why}; final report ${decision.file} found — marked completed`);
    // In the background: a batch merge (report + PDF) can take minutes and would hold the
    // queue or startup. Sync first, as the merge archives the file the sync uploads (the
    // first sync may have hit the same outage). Neither step rejects; both log failures.
    void syncScanToSupabase(decision.file).then(() => autoMergeBatchIfDone(t.context));
    return;
  }

  if (decision.action === 'resume') {
    const resumePath = path.join(getVideoscanDir(), decision.file);
    const { maxPages, targetPages } = resumeBudget(t.context, readPagesScanned(resumePath));
    // Fail first: if createTask then fails the scan is merely not resumed, whereas the
    // reverse order could leave the row running and resume it twice.
    await failTask(t.id, `${why}; auto-resuming from ${decision.file}`);
    let resumed: Task;
    try {
      resumed = await createTask('videoscan', t.context.scanUrl!, getVideoscanDir(), {
        source: 'github',
        event: 'videoscan-resume',
        title: `Resume videoscan: ${domain}`,
        scanUrl: t.context.scanUrl,
        maxPages,
        ...(targetPages !== undefined ? { targetPages } : {}),
        delay: t.context.delay,
        resumeFile: resumePath,
        ...(t.context.batchId ? { batchId: t.context.batchId } : {}),
        ...(t.context.batchLabel ? { batchLabel: t.context.batchLabel } : {}),
      });
    } catch (err) {
      // The row is already failed, so nothing retries this: say how to resume by hand.
      log.error(`Videoscan #${t.id} (${domain}): creating the auto-resume task failed; resume manually from ${resumePath}`, err);
      return;
    }
    log.warn(`Videoscan #${t.id} (${domain}): ${why} — auto-resume created as task #${resumed.id}`);
    return;
  }

  await failTask(t.id, `${why} (${decision.reason})`);
  log.warn(`Videoscan #${t.id} (${domain}): ${why} — marked failed (${decision.reason})`);
  void autoMergeBatchIfDone(t.context);
}

/** What a live process must look like to be this task's; a recorded PID may have been reused since. */
export function expectedTaskProcess(t: Pick<Task, 'id' | 'type'> & { startedAt?: string }): ExpectedProcess {
  const started = t.startedAt ? Date.parse(t.startedAt) : NaN;
  return {
    // claude-runner passes --dangerously-skip-permissions on every launch path. It narrows plain
    // 'claude' but still matches the user's own sessions started with that flag.
    markers: t.type === 'videoscan' ? ['scan.mjs', controlFileName(t.id)] : ['claude', '--dangerously-skip-permissions'],
    ...(Number.isNaN(started) ? {} : { notBeforeMs: started }),
  };
}

/**
 * Ids of rows whose scan process is gone: PID dead, or now held by another program. If the
 * process table can't be read, live PIDs count as their scans and the next tick retries.
 */
async function deadScanIds(rows: LeanTask[]): Promise<number[]> {
  const live = rows.filter(t => isPidAlive(t.pid));
  let infos: Map<number, ProcessInfo> | null = null;
  if (live.length) {
    try {
      infos = await getProcessInfos(live.map(t => t.pid!));
    } catch (err) {
      log.warn(`Reading the process table failed; assuming live PIDs are their scans: ${err instanceof Error ? err.message : err}`);
    }
  }
  // An unreadable command line (e.g. an elevated instance's scan) counts as its scan too.
  const reused = infos
    ? live.filter(t => !['match', 'unreadable'].includes(matchProcessIdentity(infos.get(t.pid!) ?? null, expectedTaskProcess(t))))
    : [];
  return [...rows.filter(t => !live.includes(t)), ...reused].map(t => t.id);
}

/**
 * Running videoscan rows of this machine that no live process backs — e.g. the scan
 * finished while the DB was down, so its final status write was lost. Left alone they
 * hold a slot until the next server restart. Returns the ids settled.
 */
async function reconcileDeadVideoscans(rows: LeanTask[]): Promise<Set<number>> {
  const settled = new Set<number>();
  const stale = deadScans.update(await deadScanIds(rows
    .filter(t => t.type === 'videoscan' && t.machineId === MACHINE_ID && !inFlight.has(t.id))));
  for (const id of stale) {
    try {
      const t = await getTask(id);
      if (!t || t.status !== 'running') continue;
      await resolveDeadVideoscan(t, 'Scan process exited but its status was never saved');
      settled.add(t.id);
      notifyUpdate(t.id);
    } catch (err) {
      log.error(`Reconciling stale videoscan #${id} failed; will retry next tick`, err);
    }
  }
  return settled;
}

async function processQueueOnce(): Promise<void> {
  const [runningTasks, allPending] = await Promise.all([
    getRunningTasksLean(),
    getPendingTasks(config.claude.maxConcurrentTasks + config.claude.maxConcurrentVideoscans, MACHINE_ID),
  ]);

  // Slot budget is per-machine: don't count other machines' running tasks against this machine's capacity.
  const settled = await reconcileDeadVideoscans(runningTasks);
  const myRunning = runningTasks.filter(t => (!t.machineId || t.machineId === MACHINE_ID) && !settled.has(t.id));
  const idsOf = (isScan: boolean) => ({
    running: myRunning.filter(t => (t.type === 'videoscan') === isScan).map(t => t.id),
    inFlight: [...inFlight].filter(([, type]) => (type === 'videoscan') === isScan).map(([id]) => id),
  });
  const scans = idsOf(true);
  const others = idsOf(false);
  let videoscanSlots = freeSlots(config.claude.maxConcurrentVideoscans, scans.running, scans.inFlight);
  let otherSlots = freeSlots(config.claude.maxConcurrentTasks, others.running, others.inFlight);

  for (const task of allPending) {
    // Resumed while its previous run is still finishing (report, final write): wait for that
    // run to settle, or two processTask calls would share one id.
    if (inFlight.has(task.id)) continue;
    if (task.type === 'videoscan') {
      if (videoscanSlots <= 0) continue;
      videoscanSlots--;
    } else {
      if (otherSlots <= 0) continue;
      otherSlots--;
    }

    const claimed = await claimTask(task.id);
    if (!claimed) {
      if (task.type === 'videoscan') videoscanSlots++;
      else otherSlots++;
      continue;
    }

    inFlight.set(task.id, task.type);
    processTask(task)
      .catch((err) => log.error(`Unhandled error in task #${task.id}`, err))
      .finally(() => inFlight.delete(task.id));
  }
}

// Startup, interval ticks and realtime wakes all call this. Two overlapping runs would
// each read the running count before the other's claims and overshoot the slot limit.
// Errors are logged per run so a failed run doesn't drop the rerun queued behind it.
export const processQueue = singleFlight(() =>
  processQueueOnce().catch(err => log.error('Queue processing error', err)));

let intervalId: NodeJS.Timeout | null = null;
let realtimeChannel: RealtimeChannel | null = null;

// Coalesce a burst of realtime events into a single processQueue call so that, say,
// inserting 50 batch tasks doesn't trigger 50 overlapping scans.
let realtimeWakePending = false;
function wakeProcessor(): void {
  if (realtimeWakePending) return;
  realtimeWakePending = true;
  setImmediate(() => {
    realtimeWakePending = false;
    void processQueue();
  });
}

// Realtime lengthens the poll to a safety heartbeat; without realtime we keep the
// original cadence so JSON-store mode still feels responsive.
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const SAFETY_POLL_INTERVAL_MS = 60_000;

// Settle a running row left by a previous server instance (crash/restart).
async function settleOrphan(t: Task): Promise<void> {
  const isTerminalTask = t.type === 'testing' || ((t.type === 'code-gen' || t.type === 'issue-fix') && !!t.context.workItemId);
  if (isTerminalTask) {
    await updateTaskStatus(t.id, 'pending');
    log.warn(`Reset terminal task #${t.id} to pending (may still have active terminal)`);
    return;
  }

  if (t.type !== 'videoscan') {
    await failTask(t.id, 'Server restarted while task was running');
    log.warn(`Marked orphaned task #${t.id} as failed`);
    return;
  }

  // If the prior server died but its scan.mjs child survived (tsx-watch reload, etc.),
  // kill it before we spawn a respawn — otherwise two scan.mjs processes race on the
  // same resume file. After a reboot the PID may belong to an unrelated program: only
  // kill a process that is verifiably this task's scan.
  if (isPidAlive(t.pid)) {
    const check = await verifyProcessIdentity(t.pid!, expectedTaskProcess(t));
    if (check.identity === 'unknown') {
      log.error(`Orphaned scan #${t.id}: cannot verify PID ${t.pid} is its scan.mjs (${check.error}); not killing, skipping auto-resume to avoid double-spawn`);
      await failTask(t.id, `Orphan PID ${t.pid} could not be verified (${check.error}); not killed`);
      return;
    }
    if (check.identity === 'match') {
      log.warn(`Orphaned videoscan #${t.id} has live PID ${t.pid} from previous instance — killing tree`);
      const result = await killProcessTree(t.pid!);
      if (!result.killed) {
        log.error(`Failed to kill orphaned scan #${t.id} PID ${t.pid}: ${result.error}; skipping auto-resume to avoid double-spawn`);
        await failTask(t.id, `Orphan kill failed: ${result.error}`);
        return;
      }
    } else {
      log.warn(`Orphaned videoscan #${t.id}: PID ${t.pid} is no longer its scan.mjs (${check.identity}) — not killing it`);
    }
  }
  await resolveDeadVideoscan(t, 'Server restarted while scan was running');
}

export async function startProcessor(intervalMs?: number): Promise<void> {
  if (intervalId) return;
  const realtimeAvailable = isSupabaseConfigured();

  // Settle orphaned running tasks: fail them, or for videoscans complete/auto-resume from
  // the scan files. With Supabase: only rows belonging to THIS machine (other machines may
  // still be running theirs). Use the orphan-specific query so we don't pull hundreds of
  // unrelated rows on every startup.
  const orphaned = await getOrphanCandidates(MACHINE_ID);
  for (const t of orphaned) {
    // One failed row must not keep the processor from starting. A videoscan left running
    // is settled later by reconcileDeadVideoscans.
    try {
      await settleOrphan(t);
    } catch (err) {
      log.error(`Settling orphaned task #${t.id} failed`, err);
    }
  }

  // dbClaimTask arbitrates atomically, so duplicate realtime notifications are harmless.
  let realtimeSubscribed = false;
  if (realtimeAvailable) {
    try {
      realtimeChannel = dbSubscribeTaskChanges(
        (event) => {
          if (event === 'INSERT' || event === 'UPDATE') wakeProcessor();
        },
        (status, err) => {
          if (status === 'SUBSCRIBED') log.info('Realtime channel SUBSCRIBED to public.tasks');
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            log.warn(`Realtime channel status: ${status}${err ? ` (${err.message})` : ''}`);
          } else {
            log.info(`Realtime channel status: ${status}`);
          }
        },
      );
      realtimeSubscribed = true;
    } catch (err) {
      log.warn(`Realtime subscription failed; using ${DEFAULT_POLL_INTERVAL_MS}ms poll fallback: ${err}`);
    }
  }

  const effectiveInterval = intervalMs ?? (realtimeSubscribed ? SAFETY_POLL_INTERVAL_MS : DEFAULT_POLL_INTERVAL_MS);
  log.info(`Task processor started (poll ${effectiveInterval}ms${realtimeSubscribed ? ' + realtime' : ''})`);
  intervalId = setInterval(() => void processQueue(), effectiveInterval);

  void processQueue();
}

export function stopProcessor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Task processor stopped');
  }
  if (realtimeChannel) {
    realtimeChannel.unsubscribe().catch((err: unknown) => log.warn(`Realtime unsubscribe failed: ${err}`));
    realtimeChannel = null;
  }
}
