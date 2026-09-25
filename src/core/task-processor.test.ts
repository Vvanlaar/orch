import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Task } from './types.js';

// In-memory task table standing in for Supabase. `snapshotLag` makes getRunningTasksLean
// return the rows as they were before the latest claims, like a read replica / slow query.
const db = vi.hoisted(() => ({
  tasks: new Map<number, Task>(),
  snapshotLag: false,
  snapshot: [] as { id: number; type: string; status: string; machineId?: string; pid?: number }[],
  // Finishes a running scan; scans otherwise run until the test ends them.
  finishScan: new Map<number, (r: { success: boolean; error?: string }) => void>(),
}));

vi.mock('./config.js', () => ({
  config: { claude: { maxConcurrentTasks: 2, maxConcurrentVideoscans: 3, terminalMode: false } },
  WORKSPACES_DIR: '.',
}));
vi.mock('./db/client.js', () => ({ MACHINE_ID: 'm1', isSupabaseConfigured: () => false }));
vi.mock('./db/tasks.js', () => ({ dbSubscribeTaskChanges: vi.fn() }));
vi.mock('./db/videoscans.js', () => ({ dbArchiveVideoscans: vi.fn() }));
vi.mock('./github-api.js', () => ({}));
vi.mock('./git-ops.js', () => ({}));
vi.mock('./learnings.js', () => ({}));
vi.mock('./settings.js', () => ({ getTerminalInteractiveSession: () => null }));
vi.mock('./claude-runner.js', () => ({ claudeEmitter: new EventEmitter(), steerTask: vi.fn() }));

vi.mock('./videoscan-runner.js', () => ({
  runVideoscan: vi.fn((taskId: number) => new Promise((resolve) => db.finishScan.set(taskId, resolve))),
  controlFileName: (id: number) => `_control-${id}.json`,
  findLatestScanFileForDomain: vi.fn(() => null),
  readScanFileInfo: vi.fn(() => null),
  readPagesScanned: vi.fn(() => 0),
  resumeBudget: vi.fn(() => ({ maxPages: 50 })),
  getVideoscanDir: () => '.',
  mergeScans: vi.fn(),
  syncScanToSupabase: vi.fn(async () => {}),
  generateReport: vi.fn(),
}));

vi.mock('./process-kill.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./process-kill.js')>()),
  isPidAlive: vi.fn(() => false),
  killProcessTree: vi.fn(async () => ({ killed: true })),
  verifyProcessIdentity: vi.fn(async () => ({ identity: 'mismatch' as const })),
  getProcessInfos: vi.fn(async () => new Map()),
}));

vi.mock('./task-queue.js', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 5));
  const lean = () => [...db.tasks.values()]
    .filter(t => t.status === 'running')
    .map(t => ({ id: t.id, type: t.type, status: t.status, machineId: t.machineId, pid: t.pid }));
  const settle = (id: number, status: Task['status']) => { const t = db.tasks.get(id); if (t) t.status = status; };
  return {
    getRunningTasksLean: vi.fn(async () => {
      const rows = db.snapshotLag ? db.snapshot : lean();
      await tick();
      return rows;
    }),
    getPendingTasks: vi.fn(async (limit: number) => {
      await tick();
      return [...db.tasks.values()].filter(t => t.status === 'pending').slice(0, limit).map(t => ({ ...t }));
    }),
    getOrphanCandidates: vi.fn(async () => [...db.tasks.values()].filter(t => t.status === 'running').map(t => ({ ...t }))),
    // Atomic, like dbClaimTask's conditional update.
    claimTask: vi.fn(async (id: number) => {
      await tick();
      const t = db.tasks.get(id);
      if (!t || t.status !== 'pending') return false;
      t.status = 'running';
      t.machineId = 'm1';
      return true;
    }),
    completeTask: vi.fn(async (id: number) => settle(id, 'completed')),
    failTask: vi.fn(async (id: number) => settle(id, 'failed')),
    updateTaskStatus: vi.fn(async (id: number, status: Task['status']) => settle(id, status)),
    createTask: vi.fn(async () => ({ id: 999 })),
    getTask: vi.fn(async (id: number) => db.tasks.get(id)),
    getTasksByBatchId: vi.fn(async () => []),
    clearStreamingOutput: vi.fn(),
    appendStreamingOutput: vi.fn(),
    updateTaskPid: vi.fn(),
    updateTaskRepoPath: vi.fn(),
    updateTaskContext: vi.fn(),
  };
});

