import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const FILE = join(process.cwd(), '.orch-batches.json');

interface BatchState {
  closed: string[];
}

function load(): BatchState {
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf-8'));
      if (Array.isArray(parsed?.closed)) return { closed: parsed.closed.filter((x: unknown) => typeof x === 'string') };
    }
  } catch {}
  return { closed: [] };
}

function save(state: BatchState): void {
  writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export function getClosedBatches(): string[] {
  return load().closed;
}

export function markBatchClosed(batchId: string): void {
  const state = load();
  if (!state.closed.includes(batchId)) {
    state.closed.push(batchId);
    save(state);
  }
}

export function markBatchOpen(batchId: string): void {
  const state = load();
  const next = state.closed.filter(id => id !== batchId);
  if (next.length !== state.closed.length) save({ closed: next });
}
