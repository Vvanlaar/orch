import { Octokit } from 'octokit';
import { config } from './config.js';
import {
  getPendingTasks,
  getRunningCount,
  startTask,
  completeTask,
  failTask,
  appendStreamingOutput,
  clearStreamingOutput,
} from './task-queue.js';
import { runClaude, runClaudeStreaming, claudeEmitter, steerTask, buildPromptForTask, buildPrCommentFixPrompt, buildCodeSimplifierPrompt, buildSelfReviewPrompt } from './claude-runner.js';
import {
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
} from './git-ops.js';
import type { Task } from './types.js';

const octokit = new Octokit({ auth: config.github.token });

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

// Wire up streaming output from claudeEmitter
claudeEmitter.on('output', (taskId: number, chunk: string) => {
  appendStreamingOutput(taskId, chunk);
  onOutputChunk?.(taskId, chunk);
});

async function postGitHubPrComment(repo: string, prNumber: number, body: string): Promise<void> {
  const [owner, repoName] = repo.split('/');
  await octokit.rest.issues.createComment({
    owner,
    repo: repoName,
    issue_number: prNumber,
    body,
  });
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
  await octokit.rest.pulls.createReplyForReviewComment({
    owner,
    repo: repoName,
    pull_number: prNumber,
    comment_id: commentId,
    body,
  });
}