const { processQueue, startProcessor, stopProcessor, expectedTaskProcess } = await import('./task-processor.js');
const taskQueue = await import('./task-queue.js');
const runner = await import('./videoscan-runner.js');
const pk = await import('./process-kill.js');

function addTask(id: number, over: Partial<Task> = {}): Task {
  const t = {
    id,
    type: 'videoscan',
    status: 'pending',
    repo: `https://site${id}.nl`,
    repoPath: process.cwd(),
    context: { source: 'github', event: 'videoscan', title: `scan ${id}`, scanUrl: `https://site${id}.nl` },
    createdAt: new Date().toISOString(),
    ...over,
  } as Task;
  db.tasks.set(id, t);
  return t;
}

const runningScans = () => [...db.tasks.values()].filter(t => t.type === 'videoscan' && t.status === 'running').length;

beforeEach(() => {
  db.tasks.clear();
  db.snapshotLag = false;
  db.snapshot = [];
  // Reset, not clear: a mocked return value must not leak into the next test.
  vi.resetAllMocks();
});

const flush = () => new Promise((r) => setTimeout(r, 50));

async function finish(id: number): Promise<void> {
  db.finishScan.get(id)?.({ success: true });
  db.finishScan.delete(id);
  await flush();
}

// Let every scan settle so this process's in-flight claims don't carry into the next test.
afterEach(async () => {
  stopProcessor();
  for (const id of [...db.finishScan.keys()]) await finish(id);
});

describe('processQueue slot limit', () => {
  it('overlapping runs (startup, realtime wake, poll tick) never claim past MAX_CONCURRENT_VIDEOSCANS', async () => {
    for (let id = 1; id <= 12; id++) addTask(id);
    await Promise.all([processQueue(), processQueue(), processQueue()]);
    await processQueue();
    expect(runningScans()).toBe(3);
    expect(runner.runVideoscan).toHaveBeenCalledTimes(3);
  });

  it('counts its own claims while the running-task read still lags behind them', async () => {
    for (let id = 1; id <= 12; id++) addTask(id);
    db.snapshotLag = true; // the DB read never shows the claims made below
    await processQueue();
    await processQueue();
    await processQueue();
    expect(runningScans()).toBe(3);
  });

  it('fills freed slots on a later run', async () => {
    for (let id = 1; id <= 5; id++) addTask(id);
    await processQueue();
    expect(runningScans()).toBe(3);
    // Another machine's scans don't use this machine's slots.
    addTask(50, { status: 'running', machineId: 'm2' });
    await finish(1);
    expect(db.tasks.get(1)!.status).toBe('completed');
    await processQueue();
    expect([...db.tasks.values()].filter(t => t.status === 'running' && t.machineId === 'm1').map(t => t.id)).toEqual([2, 3, 4]);
  });
});

