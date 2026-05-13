import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

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
  // Verify — PID may take a beat to disappear on Windows after taskkill returns
  await new Promise((r) => setTimeout(r, 100));
  if (!isPidAlive(pid)) return { killed: true };
  return { killed: false, error: lastErr ?? 'process still alive after kill' };
}