async function processPrCommentFix(task: Task): Promise<void> {
  console.log(`[Task #${task.id}] Processing PR comment fix for ${task.repo}#${task.context.prNumber}`);
  startTask(task.id);
  notifyUpdate();

  const comments = task.context.reviewComments || [];
  if (comments.length === 0) {
    completeTask(task.id, 'No review comments to fix');
    notifyUpdate();
    return;
  }

  // Checkout the PR branch
  const targetBranch = task.context.branch;
  if (!targetBranch) {
    failTask(task.id, 'No branch specified for PR');
    notifyUpdate();
    return;
  }

  const originalBranch = getCurrentBranch(task.repoPath);

  try {
    // Fetch and checkout PR branch
    const { execSync } = await import('child_process');
    execSync('git fetch origin', { cwd: task.repoPath, stdio: 'pipe' });
    execSync(`git checkout ${targetBranch}`, { cwd: task.repoPath, stdio: 'pipe' });
    execSync(`git pull origin ${targetBranch}`, { cwd: task.repoPath, stdio: 'pipe' });
  } catch (err) {
    console.error(`[Task #${task.id}] Failed to checkout branch ${targetBranch}:`, err);
    failTask(task.id, `Failed to checkout branch: ${err}`);
    checkoutBranch(task.repoPath, originalBranch);
    notifyUpdate();
    return;
  }

  try {
    // Step 1: Fix review comments
    console.log(`[Task #${task.id}] Step 1: Fixing ${comments.length} review comments`);
    const fixPrompt = buildPrCommentFixPrompt(task.context);
    const fixResult = await runClaude(task, fixPrompt, { allowEdits: true });

    if (!fixResult.success) {
      throw new Error(`Fix step failed: ${fixResult.error}`);
    }

    // Check if changes were made
    const status = getGitStatus(task.repoPath);
    const modifiedFiles = [...status.staged, ...status.unstaged, ...status.untracked];

    if (modifiedFiles.length > 0) {
      // Step 2: Run code simplifier on modified files
      console.log(`[Task #${task.id}] Step 2: Running code simplifier on ${modifiedFiles.length} files`);
      const simplifyPrompt = buildCodeSimplifierPrompt(modifiedFiles);
      await runClaude(task, simplifyPrompt, { allowEdits: true });

      // Step 3: Self-review
      console.log(`[Task #${task.id}] Step 3: Self-review`);
      const reviewPrompt = buildSelfReviewPrompt();
      const reviewResult = await runClaude(task, reviewPrompt, { allowEdits: false });

      // Check if review passed
      const reviewOutput = reviewResult.output.toLowerCase();
      if (reviewOutput.includes('needs attention') && !reviewOutput.includes('approved')) {
        console.log(`[Task #${task.id}] Self-review flagged issues, continuing anyway`);
      }

      // Step 4: Commit and push
      console.log(`[Task #${task.id}] Step 4: Committing and pushing`);
      const commitMsg = `fix: address PR review comments\n\nFixed ${comments.length} review comment(s)\nGenerated by Orch task #${task.id}`;

      if (!stageAndCommit(task.repoPath, commitMsg)) {
        throw new Error('Failed to commit changes');
      }

      if (!pushBranch(task.repoPath, targetBranch)) {
        throw new Error('Failed to push changes');
      }
    }

    // Step 5: Reply to each review comment
    console.log(`[Task #${task.id}] Step 5: Replying to review comments`);
    for (const comment of comments) {
      try {
        const replyBody = `✅ Addressed in latest push.\n\n_Auto-fixed by Orch task #${task.id}_`;
        await replyToReviewComment(task.repo, task.context.prNumber!, comment.id, replyBody);
      } catch (err) {
        console.error(`[Task #${task.id}] Failed to reply to comment ${comment.id}:`, err);
      }
    }

    const resultSummary = `Fixed ${comments.length} review comment(s) and pushed to ${targetBranch}\n\n${fixResult.output}`;
    completeTask(task.id, resultSummary);
    console.log(`[Task #${task.id}] Completed successfully`);
    notifyUpdate();

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    failTask(task.id, error);
    console.error(`[Task #${task.id}] Error:`, error);
    discardChanges(task.repoPath);
    notifyUpdate();
  } finally {
    checkoutBranch(task.repoPath, originalBranch);
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

async function handleCodeChanges(task: Task, output: string): Promise<string | null> {
  const status = getGitStatus(task.repoPath);

  if (!status.hasChanges) {
    console.log(`[Task #${task.id}] No code changes detected`);
    return null;
  }

  console.log(`[Task #${task.id}] Detected changes: ${status.unstaged.length + status.untracked.length} files`);

  const originalBranch = getCurrentBranch(task.repoPath);
  const defaultBranch = getDefaultBranch(task.repoPath);
  const newBranch = generateBranchName(task);

  // Create new branch
  if (!createBranch(task.repoPath, newBranch, defaultBranch)) {
    console.error(`[Task #${task.id}] Failed to create branch ${newBranch}`);
    discardChanges(task.repoPath);
    checkoutBranch(task.repoPath, originalBranch);
    return null;
  }

  // Commit changes
  const commitMsg = `${task.type}: ${task.context.title || 'Auto-generated changes'}\n\nGenerated by Orch task #${task.id}`;
  if (!stageAndCommit(task.repoPath, commitMsg)) {
    console.error(`[Task #${task.id}] Failed to commit`);
    discardChanges(task.repoPath);
    checkoutBranch(task.repoPath, originalBranch);
    return null;
  }

  // Push branch
  if (!pushBranch(task.repoPath, newBranch)) {
    console.error(`[Task #${task.id}] Failed to push branch`);
    checkoutBranch(task.repoPath, originalBranch);
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

  // Return to original branch
  checkoutBranch(task.repoPath, originalBranch);

  if (prUrl) {
    console.log(`[Task #${task.id}] Created PR: ${prUrl}`);
  }

  return prUrl;
}

async function processTask(task: Task): Promise<void> {
  console.log(`Processing task #${task.id} (${task.type}) for ${task.repo}`);

  // Route pr-comment-fix to specialized processor
  if (task.type === 'pr-comment-fix') {
    return processPrCommentFix(task);
  }

  clearStreamingOutput(task.id);
  startTask(task.id);
  notifyUpdate();

  // Determine if this task type should allow code edits
  const allowEdits = ['issue-fix', 'code-gen', 'pipeline-fix'].includes(task.type);

  try {
    const prompt = buildPromptForTask(task);
    const result = await runClaudeStreaming(task.id, task, prompt, { allowEdits });

    if (result.success) {
      let prUrl: string | null = null;

      // For edit tasks, check for code changes and create PR
      if (allowEdits) {
        prUrl = await handleCodeChanges(task, result.output);
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
      console.log(`Task #${task.id} completed${prUrl ? ` (PR: ${prUrl})` : ''}`);
      notifyUpdate();
    } else {
      failTask(task.id, result.error || 'Unknown error');
      console.error(`Task #${task.id} failed:`, result.error);
      notifyUpdate();
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    failTask(task.id, error);
    console.error(`Task #${task.id} error:`, error);
    notifyUpdate();
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
      console.error(`Unhandled error in task #${task.id}:`, err);
    });
  }
}

let intervalId: NodeJS.Timeout | null = null;

export function startProcessor(intervalMs = 5000): void {
  if (intervalId) return;
  console.log('Task processor started');
  intervalId = setInterval(() => {
    processQueue().catch(console.error);
  }, intervalMs);
  // Process immediately on start
  processQueue().catch(console.error);
}

export function stopProcessor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('Task processor stopped');
  }
}
