import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';
import { config, WORKSPACES_DIR } from './config.js';
import { createPull } from './github-api.js';
import { createLogger } from './logger.js';

const log = createLogger('git-ops');

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
  } catch (err) {
    log.warn('Failed to get git status', { error: String(err) });
    return { hasChanges: false, staged: [], unstaged: [], untracked: [] };
  }
}

export function getCurrentBranch(repoPath: string): string {
  try {
    return execSync('git branch --show-current', {
      cwd: repoPath,
      encoding: 'utf-8',
    }).trim();
  } catch (err) {
    log.warn('Failed to get current branch', { error: String(err) });
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
  } catch (err) {
    log.warn('Failed to get default branch', { error: String(err) });
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

    initSubmodules(repoPath);
    return true;
  } catch (err) {
    log.error('Failed to create branch', err);
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
    log.error('Failed to commit', err);
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
    log.error('Failed to push', err);
    return false;
  }
}

export function checkoutBranch(repoPath: string, branchName: string): boolean {
  try {
    execSync(`git checkout ${branchName}`, {
      cwd: repoPath,
      stdio: 'pipe',
    });
    initSubmodules(repoPath);
    return true;
  } catch (err) {
    log.warn('Failed to checkout branch', { error: String(err) });
    return false;
  }
}

function initSubmodules(cwd: string): void {
  try {
    execSync('git submodule update --init --recursive', { cwd, stdio: 'pipe', timeout: 120000 });
  } catch (err) {
    log.error('Failed to init submodules', err);
  }
}

/** Link or install node_modules in a worktree.
 *  Junction from sourceRepo when lockfiles match, else `npm ci --prefer-offline`. */
function linkOrInstallNodeModules(worktreePath: string, sourceRepoPath: string): void {
  const sourceModules = path.join(sourceRepoPath, 'node_modules');
  const targetModules = path.join(worktreePath, 'node_modules');
  if (!existsSync(sourceModules)) return; // source has no node_modules, skip

  const sourceLock = path.join(sourceRepoPath, 'package-lock.json');
  const targetLock = path.join(worktreePath, 'package-lock.json');
  if (!existsSync(targetLock)) return; // no package-lock in worktree, skip

  try {
    const same = existsSync(sourceLock) &&
      readFileSync(sourceLock, 'utf-8') === readFileSync(targetLock, 'utf-8');

    if (same && !existsSync(targetModules)) {
      // Junction (Windows) or symlink (Unix) — instant, zero disk cost
      const isWin = process.platform === 'win32';
      if (isWin) {
        execSync(`cmd /c mklink /J "${targetModules}" "${sourceModules}"`, { stdio: 'pipe' });
      } else {
        execSync(`ln -s "${sourceModules}" "${targetModules}"`, { stdio: 'pipe' });
      }
      log.info(`Linked node_modules from ${sourceRepoPath}`);
    } else if (!same) {
      log.info('Lockfile differs, running npm ci');
      execSync('npm ci --prefer-offline', { cwd: worktreePath, stdio: 'pipe', timeout: 300000 });
    }
  } catch (err) {
    log.error('Failed to link/install node_modules', err);
  }
}

export function discardChanges(repoPath: string): void {
  try {
    execSync('git checkout -- .', { cwd: repoPath, stdio: 'pipe' });
    execSync('git clean -fd', { cwd: repoPath, stdio: 'pipe' });
  } catch (err) {
    log.warn('Failed to discard changes', { error: String(err) });
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
    const pr = await createPull(owner, repoName, head, base, title, body);
    return pr.html_url;
  } catch (err) {
    log.error('Failed to create GitHub PR', err);
    return null;
  }
}

