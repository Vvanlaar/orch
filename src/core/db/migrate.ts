/**
 * One-time migration script: JSON files → Supabase
 *
 * Usage: pnpm exec tsx src/core/db/migrate.ts
 */
import 'dotenv/config';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

async function migrateTasks() {
  const DB_FILE = 'orch-tasks.json';
  if (!existsSync(DB_FILE)) {
    console.log('No orch-tasks.json found, skipping task migration');
    return;
  }

  const db = JSON.parse(readFileSync(DB_FILE, 'utf-8'));
  const tasks = db.tasks || [];
  console.log(`Migrating ${tasks.length} tasks...`);

  for (const task of tasks) {
    const { error } = await supabase.from('tasks').upsert({
      id: task.id,
      type: task.type,
      status: task.status,
      repo: task.repo,
      repo_path: task.repoPath,
      context: task.context,
      result: task.result ?? null,
      error: task.error ?? null,
      output: task.output ?? null,
      pid: null, // don't migrate PIDs
      created_at: task.createdAt,
      started_at: task.startedAt ?? null,
      completed_at: task.completedAt ?? null,
    });
    if (error) console.error(`  Task #${task.id}: ${error.message}`);
  }

  // Reset sequence to max id
  if (tasks.length > 0) {
    const maxId = Math.max(...tasks.map((t: { id: number }) => t.id));
    await supabase.rpc('setval_tasks_id', { val: maxId });
    console.log(`  Set tasks sequence to ${maxId}`);
  }

  console.log(`  Done: ${tasks.length} tasks migrated`);
}

async function migrateFeedback() {
  const FEEDBACK_FILE = '.orch-feedback.json';
  if (!existsSync(FEEDBACK_FILE)) {
    console.log('No .orch-feedback.json found, skipping feedback migration');
    return;
  }

  const entries = JSON.parse(readFileSync(FEEDBACK_FILE, 'utf-8'));
  console.log(`Migrating ${entries.length} feedback entries...`);

  for (const entry of entries) {
    const { error } = await supabase.from('feedback').upsert({
      id: entry.id,
      type: entry.type,
      action_id: entry.actionId ?? null,
      action_title: entry.actionTitle ?? null,
      action_task_type: entry.actionTaskType ?? null,
      source_type: entry.sourceType ?? null,
      source_id: entry.sourceId ?? null,
      reason: entry.reason ?? null,
      chat_context: entry.chatContext ?? null,
      processed: entry.processed ?? false,
      created_at: entry.timestamp ?? new Date().toISOString(),
    });
    if (error) console.error(`  Feedback ${entry.id}: ${error.message}`);
  }
  console.log(`  Done: ${entries.length} feedback entries migrated`);
}

async function migrateRules() {
  const RULES_FILE = '.orch-rules.md';
  if (!existsSync(RULES_FILE)) {
    console.log('No .orch-rules.md found, skipping rules migration');
    return;
  }

  const content = readFileSync(RULES_FILE, 'utf-8');
  const { error } = await supabase.from('orchestrator_rules').upsert({
    id: 1,
    content,
    updated_at: new Date().toISOString(),
  });
  if (error) console.error(`  Rules: ${error.message}`);
  else console.log('  Rules migrated');
}

async function migrateVideoscans() {
  const VIDEOSCAN_DIR = process.env.VIDEOSCAN_DIR || './videoscans';
  if (!existsSync(VIDEOSCAN_DIR)) {
    console.log('No videoscans directory found, skipping');
    return;
  }

  const files = readdirSync(VIDEOSCAN_DIR)
    .filter(f => f.startsWith('videoscan-') && f.endsWith('.json'));

  console.log(`Migrating ${files.length} videoscan metadata...`);

  for (const filename of files) {
    try {
      const data = JSON.parse(readFileSync(join(VIDEOSCAN_DIR, filename), 'utf-8'));
      const htmlFile = filename.replace('.json', '.html');
      const pdfFile = filename.replace('.json', '.pdf');

      const { error } = await supabase.from('videoscans').upsert(
        {
          filename,
          domain: data.domain || 'unknown',
          scan_date: data.scanDate || new Date().toISOString(),
          pages_scanned: data.pagesScanned || 0,
          pages_with_video: data.pagesWithVideo || data.details?.length || 0,
          unique_players: data.uniquePlayers || Object.keys(data.playerSummary || {}).length,
          player_summary: data.playerSummary || {},
          details: data.details || [],
          scan_state: data._state || {},
          has_report: existsSync(join(VIDEOSCAN_DIR, htmlFile)),
          has_pdf: existsSync(join(VIDEOSCAN_DIR, pdfFile)),
          can_resume: (data._state?.queue?.length || 0) > 0,
        },
        { onConflict: 'filename' }
      );
      if (error) console.error(`  ${filename}: ${error.message}`);
    } catch (err) {
      console.error(`  ${filename}: ${err}`);
    }
  }
  console.log(`  Done: ${files.length} videoscans migrated`);

  // Upload files to Supabase Storage
  console.log('Uploading videoscan files to storage...');
  const BUCKET = 'videoscans';
  const { error: bucketErr } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (bucketErr && !bucketErr.message.includes('already exists')) {
    console.error(`  Failed to create bucket: ${bucketErr.message}`);
    return;
  }

  const allFiles = readdirSync(VIDEOSCAN_DIR)
    .filter(f => f.startsWith('videoscan-') && (f.endsWith('.json') || f.endsWith('.html') || f.endsWith('.pdf')));
  let uploaded = 0;
  for (const f of allFiles) {
    const content = readFileSync(join(VIDEOSCAN_DIR, f));
    const contentType = f.endsWith('.html') ? 'text/html' : f.endsWith('.pdf') ? 'application/pdf' : 'application/json';
    const { error } = await supabase.storage.from(BUCKET).upload(f, content, { contentType, upsert: true });
    if (error) console.error(`  Upload ${f}: ${error.message}`);
    else uploaded++;
  }
  console.log(`  Done: ${uploaded}/${allFiles.length} files uploaded to storage`);
}

async function migrateNotifications() {
  const { homedir } = await import('os');
  const notifPath = join(homedir(), '.claude', 'notification-log.jsonl');
  if (!existsSync(notifPath)) {
    console.log('No notification-log.jsonl found, skipping');
    return;
  }

  const content = readFileSync(notifPath, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  console.log(`Migrating ${lines.length} notifications...`);

  let count = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const { id, type, timestamp, ...rest } = entry;
      if (!id || !type) continue;

      const { error } = await supabase.from('notifications').upsert({
        id,
        type,
        data: rest,
        created_at: timestamp || new Date().toISOString(),
      });
      if (error) console.error(`  Notification ${id}: ${error.message}`);
      else count++;
    } catch {}
  }
  console.log(`  Done: ${count} notifications migrated`);
}

async function main() {
  console.log('Starting migration to Supabase...');
  console.log(`URL: ${SUPABASE_URL}`);
  console.log('');

  await migrateTasks();
  await migrateFeedback();
  await migrateRules();
  await migrateVideoscans();
  await migrateNotifications();

  console.log('\nMigration complete!');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