describe('startup orphan handling', () => {
  const orphan = (pid: number) => addTask(676, { status: 'running', machineId: 'm1', pid, startedAt: '2026-09-24T10:00:00Z' });

  // The scan died mid-crawl and left a checkpoint, so a dead scan is auto-resumed.
  beforeEach(() => {
    vi.mocked(runner.findLatestScanFileForDomain).mockReturnValue('videoscan-site676.nl-INPROGRESS.json');
    vi.mocked(runner.readScanFileInfo).mockReturnValue({ name: 'videoscan-site676.nl-INPROGRESS.json', mtimeMs: 0, checkpoint: true });
    vi.mocked(pk.isPidAlive).mockReturnValue(true);
  });

  it('does not kill a live PID that now belongs to another program, and resumes the dead scan', async () => {
    orphan(76680);
    vi.mocked(pk.verifyProcessIdentity).mockResolvedValue({ identity: 'mismatch' });
    await startProcessor(60_000);
    expect(pk.verifyProcessIdentity).toHaveBeenCalledWith(76680, {
      markers: ['scan.mjs', '_control-676.json'],
      notBeforeMs: Date.parse('2026-09-24T10:00:00Z'),
    });
    expect(pk.killProcessTree).not.toHaveBeenCalled();
    expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
  });

  it('kills a live PID that is verifiably the task\'s own scan.mjs, then resumes', async () => {
    orphan(4242);
    vi.mocked(pk.verifyProcessIdentity).mockResolvedValue({ identity: 'match' });
    await startProcessor(60_000);
    expect(pk.killProcessTree).toHaveBeenCalledWith(4242);
    expect(taskQueue.createTask).toHaveBeenCalledTimes(1);
  });

  it('neither kills nor resumes when the process cannot be verified', async () => {
    orphan(4242);
    vi.mocked(pk.verifyProcessIdentity).mockResolvedValue({ identity: 'unknown', error: 'powershell failed' });
    await startProcessor(60_000);
    expect(pk.killProcessTree).not.toHaveBeenCalled();
    expect(taskQueue.createTask).not.toHaveBeenCalled();
    expect(taskQueue.failTask).toHaveBeenCalledWith(676, expect.stringContaining('could not be verified (powershell failed)'));
  });
});

describe('reconciling running scans left by another instance', () => {
  const proc = (commandLine: string) => ({ commandLine, startedAtMs: null });

  afterEach(() => vi.useRealTimers());

  it('settles a row whose PID was reused by another program, but not one whose scan still runs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    addTask(676, { status: 'running', machineId: 'm1', pid: 76680 });
    addTask(677, { status: 'running', machineId: 'm1', pid: 76681 });
    vi.mocked(pk.isPidAlive).mockReturnValue(true);
    vi.mocked(pk.getProcessInfos).mockResolvedValue(new Map([
      [76680, proc(String.raw`C:\Program Files\Other\app.exe`)],
      [76681, proc(String.raw`node.exe C:\dev\orch\src\videoscan\scan.mjs https://x.nl --control-file C:\v\_control-677.json`)],
    ]));

    await processQueue(); // first seen dead: not settled yet
    expect(db.tasks.get(676)!.status).toBe('running');

    vi.setSystemTime(Date.now() + 6 * 60_000);
    await processQueue();
    expect(db.tasks.get(676)!.status).toBe('failed');
    expect(db.tasks.get(677)!.status).toBe('running');
    expect(pk.killProcessTree).not.toHaveBeenCalled();
  });

  it('leaves a live PID alone when its command line is hidden (elevated instance)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    addTask(676, { status: 'running', machineId: 'm1', pid: 76680 });
    vi.mocked(pk.isPidAlive).mockReturnValue(true);
    vi.mocked(pk.getProcessInfos).mockResolvedValue(new Map([[76680, { commandLine: null, startedAtMs: null }]]));
    await processQueue();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await processQueue();
    expect(db.tasks.get(676)!.status).toBe('running');
  });

  it('leaves live PIDs alone when the process table cannot be read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    addTask(676, { status: 'running', machineId: 'm1', pid: 76680 });
    vi.mocked(pk.isPidAlive).mockReturnValue(true);
    vi.mocked(pk.getProcessInfos).mockRejectedValue(new Error('powershell failed'));
    await processQueue();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await processQueue();
    expect(db.tasks.get(676)!.status).toBe('running');
  });
});

describe('expectedTaskProcess', () => {
  it('pins a videoscan to its own scan.mjs by control file', () => {
    expect(expectedTaskProcess({ id: 7, type: 'videoscan' })).toEqual({ markers: ['scan.mjs', '_control-7.json'] });
  });

  it('expects the claude CLI for other task types', () => {
    expect(expectedTaskProcess({ id: 7, type: 'pr-review', startedAt: 'not a date' }))
      .toEqual({ markers: ['claude', '--dangerously-skip-permissions'] });
  });
});
