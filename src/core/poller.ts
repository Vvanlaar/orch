import { Octokit } from 'octokit';
import { config } from './config.js';
import { createTask, getAllTasks } from './task-queue.js';
import { triggerUpdate } from './task-processor.js';
import { getEffectiveRepoMapping } from './repo-scanner.js';
import type { TaskContext } from './types.js';
import path from 'path';

const octokit = new Octokit({ auth: config.github.token });

// Track processed items to avoid duplicates
const processed = new Set<string>();

function getProcessedKey(source: string, type: string, id: string | number, updatedAt?: string): string {
  return `${source}:${type}:${id}:${updatedAt || ''}`;
}

function isProcessed(key: string): boolean {
  return processed.has(key);
}

function markProcessed(key: string): void {
  processed.add(key);
  // Keep set from growing indefinitely
  if (processed.size > 10000) {
    const arr = Array.from(processed);
    arr.splice(0, 5000);
    processed.clear();
    arr.forEach((k) => processed.add(k));
  }
}

// Load already-processed tasks on startup
function initProcessedFromDb(): void {
  const tasks = getAllTasks(500);
  for (const task of tasks) {
    const id = task.context.prNumber || task.context.issueNumber || task.context.workItemId;
    if (id) {
      const key = getProcessedKey(task.context.source, task.type, id);
      processed.add(key);
    }
  }
}

function resolveRepoPath(fullName: string): string | null {
  const mapped = config.repos.mapping[fullName];
  if (mapped) {
    return path.resolve(config.repos.baseDir, mapped);
  }
  const repoName = fullName.split('/').pop()!;
  return path.resolve(config.repos.baseDir, repoName);
}

// Cache authenticated user
let cachedUsername: string | null = null;

async function getAuthenticatedUsername(): Promise<string | null> {
  if (cachedUsername) return cachedUsername;
  try {
    const { data: user } = await octokit.rest.users.getAuthenticated();
    cachedUsername = user.login;
    return cachedUsername;
  } catch {
    return null;
  }
}

async function pollMyPRReviewComments(repoFullName: string): Promise<void> {
  const [owner, repo] = repoFullName.split('/');
  const repoPath = resolveRepoPath(repoFullName);
  if (!repoPath) return;

  const username = await getAuthenticatedUsername();
  if (!username) return;

  try {
    // Fetch PRs authored by authenticated user
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 10,
    });

    const myPrs = prs.filter(pr => pr.user?.login === username);

    for (const pr of myPrs) {
      // Fetch review comments for this PR
      const { data: comments } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pr.number,
      });

      // Filter to unresolved comments (not by the PR author themselves)
      const unresolvedComments = comments.filter(c =>
        c.user?.login !== username && !c.in_reply_to_id
      );

      if (unresolvedComments.length === 0) continue;

      // Use latest comment timestamp for dedup key
      const latestComment = unresolvedComments.reduce((a, b) =>
        new Date(a.updated_at) > new Date(b.updated_at) ? a : b
      );
      const key = getProcessedKey('github', 'review-comment', `${pr.number}`, latestComment.updated_at);
      if (isProcessed(key)) continue;

      const reviewComments = unresolvedComments.map(c => ({
        id: c.id,
        path: c.path,
        line: c.line || c.original_line || 0,
        body: c.body,
        diffHunk: c.diff_hunk,
      }));

      const context: TaskContext = {
        source: 'github',
        event: 'pull_request.review_comment',
        prNumber: pr.number,
        branch: pr.head.ref,
        baseBranch: pr.base.ref,
        title: pr.title,
        body: pr.body || '',
        url: pr.html_url,
        reviewComments,
      };

      createTask('pr-comment-fix', repoFullName, repoPath, context);
      markProcessed(key);
      console.log(`[Poller] Created pr-comment-fix task for ${repoFullName}#${pr.number} (${unresolvedComments.length} comments)`);
      triggerUpdate();
    }
  } catch (err) {
    console.error(`[Poller] Error polling review comments for ${repoFullName}:`, err);
  }
}

