import { getSupabase, MACHINE_ID } from './client.js';

export async function dbGetSetting(key: string): Promise<unknown | null> {
  const { data, error } = await getSupabase()
    .from('settings')
    .select('value')
    .eq('key', key)
    .eq('machine_id', MACHINE_ID)
    .single();

  if (error || !data) return null;
  return data.value;
}

export async function dbSetSetting(key: string, value: unknown): Promise<void> {
  const { error } = await getSupabase()
    .from('settings')
    .upsert({
      key,
      machine_id: MACHINE_ID,
      value,
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(`Failed to save setting: ${error.message}`);
}
