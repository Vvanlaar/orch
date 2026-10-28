import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobContext } from './bbcore-runner.js';
import type { Task } from './types.js';

const dir = mkdtempSync(join(tmpdir(), 'bbcore-recipes-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const m = vi.hoisted(() => ({
  getTask: vi.fn(),
  getAllTasks: vi.fn(),
  getTasksByBatchId: vi.fn(),
  updateTaskContext: vi.fn(),
  failTask: vi.fn(),
  stopRunningTask: vi.fn(),
  startVideoscanTask: vi.fn(),
  startVideoscanUrlsTask: vi.fn(),
  listScans: vi.fn(),
  importDigitoegankelijk: vi.fn(),
  triggerUpdate: vi.fn(),
  ensureLocal: vi.fn(async () => {}),
}));

vi.mock('./logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('./db/client.js', () => ({ MACHINE_ID: 'm1' }));
vi.mock('./task-processor.js', () => ({ triggerUpdate: m.triggerUpdate }));
vi.mock('./task-stop.js', () => ({ stopRunningTask: m.stopRunningTask }));
vi.mock('./task-queue.js', () => ({
  getTask: m.getTask,
  getAllTasks: m.getAllTasks,
  getTasksByBatchId: m.getTasksByBatchId,
  updateTaskContext: m.updateTaskContext,
  failTask: m.failTask,
  getStreamingOutput: () => '[3/50] https://example.nl/a\n',
}));
vi.mock('./videoscan-start.js', () => ({
  startVideoscanTask: m.startVideoscanTask,
  startVideoscanUrlsTask: m.startVideoscanUrlsTask,
  VideoscanRequestError: class extends Error {},
}));
vi.mock('./videoscan-runner.js', () => ({
  ensureLocal: m.ensureLocal,
  getVideoscanDir: () => dir,
  isDerivedScan: (f: string) => f.endsWith('-merged.json'),
  listScans: m.listScans,
}));
vi.mock('./digitoegankelijk.js', async (orig) => ({ ...(await orig<object>()), importDigitoegankelijk: m.importDigitoegankelijk }));

const { RECIPES, recoverJobs } = await import('./bbcore-recipes.js');
const recipe = (id: string) => RECIPES.find(r => r.id === id)!;

function ctx(progressAnswers: boolean[] = []) {
  const ctl = new AbortController();
  let cancel = false;
  const c = {
    job: { id: 'job1', type: 'videoscan', input: {} },
    signal: ctl.signal,
    get cancelRequested() { return cancel; },
    progress: vi.fn(async () => {
      if (progressAnswers.shift()) { cancel = true; ctl.abort(); }
      return cancel;
    }),
    artifact: vi.fn(async () => {}),
  };
  return c as typeof c & JobContext;
}

function task(id: number, status: Task['status'], context: Partial<Task['context']> = {}, extra: Partial<Task> = {}): Task {
  return {
    id, type: 'videoscan', status, repo: 'x', repoPath: dir, createdAt: '',
    context: { source: 'github', event: 'videoscan', scanUrl: 'https://example.nl', maxPages: 50, bbCoreJobId: 'job1', ...context },
    ...extra,
  } as Task;
}

function writeScan(name: string, scan: object, html = true) {
  writeFileSync(join(dir, name), JSON.stringify(scan));
  if (html) writeFileSync(join(dir, name.replace('.json', '.html')), '<h1>report</h1>');
}

beforeEach(() => {
  vi.clearAllMocks();
  m.getAllTasks.mockResolvedValue([]);
});

describe('videoscan recipe', () => {
  it('starts a task pinned to this machine and returns its scan with the report artifact', async () => {
    writeScan('videoscan-example.nl-1.json', {
      domain: 'example.nl', scanDate: '2026-10-28', pagesScanned: 12, pagesWithVideo: 2,
      playerSummary: { YouTube: { count: 2 }, Vimeo: { count: 1 } },
      details: [{ url: 'https://example.nl/a', players: [{ name: 'YouTube' }] }],
    });
    m.startVideoscanTask.mockResolvedValue(task(7, 'pending'));
    m.getTask.mockResolvedValue(task(7, 'completed', {}, { result: 'Scan complete\nJSON: videoscan-example.nl-1.json' }));
    const c = ctx();

    const result: any = await recipe('videoscan').run({ url: 'example.nl', maxPages: 20 }, c);

    expect(m.startVideoscanTask).toHaveBeenCalledWith(
      { url: 'https://example.nl/', maxPages: 20, mode: 'video' },
      { bbCoreJobId: 'job1', targetMachineId: 'm1' },
    );
    expect(result).toMatchObject({
      taskId: 7, filename: 'videoscan-example.nl-1.json', domain: 'example.nl', pagesScanned: 12, pagesWithVideo: 2, uniquePlayers: 2,
      playerSummary: [{ player: 'YouTube', pages: 2 }, { player: 'Vimeo', pages: 1 }],
      artifact: { name: 'videoscan-example.nl-1.html', contentType: 'text/html' },
    });
    expect(result.sovereignty).toBeUndefined();
    expect(c.artifact).toHaveBeenCalledWith('videoscan-example.nl-1.html', 'text/html', expect.any(Buffer));
  });

  it('adds the sovereignty grade in sovereignty mode', async () => {
    writeScan('videoscan-sov.nl-1.json', { domain: 'sov.nl', mode: 'sovereignty', playerSummary: { YouTube: { count: 1 } }, details: [] }, false);
    m.startVideoscanTask.mockResolvedValue(task(8, 'pending', { scanMode: 'sovereignty' }));
    m.getTask.mockResolvedValue(task(8, 'completed', {}, { result: 'JSON: videoscan-sov.nl-1.json' }));

    const result: any = await recipe('videoscan').run({ url: 'https://sov.nl', mode: 'sovereignty' }, ctx());

    expect(result.sovereignty.grade).toMatch(/^[A-E]$/);
    expect(result.sovereignty.players[0]).toMatchObject({ player: 'YouTube', grade: expect.stringMatching(/^[A-E]$/) });
    expect(result.artifact).toBeUndefined();
  });

  it('reports progress from the task output, and a cancel stops the task', async () => {
    m.startVideoscanTask.mockResolvedValue(task(9, 'pending'));
    m.getTask.mockResolvedValue(task(9, 'running'));
    m.stopRunningTask.mockResolvedValue(undefined);
    const c = ctx([true]);

    await expect(recipe('videoscan').run({ url: 'https://example.nl' }, c)).rejects.toThrow('Cancelled');

    expect(c.progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'scanning', taskId: 9, status: 'running', visited: 3, planned: 3, maxPages: 50 }));
    expect(m.stopRunningTask).toHaveBeenCalledWith(expect.objectContaining({ id: 9 }), 'bb-core');
  });

  it('follows an auto-resume to the new task', async () => {
    writeScan('videoscan-example.nl-2.json', { domain: 'example.nl', playerSummary: {} }, false);
    m.startVideoscanTask.mockResolvedValue(task(10, 'pending'));
    m.getTask.mockImplementation(async (id: number) => id === 10
      ? task(10, 'failed', {}, { error: 'process gone; auto-resuming from x.json' })
      : task(11, 'completed', {}, { result: 'JSON: videoscan-example.nl-2.json' }));
    // first call: the open-crawl check before starting; then the successor lookup
    m.getAllTasks.mockResolvedValueOnce([]).mockResolvedValue([task(11, 'pending'), task(12, 'completed', { bbCoreJobId: 'other' })]);

    const result: any = await recipe('videoscan').run({ url: 'https://example.nl' }, ctx());

    expect(result).toMatchObject({ taskId: 11, filename: 'videoscan-example.nl-2.json' });
  });

  it('fails the job with the task error', async () => {
    m.startVideoscanTask.mockResolvedValue(task(13, 'pending'));
    m.getTask.mockResolvedValue(task(13, 'failed', {}, { error: 'net::ERR_NAME_NOT_RESOLVED' }));
    await expect(recipe('videoscan').run({ url: 'https://example.nl' }, ctx())).rejects.toThrow('ERR_NAME_NOT_RESOLVED');
  });

  it('refuses a second crawl of a host that is already open', async () => {
    m.getAllTasks.mockResolvedValue([task(40, 'running', { scanUrl: 'https://www.example.nl/', bbCoreJobId: undefined })]);
    await expect(recipe('videoscan').run({ url: 'https://example.nl' }, ctx())).rejects.toThrow('task #40');
    expect(m.startVideoscanTask).not.toHaveBeenCalled();
  });

  it('rejects bad input before starting anything', async () => {
    await expect(recipe('videoscan').run({ url: 'javascript:alert(1)' }, ctx())).rejects.toThrow();
    await expect(recipe('videoscan').run({ url: 'https://x.nl', maxPages: 0 }, ctx())).rejects.toThrow('maxPages');
    await expect(recipe('videoscan').run({ url: 'https://x.nl', mode: 'deep' }, ctx())).rejects.toThrow('mode');
    expect(m.startVideoscanTask).not.toHaveBeenCalled();
  });
});

