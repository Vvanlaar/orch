#!/usr/bin/env node
// Block until a batch started by scan-start.mjs has nothing pending or running.
//
//   node scan-watch.mjs <batchId> [--interval SEC] [--once]
//
// Meant to run in the background: it prints a line whenever the counts change
// and exits when the batch settles. Exit 0 = every scan completed; 1 = settled
// with failed/dismissed scans; 3 = only paused tasks are left (someone has to
// resume or stop them); 4 = the server stopped answering; 2 = usage, or the
// server refused the request. --once prints the state and exits 0 while the
// batch is still busy.

import { api, fail, parseArgs, readManifest } from './api.mjs';

const { target: batchId, flags } = parseArgs(process.argv.slice(2), { '--interval': 'value', '--once': 'bool' },
  'usage: scan-watch.mjs <batchId> [--interval SEC] [--once]');
const once = !!flags['--once'];
const intervalSec = Number(flags['--interval'] ?? 60);
// A NaN or 0 interval turns the loop into a flood of requests at a live service.
if (!Number.isFinite(intervalSec) || intervalSec < 5) fail('--interval must be at least 5 seconds');
const interval = intervalSec * 1000;

// Two sources, because each misses something. The launch manifest: /api/tasks
// lists the 100 newest tasks only, so a batch can scroll out of it while its
// last crawl still runs. /api/tasks: a resume or retry (the service does both
// on its own after a restart) fails the original task and creates a NEW one in
// the same batch, which no manifest knows about.
const known = new Set(readManifest(batchId)?.tasks.map(t => t.taskId) ?? []);

const stamp = () => new Date().toTimeString().slice(0, 5);
const MAX_MISSES = 10;
let last = '';
let misses = 0;

for (;;) {
  let tasks;
  try {
    const listed = new Map((await api('/api/tasks')).map(t => [t.id, t]));
    for (const t of listed.values()) if (t.context?.batchId === batchId) known.add(t.id);
    if (!known.size) fail(`No tasks known for batch "${batchId}" — no launch manifest and nothing in /api/tasks`);
    // One by one only for what the list no longer shows: a task row carries its
    // whole output, and fifty of those per poll is real load on a busy service.
    tasks = (await Promise.all([...known].map(id => listed.get(id) ?? api(`/api/tasks/${id}`).catch(err => {
      if (err.status !== 404) throw err;
      known.delete(id); // deleted since launch (a pending task replaced by a re-capped one)
      return null;
    })))).filter(Boolean);
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

  // A failed task whose scan was started again later is history, not an outcome.
  const scanKey = (t) => (t.context?.urls?.length ? t.context.urls.join(' ') : t.context?.scanUrl) || `#${t.id}`;
  const newest = new Map();
  for (const t of tasks) if (!newest.has(scanKey(t)) || newest.get(scanKey(t)) < t.id) newest.set(scanKey(t), t.id);
  const current = tasks.filter(t => newest.get(scanKey(t)) === t.id);

  const by = {};
  for (const t of current) (by[t.status] ??= []).push(t);
  const line = Object.entries(by).map(([s, l]) => `${l.length} ${s}`).join(', ');
  if (line !== last) {
    const running = (by.running || []).map(t => { try { return new URL(t.context.scanUrl).hostname; } catch { return `#${t.id}`; } }).join(' ');
    console.log(`${stamp()}  ${line}${running ? `  — running: ${running}` : ''}`);
    last = line;
  }

  const busy = (by.pending?.length || 0) + (by.running?.length || 0);
  if (!busy || once) {
    for (const t of current.filter(t => !['completed', 'pending', 'running'].includes(t.status))) {
      console.log(`  ${t.status}  #${t.id}  ${t.context?.scanUrl}${t.error ? `  — ${String(t.error).slice(0, 160)}` : ''}`);
    }
    if (busy) process.exit(0);
    if (by.paused?.length) { console.log('Only paused tasks left — resume or stop them; the batch cannot settle on its own.'); process.exit(3); }
    const clean = (by.completed?.length || 0) === current.length;
    console.log(clean ? 'Batch settled — every scan completed.' : 'Batch settled — not every scan completed, see above.');
    process.exit(clean ? 0 : 1);
  }
  await sleep(interval);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
