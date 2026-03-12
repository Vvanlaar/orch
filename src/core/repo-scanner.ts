import { readdirSync, existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { join, resolve } from 'path';
import { config, WORKSPACES_DIR } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('repo-scanner');

export interface RepoInfo {
  localPath: string;
  localName: string;
  remote: string | null;
  source: 'github' | 'ado' | 'unknown';
}

function getGitRemote(repoPath: string): string | null {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return remote || null;
  } catch {
    return null;
  }
}

function parseRemoteUrl(remote: string): { fullName: string; source: 'github' | 'ado' | 'unknown' } {
  // GitHub SSH: git@github.com:owner/repo.git
  // GitHub HTTPS: https://github.com/owner/repo.git
  const githubSsh = remote.match(/git@github\.com:(.+?)(?:\.git)?$/);
  if (githubSsh) {
    return { fullName: githubSsh[1], source: 'github' };
  }

  const githubHttps = remote.match(/https:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (githubHttps) {
    return { fullName: githubHttps[1], source: 'github' };
  }

  // ADO SSH: git@ssh.dev.azure.com:v3/org/project/repo
  const adoSsh = remote.match(/git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+?)$/);
  if (adoSsh) {
    return { fullName: `${adoSsh[1]}/${adoSsh[2]}/${adoSsh[3]}`, source: 'ado' };
  }

  // ADO HTTPS: https://dev.azure.com/org/project/_git/repo
  // or: https://org@dev.azure.com/org/project/_git/repo
  const adoHttps = remote.match(/https:\/\/(?:[^@]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/(.+?)(?:\.git)?$/);
  if (adoHttps) {
    return { fullName: `${adoHttps[1]}/${adoHttps[2]}/${adoHttps[3]}`, source: 'ado' };
  }

  // Old VSTS format: https://org.visualstudio.com/project/_git/repo
  const vstsHttps = remote.match(/https:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/(.+?)(?:\.git)?$/);
  if (vstsHttps) {
    return { fullName: `${vstsHttps[1]}/${vstsHttps[2]}/${vstsHttps[3]}`, source: 'ado' };
  }

  return { fullName: remote, source: 'unknown' };
}

function scanDirectory(dir: string, namePrefix: string): RepoInfo[] {
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  } catch { return []; }

  const repos: RepoInfo[] = [];
  for (const entry of readdirSync(dir)) {
    try {
    const fullPath = join(dir, entry);
    if (!statSync(fullPath).isDirectory()) continue;
    if (!existsSync(join(fullPath, '.git'))) continue;

    const remote = getGitRemote(fullPath);
    const parsed = remote ? parseRemoteUrl(remote) : { fullName: null, source: 'unknown' as const };

    if (remote && parsed.source === 'unknown') {
      log.info(`Unknown remote format for ${entry}: ${remote}`);
    }

    repos.push({
      localPath: fullPath,
      localName: namePrefix ? `${namePrefix}/${entry}` : entry,
      remote: parsed.fullName || entry,
      source: parsed.source,
    });
    } catch {
      log.warn(`Failed to scan ${namePrefix ? namePrefix + '/' : ''}${entry}`);
    }
  }
  return repos;
}

export function scanRepos(): RepoInfo[] {
  const baseDir = resolve(config.repos.baseDir);

  if (!existsSync(baseDir)) {
    log.warn(`Base directory not found: ${baseDir}`);
    return [];
  }

  return [
    ...scanDirectory(baseDir, ''),
    ...scanDirectory(join(WORKSPACES_DIR, 'clones'), '.workspaces/clones'),
  ];
}

export function buildRepoMapping(): Record<string, string> {
  const repos = scanRepos();
  const mapping: Record<string, string> = {};

  for (const repo of repos) {
    if (repo.remote && repo.source !== 'unknown') {
      // Use full remote name for known sources (github, ado)
      mapping[repo.remote] = repo.localName;
    }
    // Also add by local name for fallback lookups
    mapping[repo.localName] = repo.localName;
  }

  return mapping;
}

export function getScannedRepos(): RepoInfo[] {
  return scanRepos();
}

export function getEffectiveRepoMapping(): Record<string, string> {
  // Start with manual mapping
  const mapping = { ...config.repos.mapping };

  // Merge auto-scanned repos if enabled
  if (config.repos.autoScan) {
    const scanned = buildRepoMapping();
    for (const [key, local] of Object.entries(scanned)) {
      if (!mapping[key]) {
        mapping[key] = local;
      }
    }
  }

  return mapping;
}