describe('videoscan_org recipe', () => {
  it('plans the organisation into one batch and returns the merged scan once auto-merged', async () => {
    m.importDigitoegankelijk.mockResolvedValue({
      orgName: 'Gemeente Test', totalSites: 3, skippedApps: 0,
      groups: [
        { rootDomain: 'test.nl', sites: [{ url: 'https://www.test.nl/' }, { url: 'https://loket.test.nl/login' }] },
        { rootDomain: 'raad.nl', sites: [{ url: 'https://raad.nl/' }] },
      ],
    });
    m.startVideoscanTask.mockResolvedValueOnce(task(20, 'pending')).mockResolvedValueOnce(task(21, 'pending'));
    m.startVideoscanUrlsTask.mockResolvedValue(task(22, 'pending'));
    m.getTasksByBatchId.mockResolvedValue([
      task(20, 'completed', {}, { result: 'JSON: a.json' }),
      task(21, 'completed', {}, { result: 'JSON: b.json' }),
      task(22, 'failed', {}, { error: 'login wall' }),
    ]);
    writeScan('videoscan-test-organisatie-merged.json', { domain: 'test-organisatie', pagesScanned: 40, playerSummary: { Vimeo: { count: 4 } } });
    m.listScans.mockImplementation(async () => [{ filename: 'videoscan-test-organisatie-merged.json', batchId: m.startVideoscanTask.mock.calls[0][0].batchId }]);

    const result: any = await recipe('videoscan_org').run({ digi: 'https://dashboard.digitoegankelijk.nl/organisaties/123', maxPages: 100 }, ctx());

    expect(m.importDigitoegankelijk).toHaveBeenCalledWith(123);
    const batch = m.startVideoscanTask.mock.calls[0][0];
    expect(batch.batchId).toMatch(/^digi-gemeente-test-\d+$/);
    expect(batch.batchLabel).toBe('Digi import — Gemeente Test');
    expect(m.startVideoscanTask.mock.calls.map(c => c[0].url)).toEqual(['https://www.test.nl/', 'https://raad.nl/']);
    expect(m.startVideoscanUrlsTask.mock.calls[0][0]).toMatchObject({ urls: ['https://loket.test.nl/login'], maxPages: 100, batchId: batch.batchId });
    expect(result).toMatchObject({
      orgName: 'Gemeente Test', tasks: 3, members: ['a.json', 'b.json'],
      filename: 'videoscan-test-organisatie-merged.json', pagesScanned: 40,
      failed: [{ taskId: 22, error: 'login wall' }],
      artifact: { name: 'videoscan-test-organisatie-merged.html' },
    });
  });

  it('waits out the gap of an auto-resume instead of settling the batch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      writeScan('videoscan-one.nl-1.json', { domain: 'one.nl', playerSummary: {} }, false);
      m.importDigitoegankelijk.mockResolvedValue({ orgName: 'One', totalSites: 1, skippedApps: 0, groups: [{ rootDomain: 'one.nl', sites: [{ url: 'https://one.nl/' }] }] });
      m.startVideoscanTask.mockResolvedValue(task(50, 'pending'));
      const crashed = task(50, 'failed', { scanUrl: 'https://one.nl/' }, { error: 'process gone; auto-resuming from x.json' });
      m.getTasksByBatchId
        .mockResolvedValueOnce([crashed])
        .mockResolvedValue([crashed, task(51, 'completed', { scanUrl: 'https://one.nl/' }, { result: 'JSON: videoscan-one.nl-1.json' })]);
      const c = ctx();
      const done = recipe('videoscan_org').run({ digi: 7 }, c);
      await vi.advanceTimersByTimeAsync(5_000);
      const result: any = await done;
      expect(result).toMatchObject({ tasks: 2, filename: 'videoscan-one.nl-1.json' });
      expect(result.failed).toBeUndefined();
      expect(c.progress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'scanning' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects something that is not a digi organisation', async () => {
    await expect(recipe('videoscan_org').run({ digi: 'https://example.nl' }, ctx())).rejects.toThrow('digi must be');
  });
});

