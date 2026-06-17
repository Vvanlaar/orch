import type { Notification, OrchestratorState, Task } from '../lib/types';
import { getToken } from './session.svelte';

// WebSocket connection state
let ws: WebSocket | null = $state(null);
let connected = $state(false);

// Task output handlers
type OutputHandler = (taskId: number, chunk: string) => void;
type TasksHandler = (tasks: Task[]) => void;
type NotificationHandler = (notification: Notification) => void;
type OrchestratorHandler = (state: OrchestratorState) => void;

let onOutput: OutputHandler | null = null;
let onTasks: TasksHandler | null = null;
let onNotification: NotificationHandler | null = null;
let onOrchestrator: OrchestratorHandler | null = null;

export function setOutputHandler(handler: OutputHandler) {
  onOutput = handler;
}

export function setTasksHandler(handler: TasksHandler) {
  onTasks = handler;
}

export function setNotificationHandler(handler: NotificationHandler) {
  onNotification = handler;
}

export function setOrchestratorHandler(handler: OrchestratorHandler) {
  onOrchestrator = handler;
}

export function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Use location.host - Vite proxies /ws to backend in dev. The token rides as
  // a query param (WebSocket can't set Authorization); the server rejects the
  // upgrade unless it carries the admin scope.
  const token = getToken();
  const qs = token ? `?token=${encodeURIComponent(token)}` : '';
  ws = new WebSocket(`${protocol}//${location.host}/ws${qs}`);

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
      } else if (data.type === 'notification' && onNotification) {
        onNotification(data.notification);
      } else if (data.type === 'orchestrator' && onOrchestrator) {
        onOrchestrator(data.state);
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
