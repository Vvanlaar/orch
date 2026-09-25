import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { getProcessInfos, matchProcessIdentity, verifyProcessIdentity } from './process-kill.js';

const STARTED = Date.parse('2026-09-24T10:00:00Z');
const scan = { markers: ['scan.mjs', '_control-676.json'], notBeforeMs: STARTED };
const scanCmd = String.raw`C:\node\node.exe C:\dev\orch\src\videoscan\scan.mjs https://utrecht.nl --control-file C:\dev\orch\videoscan\_control-676.json`;

describe('matchProcessIdentity', () => {
  it('matches the task\'s own scan.mjs', () => {
    expect(matchProcessIdentity({ commandLine: scanCmd, startedAtMs: STARTED + 1_000 }, scan)).toBe('match');
  });

  it('matches case-insensitively', () => {
    expect(matchProcessIdentity({ commandLine: scanCmd.toUpperCase(), startedAtMs: null }, scan)).toBe('match');
  });

  it('rejects an unrelated program that reused the PID', () => {
    expect(matchProcessIdentity({ commandLine: String.raw`C:\Program Files\Other\app.exe`, startedAtMs: STARTED + 1_000 }, scan)).toBe('mismatch');
  });

  it('rejects another task\'s scan.mjs', () => {
    const other = scanCmd.replace('_control-676', '_control-677');
    expect(matchProcessIdentity({ commandLine: other, startedAtMs: STARTED + 1_000 }, scan)).toBe('mismatch');
  });

  it('rejects a process created before the task started', () => {
    expect(matchProcessIdentity({ commandLine: scanCmd, startedAtMs: STARTED - 60_000 }, scan)).toBe('mismatch');
  });

  it('rejects a process whose command line is hidden (another user\'s)', () => {
    expect(matchProcessIdentity({ commandLine: null, startedAtMs: STARTED + 1_000 }, scan)).toBe('mismatch');
  });

  it('reports a missing process as gone', () => {
    expect(matchProcessIdentity(null, scan)).toBe('gone');
  });
});

describe('verifyProcessIdentity (real process table)', () => {
  const self = { markers: [path.basename(process.execPath)] };

  it('reads this process', async () => {
    const info = (await getProcessInfos([process.pid])).get(process.pid);
    expect(info?.commandLine).toBeTruthy();
    expect(await verifyProcessIdentity(process.pid, self)).toEqual({ identity: 'match' });
    expect(await verifyProcessIdentity(process.pid, { markers: ['scan.mjs', '_control-676.json'] })).toEqual({ identity: 'mismatch' });
  }, 30_000);

  it('rejects any live process for a task started before the last boot, without querying', async () => {
    expect(await verifyProcessIdentity(process.pid, { ...self, notBeforeMs: 0 })).toEqual({ identity: 'mismatch' });
  });

  it('reports an exited process as gone', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.on('exit', r));
    expect(await verifyProcessIdentity(child.pid!, self)).toEqual({ identity: 'gone' });
  }, 30_000);
});
