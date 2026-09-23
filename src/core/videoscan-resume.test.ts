import { describe, it, expect } from 'vitest';
import { resumeBudget } from './videoscan-runner.js';

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
