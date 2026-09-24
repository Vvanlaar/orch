import type { TaskContext } from './types.js';

/**
 * A resumeFile is a checkpoint on one machine's disk, so a task carrying one must
 * run there: pin it to `machineId` unless it already has a pin. Without this any
 * machine sharing the queue could claim it and fail on a missing file.
 */
export function pinToCheckpointMachine(context: TaskContext, machineId: string): TaskContext {
  if (!context.resumeFile || context.targetMachineId) return context;
  return { ...context, targetMachineId: machineId };
}