describe('videoscan_list / videoscan_get', () => {
  it('lists newest first, filtered by domain', async () => {
    m.listScans.mockResolvedValue([
      { filename: 'a.json', domain: 'old.example.nl', scanDate: '2026-01-01', pagesScanned: 1, pagesWithVideo: 0, uniquePlayers: 0, hasReport: false },
      { filename: 'b.json', domain: 'example.nl', scanDate: '2026-05-01', pagesScanned: 2, pagesWithVideo: 1, uniquePlayers: 1, hasReport: true },
      { filename: 'c.json', domain: 'other.nl', scanDate: '2026-06-01', pagesScanned: 3, pagesWithVideo: 0, uniquePlayers: 0, hasReport: true },
      { filename: 'd-INPROGRESS.json', domain: 'example.nl', scanDate: '2026-07-01', pagesScanned: 3, pagesWithVideo: 0, uniquePlayers: 0, hasReport: false },
    ]);
    const result: any = await recipe('videoscan_list').run({ domain: 'www.Example.nl', limit: 5 }, ctx());
    expect(result.total).toBe(2);
    expect(result.scans.map((s: any) => s.filename)).toEqual(['b.json', 'a.json']);
  });

  it('refuses a filename outside the scans dir', async () => {
    await expect(recipe('videoscan_get').run({ filename: '../secrets.json' }, ctx())).rejects.toThrow('filename');
  });

  it('reads an archived merge member in place, without fetching it back', async () => {
    mkdirSync(join(dir, 'archived'), { recursive: true });
    writeFileSync(join(dir, 'archived', 'videoscan-arch.nl-1.json'), JSON.stringify({ domain: 'arch.nl', playerSummary: {} }));
    writeFileSync(join(dir, 'archived', 'videoscan-arch.nl-1.html'), '<h1>r</h1>');
    const result: any = await recipe('videoscan_get').run({ filename: 'videoscan-arch.nl-1.json' }, ctx());
    expect(result).toMatchObject({ domain: 'arch.nl', artifact: { name: 'videoscan-arch.nl-1.html' } });
    expect(m.ensureLocal).not.toHaveBeenCalled();
  });

  it('gets one scan with its video pages', async () => {
    writeScan('videoscan-get.nl-1.json', {
      domain: 'get.nl', playerSummary: { YouTube: { count: 1 } },
      details: [{ url: 'https://get.nl/a', players: [{ name: 'YouTube' }, { name: 'YouTube' }] }, { url: 'https://get.nl/b', players: [] }],
    });
    const result: any = await recipe('videoscan_get').run({ filename: 'videoscan-get.nl-1.json' }, ctx());
    expect(result.videoPages).toEqual([{ url: 'https://get.nl/a', players: ['YouTube'] }]);
    expect(result.artifact).toEqual({ name: 'videoscan-get.nl-1.html', contentType: 'text/html' });
  });
});

describe('recoverJobs', () => {
  it('reattaches unreported jobs of this machine only', async () => {
    m.getAllTasks.mockResolvedValue([
      task(30, 'running', { targetMachineId: 'm1', bbCoreJobId: 'a' }),
      task(31, 'completed', { targetMachineId: 'm1', bbCoreJobId: 'b', bbCoreReported: true }),
      task(32, 'running', { targetMachineId: 'm2', bbCoreJobId: 'c' }),
      task(33, 'running', { targetMachineId: 'm1', bbCoreJobId: 'd', batchId: 'digi-x-1' }),
      task(34, 'pending', { targetMachineId: 'm1', bbCoreJobId: 'd', batchId: 'digi-x-1' }),
    ]);
    const jobs = await recoverJobs();
    expect(jobs.map(j => [j.job.id, j.job.type])).toEqual([['a', 'videoscan'], ['d', 'videoscan_org']]);
  });
});
