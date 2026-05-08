#!/usr/bin/env node
// One-shot backfill: populate batch_id/batch_label on existing videoscans rows that
// were written before the batch-grouping feature shipped. Two passes:
//   1. Match scan filename → owning task via the `JSON: <filename>` line in task.result;
//      copy batchId/batchLabel from the task's context.
//   2. For anything still NULL, peek at the .videoscans/<filename> JSON on disk — if a
//      newer scan.mjs already stamped batchId/batchLabel into the file, surface it.
//
// Idempotent: only touches rows where batch_id IS NULL. Pass `--dry-run` to preview.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const DRY_RUN = process.argv.includes('--dry-run');
const VIDEOSCAN_DIR = process.env.VIDEOSCAN_DIR || '.videoscans';
const JSON_LINE = /^JSON:\s*(.+\.json)\s*$/m;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}
const sb = createClient(supabaseUrl, supabaseKey);

console.log(`backfill-videoscan-batches  (${DRY_RUN ? 'DRY RUN' : 'live'})`);
console.log(`videoscan dir: ${VIDEOSCAN_DIR}\n`);

// 1. Pull every videoscans row missing batch info (including archived).
const { data: rows, error: rowsErr } = await sb
  .from('videoscans')
  .select('filename, batch_id, batch_label, archived')
  .is('batch_id', null);
if (rowsErr) { console.error(rowsErr.message); process.exit(1); }
console.log(`videoscans rows with NULL batch_id: ${rows.length}`);
if (rows.length === 0) { console.log('nothing to do.'); process.exit(0); }

// 2. Pull every videoscan task with a batchId set, build filename → {batchId, batchLabel}.
const { data: tasks, error: tasksErr } = await sb
  .from('tasks')
  .select('id, context, result')
  .eq('type', 'videoscan')
  .not('context->>batchId', 'is', null);
if (tasksErr) { console.error(tasksErr.message); process.exit(1); }
console.log(`videoscan tasks with batchId: ${tasks.length}`);

const byFilename = new Map();
let tasksWithoutResult = 0;
let tasksWithoutJsonLine = 0;
for (const t of tasks) {
  const batchId = t.context?.batchId;
  const batchLabel = t.context?.batchLabel ?? null;
  if (!batchId) continue;
  if (!t.result) { tasksWithoutResult++; continue; }
  const m = t.result.match(JSON_LINE);
  if (!m) { tasksWithoutJsonLine++; continue; }
  const filename = m[1].trim();
  // Don't overwrite an earlier task's mapping (rare — same filename written twice).
  if (!byFilename.has(filename)) byFilename.set(filename, { batchId, batchLabel, taskId: t.id });
}
console.log(`  filename map size: ${byFilename.size} (skipped ${tasksWithoutResult} no-result, ${tasksWithoutJsonLine} no-JSON-line)\n`);

// 3. For each NULL row, decide a source.
const updates = [];
let matchedFromTasks = 0;
let matchedFromDisk = 0;
let stillUnmatched = 0;
const unmatchedSamples = [];

for (const row of rows) {
  const fromTask = byFilename.get(row.filename);
  if (fromTask) {
    updates.push({ filename: row.filename, batch_id: fromTask.batchId, batch_label: fromTask.batchLabel, source: `task #${fromTask.taskId}` });
    matchedFromTasks++;
    continue;
  }
  // Disk fallback: a newer scan.mjs may have stamped batchId into the JSON itself,
  // even if the row didn't get those columns at upsert time.
  const path = join(VIDEOSCAN_DIR, row.filename);
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      if (typeof data.batchId === 'string' && data.batchId) {
        updates.push({
          filename: row.filename,
          batch_id: data.batchId,
          batch_label: typeof data.batchLabel === 'string' ? data.batchLabel : null,
          source: 'disk JSON',
        });
        matchedFromDisk++;
        continue;
      }
    } catch { /* unreadable JSON — fall through */ }
  }
  stillUnmatched++;
  if (unmatchedSamples.length < 5) unmatchedSamples.push(row.filename);
}

console.log(`matched from tasks:  ${matchedFromTasks}`);
console.log(`matched from disk:   ${matchedFromDisk}`);
console.log(`still unmatched:     ${stillUnmatched}`);
if (unmatchedSamples.length > 0) {
  console.log(`  examples: ${unmatchedSamples.join(', ')}`);
}
console.log('');

if (updates.length === 0) { console.log('no updates to apply.'); process.exit(0); }

if (DRY_RUN) {
  console.log('DRY RUN — would update:');
  for (const u of updates.slice(0, 20)) {
    console.log(`  ${u.filename}  ←  ${u.batch_id}  (${u.source})`);
  }
  if (updates.length > 20) console.log(`  … and ${updates.length - 20} more`);
  process.exit(0);
}

// 4. Apply updates one row at a time. Volume is small (hundreds at most) and this keeps
// errors per-row rather than aborting the whole batch.
let applied = 0;
let failed = 0;
for (const u of updates) {
  const { error } = await sb
    .from('videoscans')
    .update({ batch_id: u.batch_id, batch_label: u.batch_label })
    .eq('filename', u.filename);
  if (error) { failed++; console.error(`  FAIL ${u.filename}: ${error.message}`); continue; }
  applied++;
}
console.log(`\napplied: ${applied}  failed: ${failed}`);
