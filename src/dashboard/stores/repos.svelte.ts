import type { GitHubRepo } from '../lib/types';
import { fetchOrgRepos, cloneRepo as apiCloneRepo } from '../lib/api';

let orgRepos = $state<GitHubRepo[]>([]);
let loading = $state(false);
let cloning = $state<string | null>(null);

export function getOrgRepos() {
  return orgRepos;
}

export function isLoading() {
  return loading;
}

export function getCloningRepo() {
  return cloning;
}

export async function loadOrgRepos() {
  if (loading) return;
  loading = true;
  try {
    orgRepos = await fetchOrgRepos();
  } catch (err) {
    console.error('Failed to load org repos:', err);
  } finally {
    loading = false;
  }
}

export async function cloneRepo(repo: GitHubRepo): Promise<boolean> {
  cloning = repo.name;
  try {
    const result = await apiCloneRepo(repo.clone_url, repo.name);
    if (result.success) {
      // Update local state
      orgRepos = orgRepos.map(r =>
        r.name === repo.name ? { ...r, isLocal: true } : r
      );
      return true;
    } else {
      alert(`Clone failed: ${result.error}`);
      return false;
    }
  } catch (err) {
    console.error('Failed to clone repo:', err);
    alert(`Clone failed: ${err}`);
    return false;
  } finally {
    cloning = null;
  }
}
