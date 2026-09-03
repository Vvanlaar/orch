import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// generateReport shells out to src/videoscan/report.mjs (and, if that produces
// HTML, to chromium for the PDF). Stub the spawn so wrap-up stays in-process:
// no HTML is written, so the PDF/upload steps are skipped too.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: () => {
      const handlers = new Map<string, (arg?: unknown) => void>();
      const proc = {
        on(event: string, cb: (arg?: unknown) => void) { handlers.set(event, cb); return proc; },
      };
      setImmediate(() => handlers.get('close')?.(0));
      return proc;
    },
  };
});

const dir = mkdtempSync(join(tmpdir(), 'videoscan-batch-'));
process.env.VIDEOSCAN_DIR = dir;
// Keep listScans/sync on the disk path — no Supabase round trips from a unit test.
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const { wrapUpBatch, summarizeBatch, listScans } = await import('./videoscan-runner.js');

const BATCH_ID = 'test-batch-1788339397978';
const BATCH_LABEL = 'Test Batch';

const SCAN_A = 'videoscan-a.example-2026-09-02T10-00-00.json';
const SCAN_B = 'videoscan-b.example-2026-09-02T11-00-00.json';

interface Detail { url: string; players: { name: string; evidence: string[] }[] }

function detail(url: string, ...players: string[]): Detail {
  return { url, players: players.map(name => ({ name, evidence: [`${name}-evidence`] })) };
}

function writeScan(filename: string, domain: string, scanDate: string, details: Detail[], visited: string[]) {
  const playerSummary: Record<string, { count: number; pages: string[] }> = {};
  for (const d of details) {
    for (const p of d.players) {
      const entry = playerSummary[p.name] ||= { count: 0, pages: [] };
      entry.count++;
      entry.pages.push(d.url);
    }
  }
  writeFileSync(join(dir, filename), JSON.stringify({
    domain,
    scanDate,
    pagesScanned: visited.length,
    pagesWithVideo: details.length,
    uniquePlayers: Object.keys(playerSummary).length,
    playerSummary,
    details,
    _state: { visited, queue: [] },
    batchId: BATCH_ID,
    batchLabel: BATCH_LABEL,
  }, null, 2));
}

function readJson(filename: string) {
  return JSON.parse(readFileSync(join(dir, filename), 'utf-8'));
}

function totals(filename: string) {
  const data = readJson(filename);
  return {
    pagesScanned: data.pagesScanned,
    pagesWithVideo: data.pagesWithVideo,
    uniquePlayers: data.uniquePlayers,
    playerSummary: data.playerSummary,
    urls: data.details.map((d: Detail) => d.url).sort(),
  };
}

function seedBatch() {
  writeScan(SCAN_A, 'a.example', '2026-09-02T10:00:00.000Z', [
    detail('https://a.example/1', 'Blue Billywig'),
    detail('https://a.example/2', 'JW Player'),
    detail('https://a.example/3', 'Video.js'),
  ], ['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4']);

  writeScan(SCAN_B, 'b.example', '2026-09-02T11:00:00.000Z', [
    detail('https://b.example/1', 'Blue Billywig'),
    detail('https://b.example/2', 'Blue Billywig'),
  ], ['https://b.example/1', 'https://b.example/2']);
}

beforeEach(() => {
  for (const f of readdirSync(dir)) unlinkSync(join(dir, f));
  seedBatch();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('wrapUpBatch re-entrancy', () => {
  it('produces identical totals when wrapped up twice with unchanged sources', async () => {
    const first = await wrapUpBatch(BATCH_ID);
    const before = totals(first.summary);
    expect(before.pagesWithVideo).toBe(5);
    expect(before.pagesScanned).toBe(6);

    const second = await wrapUpBatch(BATCH_ID);
    expect(second.summary).toBe(first.summary); // same filename — the summary is overwritten
    expect(totals(second.summary)).toEqual(before);
  });

  it('does not resurrect a page pruned from a source scan after the first wrap-up', async () => {
    const first = await wrapUpBatch(BATCH_ID);
    expect(totals(first.summary).urls).toContain('https://a.example/3');
    expect(existsSync(join(dir, first.summary))).toBe(true);

    // Prune the false-positive Video.js hit from the per-domain scan, exactly as
    // the dashboard's page-removal flow does (details + counts, visited intact).
    writeScan(SCAN_A, 'a.example', '2026-09-02T10:00:00.000Z', [
      detail('https://a.example/1', 'Blue Billywig'),
      detail('https://a.example/2', 'JW Player'),
    ], ['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4']);

    const second = await wrapUpBatch(BATCH_ID);
    const after = totals(second.summary);
    expect(after.urls).not.toContain('https://a.example/3');
    expect(after.pagesWithVideo).toBe(4);
    expect(after.pagesScanned).toBe(6); // visited is untouched by pruning
    expect(Object.keys(after.playerSummary).sort()).toEqual(['Blue Billywig', 'JW Player']);
    expect(after.uniquePlayers).toBe(2);
  });

  it('keeps the previous summary out of the batch it summarizes', async () => {
    const { summary } = await wrapUpBatch(BATCH_ID);
    const inBatch = (await listScans()).filter(s => s.batchId === BATCH_ID).map(s => s.filename);
    // The summary carries the batchId (so the dashboard groups it under its
    // batch), which is exactly why wrap-up must exclude it from its own inputs.
    expect(inBatch).toContain(summary);
    expect(readJson(summary).isSummary).toBe(true);

    // Plant a page that exists in no source scan. If the summary were fed back
    // in, this ghost would survive into the next summary and inflate the totals.
    const stale = readJson(summary);
    stale.details.push(detail('https://a.example/ghost', 'Video.js'));
    stale._state.visited.push('https://a.example/ghost');
    writeFileSync(join(dir, summary), JSON.stringify(stale, null, 2));

    const second = await wrapUpBatch(BATCH_ID);
    const after = totals(second.summary);
    expect(after.urls).not.toContain('https://a.example/ghost');
    expect(after.pagesWithVideo).toBe(5);
    expect(after.pagesScanned).toBe(6);
  });

  it('still fails when a batch has nothing but summaries', async () => {
    const { summary } = await wrapUpBatch(BATCH_ID);
    unlinkSync(join(dir, SCAN_A));
    unlinkSync(join(dir, SCAN_B));
    await expect(wrapUpBatch(BATCH_ID)).rejects.toThrow(/only summaries/);
    expect(existsSync(join(dir, summary))).toBe(true);
  });
});

describe('summarizeBatch', () => {
  it('refuses a summary as input', async () => {
    const { summary } = await wrapUpBatch(BATCH_ID);
    expect(() => summarizeBatch([SCAN_A, summary], BATCH_ID, BATCH_LABEL))
      .toThrow(/Refusing to summarize an existing summary/);
  });

  it('refuses an isSummary file that does not use the -summary.json suffix', () => {
    const renamed = 'videoscan-hand-renamed-2026-09-02T12-00-00.json';
    writeFileSync(join(dir, renamed), JSON.stringify({
      ...readJson(SCAN_A), isSummary: true,
    }));
    expect(() => summarizeBatch([renamed], BATCH_ID, BATCH_LABEL)).toThrow(/existing summary/);
  });
});
