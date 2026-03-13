import { getSupabase } from './client.js';
import type { FeedbackEntry } from '../orch-feedback.js';

function rowToFeedbackEntry(row: any): FeedbackEntry {
  return {
    id: row.id,
    timestamp: row.created_at,
    type: row.type,
    actionId: row.action_id ?? undefined,
    actionTitle: row.action_title ?? undefined,
    actionTaskType: row.action_task_type ?? undefined,
    sourceType: row.source_type ?? undefined,
    sourceId: row.source_id ?? undefined,
    reason: row.reason ?? undefined,
    chatContext: row.chat_context ?? undefined,
    processed: row.processed,
  };
}

export async function dbLoadFeedbackLog(): Promise<FeedbackEntry[]> {
  const { data, error } = await getSupabase()
    .from('feedback')
    .select()
    .order('created_at', { ascending: true });

  if (error) return [];
  return (data ?? []).map(rowToFeedbackEntry);
}

export async function dbAppendFeedback(entry: Omit<FeedbackEntry, 'id' | 'timestamp' | 'processed'>): Promise<void> {
  const id = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const { error } = await getSupabase()
    .from('feedback')
    .insert({
      id,
      type: entry.type,
      action_id: entry.actionId ?? null,
      action_title: entry.actionTitle ?? null,
      action_task_type: entry.actionTaskType ?? null,
      source_type: entry.sourceType ?? null,
      source_id: entry.sourceId ?? null,
      reason: entry.reason ?? null,
      chat_context: entry.chatContext ?? null,
      processed: false,
    });
  if (error) throw new Error(`Failed to append feedback: ${error.message}`);
}

export async function dbGetUnprocessedFeedback(): Promise<FeedbackEntry[]> {
  const { data, error } = await getSupabase()
    .from('feedback')
    .select()
    .eq('processed', false)
    .order('created_at', { ascending: true });

  if (error) return [];
  return (data ?? []).map(rowToFeedbackEntry);
}

export async function dbMarkFeedbackProcessed(ids: string[]): Promise<void> {
  const { error } = await getSupabase()
    .from('feedback')
    .update({ processed: true })
    .in('id', ids);
  if (error) throw new Error(`Failed to mark feedback processed: ${error.message}`);
}

export async function dbLoadOrchestratorRules(): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from('orchestrator_rules')
    .select('content')
    .eq('id', 1)
    .single();

  if (error || !data) return null;
  return data.content || null;
}

export async function dbSaveOrchestratorRules(content: string): Promise<void> {
  const { error } = await getSupabase()
    .from('orchestrator_rules')
    .upsert({ id: 1, content, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Failed to save orchestrator rules: ${error.message}`);
}
