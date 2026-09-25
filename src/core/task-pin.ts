import type { Task, TaskContext } from './types.js';

/**
 * A resumeFile is a checkpoint on one machine's disk, so a task carrying one must
 * run there: pin it to `machineId` unless it already has a pin. Without this any
 * machine sharing the queue could claim it and fail on a missing file.
 */
export function pinToCheckpointMachine(context: TaskContext, machineId: string): TaskContext {
  if (!context.resumeFile || context.targetMachineId) return context;
  return { ...context, targetMachineId: machineId };
}

/**
 * The other machine that holds a paused task's checkpoint, or null when it may be here:
 * the machine that ran the scan, else the one the task is pinned to.
 */
export function checkpointElsewhere(task: Pick<Task, 'machineId' | 'context'>, machineId: string): string | null {
  const owner = task.machineId || task.context.targetMachineId;
  return owner && owner !== machineId ? owner : null;
}

/**
 * Why a failed task can't be retried here, or null. createTask pins a task with a
 * checkpoint to the creating machine, so an unpinned one (created before pinning, or
 * unpinned by hand) is retried only where its checkpoint is.
 */
export function retryRefusal(context: TaskContext, fileExists: (path: string) => boolean): string | null {
  const { resumeFile, targetMachineId } = context;
  if (!resumeFile || targetMachineId || fileExists(resumeFile)) return null;
  return `Resume file ${resumeFile} is not on this machine; retry from the machine that has it`;
}
