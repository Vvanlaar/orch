import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Wrap-up with Supabase on, and chosen uploads failing. All of it mocked: no
// test may reach the real table or storage (a checkout with a .env has both
// configured), nor launch a browser. The table is the temp dir's listing, as it
// would be after every successful sync.
const { dbArchiveVideoscans, uploads } = vi.hoisted(() => ({
  dbArchiveVideoscans: vi.fn(async (_filenames: string[]) => {}),
  uploads: { fail: (_filename: string): boolean => false },
}));
vi.mock('./db/client.js', async (original) => ({
  ...(await original<typeof import('./db/client.js')>()),
  isSupabaseConfigured: () => true,
  getSupabase: () => { throw new Error('tests must not reach Supabase'); },
}));
vi.mock('./db/storage.js', () => ({
  uploadScanFiles: async (filename: string) => {
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
    dbUpsertVideoscan: async () => {},
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

function scan(filename: string, domain: string, batchId: string, day: string, visited: string[]) {
  writeFileSync(join(dir, filename), JSON.stringify({
    domain, scanDate: `2026-07-${day}T00:00:00.000Z`,
    pagesScanned: visited.length, pagesWithVideo: 0, uniquePlayers: 0,
    playerSummary: {}, details: [], _state: { visited, queue: [] },
    batchId, batchLabel: batchId,
  }));
}

const files = () => readdirSync(dir);
const SOURCES = ['videoscan-x.nl-2026-07-01T00-00-00.json', 'videoscan-x.nl-2026-07-02T00-00-00.json'];

describe('wrapUpBatch when a sync fails', () => {
  it('undoes a merge that did not sync, instead of leaving its domain out of the summary', async () => {
    scan(SOURCES[0], 'x.nl', 'sync', '01', ['https://x.nl/']);
    scan(SOURCES[1], 'x.nl', 'sync', '02', ['https://x.nl/', 'https://x.nl/a']);
    uploads.fail = (f) => f.endsWith('-merged.json');

    await expect(wrapUpBatch('sync')).rejects.toThrow(/merge of x\.nl to Supabase \(storage unreachable\).*merge was undone/);

    expect(dbArchiveVideoscans).not.toHaveBeenCalled();
    // The sources are back where they were, and nothing else is left behind
    for (const f of SOURCES) expect(files()).toContain(f);
    expect(files().some(f => f.endsWith('-merged.json') || f.endsWith('-summary.json'))).toBe(false);
    expect(existsSync(join(dir, 'archived')) ? readdirSync(join(dir, 'archived')) : []).toEqual([]);
  });

  it('wraps up from the restored sources once the sync works again', async () => {
    uploads.fail = () => false;

    const result = await wrapUpBatch('sync');

    expect(result.mergedDomains).toEqual(['x.nl']);
    expect(dbArchiveVideoscans).toHaveBeenCalledWith(SOURCES);
    expect(files().filter(f => f.endsWith('-merged.json'))).toHaveLength(1);
  });

  it('keeps the batch open when the summary does not sync', async () => {
    scan('videoscan-y.nl-2026-07-03T00-00-00.json', 'y.nl', 'summary-sync', '03', ['https://y.nl/']);
    uploads.fail = (f) => f.endsWith('-summary.json');

    await expect(wrapUpBatch('summary-sync')).rejects.toThrow(/could not sync it to Supabase \(storage unreachable\); the batch stays open/);
  });
});
