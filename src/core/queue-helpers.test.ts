import { describe, it, expect, vi } from 'vitest';
import { createStaleTracker, decideDeadScan, freeSlots, singleFlight, withRetry, type ScanFileInfo } from './queue-helpers.js';

const STARTED = Date.parse('2026-09-24T10:00:00Z');
const file = (name: string, mtimeMs: number, checkpoint = false): ScanFileInfo => ({ name, mtimeMs, checkpoint });
const crawl = { startedAtMs: STARTED, crawlMode: true };

describe('decideDeadScan', () => {
  it('completes a scan whose final report was written during this run', () => {
    const latest = file('videoscan-utrecht.nl-2026-09-24T12-00-00.json', STARTED + 3_600_000);
    expect(decideDeadScan({ ...crawl, latest })).toEqual({ action: 'complete', file: latest.name });
  });

  it('resumes from the checkpoint of a scan that died mid-crawl', () => {
    const latest = file('videoscan-utrecht.nl-INPROGRESS.json', STARTED + 60_000, true);
    expect(decideDeadScan({ ...crawl, latest })).toEqual({ action: 'resume', file: latest.name });
  });

  it('completes a finished report that kept the INPROGRESS name of the checkpoint it resumed', () => {
    const latest = file('videoscan-utrecht.nl-INPROGRESS.json', STARTED + 60_000, false);
    expect(decideDeadScan({ ...crawl, latest }).action).toBe('complete');
  });

  it('fails when the newest report predates this run', () => {
    const latest = file('videoscan-utrecht.nl-2026-09-01T08-00-00.json', STARTED - 1);
    expect(decideDeadScan({ ...crawl, latest })).toEqual({ action: 'fail', reason: 'no report from this run' });
  });

  it('fails without a readable scan file', () => {
    expect(decideDeadScan({ ...crawl, latest: null }).action).toBe('fail');
  });

  it('fails when the start time is unknown, as the report cannot be tied to this run', () => {
    const latest = file('videoscan-utrecht.nl-2026-09-24T12-00-00.json', STARTED);
    expect(decideDeadScan({ ...crawl, startedAtMs: null, latest }).action).toBe('fail');
  });

  it('does not resume an explicit-URL scan', () => {
    const latest = file('videoscan-utrecht.nl-INPROGRESS.json', STARTED + 1, true);
    expect(decideDeadScan({ ...crawl, crawlMode: false, latest }).action).toBe('fail');
  });

  it('fails a scan whose merge into a target file never ran', () => {
    const latest = file('videoscan-utrecht.nl-2026-09-24T12-00-00.json', STARTED + 1);
    expect(decideDeadScan({ ...crawl, mergeTarget: 'videoscan-utrecht.nl-2026-09-01T08-00-00.json', latest }).action).toBe('fail');
  });

  it('completes a scan whose merge into the target file ran before the status write was lost', () => {
    const target = 'videoscan-utrecht.nl-2026-09-01T08-00-00.json';
    const latest = file(target, STARTED + 1);
    expect(decideDeadScan({ ...crawl, crawlMode: false, mergeTarget: target, latest })).toEqual({ action: 'complete', file: target });
  });

  it('counts a report written in the same millisecond the run started', () => {
    const latest = file('videoscan-utrecht.nl-2026-09-24T10-00-00.json', STARTED);
    expect(decideDeadScan({ ...crawl, latest }).action).toBe('complete');
  });

  it('fails on an unparseable start time instead of accepting any report', () => {
    const latest = file('videoscan-utrecht.nl-2026-09-01T08-00-00.json', STARTED - 86_400_000);
    expect(decideDeadScan({ ...crawl, startedAtMs: Date.parse('not a date'), latest }).action).toBe('fail');
  });
});

describe('freeSlots', () => {
  it('subtracts running rows', () => {
    expect(freeSlots(10, [1, 2, 3], [])).toBe(7);
  });

  it('counts claims not yet visible in the DB read', () => {
    expect(freeSlots(10, [1, 2], [3, 4])).toBe(6);
  });

  it('counts a task that is both running and in flight once', () => {
    expect(freeSlots(10, [1, 2, 3], [2, 3])).toBe(7);
  });

  it('goes negative when over the limit', () => {
    expect(freeSlots(2, [1, 2, 3], [])).toBe(-1);
  });
});

describe('singleFlight', () => {
  it('never overlaps runs and folds concurrent calls into one rerun', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    let release!: () => void;
    const fn = vi.fn(async () => {
      runs++;
      active++;
      maxActive = Math.max(maxActive, active);
      if (runs === 1) await new Promise<void>((r) => { release = r; });
      active--;
    });
    const run = singleFlight(fn);

    const first = run();
    const second = run();
    const third = run();
    release();
    await Promise.all([first, second, third]);

    expect(maxActive).toBe(1);
    expect(runs).toBe(2);
  });

  it('starts a fresh run once the previous one settled', async () => {
    const fn = vi.fn(async () => {});
    const run = singleFlight(fn);
    await run();
    await run();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('frees itself after a failed run', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    const run = singleFlight(fn);
    await expect(run()).rejects.toThrow('db down');
    await expect(run()).resolves.toBeUndefined();
  });
});

describe('withRetry', () => {
  const noWait = () => Promise.resolve();

  it('retries until the call succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('521')).mockResolvedValue('ok');
    const onRetry = vi.fn();
    await expect(withRetry(fn, [1, 1], onRetry, noWait)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, 1);
  });

  it('rethrows the last error once the delays run out', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(withRetry(fn, [1, 1], undefined, noWait)).rejects.toThrow('timeout');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('createStaleTracker', () => {
  it('reports an id only once it has been dead for the whole window', () => {
    const tracker = createStaleTracker(300_000);
    expect(tracker.update([7], 0)).toEqual([]);
    expect(tracker.update([7], 299_999)).toEqual([]);
    expect(tracker.update([7], 300_000)).toEqual([7]);
  });

  it('restarts the window for an id that was seen alive in between', () => {
    const tracker = createStaleTracker(300_000);
    tracker.update([7], 0);
    tracker.update([], 100_000);
    expect(tracker.update([7], 300_000)).toEqual([]);
    expect(tracker.update([7], 600_000)).toEqual([7]);
  });

  it('tracks ids independently', () => {
    const tracker = createStaleTracker(10);
    tracker.update([1], 0);
    expect(tracker.update([1, 2], 10)).toEqual([1]);
  });
});
