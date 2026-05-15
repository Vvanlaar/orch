// Flip currently-running videoscans back to pending so the orphan handler
// at server startup skips them and the queue claims them fresh.
// Run while the server is DOWN.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data: running, error: e1 } = await sb
  .from('tasks')
  .select('id,context,created_at')
  .eq('type', 'videoscan')
  .eq('status', 'running');
if (e1) { console.error('list failed:', e1.message); process.exit(1); }
if (!running.length) { console.log('no running videoscans to requeue'); process.exit(0); }

console.log(`flipping ${running.length} running → pending:`);
for (const t of running) console.log(`  #${t.id} ${t.context?.scanUrl}`);

const ids = running.map(t => t.id);
// Also backdate created_at to NOW so they sit after aaenmaas (2020) but before the rest (08:26).
const newTs = new Date(Date.now() - 60_000).toISOString(); // 1 min ago — after 2020, before now
const { error: e2 } = await sb
  .from('tasks')
  .update({ status: 'pending', machine_id: null, created_at: newTs })
  .in('id', ids);
if (e2) { console.error('update failed:', e2.message); process.exit(1); }
console.log(`done — re-queued at created_at=${newTs}`);
