import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { Task, TaskStatus, TaskType, TaskContext } from './types.js';
import { isSupabaseConfigured, MACHINE_ID } from './db/client.js';
import {
  dbCreateTask,
  dbGetTask,
  dbGetPendingTasks,
  dbGetRunningCount,
  dbGetAllTasks,
  dbStartTask,
  dbCompleteTask,
  dbFailTask,
  dbUpdateTaskPid,
  dbUpdateTaskStatus,
  dbUpdateTaskRepoPath,
  dbDeleteTask,
  dbGetTasksWithPids,
  dbGetPendingSuggestions,
  dbApproveSuggestion,
  dbDismissSuggestion,
  dbClaimTask,
  dbGetTasksByBatchId,
  dbUpdateTask,
} from './db/tasks.js';
import { createLogger } from './logger.js';

const log = createLogger('task-queue');

// ── JSON file fallback (when Supabase not configured) ──

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

function jsonCreateTask(type: TaskType, repo: string, repoPath: string, context: TaskContext, status: TaskStatus = 'pending'): Task {
  const db = loadDb();
  const task: Task = {
    id: db.nextId++,
    type,
    status,
    repo,
    repoPath,
    context,
    createdAt: new Date().toISOString(),
  };
  db.tasks.push(task);
  saveDb(db);
  return task;
}

function jsonGetTask(id: number): Task | undefined {
  return loadDb().tasks.find((t) => t.id === id);
}

function jsonGetPendingTasks(limit = 10): Task[] {
  return loadDb().tasks
    .filter((t) => t.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit);
}

function jsonGetRunningCount(): number {
  return loadDb().tasks.filter((t) => t.status === 'running').length;
}

