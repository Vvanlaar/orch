import type { PR, WorkItem } from './types';

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
