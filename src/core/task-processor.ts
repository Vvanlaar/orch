import { existsSync } from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { config, WORKSPACES_DIR } from './config.js';

const log = createLogger('task-processor');
import { createIssueComment, createReviewCommentReply, getReviewThreads, resolveReviewThread } from './github-api.js';
import {
  getPendingTasks,
  getRunningCount,
  startTask,
  completeTask,
  failTask,
  appendStreamingOutput,
  clearStreamingOutput,
  updateTaskPid,
  updateTaskRepoPath,
  updateTaskStatus,
  getTask,
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
} from './git-ops.js';
import type { Task } from './types.js';

let onTaskUpdate: (() => void) | null = null;
let onOutputChunk: ((taskId: number, chunk: string) => void) | null = null;

export function setTaskUpdateCallback(callback: () => void): void {
  onTaskUpdate = callback;
}

export function setOutputCallback(callback: (taskId: number, chunk: string) => void): void {
  onOutputChunk = callback;
}

function notifyUpdate(): void {
  onTaskUpdate?.();
}

export function triggerUpdate(): void {
  notifyUpdate();
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
function triggerLearningExtraction(task: Task): void {
  if (!task.context.retryOfTaskId) return;
  const failedTask = getTask(task.context.retryOfTaskId);
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
  updateTaskPid(taskId, pid);
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
  startTask(task.id);
  notifyUpdate();

  const comments = task.context.reviewComments || [];
  if (comments.length === 0) {
    completeTask(task.id, 'No review comments to fix');
    notifyUpdate();
    return;
  }

  const targetBranch = task.context.branch;
  if (!targetBranch) {
    failTask(task.id, 'No branch specified for PR');
    notifyUpdate();
    return;
  }

  const prNumber = task.context.prNumber;
  if (!prNumber) {
    failTask(task.id, 'No PR number specified');
    notifyUpdate();
    return;
  }

  const worktreePath = checkoutPRInWorktree(task.repoPath, prNumber, targetBranch);
  if (!worktreePath) {
    failTask(task.id, `Failed to create worktree for PR #${prNumber}`);
    notifyUpdate();
    return;
  }

  try {
    // Step 0: Merge base branch to fix conflicts
    const baseBranch = task.context.baseBranch;
    if (baseBranch) {
      const { execSync } = await import('child_process');
      execSync(`git fetch origin ${baseBranch}`, { cwd: worktreePath, stdio: 'pipe' });
      try {
        execSync(`git merge origin/${baseBranch} --no-edit`, { cwd: worktreePath, stdio: 'pipe' });
        log.info(`Task #${task.id} Step 0: Merged ${baseBranch} (no conflicts)`);
      } catch {
        log.info(`Task #${task.id} Step 0: Merge conflicts detected, letting Claude resolve`);
        const mergePrompt = buildMergeConflictPrompt(baseBranch);
        const mergeResult = await runClaude(task, mergePrompt, { allowEdits: true, workingDir: worktreePath });
        if (mergeResult.success) {
          try {
            execSync('git commit --no-edit', { cwd: worktreePath, stdio: 'pipe' });
            log.info(`Task #${task.id} Step 0: Merge conflicts resolved and committed`);
          } catch {
            log.warn(`Task #${task.id} Merge commit failed, aborting merge`);
            try { execSync('git merge --abort', { cwd: worktreePath, stdio: 'pipe' }); } catch {}
          }
        } else {
          log.warn(`Task #${task.id} Merge conflict resolution failed, aborting merge`);
          try { execSync('git merge --abort', { cwd: worktreePath, stdio: 'pipe' }); } catch {}
        }
      }
    }

    // Step 1: Fix review comments
    log.info(`Task #${task.id} Step 1: Fixing ${comments.length} review comments`);
    const fixPrompt = buildPrCommentFixPrompt(task.context);
    const fixResult = await runClaude(task, fixPrompt, { allowEdits: true, workingDir: worktreePath });

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
      await runClaude(task, simplifyPrompt, { allowEdits: true, workingDir: worktreePath });

      // Step 3: Self-review
      log.info(`Task #${task.id} Step 3: Self-review`);
      const reviewPrompt = buildSelfReviewPrompt();
      const reviewResult = await runClaude(task, reviewPrompt, { allowEdits: false, workingDir: worktreePath });

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

      // Push HEAD to the remote PR branch (local branch is pr-N, not targetBranch)
      const { execSync } = await import('child_process');
      try {
        execSync(`git push origin HEAD:${targetBranch}`, { cwd: worktreePath, stdio: 'pipe' });
      } catch (pushErr) {
        throw new Error(`Failed to push changes: ${pushErr}`);
      }
    }

    // Step 5: Generate per-comment resolutions
    log.info(`Task #${task.id} Step 5: Generating comment resolutions`);
    let resolutions: Array<{ index: number; resolution: string }> = [];
    try {
      const resPrompt = buildCommentResolutionPrompt(comments);
      const resResult = await runClaude(task, resPrompt, { allowEdits: false, workingDir: worktreePath });
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
    completeTask(task.id, resultSummary);
    log.info(`Task #${task.id} Completed successfully`);
    triggerLearningExtraction(task);
    notifyUpdate();

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    failTask(task.id, error);
    log.error(`Task #${task.id} Error: ${error}`);
    discardChanges(worktreePath);
    notifyUpdate();
  } finally {
    removeWorktree(task.repoPath, worktreePath);
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
      updateTaskStatus(task.id, 'needs-repo');
      notifyUpdate();
      return;
    }
    updateTaskRepoPath(task.id, resolvedPath, false);
    task.repoPath = resolvedPath;
  }

  // Route pr-comment-fix to specialized processor
  if (task.type === 'pr-comment-fix') {
    return processPrCommentFix(task);
  }

  clearStreamingOutput(task.id);
  startTask(task.id);
  notifyUpdate();

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
        failTask(task.id, termResult.error || 'Failed to open terminal');
        notifyUpdate();
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
      completeTask(task.id, resultWithPr);
      log.info(`Task #${task.id} completed${prUrl ? ` (PR: ${prUrl})` : ''}`);
      triggerLearningExtraction(task);
      notifyUpdate();
    } else {
      failTask(task.id, result.error || 'Unknown error');
      log.error(`Task #${task.id} failed: ${result.error}`);
      notifyUpdate();
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    failTask(task.id, error);
    log.error(`Task #${task.id} error: ${error}`);
    notifyUpdate();
  } finally {
    if (worktreePath) {
      removeWorktree(task.repoPath, worktreePath);
    }
  }
}

export async function processQueue(): Promise<void> {
  const runningCount = getRunningCount();
  const available = config.claude.maxConcurrentTasks - runningCount;

  if (available <= 0) return;

  const pending = getPendingTasks(available);

  for (const task of pending) {
    // Don't await - run concurrently
    processTask(task).catch((err) => {
      log.error(`Unhandled error in task #${task.id}`, err);
    });
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startProcessor(intervalMs = 5000): void {
  if (intervalId) return;
  log.info('Task processor started');
  intervalId = setInterval(() => {
    processQueue().catch(err => log.error('Queue processing error', err));
  }, intervalMs);
  // Process immediately on start
  processQueue().catch(err => log.error('Queue processing error', err));
}

export function stopProcessor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Task processor stopped');
  }
}
