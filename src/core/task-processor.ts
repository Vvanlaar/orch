import { Octokit } from 'octokit';
import { config } from './config.js';
import {
  getPendingTasks,
  getRunningCount,
  startTask,
  completeTask,
  failTask,
} from './task-queue.js';
import { runClaude, buildPromptForTask } from './claude-runner.js';
import type { Task } from './types.js';

const octokit = new Octokit({ auth: config.github.token });

let onTaskUpdate: (() => void) | null = null;

export function setTaskUpdateCallback(callback: () => void): void {
  onTaskUpdate = callback;
}

function notifyUpdate(): void {
  onTaskUpdate?.();
}

export function triggerUpdate(): void {
  notifyUpdate();
}

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

async function processTask(task: Task): Promise<void> {
  console.log(`Processing task #${task.id} (${task.type}) for ${task.repo}`);
  startTask(task.id);
  notifyUpdate();

  try {
    const prompt = buildPromptForTask(task);
    const result = await runClaude(task, prompt);

    if (result.success) {
      const comment = `## 🤖 Claude Code Review\n\n${result.output}`;

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

      completeTask(task.id, result.output);
      console.log(`Task #${task.id} completed`);
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
