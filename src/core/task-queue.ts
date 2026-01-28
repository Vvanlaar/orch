import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { Task, TaskStatus, TaskType, TaskContext } from './types.js';

const DB_FILE = 'orch-tasks.json';

interface DB {
  nextId: number;
  tasks: Task[];
}

function loadDb(): DB {
  if (!existsSync(DB_FILE)) {
    return { nextId: 1, tasks: [] };
  }
  try {
    return JSON.parse(readFileSync(DB_FILE, 'utf-8'));
  } catch {
    return { nextId: 1, tasks: [] };
  }
}

function saveDb(db: DB): void {
  writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

export function createTask(
  type: TaskType,
  repo: string,
  repoPath: string,
  context: TaskContext
): Task {
  const db = loadDb();
  const task: Task = {
    id: db.nextId++,
    type,
    status: 'pending',
    repo,
    repoPath,
    context,
    createdAt: new Date().toISOString(),
  };
  db.tasks.push(task);
  saveDb(db);
  return task;
}

export function getTask(id: number): Task | undefined {
  const db = loadDb();
  return db.tasks.find((t) => t.id === id);
}

export function getPendingTasks(limit = 10): Task[] {
  const db = loadDb();
  return db.tasks
    .filter((t) => t.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
}

export function getRunningCount(): number {
  const db = loadDb();
  return db.tasks.filter((t) => t.status === 'running').length;
}

export function getAllTasks(limit = 50): Task[] {
  const db = loadDb();
  return db.tasks
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

function updateTask(id: number, updates: Partial<Task>): void {
  const db = loadDb();
  const idx = db.tasks.findIndex((t) => t.id === id);
  if (idx !== -1) {
    db.tasks[idx] = { ...db.tasks[idx], ...updates };
    saveDb(db);
  }
}

export function startTask(id: number): void {
  updateTask(id, { status: 'running', startedAt: new Date().toISOString() });
}

export function completeTask(id: number, result: string): void {
  const output = streamingOutputs.get(id);
  streamingOutputs.delete(id);
  updateTask(id, { status: 'completed', result, output, pid: undefined, completedAt: new Date().toISOString() });
}

export function failTask(id: number, error: string): void {
  const output = streamingOutputs.get(id);
  streamingOutputs.delete(id);
  updateTask(id, { status: 'failed', error, output, pid: undefined, completedAt: new Date().toISOString() });
}

export function updateTaskPid(id: number, pid: number | undefined): void {
  updateTask(id, { pid });
}

export function updateTaskStatus(id: number, status: TaskStatus): void {
  const updates: Partial<Task> = { status };
  if (status === 'running') {
    updates.startedAt = new Date().toISOString();
  }
  updateTask(id, updates);
}

export function deleteTask(id: number): boolean {
  const db = loadDb();
  const idx = db.tasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  const task = db.tasks[idx];
  // Only allow deleting non-running tasks
  if (task.status === 'running') return false;
  db.tasks.splice(idx, 1);
  saveDb(db);
  return true;
}

// In-memory streaming output (not persisted to disk for performance)
const streamingOutputs = new Map<number, string>();
const MAX_STREAMING_OUTPUT = 100 * 1024; // 100KB cap

export function appendStreamingOutput(id: number, chunk: string): void {
  let current = streamingOutputs.get(id) || '';
  current += chunk;
  // Truncate from beginning if too large
  if (current.length > MAX_STREAMING_OUTPUT) {
    current = '...[truncated]...\n' + current.slice(-MAX_STREAMING_OUTPUT + 20);
  }
  streamingOutputs.set(id, current);
}

export function getStreamingOutput(id: number): string {
  return streamingOutputs.get(id) || '';
}

export function clearStreamingOutput(id: number): void {
  streamingOutputs.delete(id);
}

// Get tasks with streaming output merged in (live output or persisted fallback)
export function getAllTasksWithOutput(limit = 50): Task[] {
  const tasks = getAllTasks(limit);
  return tasks.map(t => ({
    ...t,
    streamingOutput: streamingOutputs.get(t.id) || t.output,
  }));
}

// Get running tasks that have PIDs (for process management)
export function getTasksWithPids(): Task[] {
  const db = loadDb();
  return db.tasks.filter(t => t.status === 'running' && t.pid);
}

// Create retry task from failed task
export function retryTask(failedTaskId: number): Task | null {
  const failedTask = getTask(failedTaskId);
  if (!failedTask || failedTask.status !== 'failed') return null;

  return createTask(failedTask.type, failedTask.repo, failedTask.repoPath, {
    ...failedTask.context,
    retryOfTaskId: failedTaskId,
    retryError: failedTask.error || 'Unknown error',
    retryCount: (failedTask.context.retryCount || 0) + 1,
  });
}
