import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Task } from './types.js';

// In-memory task table. `finishScan` settles a task's mocked runVideoscan; `recorded`
// settles the write that records its outcome, which otherwise stays pending.
const db = vi.hoisted(() => ({
  tasks: new Map<number, Task>(),
  finishScan: new Map<number, { resolve: (r: { success: boolean; jsonFile?: string }) => void; reject: (e: Error) => void }>(),
  recorded: new Map<number, () => void>(),
}));

vi.mock('./config.js', () => ({
  config: { claude: { maxConcurrentTasks: 2, maxConcurrentVideoscans: 3, terminalMode: false } },
  WORKSPACES_DIR: '.',
}));
vi.mock('./db/client.js', () => ({ MACHINE_ID: 'm1', isSupabaseConfigured: () => false }));
vi.mock('./db/tasks.js', () => ({ dbSubscribeTaskChanges: vi.fn() }));
vi.mock('./db/videoscans.js', () => ({ dbArchiveVideoscans: vi.fn() }));
vi.mock('./db/storage.js', () => ({}));
vi.mock('./github-api.js', () => ({}));
vi.mock('./git-ops.js', () => ({}));
vi.mock('./learnings.js', () => ({}));
vi.mock('./settings.js', () => ({ getTerminalInteractiveSession: () => null }));
vi.mock('./claude-runner.js', () => ({ claudeEmitter: new EventEmitter(), steerTask: vi.fn() }));

// The real hold, a fake run: only processVideoscan's own hold is under test.
vi.mock('./videoscan-runner.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./videoscan-runner.js')>(),
  runVideoscan: vi.fn((taskId: number) => new Promise((resolve, reject) => db.finishScan.set(taskId, { resolve, reject }))),
}));

vi.mock('./task-queue.js', () => {
  const settle = (id: number, status: Task['status']) => { const t = db.tasks.get(id); if (t) t.status = status; };
  const recording = (id: number) => new Promise<void>((r) => db.recorded.set(id, r));
  return {
    getRunningTasksLean: vi.fn(async () => []),
    getPendingTasks: vi.fn(async () => [...db.tasks.values()].filter(t => t.status === 'pending').map(t => ({ ...t }))),
    claimTask: vi.fn(async (id: number) => { settle(id, 'running'); return true; }),
    getTask: vi.fn(async (id: number) => db.tasks.get(id)),
    getTasksByBatchId: vi.fn(async () => []),
    updateTaskContext: vi.fn((id: number) => recording(id)),
    completeTask: vi.fn((id: number) => recording(id).then(() => settle(id, 'completed'))),
    failTask: vi.fn((id: number) => recording(id).then(() => settle(id, 'failed'))),
    clearStreamingOutput: vi.fn(),
    appendStreamingOutput: vi.fn(),
  };
});

// VIDEOSCAN_DIR is read when the runner loads, so point it at a temp dir first.
const dir = mkdtempSync(join(tmpdir(), 'orch-hold-'));
process.env.VIDEOSCAN_DIR = dir;
const { processQueue } = await import('./task-processor.js');
const { isVideoscanRunning } = await import('./videoscan-runner.js');
const taskQueue = await import('./task-queue.js');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VIDEOSCAN_DIR;
});

beforeEach(() => {
  db.tasks.clear();
  db.finishScan.clear();
  db.recorded.clear();
  vi.clearAllMocks();
});

/** Starts a videoscan task and waits until its run is in flight. */
async function startScan(id: number): Promise<Task> {
  const task = {
    id, type: 'videoscan', status: 'pending', repo: 'https://x.nl', repoPath: '.',
    context: { source: 'github', event: 'videoscan', title: 'scan', scanUrl: 'https://x.nl' },
    createdAt: new Date().toISOString(),
  } as Task;
  db.tasks.set(id, task);
  await processQueue();
  await vi.waitFor(() => expect(db.finishScan.has(id)).toBe(true));
  return task;
}

describe('processVideoscan hold', () => {
  it('keeps a paused task in flight until its resumeFile is written', async () => {
    const task = await startScan(1);
    expect(isVideoscanRunning(1)).toBe(true);

    task.status = 'paused';
    db.finishScan.get(1)!.resolve({ success: true, jsonFile: 'videoscan-x.nl.json' });
    await vi.waitFor(() => expect(taskQueue.updateTaskContext).toHaveBeenCalledWith(1, { resumeFile: join(dir, 'videoscan-x.nl.json') }));
    expect(isVideoscanRunning(1)).toBe(true);

    db.recorded.get(1)!();
    await vi.waitFor(() => expect(isVideoscanRunning(1)).toBe(false));
  });

  it('keeps a finished task in flight until it is completed', async () => {
    await startScan(2);

    db.finishScan.get(2)!.resolve({ success: true, jsonFile: 'videoscan-x.nl.json' });
    await vi.waitFor(() => expect(taskQueue.completeTask).toHaveBeenCalled());
    expect(isVideoscanRunning(2)).toBe(true);

    db.recorded.get(2)!();
    await vi.waitFor(() => expect(isVideoscanRunning(2)).toBe(false));
  });

  it('releases when the run throws', async () => {
    await startScan(3);

    db.finishScan.get(3)!.reject(new Error('boom'));
    await vi.waitFor(() => expect(taskQueue.failTask).toHaveBeenCalledWith(3, 'boom'));
    expect(isVideoscanRunning(3)).toBe(true);

    db.recorded.get(3)!();
    await vi.waitFor(() => expect(isVideoscanRunning(3)).toBe(false));
  });
});
