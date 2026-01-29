import type { Task } from '../lib/types';

// WebSocket connection state
let ws: WebSocket | null = $state(null);
let connected = $state(false);

// Task output handlers
type OutputHandler = (taskId: number, chunk: string) => void;
type TasksHandler = (tasks: Task[]) => void;

let onOutput: OutputHandler | null = null;
let onTasks: TasksHandler | null = null;

export function setOutputHandler(handler: OutputHandler) {
  onOutput = handler;
}

export function setTasksHandler(handler: TasksHandler) {
  onTasks = handler;
}

export function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Use location.host - Vite proxies /ws to backend in dev
  ws = new WebSocket(`${protocol}//${location.host}/ws`);

  ws.onopen = () => {
    connected = true;
  };

  ws.onerror = (e) => {
    console.error('WebSocket error:', e);
  };

  ws.onclose = () => {
    connected = false;
    ws = null;
    // Auto-reconnect after 3s
    setTimeout(connect, 3000);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'tasks' && onTasks) {
        onTasks(data.tasks);
      } else if (data.type === 'output' && onOutput) {
        onOutput(data.taskId, data.chunk);
      }
    } catch (e) {
      console.error('WebSocket parse error:', e);
    }
  };
}

export function send(message: object) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export function isConnected() {
  return connected;
}

// Reactive getter
export function getConnectionState() {
  return { connected };
}
