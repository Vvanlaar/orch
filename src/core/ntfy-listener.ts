import https from 'https';
import type { IncomingMessage } from 'http';
import { approveSuggestion, dismissSuggestion, getPendingSuggestions, getTask } from './task-queue.js';
import { sendNtfyConfirmation } from './ntfy-sender.js';
import { triggerUpdate } from './task-processor.js';
import { createLogger } from './logger.js';

const log = createLogger('ntfy-listener');

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
    log.info(`Ignoring unrecognized: "${text}"`);
    return;
  }

  if (cmd.action === 'approve-all') {
    const suggestions = await getPendingSuggestions();
    if (suggestions.length === 0) {
      await sendNtfyConfirmation('No pending suggestions');
      return;
    }
    for (const s of suggestions) {
      await approveSuggestion(s.id);
    }
    triggerUpdate();
    await sendNtfyConfirmation(`Approved ${suggestions.length} suggestion(s)`);
    log.info(`Approved all ${suggestions.length} suggestions`);
    return;
  }

  const task = await getTask(cmd.id!);
  if (!task || task.status !== 'suggestion') {
    await sendNtfyConfirmation(`Task #${cmd.id} not found or not a suggestion`);
    return;
  }

  if (cmd.action === 'dismiss') {
    await dismissSuggestion(cmd.id!);
    triggerUpdate();
    await sendNtfyConfirmation(`Task #${cmd.id} dismissed`);
    log.info(`Dismissed #${cmd.id}`);
  } else {
    await approveSuggestion(cmd.id!, cmd.extra);
    triggerUpdate();
    const note = cmd.extra ? ` with note: ${cmd.extra}` : '';
    await sendNtfyConfirmation(`Task #${cmd.id} approved${note}`);
    log.info(`Approved #${cmd.id}${note}`);
  }
}

function connect(): void {
  if (stopped || !NTFY_COMMAND_TOPIC) return;

  const url = `https://ntfy.sh/${NTFY_COMMAND_TOPIC}/json`;
  log.info(`Connecting to ${url}`);

  const req = https.get(url, (res) => {
    connection = res;
    backoff = 1000;
    log.info('Connected');

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
              log.error('Handle error', err);
            });
          }
        } catch {
          // ignore non-JSON lines (keepalive, etc)
        }
      }
    });

    res.on('end', () => {
      log.info('Disconnected');
      connection = null;
      scheduleReconnect();
    });

    res.on('error', (err) => {
      log.error('Stream error', err);
      connection = null;
      scheduleReconnect();
    });
  });

  req.on('error', (err) => {
    log.error('Connection error', err);
    connection = null;
    scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (stopped) return;
  log.info(`Reconnecting in ${backoff / 1000}s`);
  reconnectTimer = setTimeout(() => {
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
    connect();
  }, backoff);
}

export function startNtfyListener(): void {
  if (!NTFY_COMMAND_TOPIC) {
    log.info('NTFY_COMMAND_TOPIC not set, skipping');
    return;
  }
  if (!process.env.NTFY_TOPIC) {
    log.warn('NTFY_COMMAND_TOPIC set but NTFY_TOPIC is missing — suggestions will queue but no notifications will be sent');
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
  log.info('Stopped');
}
