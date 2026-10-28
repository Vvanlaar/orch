// Stopping a running task: the stop route and a bb-core cancel go the same way.
import { killTask } from './claude-runner.js';
import { MACHINE_ID } from './db/client.js';
import { killStrayTaskProcess } from './task-processor.js';
import { failTask } from './task-queue.js';
import type { Task } from './types.js';
import { killVideoscan } from './videoscan-runner.js';

/**
 * Kills the task's process (when it runs here) and fails the row.
 * Returns the kill error when the process is still alive afterwards.
 */
export async function stopRunningTask(task: Task, by: string): Promise<string | undefined> {
  const isLocal = !task.machineId || task.machineId === MACHINE_ID;
  let killError: string | undefined;
  if (isLocal) {
    const killed = task.type === 'videoscan' ? killVideoscan(task.id) : killTask(task.id);
    // Fallback when typed-kill no-ops (process spawned by a prior server instance).
    if (!killed) killError = await killStrayTaskProcess(task);
  }
  const failReason = killError
    ? `Stop requested but process ${task.pid} still alive: ${killError}`
    : isLocal ? `Stopped by ${by}` : `Stopped by ${by} (was remote on ${task.machineId})`;
  await failTask(task.id, failReason);
  return killError;
}
