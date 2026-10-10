#!/usr/bin/env node
// Plan and launch a videoscan on the running orch service.
//
//   node scan-start.mjs <digitoegankelijk org url | org id | site url> [options]
//
//   --shared host,host    sites that are not this organisation's alone: crawled,
//                         but only up to --shared-max-pages (www. ignored)
//   --shared-max-pages N  default 499
//   --exclude host,host   leave these hosts out altogether
//   --max-pages N         per crawl task (default 20000, the dashboard's default)
//   --delay MS            per-request delay (default 200)
//   --title "Gemeente X"  report title, kept in the launch manifest for scan-report.mjs
//   --cover <image url>   report cover image, likewise
//   --batch <batchId>     site URL only: add the crawl to a batch scan-start launched
//                         earlier (a site the import missed, a redirect's target)
//   --apply               create the tasks; without it this is a dry run
//
// Always prints what else is open on the server first. A DigiToegankelijk
// organisation becomes one batch, planned the way the dashboard's import does;
// a plain site URL becomes a batch of one crawl, so the later steps (watch,
// re-scan, report) find it the same way.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { api, fail, parseArgs, readManifest, writeManifest, OPEN_STATUSES } from './api.mjs';
import { bare, buildPlan } from './logic.mjs';
import { videoscanDir, heartbeats } from '../../videoscan-validate/scripts/lib.mjs';

const USAGE = 'usage: scan-start.mjs <digitoegankelijk org url | org id | site url> [--shared h1,h2] [--shared-max-pages N] [--exclude h1,h2] [--max-pages N] [--delay MS] [--title "…"] [--cover <url>] [--batch <batchId>] [--apply]';
const { target, flags } = parseArgs(process.argv.slice(2), {
  '--shared': 'value', '--shared-max-pages': 'value', '--exclude': 'value', '--max-pages': 'value',
  '--delay': 'value', '--title': 'value', '--cover': 'value', '--batch': 'value', '--apply': 'bool',
}, USAGE);
const maxPages = Number(flags['--max-pages'] ?? 20000);
const sharedMaxPages = Number(flags['--shared-max-pages'] ?? 499);
const delay = Number(flags['--delay'] ?? 200);
const apply = !!flags['--apply'];
for (const [name, n] of [['--max-pages', maxPages], ['--shared-max-pages', sharedMaxPages]]) {
  if (!Number.isInteger(n) || n < 1) fail(`${name} must be a positive integer`);
}
if (!Number.isFinite(delay) || delay < 0) fail('--delay must be a number of milliseconds');

const hostList = (v) => new Set((v || '').split(',').map(h => bare(h.trim())).filter(Boolean));
const excluded = hostList(flags['--exclude']);
const shared = hostList(flags['--shared']);

// ── What else is the server doing? ──
// /api/tasks returns the 100 newest tasks only, so an open task older than that
// is not listed here; scan-status.mjs (heartbeats) is the check for live crawls.
const tasks = await api('/api/tasks');
const open = tasks.filter(t => OPEN_STATUSES.includes(t.status));
console.log(`── Open tasks on the server (of the ${tasks.length} newest) ──`);
if (!open.length) console.log('  none');
for (const t of open) console.log(`  #${t.id}  ${t.type}  ${t.status}  ${t.context?.title || t.repo}${t.context?.batchLabel ? `  [${t.context.batchLabel}]` : ''}`);

// ── Plan ──
const digi = target.match(/^https?:\/\/dashboard\.digitoegankelijk\.nl\/organisaties\/(\d+)/) || target.match(/^(\d+)$/);
let groups;
let batch;
let orgSlug = '';
// --batch: the batch this crawl joins, as its launch manifest describes it.
const joined = flags['--batch'] ? readManifest(flags['--batch']) : null;
if (flags['--batch'] && (digi || !joined)) fail(digi ? '--batch adds one site to a batch; it takes a site URL, not an organisation' : `No launch manifest for batch "${flags['--batch']}"`);

