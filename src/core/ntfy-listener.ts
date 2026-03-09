import https from 'https';
import type { IncomingMessage } from 'http';
import { approveSuggestion, dismissSuggestion, getPendingSuggestions, getTask } from './task-queue.js';
import { sendNtfyConfirmation } from './ntfy-sender.js';
import { triggerUpdate } from './task-processor.js';

const NTFY_COMMAND_TOPIC = process.env.NTFY_COMMAND_TOPIC;

let connection: IncomingMessage | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let backoff = 1000;
const MAX_BACKOFF = 60000;
let stopped = false;

function parseCommand(text: string): { action: 'approve' | 'dismiss' | 'approve-all'; id?: number; extra?: string } | null {
  const trimmed = text.trim().toLowerCase();

  if (trimmed === 'all') {
    return { action: 'approve-all' };
  }

  // "skip {id}" or "no {id}"
  const skipMatch = trimmed.match(/^(?:skip|no)\s+(\d+)$/);
  if (skipMatch) {
    return { action: 'dismiss', id: parseInt(skipMatch[1]) };
  }

  // "yes {id}" or just "{id}"
  const approveMatch = trimmed.match(/^(?:yes\s+)?(\d+)$/);
  if (approveMatch) {
    return { action: 'approve', id: parseInt(approveMatch[1]) };
  }

  // "{id}: extra instructions"
  const modifyMatch = text.trim().match(/^(\d+):\s*(.+)$/s);
  if (modifyMatch) {
    return { action: 'approve', id: parseInt(modifyMatch[1]), extra: modifyMatch[2].trim() };
  }

  return null;
}

async function handleMessage(text: string): Promise<void> {
  const cmd = parseCommand(text);
  if (!cmd) {
    console.log(`[ntfy-listener] Ignoring unrecognized: "${text}"`);
    return;
  }

  if (cmd.action === 'approve-all') {
    const suggestions = getPendingSuggestions();
    if (suggestions.length === 0) {
      await sendNtfyConfirmation('No pending suggestions');
      return;
    }
    for (const s of suggestions) {
      approveSuggestion(s.id);
    }
    triggerUpdate();
    await sendNtfyConfirmation(`Approved ${suggestions.length} suggestion(s)`);
    console.log(`[ntfy-listener] Approved all ${suggestions.length} suggestions`);
    return;
  }

  const task = getTask(cmd.id!);
  if (!task || task.status !== 'suggestion') {
    await sendNtfyConfirmation(`Task #${cmd.id} not found or not a suggestion`);
    return;
  }

  if (cmd.action === 'dismiss') {
    dismissSuggestion(cmd.id!);
    triggerUpdate();
    await sendNtfyConfirmation(`Task #${cmd.id} dismissed`);
    console.log(`[ntfy-listener] Dismissed #${cmd.id}`);
  } else {
    approveSuggestion(cmd.id!, cmd.extra);
    triggerUpdate();
    const note = cmd.extra ? ` with note: ${cmd.extra}` : '';
    await sendNtfyConfirmation(`Task #${cmd.id} approved${note}`);
    console.log(`[ntfy-listener] Approved #${cmd.id}${note}`);
  }
}

function connect(): void {
  if (stopped || !NTFY_COMMAND_TOPIC) return;

  const url = `https://ntfy.sh/${NTFY_COMMAND_TOPIC}/json`;
  console.log(`[ntfy-listener] Connecting to ${url}`);

  const req = https.get(url, (res) => {
    connection = res;
    backoff = 1000;
    console.log('[ntfy-listener] Connected');

    let buffer = '';
    res.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.event === 'message' && msg.message) {
            handleMessage(msg.message).catch((err) => {
              console.error('[ntfy-listener] Handle error:', err);
            });
          }
        } catch {
          // ignore non-JSON lines (keepalive, etc)
        }
      }
    });

    res.on('end', () => {
      console.log('[ntfy-listener] Disconnected');
      connection = null;
      scheduleReconnect();
    });

    res.on('error', (err) => {
      console.error('[ntfy-listener] Stream error:', err.message);
      connection = null;
      scheduleReconnect();
    });
  });

  req.on('error', (err) => {
    console.error('[ntfy-listener] Connection error:', err.message);
    connection = null;
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (stopped) return;
  console.log(`[ntfy-listener] Reconnecting in ${backoff / 1000}s`);
  reconnectTimer = setTimeout(() => {
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
    connect();
  }, backoff);
}

export function startNtfyListener(): void {
  if (!NTFY_COMMAND_TOPIC) {
    console.log('[ntfy-listener] NTFY_COMMAND_TOPIC not set, skipping');
    return;
  }
  if (!process.env.NTFY_TOPIC) {
    console.warn('[ntfy-listener] WARNING: NTFY_COMMAND_TOPIC set but NTFY_TOPIC is missing — suggestions will queue but no notifications will be sent');
  }
  stopped = false;
  connect();
}

export function stopNtfyListener(): void {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (connection) {
    connection.destroy();
    connection = null;
  }
  console.log('[ntfy-listener] Stopped');
}
