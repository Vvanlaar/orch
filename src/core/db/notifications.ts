import { getSupabase } from './client.js';

export interface NotificationRow {
  id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

export async function dbGetNotifications(limit = 50): Promise<NotificationRow[]> {
  const { data, error } = await getSupabase()
    .from('notifications')
    .select('id, type, data, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return [];
  return data ?? [];
}

export async function dbInsertNotification(notification: { id: string; type: string; [key: string]: unknown }): Promise<void> {
  const { id, type, ...rest } = notification;
  const { error } = await getSupabase()
    .from('notifications')
    .upsert({ id, type, data: rest, created_at: new Date().toISOString() });
  if (error) throw new Error(`Failed to insert notification: ${error.message}`);
}
