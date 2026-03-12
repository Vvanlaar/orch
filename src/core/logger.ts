import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'fs';

const LOG_FILE = 'orch-server.log';
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_ROTATIONS = 3;

type Level = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: string;
  level: Level;
  module: string;
  msg: string;
  error?: string;
  stack?: string;
  meta?: Record<string, unknown>;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, err?: unknown, meta?: Record<string, unknown>): void;
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const size = statSync(LOG_FILE).size;
    if (size < MAX_SIZE) return;

    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const from = `orch-server.${i}.log`;
      const to = `orch-server.${i + 1}.log`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(LOG_FILE, 'orch-server.1.log');
  } catch {
    // rotation failure must never crash
  }
}

function writeEntry(entry: LogEntry): void {
  try {
    rotateIfNeeded();
    appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {
    // logger must never crash
  }
}

function serializeError(err: unknown): { error?: string; stack?: string } {
  if (!err) return {};
  if (err instanceof Error) {
    return { error: err.message, stack: err.stack };
  }
  return { error: String(err) };
}

export function createLogger(module: string): Logger {
  return {
    info(msg: string, meta?: Record<string, unknown>) {
      console.log(`[${module}] ${msg}`);
      writeEntry({ ts: new Date().toISOString(), level: 'info', module, msg, meta });
    },
    warn(msg: string, meta?: Record<string, unknown>) {
      console.warn(`[${module}] ${msg}`);
      writeEntry({ ts: new Date().toISOString(), level: 'warn', module, msg, meta });
    },
    error(msg: string, err?: unknown, meta?: Record<string, unknown>) {
      const { error, stack } = serializeError(err);
      console.error(`[${module}] ${msg}`, err ?? '');
      writeEntry({ ts: new Date().toISOString(), level: 'error', module, msg, error, stack, meta });
    },
  };
}

export function getRecentErrors(limit = 50): LogEntry[] {
  try {
    if (!existsSync(LOG_FILE)) return [];
    const content = readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const errors: LogEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && errors.length < limit; i--) {
      try {
        const entry: LogEntry = JSON.parse(lines[i]);
        if (entry.level === 'error') errors.push(entry);
      } catch { /* skip malformed */ }
    }
    return errors;
  } catch {
    return [];
  }
}
