import { describe, it, expect } from 'vitest';
import { checkpointElsewhere, pinToCheckpointMachine, retryRefusal } from './task-pin.js';

describe('pinToCheckpointMachine', () => {
  it('pins a resume task to the machine that holds its checkpoint', () => {
    // laptop-2 restarted and created resume tasks #887–899 unpinned
    const ctx = pinToCheckpointMachine(
      { source: 'github', event: 'videoscan-resume', resumeFile: 'videoscans/videoscan-utrecht.nl-INPROGRESS.json' },
      'laptop-2',
    );
    expect(ctx.targetMachineId).toBe('laptop-2');
  });

  it('keeps an explicit pin', () => {
    const ctx = pinToCheckpointMachine({ source: 'github', event: 'videoscan-resume', resumeFile: 'x.json', targetMachineId: 'desktop' }, 'laptop-2');
    expect(ctx.targetMachineId).toBe('desktop');
  });

  it('leaves tasks without a checkpoint unpinned', () => {
    const ctx = pinToCheckpointMachine({ source: 'github', event: 'videoscan' }, 'laptop-2');
    expect(ctx.targetMachineId).toBeUndefined();
  });
});

describe('checkpointElsewhere', () => {
  const ctx = { source: 'github', event: 'videoscan' } as const;

  it('names the machine that ran the scan', () => {
    expect(checkpointElsewhere({ machineId: 'laptop-2', context: ctx }, 'desktop')).toBe('laptop-2');
  });

  it('names the pinned machine of a task paused before any claim', () => {
    expect(checkpointElsewhere({ context: { ...ctx, targetMachineId: 'laptop-2' } }, 'desktop')).toBe('laptop-2');
  });

  it('is null for this machine or an unclaimed, unpinned task', () => {
    expect(checkpointElsewhere({ machineId: 'desktop', context: ctx }, 'desktop')).toBeNull();
    expect(checkpointElsewhere({ context: ctx }, 'desktop')).toBeNull();
  });
});

describe('retryRefusal', () => {
  const resume = { source: 'github', event: 'videoscan-resume', resumeFile: 'v/x-INPROGRESS.json' } as const;

  it('refuses an unpinned resume task whose file is not here', () => {
    expect(retryRefusal(resume, () => false)).toContain('v/x-INPROGRESS.json is not on this machine');
  });

  it('allows it where the file is, or when pinned, or without a checkpoint', () => {
    expect(retryRefusal(resume, () => true)).toBeNull();
    expect(retryRefusal({ ...resume, targetMachineId: 'desktop' }, () => false)).toBeNull();
    expect(retryRefusal({ source: 'github', event: 'videoscan' }, () => false)).toBeNull();
  });
});
