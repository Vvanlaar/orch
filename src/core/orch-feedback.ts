import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { runClaude } from './claude-runner.js';
import type { TaskType } from './types.js';
import { createLogger } from './logger.js';
import { isSupabaseConfigured } from './db/client.js';
import { dbLoadFeedbackLog, dbAppendFeedback, dbGetUnprocessedFeedback, dbMarkFeedbackProcessed, dbLoadOrchestratorRules, dbSaveOrchestratorRules } from './db/feedback.js';

const log = createLogger('orch-feedback');

const FEEDBACK_FILE = '.orch-feedback.json';
const RULES_FILE = '.orch-rules.md';

function feedbackPath(): string {
  return join(process.cwd(), FEEDBACK_FILE);
}

function rulesPath(): string {
  return join(process.cwd(), RULES_FILE);
}

export interface FeedbackEntry {
  id: string;
  timestamp: string;
  type: 'dismiss' | 'chat-correction' | 'accept';
  actionId?: string;
  actionTitle?: string;
  actionTaskType?: TaskType;
  sourceType?: string;
  sourceId?: string;
  reason?: string;
  chatContext?: string;
  processed: boolean;
}

const useDb = isSupabaseConfigured();

// ── JSON fallback functions ──

function jsonLoadFeedbackLog(): FeedbackEntry[] {
  const fp = feedbackPath();
  if (!existsSync(fp)) return [];
  try {
    return JSON.parse(readFileSync(fp, 'utf-8'));
  } catch {
    return [];
  }
}

function jsonAppendFeedback(entry: Omit<FeedbackEntry, 'id' | 'timestamp' | 'processed'>): void {
  const entries = jsonLoadFeedbackLog();
  entries.push({
    ...entry,
    id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    processed: false,
  });
  writeFileSync(feedbackPath(), JSON.stringify(entries, null, 2));
}

function jsonLoadOrchestratorRules(): string | null {
  const fp = rulesPath();
  if (!existsSync(fp)) return null;
  try {
    return readFileSync(fp, 'utf-8');
  } catch {
    return null;
  }
}

function jsonSaveOrchestratorRules(content: string): void {
  writeFileSync(rulesPath(), content);
}

function jsonGetUnprocessedFeedback(): FeedbackEntry[] {
  return jsonLoadFeedbackLog().filter(e => !e.processed);
}

function jsonMarkFeedbackProcessed(ids: string[]): void {
  const entries = jsonLoadFeedbackLog();
  const idSet = new Set(ids);
  for (const entry of entries) {
    if (idSet.has(entry.id)) entry.processed = true;
  }
  writeFileSync(feedbackPath(), JSON.stringify(entries, null, 2));
}

// ── Public async API ──

export async function loadFeedbackLog(): Promise<FeedbackEntry[]> {
  if (useDb) return dbLoadFeedbackLog();
  return jsonLoadFeedbackLog();
}

export async function appendFeedback(entry: Omit<FeedbackEntry, 'id' | 'timestamp' | 'processed'>): Promise<void> {
  if (useDb) return dbAppendFeedback(entry);
  jsonAppendFeedback(entry);
}

export async function loadOrchestratorRules(): Promise<string | null> {
  if (useDb) return dbLoadOrchestratorRules();
  return jsonLoadOrchestratorRules();
}

export async function saveOrchestratorRules(content: string): Promise<void> {
  if (useDb) return dbSaveOrchestratorRules(content);
  jsonSaveOrchestratorRules(content);
}

export async function getUnprocessedFeedback(): Promise<FeedbackEntry[]> {
  if (useDb) return dbGetUnprocessedFeedback();
  return jsonGetUnprocessedFeedback();
}

export async function markFeedbackProcessed(ids: string[]): Promise<void> {
  if (useDb) return dbMarkFeedbackProcessed(ids);
  jsonMarkFeedbackProcessed(ids);
}

export async function distillFeedback(): Promise<void> {
  const unprocessed = await getUnprocessedFeedback();
  if (unprocessed.length === 0) return;

  const existingRules = await loadOrchestratorRules();

  const feedbackLines = unprocessed.map(e => {
    if (e.type === 'dismiss') {
      return `- DISMISSED "${e.actionTitle}" (${e.actionTaskType}, source:${e.sourceType})${e.reason ? ` — reason: ${e.reason}` : ''}`;
    }
    if (e.type === 'chat-correction') {
      return `- CHAT CORRECTION: "${e.chatContext}"`;
    }
    return `- ACCEPTED "${e.actionTitle}" (${e.actionTaskType})`;
  }).join('\n');

  const prompt = `You maintain a concise rules list for an AI orchestrator that suggests developer tasks.

Based on user feedback (dismissals with reasons, chat corrections, accepts), update the rules.

## Current Rules
${existingRules || '(none yet)'}

## New Feedback
${feedbackLines}

Write an updated, concise markdown rules list. Each rule should be one line starting with "- ".
Focus on patterns: what to avoid suggesting, what the user prefers, priorities.
Remove rules that conflict with newer feedback. Keep it under 20 rules.
Output ONLY the markdown rules (no fences, no explanation).`;

  const syntheticTask = {
    id: -3,
    type: 'docs' as TaskType,
    status: 'running' as const,
    repo: 'orchestrator',
    repoPath: process.cwd(),
    context: { source: 'github' as const, event: 'distill-feedback', title: 'Distill orchestrator feedback' },
    createdAt: new Date().toISOString(),
  };

  try {
    const result = await runClaude(syntheticTask, prompt, { allowEdits: false });
    if (result.success && result.output.trim()) {
      await saveOrchestratorRules(result.output.trim());
      await markFeedbackProcessed(unprocessed.map(e => e.id));
      log.info(`Distilled ${unprocessed.length} feedback entries into rules`);
    }
  } catch (err) {
    log.error('Distillation failed', err);
  }
}
