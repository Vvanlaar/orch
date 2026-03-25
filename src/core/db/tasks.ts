import { getSupabase, MACHINE_ID } from './client.js';
import type { Task, TaskStatus, TaskType, TaskContext } from '../types.js';

interface TaskRow {
  id: number;
  type: string;
  status: string;
  repo: string;
  repo_path: string;
  context: TaskContext;
  result: string | null;
  error: string | null;
  output: string | null;
  pid: number | null;
  machine_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    type: row.type as TaskType,
    status: row.status as TaskStatus,
    repo: row.repo,
    repoPath: row.repo_path,
    context: row.context,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    output: row.output ?? undefined,
    pid: row.pid ?? undefined,
    machineId: row.machine_id ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
  };
}

export async function dbCreateTask(
  type: TaskType,
  repo: string,
  repoPath: string,
  context: TaskContext,
  status: TaskStatus = 'pending',
): Promise<Task> {
  const { data, error } = await getSupabase()
    .from('tasks')
    .insert({
      type,
      status,
      repo,
      repo_path: repoPath,
      context,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create task: ${error.message}`);
  return rowToTask(data as TaskRow);
}

export async function dbGetTask(id: number): Promise<Task | undefined> {
  const { data, error } = await getSupabase()
    .from('tasks')
    .select()
    .eq('id', id)
    .single();

  if (error || !data) return undefined;
  return rowToTask(data as TaskRow);
}

const TASK_COLUMNS_NO_OUTPUT = 'id, type, status, repo, repo_path, context, result, error, pid, machine_id, created_at, started_at, completed_at';

export async function dbGetPendingTasks(limit = 10): Promise<Task[]> {
  const { data, error } = await getSupabase()
    .from('tasks')
    .select(TASK_COLUMNS_NO_OUTPUT)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw new Error(`Failed to get pending tasks: ${error.message}`);
  return (data as TaskRow[]).map(rowToTask);
}

export async function dbGetRunningCount(): Promise<number> {
  const { count, error } = await getSupabase()
    .from('tasks')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'running');

  if (error) throw new Error(`Failed to get running count: ${error.message}`);
  return count ?? 0;
}

export async function dbGetAllTasks(limit = 50): Promise<Task[]> {
  // Exclude large `output` column to reduce egress — streaming output is overlaid separately
  const { data, error } = await getSupabase()
    .from('tasks')
    .select(TASK_COLUMNS_NO_OUTPUT)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to get all tasks: ${error.message}`);
  return (data as TaskRow[]).map(rowToTask);
}

export async function dbUpdateTask(id: number, updates: Record<string, unknown>): Promise<void> {
  const { error } = await getSupabase()
    .from('tasks')
    .update(updates)
    .eq('id', id);

  if (error) throw new Error(`Failed to update task ${id}: ${error.message}`);
}

export async function dbStartTask(id: number): Promise<void> {
  await dbUpdateTask(id, {
    status: 'running',
    started_at: new Date().toISOString(),
    machine_id: MACHINE_ID,
  });
}

export async function dbCompleteTask(id: number, result: string, output?: string): Promise<void> {
  await dbUpdateTask(id, {
    status: 'completed',
    result,
    output: output ?? null,
    pid: null,
    completed_at: new Date().toISOString(),
  });
}

export async function dbFailTask(id: number, error: string, output?: string): Promise<void> {
  await dbUpdateTask(id, {
    status: 'failed',
    error,
    output: output ?? null,
    pid: null,
    completed_at: new Date().toISOString(),
  });
}

export async function dbUpdateTaskPid(id: number, pid: number | undefined): Promise<void> {
  await dbUpdateTask(id, { pid: pid ?? null });
}

export async function dbUpdateTaskStatus(id: number, status: TaskStatus): Promise<void> {
  const updates: Record<string, unknown> = { status };
  if (status === 'running') {
    updates.started_at = new Date().toISOString();
    updates.machine_id = MACHINE_ID;
  }
  await dbUpdateTask(id, updates);
}

export async function dbUpdateTaskRepoPath(id: number, newPath: string, resetStatus = true): Promise<void> {
  const updates: Record<string, unknown> = { repo_path: newPath };
  if (resetStatus) updates.status = 'pending';
  await dbUpdateTask(id, updates);
}

export async function dbDeleteTask(id: number): Promise<boolean> {
  // Don't delete running tasks
  const { data, error } = await getSupabase()
    .from('tasks')
    .delete()
    .eq('id', id)
    .neq('status', 'running')
    .select('id');

  if (error) return false;
  return (data?.length ?? 0) > 0;
}

export async function dbGetTasksWithPids(): Promise<Task[]> {
  const { data, error } = await getSupabase()
    .from('tasks')
    .select(TASK_COLUMNS_NO_OUTPUT)
    .eq('status', 'running')
    .not('pid', 'is', null);

  if (error) return [];
  return (data as TaskRow[]).map(rowToTask);
}

export async function dbGetPendingSuggestions(): Promise<Task[]> {
  const { data, error } = await getSupabase()
    .from('tasks')
    .select(TASK_COLUMNS_NO_OUTPUT)
    .eq('status', 'suggestion')
    .order('created_at', { ascending: true });

  if (error) return [];
  return (data as TaskRow[]).map(rowToTask);
}

export async function dbApproveSuggestion(id: number, extraPrompt?: string): Promise<Task | null> {
  const updates: Record<string, unknown> = { status: 'pending' };

  // If extraPrompt, we need the current context to merge into
  if (extraPrompt) {
    const task = await dbGetTask(id);
    if (!task || task.status !== 'suggestion') return null;
    updates.context = { ...task.context, suggestionNote: extraPrompt };
  }

  // Conditional update returns the updated row — no second fetch needed
  const { data, error } = await getSupabase()
    .from('tasks')
    .update(updates)
    .eq('id', id)
    .eq('status', 'suggestion')
    .select()
    .single();

  if (error || !data) return null;
  return rowToTask(data as TaskRow);
}

export async function dbDismissSuggestion(id: number): Promise<boolean> {
  const { data } = await getSupabase()
    .from('tasks')
    .update({ status: 'dismissed', completed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'suggestion')
    .select('id');
  return (data?.length ?? 0) > 0;
}

export async function dbClaimTask(taskId: number): Promise<boolean> {
  const { data } = await getSupabase()
    .from('tasks')
    .update({
      status: 'running',
      machine_id: MACHINE_ID,
      started_at: new Date().toISOString(),
    })
    .eq('id', taskId)
    .eq('status', 'pending')
    .select('id')
    .single();
  return !!data;
}
