import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// VIDEOSCAN_DIR is read when the runner loads, so point it at a temp dir first.
const dir = mkdtempSync(join(tmpdir(), 'orch-merge-'));
process.env.VIDEOSCAN_DIR = dir;
const { mergeScans, summarizeBatch, finalizeScan } = await import('./videoscan-runner.js');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VIDEOSCAN_DIR;
});

function scan(filename: string, domain: string, scanDate: string, url: string, extra: Record<string, unknown> = {}) {
  writeFileSync(join(dir, filename), JSON.stringify({
    domain, scanDate, pagesScanned: 1, pagesWithVideo: 1, uniquePlayers: 1,
    playerSummary: {}, details: [{ url, players: [{ name: 'YouTube', evidence: [] }] }],
    _state: { visited: [url], queue: [] },
    ...extra,
  }));
}

function stored(filename: string) {
  return JSON.parse(readFileSync(join(dir, filename), 'utf-8'));
}

describe('mergeScans', () => {
  it('does not archive its own output when a source merge already has the name', () => {
    // Wrap-up re-merging a batch-stamped merge with an older same-domain scan:
    // the merge is the newest source, so its name is the one mergeScans builds.
    scan('videoscan-x.nl-2026-01-01T00-00-00.json', 'x.nl', '2026-01-01T00:00:00.000Z', 'https://x.nl/a');
    const prior = 'videoscan-x.nl-2026-01-02T00-00-00-000-merged.json';
    scan(prior, 'x.nl', '2026-01-02T00:00:00.000Z', 'https://x.nl/b');

    const { filename } = mergeScans(['videoscan-x.nl-2026-01-01T00-00-00.json', prior]);

    expect(filename).not.toBe(prior);
    expect(existsSync(join(dir, filename))).toBe(true);
    expect(existsSync(join(dir, 'archived', prior))).toBe(true);
  });

  it('keeps a label out of the path', () => {
    scan('videoscan-a.nl-2026-02-01T00-00-00.json', 'a.nl', '2026-02-01T00:00:00.000Z', 'https://a.nl/');
    scan('videoscan-b.nl-2026-02-01T00-00-00.json', 'b.nl', '2026-02-01T00:00:00.000Z', 'https://b.nl/');

    const { filename } = mergeScans(['videoscan-a.nl-2026-02-01T00-00-00.json', 'videoscan-b.nl-2026-02-01T00-00-00.json'], '../../evil label');

    expect(filename).not.toMatch(/[\\/ ]|\.\./);
    expect(existsSync(join(dir, filename))).toBe(true);
  });

  it('writes queueCapped into the merged file when a source had it', () => {
    scan('videoscan-c.nl-2026-03-01T00-00-00.json', 'c.nl', '2026-03-01T00:00:00.000Z', 'https://c.nl/a', { queueCapped: true });
    scan('videoscan-c.nl-2026-03-02T00-00-00.json', 'c.nl', '2026-03-02T00:00:00.000Z', 'https://c.nl/b');

    const { filename } = mergeScans(['videoscan-c.nl-2026-03-01T00-00-00.json', 'videoscan-c.nl-2026-03-02T00-00-00.json']);

    expect(stored(filename).queueCapped).toBe(true);
  });
});

describe('queueCapped through wrap-up', () => {
  it('survives finalizeScan, which rewrites the file to clear the queue', () => {
    // The case the flag exists for: once the queue is cleared, nothing else in
    // the file says the crawl stopped short.
    const name = 'videoscan-d.nl-2026-04-01T00-00-00.json';
    scan(name, 'd.nl', '2026-04-01T00:00:00.000Z', 'https://d.nl/', {
      queueCapped: true,
      _state: { visited: ['https://d.nl/'], queue: ['https://d.nl/agenda?page=2'] },
    });

    expect(finalizeScan(name)).toBe(true);

    expect(stored(name)._state.queue).toEqual([]);
    expect(stored(name).queueCapped).toBe(true);
  });

  it('marks a batch summary when one of its scans was capped', () => {
    scan('videoscan-e.nl-2026-05-01T00-00-00.json', 'e.nl', '2026-05-01T00:00:00.000Z', 'https://e.nl/', { queueCapped: true });
    scan('videoscan-f.nl-2026-05-01T00-00-00.json', 'f.nl', '2026-05-01T00:00:00.000Z', 'https://f.nl/');

    const capped = summarizeBatch(['videoscan-e.nl-2026-05-01T00-00-00.json', 'videoscan-f.nl-2026-05-01T00-00-00.json'], 'batch-1', 'Batch one');
    expect(stored(capped.filename).queueCapped).toBe(true);

    const clean = summarizeBatch(['videoscan-f.nl-2026-05-01T00-00-00.json'], 'batch-2', 'Batch two');
    expect('queueCapped' in stored(clean.filename)).toBe(false);
  });
});
