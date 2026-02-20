import type { Task } from '../lib/types';
import { setTasksHandler, setOutputHandler } from './websocket.svelte';
import { readPreference, writePreference } from '../lib/preferences';

// State
let tasks = $state<Task[]>([]);
const EXPANDED_TASKS_STORAGE_KEY = 'orch.dashboard.tasks.expanded';
const savedExpandedTasks = readPreference(
  EXPANDED_TASKS_STORAGE_KEY,
  [] as number[],
  (value): value is number[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isInteger(item))
);
let expandedTasks = $state(new Set<number>(savedExpandedTasks));
let taskOutputs = $state(new Map<number, string>());

function persistExpandedTasks() {
  writePreference(EXPANDED_TASKS_STORAGE_KEY, Array.from(expandedTasks));
}

// Initialize WebSocket handlers
setTasksHandler((newTasks) => {
  tasks = newTasks;
  const validIds = new Set(newTasks.map((task) => task.id));
  const nextExpanded = new Set(Array.from(expandedTasks).filter((taskId) => validIds.has(taskId)));
  if (nextExpanded.size !== expandedTasks.size) {
    expandedTasks = nextExpanded;
    persistExpandedTasks();
  }

  // Preserve output for tasks that have streaming output
  newTasks.forEach((t) => {
    if (t.streamingOutput && !taskOutputs.has(t.id)) {
      taskOutputs.set(t.id, t.streamingOutput);
    }
  });
});

setOutputHandler((taskId, chunk) => {
  const current = taskOutputs.get(taskId) || '';
  taskOutputs.set(taskId, current + chunk);
  // Force reactivity by creating new Map
  taskOutputs = new Map(taskOutputs);
});

export function getTasks() {
  return tasks;
}

export function getTaskOutput(taskId: number): string {
  return taskOutputs.get(taskId) || '';
}

export function isExpanded(taskId: number): boolean {
  return expandedTasks.has(taskId);
}

export function toggleExpanded(taskId: number) {
  if (expandedTasks.has(taskId)) {
    expandedTasks.delete(taskId);
  } else {
    expandedTasks.add(taskId);
  }
  expandedTasks = new Set(expandedTasks);
  persistExpandedTasks();
}

export function appendSteerInput(taskId: number, input: string) {
  const current = taskOutputs.get(taskId) || '';
  taskOutputs.set(taskId, current + `\n> ${input}\n`);
  taskOutputs = new Map(taskOutputs);
}

export async function fetchTasks() {
  try {
    const res = await fetch('/api/tasks');
    tasks = await res.json();
  } catch (err) {
    console.error('Failed to fetch tasks:', err);
  }
}

export async function stopTask(taskId: number) {
  const res = await fetch(`/api/tasks/${taskId}/stop`, { method: 'POST' });
  if (!res.ok) {
    const result = await res.json();
    throw new Error(result.error);
  }
}

export async function deleteTask(taskId: number) {
  const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
  if (!res.ok) {
    const result = await res.json();
    throw new Error(result.error);
  }
}

export async function retryTask(taskId: number) {
  const res = await fetch(`/api/tasks/${taskId}/retry`, { method: 'POST' });
  if (!res.ok) {
    const result = await res.json();
    throw new Error(result.error);
  }
}

export async function completeTask(taskId: number) {
  const res = await fetch(`/api/tasks/${taskId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'Completed via terminal' }),
  });
  if (!res.ok) {
    const result = await res.json();
    throw new Error(result.error);
  }
}

export async function openTerminal(taskId: number) {
  const res = await fetch(`/api/tasks/${taskId}/terminal`, { method: 'POST' });
  if (!res.ok) {
    const result = await res.json();
    throw new Error(result.error);
  }
}

export async function setRepoPath(taskId: number, repoPath: string) {
  const res = await fetch(`/api/tasks/${taskId}/repo-path`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath }),
  });
  if (!res.ok) {
    const result = await res.json();
    throw new Error(result.error);
  }
}
