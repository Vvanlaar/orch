import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const id = Number(process.argv[2]);
const { data, error } = await sb.from('tasks').select('id,status,created_at,context').eq('id', id).single();
if (error) { console.error(error.message); process.exit(1); }
console.log(JSON.stringify({ id: data.id, status: data.status, created_at: data.created_at, scanUrl: data.context?.scanUrl }, null, 2));
