import { describe, it, expect } from 'vitest';
import { resumeBudget, scanIsFromRun } from './videoscan-runner.js';

describe('resumeBudget', () => {
  it('asks only for the pages left of the original target', () => {
    // Utrecht: maxPages 3000, 2288 scanned when the server restarted
    expect(resumeBudget({ maxPages: 3000 }, 2288)).toEqual({ maxPages: 712, targetPages: 3000 });
  });

  it('keeps the target across a second restart of the auto-resumed task', () => {
    const first = resumeBudget({ maxPages: 3000 }, 2288);
    const second = resumeBudget({ ...first, event: 'videoscan-resume' }, 2900);
    expect(second).toEqual({ maxPages: 100, targetPages: 3000 });
  });

  it('still resumes a scan that already reached its target', () => {
    expect(resumeBudget({ maxPages: 1000 }, 1000).maxPages).toBe(1);
  });

  it('leaves a manual resume as it was: its target is unknown', () => {
    expect(resumeBudget({ maxPages: 500, event: 'videoscan-resume' }, 4000)).toEqual({ maxPages: 500 });
  });

  it('falls back to maxPages when the scan file is unreadable', () => {
    expect(resumeBudget({ maxPages: 3000 }, null)).toEqual({ maxPages: 3000 });
  });
});

describe('scanIsFromRun', () => {
  const startedAt = '2026-09-24T10:00:00.000Z';

  it('accepts the checkpoint or paused report this run wrote', () => {
    expect(scanIsFromRun('videoscan-utrecht.nl-INPROGRESS.json', '2026-09-24T10:30:00.000Z', startedAt)).toBe(true);
    // Supabase returns started_at with an offset instead of Z
    expect(scanIsFromRun('videoscan-utrecht.nl-2026-09-24T10-30-00.json', '2026-09-24T10:30:00.000Z', '2026-09-24T10:00:00+00:00')).toBe(true);
  });

  it('rejects the finished report of an earlier scan', () => {
    expect(scanIsFromRun('videoscan-utrecht.nl-2026-08-01T09-00-00.json', '2026-08-01T09:40:00.000Z', startedAt)).toBe(false);
  });

  it('rejects merged and summary files, and a JSON without a scanDate', () => {
    expect(scanIsFromRun('videoscan-utrecht.nl-2026-09-24-merged.json', '2026-09-24T11:00:00.000Z', startedAt)).toBe(false);
    expect(scanIsFromRun('videoscan-batch-summary.json', '2026-09-24T11:00:00.000Z', startedAt)).toBe(false);
    expect(scanIsFromRun('videoscan-utrecht.nl-INPROGRESS.json', undefined, startedAt)).toBe(false);
  });
});