export function getWorktreePath(repoPath: string, branchName: string): string {
  const repoName = path.basename(repoPath);
  const branchSlug = branchName.replace(/\//g, '-');
  return path.join(WORKSPACES_DIR, 'worktrees', repoName, branchSlug);
}

export function createWorktree(repoPath: string, branchName: string, baseBranch?: string): string | null {
  try {
    const worktreePath = getWorktreePath(repoPath, branchName);
    const base = baseBranch || getDefaultBranch(repoPath);
    execSync('git fetch origin', { cwd: repoPath, stdio: 'pipe' });

    // Enable long paths on Windows to avoid "Filename too long" errors
    if (process.platform === 'win32') {
      try { execSync('git config core.longpaths true', { cwd: repoPath, stdio: 'pipe' }); } catch (err) { log.warn('Failed to set core.longpaths', { error: String(err) }); }
    }

    execSync(`git worktree add "${worktreePath}" -b "${branchName}" "origin/${base}"`, { cwd: repoPath, stdio: 'pipe' });
    initSubmodules(worktreePath);
    linkOrInstallNodeModules(worktreePath, repoPath);
    return worktreePath;
  } catch (err) {
    log.error('Failed to create worktree', err);
    return null;
  }
}

export function checkoutPRInWorktree(repoPath: string, prNumber: number, branch?: string): string | null {
  try {
    const repoName = path.basename(repoPath);
    const worktreePath = path.join(WORKSPACES_DIR, 'worktrees', repoName, `pr-${prNumber}`);

    // Reuse existing worktree
    if (existsSync(path.join(worktreePath, '.git'))) return worktreePath;

    // Fetch the PR head ref (+ force-updates if local ref already exists)
    execFileSync('git', ['fetch', 'origin', `+pull/${prNumber}/head:pr-${prNumber}`], { cwd: repoPath, stdio: 'pipe' });

    // Enable long paths on Windows to avoid "Filename too long" errors
    if (process.platform === 'win32') {
      try { execFileSync('git', ['config', 'core.longpaths', 'true'], { cwd: repoPath, stdio: 'pipe' }); } catch (err) { log.warn('Failed to set core.longpaths', { error: String(err) }); }
    }

    mkdirSync(path.dirname(worktreePath), { recursive: true });
    execFileSync('git', ['worktree', 'add', worktreePath, `pr-${prNumber}`], { cwd: repoPath, stdio: 'pipe' });

    // Set upstream so pushes target the correct remote branch
    if (branch) {
      try {
        execFileSync('git', ['branch', '--set-upstream-to', `origin/${branch}`, `pr-${prNumber}`], { cwd: repoPath, stdio: 'pipe' });
      } catch (err) { log.warn('Failed to set upstream (fork branch?)', { error: String(err) }); }
    }

    initSubmodules(worktreePath);
    linkOrInstallNodeModules(worktreePath, repoPath);
    return worktreePath;
  } catch (err) {
    log.error('Failed to checkout PR in worktree', err);
    return null;
  }
}

export function removeWorktree(repoPath: string, worktreePath: string): void {
  try {
    execSync(`git worktree remove --force "${worktreePath}"`, { cwd: repoPath, stdio: 'pipe' });
    execSync('git worktree prune', { cwd: repoPath, stdio: 'pipe' });
  } catch (err) {
    log.error('Failed to remove worktree', err);
  }
}

export function cloneRepo(cloneUrl: string, targetName: string): string | null {
  const clonesDir = path.join(WORKSPACES_DIR, 'clones');
  const targetPath = path.join(clonesDir, targetName);
  try {
    mkdirSync(clonesDir, { recursive: true });
    // Use execFileSync to avoid command injection
    execFileSync('git', ['clone', '-c', 'core.longpaths=true', '--recurse-submodules', cloneUrl, targetPath], {
      timeout: 120000,
      stdio: 'pipe',
    });
    return targetPath;
  } catch (err) {
    log.error('Failed to clone repo', err);
    return null;
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
      log.error(`ADO PR creation failed: ${await res.text()}`);
      return null;
    }

    const data = await res.json();
    return data._links?.web?.href || null;
  } catch (err) {
    log.error('Failed to create ADO PR', err);
    return null;
  }
}
