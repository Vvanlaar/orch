import { execFileSync } from 'child_process';
import { Octokit } from 'octokit';
import { config } from './config.js';

type Method = 'pat' | 'gh';

/** Per-operation memory of which method works */
const methodPrefs = new Map<string, Method>();

/** Lazy one-time check for gh CLI availability */
let ghCliAvailable: boolean | null = null;

function isPermissionError(err: any): boolean {
  const status = err?.status;
  if (status === 401 || status === 403) return true;
  const msg = String(err?.message || err?.response?.data?.message || '');
  return msg.includes('Resource not accessible by integration') || msg.includes('insufficient');
}

function isGhCliError(err: any): boolean {
  const msg = String(err?.message || err?.stderr || '');
  return msg.includes('gh auth') || msg.includes('not logged') || msg.includes('HTTP 4');
}

function checkGhCliAvailable(): boolean {
  if (ghCliAvailable !== null) return ghCliAvailable;
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe', timeout: 10000 });
    ghCliAvailable = true;
    console.log('[GitHubAPI] gh CLI is authenticated and available');
  } catch {
    ghCliAvailable = false;
    console.log('[GitHubAPI] gh CLI not available or not authenticated');
  }
  return ghCliAvailable;
}

function ghApi(endpoint: string, method = 'GET', body?: any): any {
  const args = ['api', endpoint, '--method', method];
  if (body) {
    args.push('--input', '-');
  }
  const result = execFileSync('gh', args, {
    encoding: 'utf-8',
    timeout: 30000,
    input: body ? JSON.stringify(body) : undefined,
  });
  return result.trim() ? JSON.parse(result) : undefined;
}

function ghGraphql(query: string, variables?: Record<string, any>): any {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      if (typeof value === 'number') {
        args.push('-F', `${key}=${value}`);
      } else {
        args.push('-f', `${key}=${value}`);
      }
    }
  }
  const result = execFileSync('gh', args, {
    encoding: 'utf-8',
    timeout: 30000,
  });
  return result.trim() ? JSON.parse(result) : undefined;
}

async function tryPat<T>(op: string, octokitFn: (octokit: Octokit) => Promise<T>): Promise<T> {
  const octokit = new Octokit({ auth: config.github.token });
  const result = await octokitFn(octokit);
  if (!methodPrefs.has(op)) {
    methodPrefs.set(op, 'pat');
    console.log(`[GitHubAPI] ${op}: PAT works, remembering`);
  }
  return result;
}

function tryGhCli<T>(op: string, ghCliFn: () => T): T {
  if (!checkGhCliAvailable()) {
    throw new Error('gh CLI not available or not authenticated');
  }
  const result = ghCliFn();
  if (!methodPrefs.has(op)) {
    methodPrefs.set(op, 'gh');
    console.log(`[GitHubAPI] ${op}: gh CLI works, remembering`);
  }
  return result;
}

/**
 * Try preferred method first (per-operation memory), fall back to the other.
 * Both directions: PAT→gh and gh→PAT.
 */
async function withFallback<T>(
  octokitFn: (octokit: Octokit) => Promise<T>,
  ghCliFn: () => T,
  op = 'unknown',
): Promise<T> {
  const hasPat = !!config.github.token;
  const pref = methodPrefs.get(op);

  // Determine order: remembered pref > has PAT > gh CLI
  const tryPatFirst = pref === 'pat' || (pref == null && hasPat);

  if (tryPatFirst) {
    try {
      return await tryPat(op, octokitFn);
    } catch (err: any) {
      if (!isPermissionError(err)) throw err;
      console.warn(`[GitHubAPI] ${op}: PAT failed (${err.status || err.message}), trying gh CLI`);
      try {
        methodPrefs.delete(op); // clear stale pref
        return tryGhCli(op, ghCliFn);
      } catch (ghErr: any) {
        throw err; // throw original PAT error if gh also fails
      }
    }
  } else {
    try {
      return tryGhCli(op, ghCliFn);
    } catch (ghErr: any) {
      if (!hasPat || !isGhCliError(ghErr)) throw ghErr;
      console.warn(`[GitHubAPI] ${op}: gh CLI failed, trying PAT`);
      try {
        methodPrefs.delete(op);
        return await tryPat(op, octokitFn);
      } catch (patErr: any) {
        throw ghErr; // throw original gh error if PAT also fails
      }
    }
  }
}

// --- Exported API functions ---

export async function getAuthenticatedUser(): Promise<{ login: string }> {
  return withFallback(
    async (octokit) => {
      const { data } = await octokit.rest.users.getAuthenticated();
      return { login: data.login };
    },
    () => {
      const data = ghApi('/user');
      return { login: data.login };
    },
    'getUser',
  );
}

export async function listPulls(
  owner: string,
  repo: string,
  opts?: { state?: string; sort?: string; direction?: string; per_page?: number },
): Promise<any[]> {
  return withFallback(
    async (octokit) => {
      const { data } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: (opts?.state as any) || 'open',
        sort: (opts?.sort as any) || 'updated',
        direction: (opts?.direction as any) || 'desc',
        per_page: opts?.per_page || 30,
      });
      return data;
    },
    () => {
      const params = new URLSearchParams({
        state: opts?.state || 'open',
        sort: opts?.sort || 'updated',
        direction: opts?.direction || 'desc',
        per_page: String(opts?.per_page || 30),
      });
      return ghApi(`/repos/${owner}/${repo}/pulls?${params}`);
    },
    'listPulls',
  );
}

