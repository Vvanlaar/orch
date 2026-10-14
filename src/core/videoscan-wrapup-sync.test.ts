import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Wrap-up with Supabase on, and chosen uploads failing. All of it mocked: no
// test may reach the real table or storage (a checkout with a .env has both
// configured), nor launch a browser. The table is the temp dir's listing, as it
// would be after every successful sync.
const { dbArchiveVideoscans, dbUpsertVideoscan, uploads } = vi.hoisted(() => ({
  dbArchiveVideoscans: vi.fn(async (_filenames: string[]) => {}),
  dbUpsertVideoscan: vi.fn(async (_row: Record<string, unknown>) => {}),
  uploads: { fail: (_filename: string): boolean => false, before: (_filename: string): void => {} },
}));
vi.mock('./db/client.js', async (original) => ({
  ...(await original<typeof import('./db/client.js')>()),
  isSupabaseConfigured: () => true,
  getSupabase: () => { throw new Error('tests must not reach Supabase'); },
}));
vi.mock('./db/storage.js', () => ({
  uploadScanFiles: async (filename: string) => {
    uploads.before(filename);
    if (uploads.fail(filename)) throw new Error('storage unreachable');
  },
  downloadFile: async () => false,
  deleteScanFiles: async () => {},
}));
vi.mock('./db/videoscans.js', async () => {
  const { readdirSync, readFileSync } = await import('fs');
  const { join } = await import('path');
  const scanDir = () => process.env.VIDEOSCAN_DIR!;
  return {
    dbListScans: async () => readdirSync(scanDir())
      .filter(f => f.startsWith('videoscan-') && f.endsWith('.json'))
      .map(filename => {
        const d = JSON.parse(readFileSync(join(scanDir(), filename), 'utf-8'));
        return {
          filename, domain: d.domain, scanDate: d.scanDate, pagesScanned: d.pagesScanned,
          pagesWithVideo: 0, uniquePlayers: 0, hasReport: false, hasPdf: false,
          hasPreview: false, hasPreviewPdf: false, canResume: false,
          batchId: d.batchId, batchLabel: d.batchLabel,
        };
      }),
    dbUpsertVideoscan,
    dbDeleteVideoscans: async () => {},
    dbArchiveVideoscans,
  };
});
vi.mock('playwright', () => ({
  chromium: { launch: async () => { throw new Error('no browser in tests'); } },
}));

// VIDEOSCAN_DIR is read when the runner loads, so point it at a temp dir first.
const dir = mkdtempSync(join(tmpdir(), 'orch-wrapup-sync-'));
process.env.VIDEOSCAN_DIR = dir;
const { wrapUpBatch } = await import('./videoscan-runner.js');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VIDEOSCAN_DIR;
});

beforeEach(() => {
  dbArchiveVideoscans.mockClear();
  dbUpsertVideoscan.mockClear();
  uploads.fail = () => false;
  uploads.before = () => {};
});

function scan(filename: string, domain: string, batchId: string, day: string, visited: string[], queue: string[] = []) {
  writeFileSync(join(dir, filename), JSON.stringify({
    domain, scanDate: `2026-07-${day}T00:00:00.000Z`,
    pagesScanned: visited.length, pagesWithVideo: 0, uniquePlayers: 0,
    playerSummary: {}, details: [], _state: { visited, queue },
    batchId, batchLabel: batchId,
  }));
}

const files = () => readdirSync(dir);
const stored = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf-8'));

describe('wrapUpBatch when a sync fails', () => {
  it('undoes a merge that did not sync, and wraps up from the restored sources on the retry', async () => {
    const sources = ['videoscan-x.nl-2026-07-01T00-00-00.json', 'videoscan-x.nl-2026-07-02T00-00-00.json'];
    scan(sources[0], 'x.nl', 'sync', '01', ['https://x.nl/']);
    scan(sources[1], 'x.nl', 'sync', '02', ['https://x.nl/', 'https://x.nl/a']);
    uploads.fail = (f) => f.endsWith('-merged.json');

    await expect(wrapUpBatch('sync')).rejects.toThrow(/merge of x\.nl to Supabase \(storage unreachable\).*merge was undone/);

    expect(dbArchiveVideoscans).not.toHaveBeenCalled();
    // The sources are back where they were, and nothing else is left behind
    for (const f of sources) expect(files()).toContain(f);
    expect(files().some(f => f.endsWith('-merged.json') || f.endsWith('-summary.json'))).toBe(false);
    expect(existsSync(join(dir, 'archived')) ? readdirSync(join(dir, 'archived')) : []).toEqual([]);

    // The retry, once the sync works again
    uploads.fail = () => false;
    const result = await wrapUpBatch('sync');
    expect(result.mergedDomains).toEqual(['x.nl']);
    expect(dbArchiveVideoscans).toHaveBeenCalledWith(sources);
    expect(files().filter(f => f.startsWith('videoscan-x.nl') && f.endsWith('-merged.json'))).toHaveLength(1);
  });

  it('says what to do by hand when undoing the merge fails too', async () => {
    const sources = ['videoscan-w.nl-2026-07-01T00-00-00.json', 'videoscan-w.nl-2026-07-02T00-00-00.json'];
    scan(sources[0], 'w.nl', 'undo', '01', ['https://w.nl/']);
    scan(sources[1], 'w.nl', 'undo', '02', ['https://w.nl/', 'https://w.nl/a']);
    // One archived source disappears before the undo can move it back
    uploads.before = (f) => {
      if (f.endsWith('-merged.json')) unlinkSync(join(dir, 'archived', sources[0]));
    };
    uploads.fail = (f) => f.endsWith('-merged.json');

    await expect(wrapUpBatch('undo')).rejects.toThrow(`by hand: move ${sources[0]} back from archived/`);
    expect(dbArchiveVideoscans).not.toHaveBeenCalled();
  });

  it('puts a cleared queue back when its scan does not sync, and clears and syncs it on the retry', async () => {
    const name = 'videoscan-q.nl-2026-07-04T00-00-00.json';
    scan(name, 'q.nl', 'fin', '04', ['https://q.nl/'], ['https://q.nl/nieuws?page=2']);
    uploads.fail = (f) => f === name;

    await expect(wrapUpBatch('fin')).rejects.toThrow(/Could not sync videoscan-q\.nl.*queue was put back and the batch stays open/);
    expect(stored(name)._state.queue).toEqual(['https://q.nl/nieuws?page=2']);
    expect('queueCleared' in stored(name)).toBe(false);

    uploads.fail = () => false;
    const result = await wrapUpBatch('fin');
    expect(result.finalized).toEqual([name]);
    expect(stored(name).queueCleared).toBe(true);
    // The row gets the mark and stops offering a resume
    expect(dbUpsertVideoscan).toHaveBeenCalledWith(expect.objectContaining({ filename: name, queueCleared: true, canResume: false }));
  });

  it('throws when the summary does not sync, so the caller does not close the batch', async () => {
    scan('videoscan-y.nl-2026-07-03T00-00-00.json', 'y.nl', 'summary-sync', '03', ['https://y.nl/']);
    uploads.fail = (f) => f.endsWith('-summary.json');

    await expect(wrapUpBatch('summary-sync')).rejects.toThrow(/could not sync it to Supabase \(storage unreachable\); the batch stays open/);
  });
});
