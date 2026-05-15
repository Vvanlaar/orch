import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const id = Number(process.argv[2]);
const isoTs = process.argv[3] || '2020-01-01T00:00:00Z';
if (!id) { console.error('usage: node scripts/bump-priority.mjs <taskId> [iso-ts]'); process.exit(1); }

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing'); process.exit(1); }

const sb = createClient(url, key);
const { data, error } = await sb
  .from('tasks')
  .update({ created_at: isoTs })
  .eq('id', id)
  .select('id,status,created_at,context')
  .single();
if (error) { console.error('update failed:', error.message); process.exit(1); }
console.log('updated:', JSON.stringify({ id: data.id, status: data.status, created_at: data.created_at, scanUrl: data.context?.scanUrl }, null, 2));
