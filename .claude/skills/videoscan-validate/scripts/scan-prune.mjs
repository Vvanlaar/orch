#!/usr/bin/env node
// Phase 3b — drop confirmed false-positive detections from scan JSONs and
// recompute the counts, so an existing report can be regenerated without
// re-crawling. Run this ONLY after a browser check proved the pages have no
// such player.
//
//   node scan-prune.mjs <file|batch|domain> --player Kaltura [--evidence kwidget]
//                       [--url-contains /nieuws] [--apply]
//
// Default is a dry run. --apply rewrites the JSONs (a .bak copy is kept) and
// prints which reports to regenerate.

import { copyFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readJson, resolveTarget, videoscanDir } from './lib.mjs';

const VALUE_FLAGS = new Set(['--player', '--evidence', '--url-contains']);
const opts = {};
let target;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_FLAGS.has(a)) opts[a.slice(2)] = args[++i];
  else if (a === '--apply') opts.apply = true;
  else if (!a.startsWith('--')) target ??= a;
}
const { player, evidence, 'url-contains': urlContains, apply } = opts;

if (!target || !player) {
  console.error('usage: scan-prune.mjs <file|batch|domain> --player <name> [--evidence <substr>] [--url-contains <substr>] [--apply]');
  process.exit(2);
}

const dir = videoscanDir();
const { scans } = resolveTarget(target, dir);

// Plan every file first, write nothing until all of them parse cleanly — a
// half-applied prune across a batch is far harder to undo than no prune.
const planned = [];

for (const s of scans) {
  const path = join(dir, s.filename);
  const data = readJson(path);
  if (!Array.isArray(data.details)) continue;

  let dropped = 0;
  let pagesLost = 0;
  const kept = [];
  for (const row of data.details) {
    if (!Array.isArray(row?.players)) { kept.push(row); continue; }
    if (urlContains && !row.url.includes(urlContains)) { kept.push(row); continue; }
    const before = row.players.length;
    const players = row.players.filter(p => {
      if (p.name !== player) return true;
      if (evidence && !(p.evidence || []).some(e => e.toLowerCase().includes(evidence.toLowerCase()))) return true;
      return false;
    });
    dropped += before - players.length;
    // A page whose only player was the false positive is no longer a page with
    // video — it must leave `details`, or pagesWithVideo keeps counting it.
    if (players.length) kept.push(before === players.length ? row : { ...row, players });
    else if (before > 0) pagesLost++;
    else kept.push(row);
  }
  if (!dropped) continue;

  const playerMap = new Map();
  for (const row of kept) {
    for (const p of row.players || []) {
      const e = playerMap.get(p.name) || { count: 0, pages: [] };
      e.count++;
      e.pages.push(row.url);
      playerMap.set(p.name, e);
    }
  }

  const next = {
    ...data,
    details: kept,
    pagesWithVideo: kept.length,
    uniquePlayers: playerMap.size,
    playerSummary: Object.fromEntries([...playerMap]),
  };

  planned.push({ file: s.filename, path, isSummary: !!s.isSummary, data, next, dropped, pagesLost, playerMap });
}

if (!planned.length) {
  console.log(`No "${player}" detections matched — nothing to prune.`);
  process.exit(0);
}

for (const p of planned) {
  console.log(`${p.file}${p.isSummary ? '  (batch summary)' : ''}`);
  console.log(`  detections dropped: ${p.dropped}`);
  console.log(`  pagesWithVideo: ${p.data.pagesWithVideo} → ${p.next.pagesWithVideo}`);
  console.log(`  players: ${Object.keys(p.data.playerSummary || {}).length} → ${p.playerMap.size}${Object.keys(p.data.playerSummary || {}).includes(player) && !p.playerMap.has(player) ? ` (${player} gone)` : ''}`);
  if (apply) {
    if (!existsSync(`${p.path}.bak`)) copyFileSync(p.path, `${p.path}.bak`);
    writeFileSync(p.path, JSON.stringify(p.next, null, 2));
  }
}

// A batch summary holds a copy of every member's rows, so adding its numbers to
// the members' would report each correction twice. Count the sources; mention
// the summary separately.
const sources = planned.filter(p => !p.isSummary);
const summaries = planned.filter(p => p.isSummary);
const totalDropped = sources.reduce((n, p) => n + p.dropped, 0);
const totalPagesLost = sources.reduce((n, p) => n + p.pagesLost, 0);

console.log(`\n${apply ? 'Applied' : 'Dry run'}: ${totalDropped} detection(s) across ${sources.length} scan file(s); ${totalPagesLost} page(s) no longer count as having video.`);
if (summaries.length) console.log(`Plus ${summaries.length} batch summary file(s), already corrected in this run — their rows are copies of the above, not extra findings.`);
if (!apply) {
  console.log('Re-run with --apply to write (a .bak is kept per file).');
} else {
  console.log('\nNow regenerate the reports so the HTML/PDF match the JSON:');
  for (const p of planned) {
    console.log(`  curl -s -X POST -H "Authorization: Bearer $ORCH_TOKEN" -H 'Content-Type: application/json' \\`);
    console.log(`    -d '{"filename":"${p.file}"}' http://127.0.0.1:3011/api/videoscans/generate-report`);
  }
  console.log('  …and POST /api/videoscans/sync for each file to push the corrected row to Supabase.');
  console.log('  Do NOT re-run wrap-up to rebuild the summary: a same-domain duplicate still holding');
  console.log('  the pruned rows wins the merge (most players per URL) and resurrects them.');
}
