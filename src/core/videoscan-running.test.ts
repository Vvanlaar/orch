import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const spawn = vi.hoisted(() => vi.fn());
const uploadScanFiles = vi.hoisted(() => vi.fn());

vi.mock('child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('child_process')>(), spawn }));
vi.mock('./db/client.js', async (importOriginal) => ({ ...await importOriginal<typeof import('./db/client.js')>(), isSupabaseConfigured: () => true }));
vi.mock('./db/storage.js', () => ({ uploadScanFiles, downloadFile: vi.fn(), deleteScanFiles: vi.fn() }));
vi.mock('./db/videoscans.js', () => ({ dbUpsertVideoscan: vi.fn(), dbListScans: vi.fn(), dbDeleteVideoscans: vi.fn(), dbArchiveVideoscans: vi.fn() }));

// VIDEOSCAN_DIR is read when the runner loads, so point it at a temp dir first.
const dir = mkdtempSync(join(tmpdir(), 'orch-running-'));
process.env.VIDEOSCAN_DIR = dir;
const { runVideoscan, isVideoscanRunning, holdVideoscan, killVideoscan } = await import('./videoscan-runner.js');

// The scan JSON of the run: post-processing syncs it, which is the slow part. The runner only
// takes a file the run names (stdout marker) or resumes, not just any file of the domain.
const SCAN_JSON = 'videoscan-x.nl-2026-01-01T00-00-00.json';
writeFileSync(join(dir, SCAN_JSON), JSON.stringify({ domain: 'x.nl', _state: { queue: ['https://x.nl/a'] } }));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VIDEOSCAN_DIR;
});

function fakeProc() {
  return Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
}

/** Queues one fake child per spawn() call, in order. */
function procs(n: number) {
  const list = Array.from({ length: n }, fakeProc);
  for (const p of list) spawn.mockReturnValueOnce(p);
  return list;
}

/** Makes the Supabase upload hang until the returned function is called. */
function holdSync(): () => void {
  let finish!: () => void;
  uploadScanFiles.mockReturnValueOnce(new Promise<void>(r => { finish = r; }));
  return finish;
}

beforeEach(() => {
  spawn.mockReset();
  uploadScanFiles.mockReset();
});

describe('isVideoscanRunning', () => {
  it('stays true through report and sync after scan.mjs exits 0', async () => {
    const [scan, report] = procs(2);
    const finishSync = holdSync();
    const run = runVideoscan(1, { scanUrl: 'https://x.nl/' });
    expect(isVideoscanRunning(1)).toBe(true);

    scan.stdout.emit('data', `VIDEOSCAN_JSON: ${SCAN_JSON}\n`);
    scan.emit('close', 0);
    expect(isVideoscanRunning(1)).toBe(true);
    report.emit('close', 0);
    await vi.waitFor(() => expect(uploadScanFiles).toHaveBeenCalled());
    expect(isVideoscanRunning(1)).toBe(true);

    finishSync();
    expect((await run).success).toBe(true);
    expect(isVideoscanRunning(1)).toBe(false);
  });

  it('stays true through the post-crash sync after a non-zero exit', async () => {
    const [scan] = procs(1);
    const finishSync = holdSync();
    const run = runVideoscan(2, { scanUrl: 'https://x.nl/', resumeFile: join(dir, SCAN_JSON) });

    scan.emit('close', 1);
    await vi.waitFor(() => expect(uploadScanFiles).toHaveBeenCalled());
    expect(isVideoscanRunning(2)).toBe(true);

    finishSync();
    expect((await run).success).toBe(false);
    expect(isVideoscanRunning(2)).toBe(false);
  });

  it('stays true after a kill until the killed process has closed', async () => {
    const [scan] = procs(1);
    const run = runVideoscan(3, { scanUrl: 'https://x.nl/' });

    expect(killVideoscan(3)).toBe(true);
    expect(scan.kill).toHaveBeenCalledWith('SIGTERM');
    expect(isVideoscanRunning(3)).toBe(true);

    scan.emit('close', null);
    await run;
    expect(isVideoscanRunning(3)).toBe(false);
  });

  it('clears when the process fails to spawn', async () => {
    const [scan] = procs(1);
    const run = runVideoscan(4, { scanUrl: 'https://x.nl/' });

    scan.emit('error', new Error('ENOENT'));
    expect(await run).toEqual({ success: false, error: 'ENOENT' });
    expect(isVideoscanRunning(4)).toBe(false);
  });

  it('clears when spawn itself throws', async () => {
    spawn.mockImplementationOnce(() => { throw new Error('EMFILE'); });

    await expect(runVideoscan(7, { scanUrl: 'https://x.nl/' })).rejects.toThrow('EMFILE');
    expect(isVideoscanRunning(7)).toBe(false);
  });

  it("stays true while the caller holds the task past the run's own hold", async () => {
    const release = holdVideoscan(5);
    const [scan] = procs(1);
    const run = runVideoscan(5, { scanUrl: 'https://x.nl/' });

    scan.emit('error', new Error('ENOENT'));
    await run;
    expect(isVideoscanRunning(5)).toBe(true);

    release();
    expect(isVideoscanRunning(5)).toBe(false);
  });

  it('counts a release once', () => {
    const first = holdVideoscan(6);
    const second = holdVideoscan(6);
    first();
    first();
    expect(isVideoscanRunning(6)).toBe(true);
    second();
    expect(isVideoscanRunning(6)).toBe(false);
  });
});
