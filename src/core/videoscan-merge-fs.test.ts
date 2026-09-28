import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// VIDEOSCAN_DIR is read when the runner loads, so point it at a temp dir first.
const dir = mkdtempSync(join(tmpdir(), 'orch-merge-'));
process.env.VIDEOSCAN_DIR = dir;
const { mergeScans } = await import('./videoscan-runner.js');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VIDEOSCAN_DIR;
});

function scan(filename: string, domain: string, scanDate: string, url: string) {
  writeFileSync(join(dir, filename), JSON.stringify({
    domain, scanDate, pagesScanned: 1, pagesWithVideo: 1, uniquePlayers: 1,
    playerSummary: {}, details: [{ url, players: [{ name: 'YouTube', evidence: [] }] }],
    _state: { visited: [url], queue: [] },
  }));
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
});
