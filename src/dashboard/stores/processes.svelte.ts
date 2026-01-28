import type { Process } from '../lib/types';

let processes = $state<Process[]>([]);
let loading = $state(false);

export function getProcesses() {
  // Sort by start time (oldest first)
  return [...processes].sort(
    (a, b) => new Date(a.startTime || 0).getTime() - new Date(b.startTime || 0).getTime()
  );
}

export function isLoading() {
  return loading;
}

export async function fetchProcesses() {
  loading = true;
  try {
    const res = await fetch('/api/processes');
    processes = await res.json();
  } catch (err) {
    console.error('Failed to fetch processes:', err);
    processes = [];
  } finally {
    loading = false;
  }
}

export async function killProcess(pid: number) {
  await fetch(`/api/processes/${pid}/kill`, { method: 'POST' });
  await fetchProcesses();
}

export async function killOldProcesses() {
  await fetch('/api/processes/kill-old', { method: 'POST' });
  await fetchProcesses();
}

export async function killAllProcesses() {
  await fetch('/api/processes/kill-all', { method: 'POST' });
  await fetchProcesses();
}
