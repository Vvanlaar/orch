import { describe, it, expect } from 'vitest';
import { pinToCheckpointMachine } from './task-pin.js';

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
