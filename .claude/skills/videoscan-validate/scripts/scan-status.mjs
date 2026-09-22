#!/usr/bin/env node
// Phase 1 — is this scan/batch finished, and is it safe to wrap up?
//
//   node scan-status.mjs                 # every open batch + everything live
//   node scan-status.mjs <batch|domain>  # one target
//
// Exit code 0 always; the verdict is in the output, not the status.

import { listScans, heartbeats, closedBatches, resolveTarget, videoscanDir, fmtAge } from './lib.mjs';

const target = process.argv[2];
const dir = videoscanDir();
const hb = heartbeats(dir);
const live = hb.filter(h => h.live);
const stale = hb.filter(h => !h.live);
const closed = closedBatches(dir);

console.log(`videoscans dir: ${dir}\n`);

console.log('── Running scans ──');
if (!live.length) console.log('  none (no heartbeat newer than 60s)');
for (const h of live) console.log(`  LIVE   task ${h.taskId}  ${h.hostname}  conc=${h.concurrency}  (${fmtAge(h.ageMs)} ago)`);
// Heartbeats are only deleted on a clean exit, so years of crashed runs pile up.
// The recent ones may still be today's problem; the rest are archaeology.
const RECENT = 24 * 60 * 60 * 1000;
const recentStale = stale.filter(h => (h.ageMs ?? Infinity) < RECENT);
for (const h of recentStale) console.log(`  stale  task ${h.taskId ?? '?'}  ${h.hostname ?? h.file}  last beat ${fmtAge(h.ageMs)} ago — crashed or killed, heartbeat never cleaned up`);
if (stale.length > recentStale.length) console.log(`  (+${stale.length - recentStale.length} heartbeat files older than a day — long-dead runs, ignore)`);

// A scan only carries its batch id if it was launched as part of one, and an
// ad-hoc run never gets one at all — so a live crawl can be invisible to the
// batch it belongs to until it exits and writes its final JSON. List them
// separately rather than pretending they are filed.
const allScans = listScans(dir);
const unfiled = allScans.filter(s => !s.batchId && s.filename.includes('INPROGRESS'));
if (unfiled.length) {
  console.log('\n── In-progress scans with no batch id ──');
  for (const s of unfiled) {
    const beat = hb.find(h => h.hostname === s.domain);
    const state = beat?.live ? 'LIVE' : beat ? `stopped ${fmtAge(beat.ageMs)} ago` : 'no heartbeat';
    console.log(`  ${s.domain}  ${s.pagesScanned} scanned, ${s.queued} queued  (${state})`);
  }
  console.log('  These belong to no batch on disk. If one covers a host in the batch you are');
  console.log('  about to wrap up, finish or stop it first — its exit write lands after the merge.');
}

const scans = target ? resolveTarget(target, dir).scans : allScans;
const batches = new Map();
for (const s of scans) {
  if (s.unreadable) continue;
  const id = s.batchId || '(ungrouped)';
  if (!batches.has(id)) batches.set(id, { label: s.batchLabel || id, scans: [] });
  batches.get(id).scans.push(s);
}

console.log('\n── Batches ──');
for (const [id, b] of [...batches].sort((a, b) => b[1].scans.length - a[1].scans.length)) {
  if (!target && id === '(ungrouped)') continue;
  const members = b.scans.filter(s => !s.isSummary);
  const summary = b.scans.find(s => s.isSummary);
  const resumable = members.filter(s => s.queued > 0);
  const empty = members.filter(s => s.pagesScanned === 0);
  const liveHere = live.filter(h => members.some(s => s.domain === h.hostname));
  const isClosed = closed.includes(id);

  console.log(`\n${isClosed ? '[closed]' : '[open]  '} ${b.label}  (${id})`);
  console.log(`  ${members.length} scans · ${members.reduce((n, s) => n + s.pagesScanned, 0)} pages · ${members.reduce((n, s) => n + s.pagesWithVideo, 0)} with video`);
  if (summary) console.log(`  summary: ${summary.filename}`);

  const blockers = [];
  if (liveHere.length) blockers.push(`${liveHere.length} scan(s) still running: ${liveHere.map(h => h.hostname).join(', ')}`);
  // `maxPages` is whatever the caller passed (the API defaults to 50), so a
  // round number is a hint that the run hit its own ceiling, not proof.
  for (const s of resumable) blockers.push(`${s.domain} has ${s.queued} URLs queued (${s.pagesScanned} scanned${s.pagesScanned % 1000 === 0 ? ` — looks like it stopped on its own --max-pages ${s.pagesScanned}` : ''})`);
  for (const s of empty) blockers.push(`${s.domain} scanned 0 pages — dead host or blocked`);
  for (const s of members.filter(s => s.failureRate > 0.2)) blockers.push(`${s.domain} failed ${Math.round(s.failureRate * 100)}% of requests`);

  const dupes = [...new Map(members.map(s => [s.domain, 0])).keys()]
    .filter(d => members.filter(s => s.domain === d).length > 1);
  for (const d of dupes) blockers.push(`${d} has ${members.filter(s => s.domain === d).length} scan files — wrap-up will merge them`);

  if (blockers.length) {
    for (const b2 of blockers) console.log(`  · ${b2}`);
  } else if (live.length) {
    // Never claim "ready" while anything crawls: an unfiled run can belong to
    // this batch without saying so, and only its exit write would reveal it.
    console.log(`  ~ no blocker found in this batch's files, but ${live.length} scan(s) are running`);
    console.log(`    (${live.map(h => h.hostname).join(', ')}) — confirm none of them is a host of this batch`);
  } else {
    console.log('  ✓ ready to wrap up — nothing running, no queue left');
  }
}

if (live.length) {
  console.log('\nNOTE: a scan writes its JSON on exit. Wrapping up a batch while one of its');
  console.log('      scans is still running lets that write land after the merge and undo it.');
  console.log('      Scans of OTHER batches are harmless — only same-batch hosts matter.');
}
