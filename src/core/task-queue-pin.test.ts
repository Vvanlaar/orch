import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, TaskContext } from './types.js';

vi.mock('./db/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/client.js')>()),
  isSupabaseConfigured: () => true,
  MACHINE_ID: 'laptop-2',
}));

const dbCreateTask = vi.fn(async (type: Task['type'], repo: string, repoPath: string, context: TaskContext) =>
  ({ id: 900, type, repo, repoPath, context, status: 'pending', createdAt: '' }) as Task);
const dbGetTask = vi.fn();

vi.mock('./db/tasks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db/tasks.js')>()),
  dbCreateTask: (...args: Parameters<typeof dbCreateTask>) => dbCreateTask(...args),
  dbGetTask: (id: number) => dbGetTask(id),
}));

const { createTask, retryTask } = await import('./task-queue.js');

const resumeCtx: TaskContext = {
  source: 'github',
  event: 'videoscan-resume',
  scanUrl: 'https://www.utrecht.nl',
  resumeFile: 'videoscans/videoscan-utrecht.nl-INPROGRESS.json',
};

describe('checkpoint pinning in the task queue', () => {
  beforeEach(() => {
    dbCreateTask.mockClear();
    dbGetTask.mockReset();
  });

  it('createTask pins a resume task to this machine', async () => {
    const task = await createTask('videoscan', 'https://www.utrecht.nl', 'videoscans', resumeCtx);
    expect(task.context.targetMachineId).toBe('laptop-2');
  });

  it('createTask leaves a fresh scan claimable by any machine', async () => {
    const task = await createTask('videoscan', 'https://www.utrecht.nl', 'videoscans', { source: 'github', event: 'videoscan', scanUrl: 'https://www.utrecht.nl' });
    expect(task.context.targetMachineId).toBeUndefined();
  });

  it('retryTask keeps the pin of the task it retries', async () => {
    dbGetTask.mockResolvedValue({ id: 887, type: 'videoscan', status: 'failed', repo: 'x', repoPath: 'videoscans', context: { ...resumeCtx, targetMachineId: 'desktop' }, machineId: 'desktop', createdAt: '' } as Task);
    const task = await retryTask(887);
    expect(task?.context.targetMachineId).toBe('desktop');
  });

  it('retryTask pins an unpinned resume task to this machine', async () => {
    dbGetTask.mockResolvedValue({ id: 886, type: 'videoscan', status: 'failed', repo: 'x', repoPath: 'videoscans', context: resumeCtx, createdAt: '' } as Task);
    const task = await retryTask(886);
    expect(task?.context.targetMachineId).toBe('laptop-2');
  });
});