if (digi) {
  const org = await api('/api/videoscans/import-digitoegankelijk', { id: Number(digi[1]) });
  console.log(`\n── DigiToegankelijk organisation ${digi[1]}: ${org.orgName} ──`);
  console.log(`  ${org.totalSites} sites on ${org.groups.length} domains, ${org.skippedApps} apps skipped`);
  groups = org.groups;
  orgSlug = org.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'import';
  // Same id and label shape as VideoscanPage.svelte's handleBulkStart, so the
  // batch groups and wraps up in the dashboard like one started there.
  batch = { batchId: `digi-${orgSlug}-${Date.now()}`, batchLabel: `Digi import — ${org.orgName}` };
} else {
  let url;
  try { url = new URL(/^https?:\/\//.test(target) ? target : `https://${target}`); } catch { fail(`Not a URL or organisation id: ${target}`); }
  const host = bare(url.hostname);
  groups = [{ rootDomain: host, sites: [{ url: url.href }] }];
  batch = joined ? { batchId: joined.batchId, batchLabel: joined.batchLabel } : { batchId: `site-${host}-${Date.now()}`, batchLabel: `Site — ${host}` };
}

const { plan, skipped, unknown } = buildPlan(groups, { excluded, shared, maxPages, sharedMaxPages });
if (unknown.length) fail(`--exclude / --shared name hosts this plan does not crawl: ${unknown.join(', ')}`);

console.log(`\n── Plan: ${plan.length} tasks, max ${maxPages} pages per crawl, delay ${delay}ms ──`);
const dir = videoscanDir();
const live = new Set(heartbeats(dir).filter(h => h.live && h.hostname).map(h => bare(h.hostname)));
const liveInPlan = [];
for (const p of plan) {
  if (p.kind === 'urls') { console.log(`  pages  ${p.domain}: ${p.urls.join('  ')}`); continue; }
  const host = bare(new URL(p.url).hostname);
  if (live.has(host)) liveInPlan.push(host);
  const cap = p.maxPages === maxPages ? '' : `  (shared — max ${p.maxPages} pages)`;
  // Only a hint: the organisation's own tenant on a supplier platform fails
  // this test too, and so does a project site with a name of its own. And the
  // import's organisation name can itself be a supplier's domain, or
  // "Organisation <id>", in which case every line gets the hint.
  const hint = orgSlug && !cap && !host.includes(orgSlug.replace(/-/g, '')) && !host.includes(orgSlug) ? '  ? name does not carry the organisation — shared site?' : '';
  console.log(`  crawl  ${p.url}${cap}${hint}${checkpointNote(host)}`);
}
for (const u of skipped) console.log(`  skip   ${u}  (--exclude)`);

if (!apply) {
  console.log('\nDry run — nothing started. Re-run with --apply to create the tasks.');
  process.exit(0);
}
// Two crawls of one host write the same checkpoint file and take each other's
// result for their own.
if (liveInPlan.length) fail(`Not started: a crawl of ${liveInPlan.join(', ')} is running right now. Wait for it, or leave the host out with --exclude.`, 1);

// ── Launch ──
const started = [];
const notStarted = [];
for (const p of plan) {
  const what = p.kind === 'crawl' ? p.url : p.urls.join(' ');
  try {
    const r = p.kind === 'crawl'
      ? await api('/api/actions/start-videoscan', { url: p.url, maxPages: p.maxPages, delay, ...batch })
      : await api('/api/actions/start-videoscan-urls', { urls: p.urls, maxPages, delay, ...batch });
    if (!Number.isInteger(r.taskId)) throw new Error(`no task id in the reply: ${JSON.stringify(r).slice(0, 120)}`);
    started.push({ taskId: r.taskId, kind: p.kind, target: what, ...(p.kind === 'crawl' ? { maxPages: p.maxPages } : {}) });
  } catch (err) {
    notStarted.push({ target: what, error: err.message });
  }
}

console.log(`\nStarted ${started.length}/${plan.length} tasks${started.length ? ` (#${started[0].taskId}–#${started.at(-1).taskId})` : ''}`);
for (const n of notStarted) console.log(`  FAILED to start  ${n.target}: ${n.error}`);
if (started.length || (joined && notStarted.length)) {
  const report = { ...(flags['--title'] ? { title: flags['--title'] } : {}), ...(flags['--cover'] ? { cover: flags['--cover'] } : {}) };
  // notStarted goes in too: the watcher has no other way to know the batch is
  // short of sites, and would call it complete.
  // Re-read when joining: the watcher and scan-report write to the manifest too.
  const base = flags['--batch'] ? readManifest(flags['--batch']) : null;
  writeManifest(base
    ? { ...base, tasks: [...base.tasks, ...started], notStarted: [...(base.notStarted ?? []), ...notStarted] }
    : { ...batch, target, maxPages, delay, startedAt: new Date().toISOString(), tasks: started, skipped, notStarted, report });
  console.log(`batch: ${batch.batchId}`);
  console.log(`watch: node .claude/skills/videoscan-start/scripts/scan-watch.mjs ${batch.batchId}`);
}
process.exit(notStarted.length ? 1 : 0);

/**
 * scan.mjs checkpoints to one fixed name per host, so a fresh crawl overwrites
 * whatever an earlier crawl of that host left behind.
 */
function checkpointNote(host) {
  if (live.has(host)) return '\n         ! a crawl of this host is LIVE right now — --apply will refuse';
  const file = join(dir, `videoscan-${host}-INPROGRESS.json`);
  if (!existsSync(file)) return '';
  try {
    const d = JSON.parse(readFileSync(file, 'utf-8'));
    return `\n         ! overwrites a stopped crawl's checkpoint: ${d.pagesScanned ?? '?'} scanned, ${d._state?.queue?.length ?? '?'} queued, ${d.details?.length ?? '?'} with video (${(d.scanDate || '').slice(0, 10)})`;
  } catch {
    return '\n         ! overwrites an unreadable INPROGRESS checkpoint';
  }
}
