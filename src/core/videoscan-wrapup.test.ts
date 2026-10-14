import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// wrapUpBatch lists, syncs and renders a PDF. Keep it on the temp dir: a checkout
// with a .env would otherwise list the real Supabase table, and no test should
// launch a browser.
vi.mock('./db/client.js', async (original) => ({
  ...(await original<typeof import('./db/client.js')>()),
  isSupabaseConfigured: () => false,
}));
vi.mock('playwright', () => ({
  chromium: { launch: async () => { throw new Error('no browser in tests'); } },
}));

// VIDEOSCAN_DIR is read when the runner loads, so point it at a temp dir first.
const dir = mkdtempSync(join(tmpdir(), 'orch-wrapup-'));
process.env.VIDEOSCAN_DIR = dir;
const { wrapUpBatch } = await import('./videoscan-runner.js');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VIDEOSCAN_DIR;
});

function scan(filename: string, domain: string, batchId: string, visited: string[], queue: string[]) {
  writeFileSync(join(dir, filename), JSON.stringify({
    domain, scanDate: `2026-07-${String(visited.length).padStart(2, '0')}T00:00:00.000Z`,
    pagesScanned: visited.length, pagesWithVideo: 0, uniquePlayers: 0,
    playerSummary: {}, details: [],
    _state: { visited, queue },
    batchId, batchLabel: batchId,
  }));
}

function stored(filename: string) {
  return JSON.parse(readFileSync(join(dir, filename), 'utf-8'));
}

describe('wrapUpBatch', () => {
  it('does not mark a site partial when a retry in the batch covered it', async () => {
    // Run 1 stopped on its page budget; run 2 visited what run 1 still had queued
    scan('videoscan-x.nl-2026-07-01T00-00-00.json', 'x.nl', 'covered', ['https://x.nl/'], ['https://x.nl/a']);
    scan('videoscan-x.nl-2026-07-02T00-00-00.json', 'x.nl', 'covered', ['https://x.nl/', 'https://x.nl/a'], []);

    const result = await wrapUpBatch('covered');

    expect(result.mergedDomains).toEqual(['x.nl']);
    // Nothing was left to clear once the two were merged
    expect(result.finalized).toEqual([]);
    const summary = stored(result.summary);
    expect(summary._state.queue).toEqual([]);
    expect('queueCleared' in summary).toBe(false);
  });

  it('marks what it cleared, in the scan and in the summary', async () => {
    scan('videoscan-y.nl-2026-07-01T00-00-00.json', 'y.nl', 'partial', ['https://y.nl/'], ['https://y.nl/a']);
    // Two runs of z.nl that between them still left a page unvisited
    scan('videoscan-z.nl-2026-07-01T00-00-00.json', 'z.nl', 'partial', ['https://z.nl/'], ['https://z.nl/a', 'https://z.nl/b']);
    scan('videoscan-z.nl-2026-07-02T00-00-00.json', 'z.nl', 'partial', ['https://z.nl/', 'https://z.nl/a'], []);

    const result = await wrapUpBatch('partial');

    expect(result.mergedDomains).toEqual(['z.nl']);
    expect(result.finalized).toHaveLength(2);
    expect(result.finalized).toContain('videoscan-y.nl-2026-07-01T00-00-00.json');
    for (const f of result.finalized) {
      expect(stored(f)._state.queue).toEqual([]);
      expect(stored(f).queueCleared).toBe(true);
    }
    expect(stored(result.summary).queueCleared).toBe(true);
  });
});