function jsonGetAllTasks(limit = 50): Task[] {
  return loadDb().tasks
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

function jsonUpdateTask(id: number, updates: Partial<Task>): void {
  const db = loadDb();
  const idx = db.tasks.findIndex((t) => t.id === id);
  if (idx !== -1) {
    db.tasks[idx] = { ...db.tasks[idx], ...updates };
    saveDb(db);
  }
}

function jsonDeleteTask(id: number): boolean {
  const db = loadDb();
  const idx = db.tasks.findIndex(t => t.id === id);
  if (idx === -1) return false;
  if (db.tasks[idx].status === 'running') return false;
  db.tasks.splice(idx, 1);
  saveDb(db);
  return true;
}

// ── In-memory streaming output (shared, not in DB) ──

const streamingOutputs = new Map<number, string>();
const MAX_STREAMING_OUTPUT = 100 * 1024; // 100KB cap

export function appendStreamingOutput(id: number, chunk: string): void {
  let current = streamingOutputs.get(id) || '';
  current += chunk;
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

// ── Unified async API (calls DB or JSON depending on config) ──

// Evaluated once — Supabase config cannot change at runtime
const useDb = isSupabaseConfigured();

export async function createTask(
  type: TaskType,
  repo: string,
  repoPath: string,
  context: TaskContext,
): Promise<Task> {
  if (useDb) return dbCreateTask(type, repo, repoPath, context);
  return jsonCreateTask(type, repo, repoPath, context);
}

export async function createSuggestion(
  type: TaskType,
  repo: string,
  repoPath: string,
  context: TaskContext,
): Promise<Task> {
  if (useDb) return dbCreateTask(type, repo, repoPath, context, 'suggestion');
  return jsonCreateTask(type, repo, repoPath, context, 'suggestion');
}

export async function getPendingSuggestions(): Promise<Task[]> {
  if (useDb) return dbGetPendingSuggestions();
  return loadDb().tasks
    .filter((t) => t.status === 'suggestion')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function approveSuggestion(id: number, extraPrompt?: string): Promise<Task | null> {
  if (useDb) return dbApproveSuggestion(id, extraPrompt);
  const db = loadDb();
  const idx = db.tasks.findIndex((t) => t.id === id);
  if (idx === -1 || db.tasks[idx].status !== 'suggestion') return null;
  if (extraPrompt) db.tasks[idx].context.suggestionNote = extraPrompt;
  db.tasks[idx].status = 'pending';
  saveDb(db);
  return db.tasks[idx];
}

export async function dismissSuggestion(id: number): Promise<boolean> {
  if (useDb) return dbDismissSuggestion(id);
  const db = loadDb();
  const idx = db.tasks.findIndex((t) => t.id === id);
  if (idx === -1 || db.tasks[idx].status !== 'suggestion') return false;
  db.tasks[idx].status = 'dismissed';
  db.tasks[idx].completedAt = new Date().toISOString();
  saveDb(db);
  return true;
}

export async function getTask(id: number): Promise<Task | undefined> {
  if (useDb) return dbGetTask(id);
  return jsonGetTask(id);
}

export async function getPendingTasks(limit = 10, forMachineId?: string): Promise<Task[]> {
  if (useDb) return dbGetPendingTasks(limit, forMachineId);
  const all = jsonGetPendingTasks(limit * 4);
  const filtered = forMachineId
    ? all.filter(t => !t.context?.targetMachineId || t.context.targetMachineId === forMachineId)
    : all;
  return filtered.slice(0, limit);
}

export async function getRunningCount(): Promise<number> {
  if (useDb) return dbGetRunningCount();
  return jsonGetRunningCount();
}

export async function getRunningTasks(): Promise<Task[]> {
  const all = await getAllTasks(500);
  return all.filter(t => t.status === 'running');
}

export async function getAllTasks(limit = 50): Promise<Task[]> {
  if (useDb) return dbGetAllTasks(limit);
  return jsonGetAllTasks(limit);
}

export async function getTasksByBatchId(batchId: string): Promise<Task[]> {
  if (useDb) return dbGetTasksByBatchId(batchId);
  return loadDb().tasks.filter(t => t.context?.batchId === batchId);
}

export async function startTask(id: number): Promise<void> {
  if (useDb) return dbStartTask(id);
  jsonUpdateTask(id, { status: 'running', startedAt: new Date().toISOString(), machineId: MACHINE_ID });
}

export async function claimTask(id: number): Promise<boolean> {
  if (useDb) return dbClaimTask(id);
  const task = jsonGetTask(id);
  if (!task || task.status !== 'pending') return false;
  jsonUpdateTask(id, { status: 'running', startedAt: new Date().toISOString(), machineId: MACHINE_ID });
  return true;
}

export async function completeTask(id: number, result: string): Promise<void> {
  const output = streamingOutputs.get(id);
  streamingOutputs.delete(id);
  if (useDb) return dbCompleteTask(id, result, output);
  jsonUpdateTask(id, { status: 'completed', result, output, pid: undefined, completedAt: new Date().toISOString() });
}

export async function failTask(id: number, error: string): Promise<void> {
  const output = streamingOutputs.get(id);
  streamingOutputs.delete(id);
  if (useDb) return dbFailTask(id, error, output);
  jsonUpdateTask(id, { status: 'failed', error, output, pid: undefined, completedAt: new Date().toISOString() });
}

export async function updateTaskPid(id: number, pid: number | undefined): Promise<void> {
  if (useDb) return dbUpdateTaskPid(id, pid);
  jsonUpdateTask(id, { pid });
}

export async function updateTaskStatus(id: number, status: TaskStatus): Promise<void> {
  if (useDb) return dbUpdateTaskStatus(id, status);
  const updates: Partial<Task> = { status };
  if (status === 'running') updates.startedAt = new Date().toISOString();
  jsonUpdateTask(id, updates);
}

export async function updateTaskRepoPath(id: number, newPath: string, resetStatus = true): Promise<void> {
  if (useDb) return dbUpdateTaskRepoPath(id, newPath, resetStatus);
  const updates: Record<string, unknown> = { repoPath: newPath };
  if (resetStatus) updates.status = 'pending';
  jsonUpdateTask(id, updates);
}

export async function deleteTask(id: number): Promise<boolean> {
  streamingOutputs.delete(id);
  if (useDb) return dbDeleteTask(id);
  return jsonDeleteTask(id);
}

export async function pinTask(id: number, machineId: string | null): Promise<Task | null> {
  const task = await getTask(id);
  if (!task) return null;
  const ctx: TaskContext = { ...task.context };
  if (machineId) ctx.targetMachineId = machineId;
  else delete ctx.targetMachineId;
  if (useDb) {
    await dbUpdateTask(id, { context: ctx });
  } else {
    jsonUpdateTask(id, { context: ctx });
  }
  return { ...task, context: ctx };
}

export async function getTasksWithPids(): Promise<Task[]> {
  if (useDb) return dbGetTasksWithPids();
  return loadDb().tasks.filter(t => t.status === 'running' && t.pid);
}

export async function getAllTasksWithOutput(limit = 50): Promise<Task[]> {
  const tasks = await getAllTasks(limit);
  return tasks.map(t => ({
    ...t,
    streamingOutput: streamingOutputs.get(t.id) || t.output,
  }));
}

export async function retryTask(failedTaskId: number): Promise<Task | null> {
  const failedTask = await getTask(failedTaskId);
  if (!failedTask || failedTask.status !== 'failed') return null;

  return createTask(failedTask.type, failedTask.repo, failedTask.repoPath, {
    ...failedTask.context,
    retryOfTaskId: failedTaskId,
    retryError: failedTask.error || 'Unknown error',
    retryCount: (failedTask.context.retryCount || 0) + 1,
  });
}
