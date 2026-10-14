import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { scanRow } from './videoscan-row.js';

const dir = mkdtempSync(join(tmpdir(), 'orch-scan-row-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('scanRow', () => {
  it('builds the stored row of a crawl', () => {
    const name = 'videoscan-x.nl-2026-07-01T00-00-00.json';
    writeFileSync(join(dir, name.replace('.json', '.html')), '');
    writeFileSync(join(dir, name.replace('.json', '-preview.html')), '');
    const row = scanRow({
      domain: 'x.nl', scanDate: '2026-07-01T00:00:00.000Z', pagesScanned: 3,
      details: [{ url: 'https://x.nl/a', players: [] }], playerSummary: { YouTube: {} },
      _state: { visited: ['https://x.nl/'], queue: ['https://x.nl/b'] },
      queueCapped: true, batchId: 'b1', batchLabel: 'Batch',
    }, name, dir);

    expect(row).toMatchObject({
      filename: name, domain: 'x.nl', pagesScanned: 3, pagesWithVideo: 1, uniquePlayers: 1,
      hasReport: true, hasPdf: false, hasPreview: true, hasPreviewPdf: false,
      canResume: true, queueCapped: true, queueCleared: false, batchId: 'b1', batchLabel: 'Batch',
    });
  });

  it('never calls a merge resumable, whatever its queue', () => {
    // The migrate script's own copy did: a merge's queue is a union no run owns
    const row = scanRow({ domain: 'x.nl', _state: { queue: ['https://x.nl/b'] } }, 'videoscan-x.nl-2026-07-02-merged.json', dir);
    expect(row.canResume).toBe(false);
    expect(row.batchId).toBeUndefined();
  });
});
