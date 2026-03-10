import type { ClaudeUsage } from '../lib/types';

let usage = $state<ClaudeUsage | null>(null);

export function getUsage() {
  return usage;
}

export function formatResetTime(iso: string | undefined): string {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'resets soon';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
}

export function formatUpdatedAt(iso: string | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'updated just now';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `updated ${m}m ago`;
  const h = Math.floor(m / 60);
  return `updated ${h}h ${m % 60}m ago`;
}

export async function fetchClaudeUsage() {
  try {
    const res = await fetch('/api/claude/usage');
    if (!res.ok) return;
    usage = await res.json();
  } catch {
    // Ignore errors
  }
}
