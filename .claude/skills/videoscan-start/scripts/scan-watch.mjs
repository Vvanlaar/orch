#!/usr/bin/env node
// Block until a batch started by scan-start.mjs has nothing pending or running.
//
//   node scan-watch.mjs <batchId> [--interval SEC] [--step N] [--once]
//
// Meant to run in the background: it prints a line whenever the counts change
// and exits when the batch settles. Exit 0 = every scan completed; 1 = settled
// with failed/dismissed scans, or with sites that never started; 3 = only
// paused tasks are left (someone has to resume or stop them); 4 = the server
// stopped answering; 2 = usage, the server refused the request, or the batch
// has no tasks. --once prints the state and exits 0 while the batch is still
// busy. --step N exits 10 as soon as N scans have completed that no earlier
// --step run named — the cue to validate those and start the watcher again.

import { api, fail, parseArgs, readManifest, writeManifest } from './api.mjs';
import { settle, taskLabel } from './logic.mjs';

const { target: batchId, flags } = parseArgs(process.argv.slice(2), { '--interval': 'value', '--step': 'value', '--once': 'bool' },
  'usage: scan-watch.mjs <batchId> [--interval SEC] [--step N] [--once]');
const once = !!flags['--once'];
const step = flags['--step'] === undefined ? 0 : Number(flags['--step']);
if (!Number.isInteger(step) || step < 0) fail('--step must be a whole number');
const intervalSec = Number(flags['--interval'] ?? 60);
// A NaN or 0 interval turns the loop into a flood of requests at a live service.
if (!Number.isFinite(intervalSec) || intervalSec < 5) fail('--interval must be at least 5 seconds');
const interval = intervalSec * 1000;

// Two sources, because each misses something. The launch manifest: /api/tasks
// lists the 100 newest tasks only, so a batch can scroll out of it while its
// last crawl still runs. /api/tasks: a crawl the service lost in a restart is
// resumed as a NEW task in the same batch, and so are a manual resume or retry
// and the re-scans of scan-retry-failed.mjs — none of them in the manifest.
const known = new Set();
// A finished task's row cannot change, and it carries its whole output: once
// it has scrolled out of the list, fetch it one last time and keep it.
const finished = new Map();
const FINAL = ['completed', 'failed', 'dismissed'];

const stamp = () => new Date().toTimeString().slice(0, 5);
const MAX_MISSES = 10;
let last = '';
let misses = 0;
let baseline = null;

for (;;) {
  let tasks;
  const manifest = readManifest(batchId);
  try {
    for (const t of manifest?.tasks ?? []) known.add(t.taskId);
    const listed = new Map((await api('/api/tasks')).map(t => [t.id, t]));
    for (const t of listed.values()) if (t.context?.batchId === batchId) known.add(t.id);
    tasks = (await Promise.all([...known].map(async id => {
      const t = listed.get(id) ?? finished.get(id) ?? await api(`/api/tasks/${id}`).catch(err => {
        if (err.status !== 404) throw err;
        known.delete(id); // deleted since launch (a pending task replaced by a re-capped one)
        return null;
      });
      if (t && FINAL.includes(t.status)) finished.set(id, { id: t.id, status: t.status, context: t.context, error: t.error });
      return t;
    }))).filter(Boolean);
    misses = 0;
  } catch (err) {
    // The server answered and said no (wrong scope, bad token): waiting will not fix that.
    if (err.status && err.status < 500) fail(`${stamp()}  ${err.message}`);
    // A service restart drops a few polls; only a long silence is a verdict.
    if (++misses >= MAX_MISSES) fail(`${stamp()}  server unreachable for ${MAX_MISSES} polls: ${err.message}`, 4);
    if (misses === 1) console.log(`${stamp()}  poll failed, retrying: ${err.message}`);
    if (once) process.exit(4);
    await sleep(interval);
    continue;
  }

  const { current, by, busy, verdict } = settle(tasks);
  // No task at all is a wrong batch id, a wrong server or a wiped task table —
  // anything but a batch that finished.
  if (verdict === 'empty') fail(`No tasks found for batch "${batchId}" — wrong batch id, or not the server it was started on`);

  const line = Object.entries(by).map(([s, l]) => `${l.length} ${s}`).join(', ');
  if (line !== last) {
    const running = (by.running || []).map(taskLabel).join(' ');
    console.log(`${stamp()}  ${line}${running ? `  — running: ${running}` : ''}`);
    last = line;
  }

  if (!busy || once) {
    for (const t of current.filter(t => !['completed', 'pending', 'running'].includes(t.status))) {
      console.log(`  ${t.status}  #${t.id}  ${taskLabel(t)}${t.error ? `  — ${String(t.error).slice(0, 160)}` : ''}`);
    }
    const notStarted = manifest?.notStarted ?? [];
    for (const n of notStarted) console.log(`  never started  ${n.target}  — ${n.error}`);
    if (busy) process.exit(0);
    if (verdict === 'paused') { console.log('Only paused tasks left — resume or stop them; the batch cannot settle on its own.'); process.exit(3); }
    const clean = verdict === 'clean' && !notStarted.length;
    console.log(clean ? 'Batch settled — every scan completed.' : 'Batch settled — not every scan completed, see above.');
    process.exit(clean ? 0 : 1);
  }

  if (step) {
    // Remembered in the manifest, not in this process: scans that finish while
    // the previous step is being validated must still be named by the next run.
    // Without a manifest there is nowhere to remember: count from this run's start.
    baseline ??= (by.completed || []).map(t => t.id);
    const named = new Set(manifest ? manifest.named ?? [] : baseline);
    const fresh = (by.completed || []).filter(t => !named.has(t.id));
    if (fresh.length >= step) {
      console.log(`${fresh.length} more scans completed: ${fresh.map(taskLabel).join(' ')}`);
      if (manifest) writeManifest({ ...readManifest(batchId), named: [...named, ...fresh.map(t => t.id)] });
      process.exit(10);
    }
  }
  await sleep(interval);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
