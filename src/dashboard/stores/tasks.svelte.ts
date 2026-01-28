import type { Task } from '../lib/types';
import { setTasksHandler, setOutputHandler } from './websocket.svelte';

// State
let tasks = $state<Task[]>([]);
let expandedTasks = $state(new Set<number>());
let taskOutputs = $state(new Map<number, string>());

// Initialize WebSocket handlers
setTasksHandler((newTasks) => {
  tasks = newTasks;
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
