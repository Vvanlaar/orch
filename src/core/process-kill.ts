import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

/** True if a process with this PID exists on the host. False on falsy/invalid input. */
export function isPidAlive(pid: number | undefined | null): boolean {
  if (!pid || pid <= 0) return false;
  try {
    // signal 0 doesn't deliver — it just probes whether the PID is reachable
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Cross-platform force-kill of a process tree (Windows: taskkill /T /F; Unix: SIGKILL the pgid). */
export async function killProcessTree(pid: number): Promise<void> {
  if (!isPidAlive(pid)) return;
  if (process.platform === 'win32') {
    try { await execFileP('taskkill', ['/PID', String(pid), '/T', '/F']); } catch {}
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
}
