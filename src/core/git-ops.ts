import { execFileSync, execSync } from 'child_process';
import path from 'path';
import { Octokit } from 'octokit';
import { config } from './config.js';

const octokit = new Octokit({ auth: config.github.token });

export interface GitStatus {
  hasChanges: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

export function getGitStatus(repoPath: string): GitStatus {
  try {
    const status = execSync('git status --porcelain', {
      cwd: repoPath,
      encoding: 'utf-8',
    });

    const lines = status.trim().split('\n').filter(Boolean);
    const staged: string[] = [];
    const unstaged: string[] = [];
    const untracked: string[] = [];

    for (const line of lines) {
      const index = line[0];
      const worktree = line[1];
      const file = line.slice(3);

      if (index === '?' && worktree === '?') {
        untracked.push(file);
      } else if (index !== ' ' && index !== '?') {
        staged.push(file);
      } else if (worktree !== ' ') {
        unstaged.push(file);
      }
    }

    return {
      hasChanges: lines.length > 0,
      staged,
      unstaged,
      untracked,
    };
  } catch {
    return { hasChanges: false, staged: [], unstaged: [], untracked: [] };
  }
}

export function getCurrentBranch(repoPath: string): string {
  try {
    return execSync('git branch --show-current', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'main';
  }
}

export function getDefaultBranch(repoPath: string): string {
  try {
    // Try to get default branch from remote
    const remote = execSync('git remote show origin', {
      cwd: repoPath,
      encoding: 'utf-8',
    });
    const match = remote.match(/HEAD branch: (\S+)/);
    return match ? match[1] : 'main';
  } catch {
    return 'main';
  }
}

export function createBranch(repoPath: string, branchName: string, baseBranch?: string): boolean {
  try {
    const base = baseBranch || getDefaultBranch(repoPath);

    // Fetch latest
    execSync('git fetch origin', { cwd: repoPath, stdio: 'pipe' });

    // Create and checkout new branch from base
    execSync(`git checkout -b ${branchName} origin/${base}`, {
      cwd: repoPath,
      stdio: 'pipe',
    });

    return true;
  } catch (err) {
    console.error('[GitOps] Failed to create branch:', err);
    return false;
  }
}

export function stageAndCommit(repoPath: string, message: string): boolean {
  try {
    // Stage all changes
    execSync('git add -A', { cwd: repoPath, stdio: 'pipe' });

    // Commit
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: repoPath,
      stdio: 'pipe',
    });

    return true;
  } catch (err) {
    console.error('[GitOps] Failed to commit:', err);
    return false;
  }
}

export function pushBranch(repoPath: string, branchName: string): boolean {
  try {
    execSync(`git push -u origin ${branchName}`, {
      cwd: repoPath,
      stdio: 'pipe',
    });
    return true;
  } catch (err) {
    console.error('[GitOps] Failed to push:', err);
    return false;
  }
}

export function checkoutBranch(repoPath: string, branchName: string): boolean {
  try {
    execSync(`git checkout ${branchName}`, {
      cwd: repoPath,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

export function discardChanges(repoPath: string): void {
  try {
    execSync('git checkout -- .', { cwd: repoPath, stdio: 'pipe' });
    execSync('git clean -fd', { cwd: repoPath, stdio: 'pipe' });
  } catch {
    // Ignore errors
  }
}

export async function createGitHubPR(
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string
): Promise<string | null> {
  try {
    const [owner, repoName] = repo.split('/');
    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo: repoName,
      head,
      base,
      title,
      body,
    });
    return pr.html_url;
  } catch (err) {
    console.error('[GitOps] Failed to create GitHub PR:', err);
    return null;
  }
}

export function cloneRepo(cloneUrl: string, targetName: string): boolean {
  const targetPath = path.resolve(config.repos.baseDir, targetName);
  try {
    // Use execFileSync to avoid command injection
    execFileSync('git', ['clone', cloneUrl, targetPath], {
      timeout: 120000,
      stdio: 'pipe',
    });
    return true;
  } catch (err) {
    console.error('[GitOps] Failed to clone repo:', err);
    return false;
  }
}

export async function createAdoPR(
  project: string,
  repoName: string,
  sourceBranch: string,
  targetBranch: string,
  title: string,
  description: string
): Promise<string | null> {
  if (!config.ado.pat || !config.ado.organization) return null;

  try {
    const auth = Buffer.from(`:${config.ado.pat}`).toString('base64');
    const url = `https://dev.azure.com/${config.ado.organization}/${project}/_apis/git/repositories/${repoName}/pullrequests?api-version=7.1`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        sourceRefName: `refs/heads/${sourceBranch}`,
        targetRefName: `refs/heads/${targetBranch}`,
        title,
        description,
      }),
    });

    if (!res.ok) {
      console.error('[GitOps] ADO PR creation failed:', await res.text());
      return null;
    }

    const data = await res.json();
    return data._links?.web?.href || null;
  } catch (err) {
    console.error('[GitOps] Failed to create ADO PR:', err);
    return null;
  }
}
