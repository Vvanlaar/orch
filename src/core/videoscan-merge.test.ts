import { describe, it, expect } from 'vitest';
import { mergeScansData, isDerivedScan } from './videoscan-runner.js';

// Minimal scan shaped like the JSON scan.mjs writes.
function scan(over: Partial<Parameters<typeof mergeScansData>[0][number]> = {}) {
  return {
    domain: 'example.nl',
    scanDate: '2026-09-15T10:00:00.000Z',
    pagesScanned: 1,
    pagesWithVideo: 0,
    uniquePlayers: 0,
    playerSummary: {},
    details: [],
    _state: { visited: ['https://example.nl/a'], queue: [] },
    ...over,
  } as Parameters<typeof mergeScansData>[0][number];
}

describe('isDerivedScan', () => {
  it('flags merges and batch summaries', () => {
    expect(isDerivedScan('videoscan-krimpenerwaard-2026-09-16T06-11-14-344-merged.json')).toBe(true);
    expect(isDerivedScan('videoscan-digi-import-burgerzaken-2026-09-03T09-55-31-103-summary.json')).toBe(true);
  });

  it('leaves a real crawl resumable', () => {
    expect(isDerivedScan('videoscan-trefhetinoss.nl-2026-09-02T11-25-39.json')).toBe(false);
    // "-merged"/"-summary" only count as the filename suffix, not anywhere in it.
    expect(isDerivedScan('videoscan-merged-sites.nl-2026-09-02T11-25-39.json')).toBe(false);
  });
});

describe('mergeScansData', () => {
  it('carries the batch through when every source agrees', () => {
    const merged = mergeScansData([
      scan({ batchId: 'digi-krimpenerwaard-1', batchLabel: 'Digi import — krimpenerwaard' }),
      scan({ batchId: 'digi-krimpenerwaard-1', batchLabel: 'Digi import — krimpenerwaard' }),
    ]);
    expect(merged.batchId).toBe('digi-krimpenerwaard-1');
    expect(merged.batchLabel).toBe('Digi import — krimpenerwaard');
  });

  it('recovers the label from whichever source carries it', () => {
    const merged = mergeScansData([
      scan({ batchId: 'digi-krimpenerwaard-1' }),
      scan({ batchId: 'digi-krimpenerwaard-1', batchLabel: 'Digi import — krimpenerwaard' }),
    ]);
    expect(merged.batchLabel).toBe('Digi import — krimpenerwaard');
  });

  it('picks no batch when sources disagree, rather than guessing', () => {
    const merged = mergeScansData([
      scan({ batchId: 'digi-a-1' }),
      scan({ batchId: 'digi-b-2' }),
    ]);
    expect(merged.batchId).toBeUndefined();
    expect(merged.batchLabel).toBeUndefined();
  });

  it('propagates the batch when only some sources carry one', () => {
    // The targetFilename merge path: a fresh unbatched scan folded into a
    // batched target. Dropping the batch here would strand the result.
    const merged = mergeScansData([
      scan({ batchId: 'digi-krimpenerwaard-1', batchLabel: 'Digi import' }),
      scan(),
    ]);
    expect(merged.batchId).toBe('digi-krimpenerwaard-1');
    expect(merged.batchLabel).toBe('Digi import');
  });

  it('leaves the batch unset for sources that never had one', () => {
    const merged = mergeScansData([scan(), scan()]);
    expect(merged.batchId).toBeUndefined();
  });

  it('still unions visited and drops already-visited URLs from the queue', () => {
    const merged = mergeScansData([
      scan({ _state: { visited: ['https://example.nl/a'], queue: ['https://example.nl/b'] } }),
      scan({ _state: { visited: ['https://example.nl/b'], queue: ['https://example.nl/c'] } }),
    ]);
    expect(merged._state.visited.sort()).toEqual(['https://example.nl/a', 'https://example.nl/b']);
    expect(merged._state.queue).toEqual(['https://example.nl/c']);
  });
});