export async function getPull(
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<any> {
  return withFallback(
    async (octokit) => {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
      return data;
    },
    () => ghApi(`/repos/${owner}/${repo}/pulls/${pullNumber}`),
    'getPull',
  );
}

export async function listPullReviewComments(
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<any[]> {
  return withFallback(
    async (octokit) => {
      const { data } = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pullNumber,
      });
      return data;
    },
    () => ghApi(`/repos/${owner}/${repo}/pulls/${pullNumber}/comments`),
    'listPRComments',
  );
}

export async function listIssuesForRepo(
  owner: string,
  repo: string,
  opts?: { state?: string; sort?: string; direction?: string; per_page?: number },
): Promise<any[]> {
  return withFallback(
    async (octokit) => {
      const { data } = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: (opts?.state as any) || 'open',
        sort: (opts?.sort as any) || 'updated',
        direction: (opts?.direction as any) || 'desc',
        per_page: opts?.per_page || 30,
      });
      return data;
    },
    () => {
      const params = new URLSearchParams({
        state: opts?.state || 'open',
        sort: opts?.sort || 'updated',
        direction: opts?.direction || 'desc',
        per_page: String(opts?.per_page || 30),
      });
      return ghApi(`/repos/${owner}/${repo}/issues?${params}`);
    },
    'listIssues',
  );
}

export async function searchIssues(query: string): Promise<any[]> {
  return withFallback(
    async (octokit) => {
      const { data } = await octokit.rest.search.issuesAndPullRequests({ q: query, sort: 'updated', order: 'desc', per_page: 20 });
      return data.items;
    },
    () => {
      const params = new URLSearchParams({ q: query, sort: 'updated', order: 'desc', per_page: '20' });
      const data = ghApi(`/search/issues?${params}`);
      return data.items || [];
    },
    'searchIssues',
  );
}

export async function graphql<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  return withFallback(
    async (octokit) => {
      return await octokit.graphql<T>(query, variables);
    },
    () => {
      const result = ghGraphql(query, variables);
      return result?.data ?? result;
    },
    'graphql',
  );
}

export async function listOrgRepos(
  org: string,
  opts?: { per_page?: number; sort?: string },
): Promise<any[]> {
  return withFallback(
    async (octokit) => {
      const { data } = await octokit.rest.repos.listForOrg({
        org,
        per_page: opts?.per_page || 100,
        sort: (opts?.sort as any) || 'updated',
      });
      return data;
    },
    () => {
      const params = new URLSearchParams({
        per_page: String(opts?.per_page || 100),
        sort: opts?.sort || 'updated',
      });
      return ghApi(`/orgs/${org}/repos?${params}`);
    },
    'listOrgRepos',
  );
}

export async function createPull(
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string,
): Promise<any> {
  return withFallback(
    async (octokit) => {
      const { data } = await octokit.rest.pulls.create({ owner, repo, head, base, title, body });
      return data;
    },
    () => ghApi(`/repos/${owner}/${repo}/pulls`, 'POST', { head, base, title, body }),
    'createPull',
  );
}

export async function createIssueComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<any> {
  return withFallback(
    async (octokit) => {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      return data;
    },
    () => ghApi(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, 'POST', { body }),
    'createIssueComment',
  );
}

export async function createReviewCommentReply(
  owner: string,
  repo: string,
  pullNumber: number,
  commentId: number,
  body: string,
): Promise<any> {
  return withFallback(
    async (octokit) => {
      const { data } = await octokit.rest.pulls.createReplyForReviewComment({
        owner,
        repo,
        pull_number: pullNumber,
        comment_id: commentId,
        body,
      });
      return data;
    },
    () => ghApi(`/repos/${owner}/${repo}/pulls/${pullNumber}/comments/${commentId}/replies`, 'POST', { body }),
    'createReviewReply',
  );
}

export interface ReviewThread {
  id: string; // GraphQL node ID
  isResolved: boolean;
  lastCommentBody: string;
}

export async function getReviewThreads(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(last: 1) {
                nodes { body }
              }
            }
          }
        }
      }
    }
  `;
  const result = await graphql<any>(query, { owner, repo, prNumber });
  const threads = result?.repository?.pullRequest?.reviewThreads?.nodes || [];
  return threads.map((t: any) => ({
    id: t.id,
    isResolved: t.isResolved,
    lastCommentBody: t.comments?.nodes?.[0]?.body || '',
  }));
}

export async function resolveReviewThread(threadId: string): Promise<boolean> {
  const mutation = `
    mutation($threadId: ID!) {
      resolveReviewThread(input: { threadId: $threadId }) {
        thread { isResolved }
      }
    }
  `;
  const result = await graphql<any>(mutation, { threadId });
  return result?.resolveReviewThread?.thread?.isResolved ?? false;
}
