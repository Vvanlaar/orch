import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import os from 'os';
import { promisify } from 'util';

const execFileP = promisify(execFile);

export function isPidAlive(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    // signal 0 doesn't deliver — it just probes reachability
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ProcessInfo {
  /** null when the OS won't show it, e.g. another user's process. */
  commandLine: string | null;
  startedAtMs: number | null;
}

/** What a task's process must look like before we treat a live PID as that task's. */
export interface ExpectedProcess {
  /** Substrings its command line must all contain (case-insensitive). */
  markers: string[];
  /** The task's start: its process can't have been created before this. */
  notBeforeMs?: number;
}

export type ProcessIdentity = 'match' | 'mismatch' | 'gone' | 'unreadable';

// startedAt is written just before the spawn, from the same clock; this only absorbs rounding.
const START_SKEW_MS = 5_000;
const BOOT_CLOCK_MARGIN_MS = 10 * 60_000;

/** Pure check of a process against what the task's process must look like. `info` null = no such process. */
export function matchProcessIdentity(info: ProcessInfo | null, expected: ExpectedProcess): ProcessIdentity {
  if (!info) return 'gone';
  // Hidden command line: another user's or an elevated process, e.g. a scan of an instance
  // that runs elevated. It can't be told apart from the task's own process.
  if (info.commandLine === null) return 'unreadable';
  if (expected.notBeforeMs !== undefined && info.startedAtMs !== null && info.startedAtMs < expected.notBeforeMs - START_SKEW_MS) {
    return 'mismatch';
  }
  const cmd = info.commandLine.toLowerCase();
  return expected.markers.length > 0 && expected.markers.every(m => cmd.includes(m.toLowerCase())) ? 'match' : 'mismatch';
}

/**
 * Command line (and on Windows creation time) per live PID; a PID absent from the map has
 * no process. Throws when the query fails.
 */
export async function getProcessInfos(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const infos = new Map<number, ProcessInfo>();
  const valid = [...new Set(pids)].filter(p => Number.isInteger(p) && p > 0);
  if (!valid.length) return infos;

  if (process.platform === 'win32') {
    const filter = valid.map(p => `ProcessId=${p}`).join(' OR ');
    // CIM errors are non-terminating by default: the script would still print [] and exit 0,
    // which reads as "every PID gone".
    const script = `$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { @{ pid = $_.ProcessId; cmd = $_.CommandLine; created = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } } })`;
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 });
    const rows = JSON.parse(stdout.trim() || '[]') as { pid: number; cmd: string | null; created: string | null }[];
    for (const r of rows) {
      const started = r.created ? Date.parse(r.created) : NaN;
      infos.set(r.pid, { commandLine: r.cmd ?? null, startedAtMs: Number.isNaN(started) ? null : started });
    }
    return infos;
  }

  for (const pid of valid) {
    if (!isPidAlive(pid)) continue;
    let commandLine: string | null = null;
    try {
      commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    } catch {
      // No procfs (macOS): ps prints nothing and exits 1 for a missing PID.
      try {
        commandLine = (await execFileP('ps', ['-p', String(pid), '-o', 'args='])).stdout.trim() || null;
      } catch {
        if (!isPidAlive(pid)) continue;
        throw new Error(`cannot read command line of PID ${pid}`);
      }
    }
    infos.set(pid, { commandLine, startedAtMs: null });
  }
  return infos;
}

export type IdentityCheck = { identity: Exclude<ProcessIdentity, 'unreadable'> } | { identity: 'unknown'; error: string };

/**
 * Whether `pid` is still the task's process. A PID recorded before a reboot or restart
 * can since belong to an unrelated program. 'unknown' when the process table or the
 * process's command line can't be read.
 */
export async function verifyProcessIdentity(pid: number, expected: ExpectedProcess): Promise<IdentityCheck> {
  // A task started before the last boot has no surviving process: whatever holds the PID
  // now isn't it. Decided without a process-table query, which may not work early at boot.
  // The margin absorbs a clock step after boot, which shifts the computed boot time.
  if (expected.notBeforeMs !== undefined && expected.notBeforeMs < Date.now() - os.uptime() * 1000 - BOOT_CLOCK_MARGIN_MS) {
    return { identity: isPidAlive(pid) ? 'mismatch' : 'gone' };
  }
  try {
    const identity = matchProcessIdentity((await getProcessInfos([pid])).get(pid) ?? null, expected);
    return identity === 'unreadable' ? { identity: 'unknown', error: `command line of PID ${pid} is not readable` } : { identity };
  } catch (err) {
    return { identity: 'unknown', error: err instanceof Error ? err.message : String(err) };
  }
}

export type KillResult = { killed: boolean; error?: string };
export async function killProcessTree(pid: number): Promise<KillResult> {
  if (!isPidAlive(pid)) return { killed: true };
  let lastErr: string | undefined;
  if (process.platform === 'win32') {
    try {
      await execFileP('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (e1) {
      lastErr = e1 instanceof Error ? e1.message : String(e1);
      try {
        process.kill(pid, 'SIGKILL');
        lastErr = undefined;
      } catch (e2) {
        lastErr = e2 instanceof Error ? e2.message : String(e2);
      }
    }
  }
  // taskkill on Windows can return before the PID is actually gone
  await new Promise((r) => setTimeout(r, 100));
  if (!isPidAlive(pid)) return { killed: true };
  return { killed: false, error: lastErr ?? 'process still alive after kill' };
}
