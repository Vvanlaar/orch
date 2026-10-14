import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EventEmitter } from 'events';

// Wrap-up whose summary report fails. Supabase off and no browser: nothing
// leaves the temp dir. report.mjs is spawned through child_process: that spawn
// exits 1 here.
vi.mock('./db/client.js', async (original) => ({
  ...(await original<typeof import('./db/client.js')>()),
  isSupabaseConfigured: () => false,
}));
vi.mock('playwright', () => ({
  chromium: { launch: async () => { throw new Error('no browser in tests'); } },
}));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  spawn: () => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => proc.emit('close', 1));
    return proc;
  },
}));

const dir = mkdtempSync(join(tmpdir(), 'orch-wrapup-report-'));
process.env.VIDEOSCAN_DIR = dir;
const { wrapUpBatch } = await import('./videoscan-runner.js');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VIDEOSCAN_DIR;
});

describe('wrapUpBatch when the summary report fails', () => {
  it('throws, so the caller does not close a batch without its report', async () => {
    writeFileSync(join(dir, 'videoscan-r.nl-2026-07-01T00-00-00.json'), JSON.stringify({
      domain: 'r.nl', scanDate: '2026-07-01T00:00:00.000Z', pagesScanned: 1, pagesWithVideo: 0, uniquePlayers: 0,
      playerSummary: {}, details: [], _state: { visited: ['https://r.nl/'], queue: [] },
      batchId: 'report', batchLabel: 'report',
    }));

    await expect(wrapUpBatch('report')).rejects.toThrow(/its report failed \(report\.mjs exited with code 1\); the batch stays open/);
    // The summary itself is written: a retry overwrites it
    expect(readdirSync(dir).some(f => f.endsWith('-summary.json'))).toBe(true);
  });
});
