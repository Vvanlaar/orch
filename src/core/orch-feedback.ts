import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { runClaude } from './claude-runner.js';
import type { TaskType } from './types.js';

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

export function loadFeedbackLog(): FeedbackEntry[] {
  const fp = feedbackPath();
  if (!existsSync(fp)) return [];
  try {
    return JSON.parse(readFileSync(fp, 'utf-8'));
  } catch {
    return [];
  }
}

export function appendFeedback(entry: Omit<FeedbackEntry, 'id' | 'timestamp' | 'processed'>): void {
  const log = loadFeedbackLog();
  log.push({
    ...entry,
    id: `fb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    processed: false,
  });
  writeFileSync(feedbackPath(), JSON.stringify(log, null, 2));
}

export function loadOrchestratorRules(): string | null {
  const fp = rulesPath();
  if (!existsSync(fp)) return null;
  try {
    return readFileSync(fp, 'utf-8');
  } catch {
    return null;
  }
}

export function saveOrchestratorRules(content: string): void {
  writeFileSync(rulesPath(), content);
}

export function getUnprocessedFeedback(): FeedbackEntry[] {
  return loadFeedbackLog().filter(e => !e.processed);
}

export function markFeedbackProcessed(ids: string[]): void {
  const log = loadFeedbackLog();
  const idSet = new Set(ids);
  for (const entry of log) {
    if (idSet.has(entry.id)) entry.processed = true;
  }
  writeFileSync(feedbackPath(), JSON.stringify(log, null, 2));
}

export async function distillFeedback(): Promise<void> {
  const unprocessed = getUnprocessedFeedback();
  if (unprocessed.length === 0) return;

  const existingRules = loadOrchestratorRules();

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
      saveOrchestratorRules(result.output.trim());
      markFeedbackProcessed(unprocessed.map(e => e.id));
      console.log(`[orch-feedback] Distilled ${unprocessed.length} feedback entries into rules`);
    }
  } catch (err) {
    console.error('[orch-feedback] Distillation failed:', err);
  }
}
