import type { PR, WorkItem, Terminal, TerminalConfig, TerminalId, GitHubRepo } from './types';

export async function reviewPR(pr: PR): Promise<{ taskId: number; message: string }> {
  const res = await fetch('/api/actions/review-pr', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo: pr.repo,
      prNumber: pr.number,
      source: 'github',
      title: pr.title,
      url: pr.url,
    }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error);
  return result;
}

export async function fixPRComments(pr: PR): Promise<{ taskId: number; message: string }> {
  const res = await fetch('/api/actions/fix-pr-comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo: pr.repo,
      prNumber: pr.number,
      source: 'github',
      title: pr.title,
      url: pr.url,
      branch: pr.branch,
      baseBranch: pr.baseBranch,
    }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error);
  return result;
}

export async function analyzeWorkItem(wi: WorkItem): Promise<{ taskId: number; message: string }> {
  const res = await fetch('/api/actions/analyze-workitem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: wi.id,
      title: wi.title,
      project: wi.project,
      url: wi.url,
      type: wi.type,
    }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error);
  return result;
}

export async function reviewResolution(wi: WorkItem): Promise<{ taskId: number; message: string }> {
  const res = await fetch('/api/actions/review-resolution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: wi.id,
      title: wi.title,
      project: wi.project,
      url: wi.url,
      resolution: wi.resolution,
      githubPrUrl: wi.githubPrUrl,
      testNotes: wi.testNotes,
      body: wi.body,
    }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error);
  return result;
}

// Terminal configuration
export async function analyzeTerminals(): Promise<Terminal[]> {
  const res = await fetch('/api/system/terminals');
  if (!res.ok) throw new Error('Failed to analyze terminals');
  return res.json();
}

export async function getTerminalConfig(): Promise<TerminalConfig> {
  const res = await fetch('/api/config/terminal');
  if (!res.ok) throw new Error('Failed to get terminal config');
  return res.json();
}

export async function setTerminalConfig(terminal: TerminalId): Promise<void> {
  const res = await fetch('/api/config/terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terminal }),
  });
  if (!res.ok) throw new Error('Failed to set terminal config');
}

// GitHub org repos
export async function fetchOrgRepos(): Promise<GitHubRepo[]> {
  const res = await fetch('/api/github/org-repos');
  if (!res.ok) throw new Error('Failed to fetch org repos');
  return res.json();
}

export async function cloneRepo(cloneUrl: string, targetName: string): Promise<{ success: boolean; error?: string }> {
  const res = await fetch('/api/repos/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cloneUrl, targetName }),
  });
  return res.json();
}

export async function testWorkitem(wi: WorkItem, selectedRepo?: string): Promise<{ taskId: number; message: string }> {
  const res = await fetch('/api/actions/test-workitem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: wi.id,
      title: wi.title,
      project: wi.project,
      url: wi.url,
      githubPrUrl: wi.githubPrUrl,
      testNotes: wi.testNotes,
      body: wi.body,
      selectedRepo,
    }),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error);
  return result;
}