async function pollGitHubRepo(repoFullName: string): Promise<void> {
  const [owner, repo] = repoFullName.split('/');
  const repoPath = resolveRepoPath(repoFullName);
  if (!repoPath) return;

  // Poll open PRs
  try {
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 10,
    });

    for (const pr of prs) {
      const key = getProcessedKey('github', 'pr', pr.number, pr.updated_at);
      if (isProcessed(key)) continue;

      const context: TaskContext = {
        source: 'github',
        event: 'pull_request.opened',
        prNumber: pr.number,
        branch: pr.head.ref,
        baseBranch: pr.base.ref,
        title: pr.title,
        body: pr.body || '',
        url: pr.html_url,
      };

      createTask('pr-review', repoFullName, repoPath, context);
      markProcessed(key);
      console.log(`[Poller] Created PR review task for ${repoFullName}#${pr.number}`);
      triggerUpdate();
    }
  } catch (err) {
    console.error(`[Poller] Error polling PRs for ${repoFullName}:`, err);
  }

  // Poll open issues
  try {
    const { data: issues } = await octokit.rest.issues.listForRepo({
      owner,
      repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 10,
    });

    for (const issue of issues) {
      // Skip PRs (they show up in issues API too)
      if (issue.pull_request) continue;

      const key = getProcessedKey('github', 'issue', issue.number, issue.updated_at);
      if (isProcessed(key)) continue;

      const context: TaskContext = {
        source: 'github',
        event: 'issues.opened',
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body || '',
        url: issue.html_url,
      };

      createTask('issue-fix', repoFullName, repoPath, context);
      markProcessed(key);
      console.log(`[Poller] Created issue-fix task for ${repoFullName}#${issue.number}`);
      triggerUpdate();
    }
  } catch (err) {
    console.error(`[Poller] Error polling issues for ${repoFullName}:`, err);
  }
}

async function pollAdoRepo(project: string, repoName: string, localPath: string): Promise<void> {
  if (!config.ado.pat || !config.ado.organization) return;

  const auth = Buffer.from(`:${config.ado.pat}`).toString('base64');
  const baseUrl = `https://dev.azure.com/${config.ado.organization}/${project}/_apis`;

  // Poll open PRs
  try {
    const res = await fetch(
      `${baseUrl}/git/repositories/${repoName}/pullrequests?searchCriteria.status=active&api-version=7.1`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    const data = await res.json();

    for (const pr of data.value || []) {
      const key = getProcessedKey('ado', 'pr', pr.pullRequestId);
      if (isProcessed(key)) continue;

      const context: TaskContext = {
        source: 'ado',
        event: 'git.pullrequest.created',
        prNumber: pr.pullRequestId,
        branch: pr.sourceRefName?.replace('refs/heads/', ''),
        baseBranch: pr.targetRefName?.replace('refs/heads/', ''),
        title: pr.title,
        body: pr.description || '',
        url: pr.url,
      };

      const repoFullName = `${project}/${repoName}`;
      createTask('pr-review', repoFullName, localPath, context);
      markProcessed(key);
      console.log(`[Poller] Created PR review task for ${repoFullName}!${pr.pullRequestId}`);
      triggerUpdate();
    }
  } catch (err) {
    console.error(`[Poller] Error polling ADO PRs for ${project}/${repoName}:`, err);
  }
}

async function pollAll(): Promise<void> {
  const repoMapping = getEffectiveRepoMapping();

  // Poll repos
  for (const [repoFullName, localFolder] of Object.entries(repoMapping)) {
    const parts = repoFullName.split('/');

    // GitHub repo (owner/repo format)
    if (parts.length === 2) {
      await pollGitHubRepo(repoFullName);
      await pollMyPRReviewComments(repoFullName);
    }
    // ADO repo (org/project/repo format)
    else if (parts.length === 3) {
      const [_org, project, repo] = parts;
      const localPath = path.resolve(config.repos.baseDir, localFolder);
      await pollAdoRepo(project, repo, localPath);
    }
  }
}

let pollInterval: NodeJS.Timeout | null = null;

export function startPoller(intervalMs = 60000): void {
  if (pollInterval) return;

  initProcessedFromDb();
  console.log(`[Poller] Started (interval: ${intervalMs / 1000}s)`);

  // Poll immediately, then on interval
  pollAll().catch(console.error);
  pollInterval = setInterval(() => {
    pollAll().catch(console.error);
  }, intervalMs);
}

export function stopPoller(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log('[Poller] Stopped');
  }
}
