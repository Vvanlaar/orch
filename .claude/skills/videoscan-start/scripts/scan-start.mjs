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
//   --apply               create the tasks; without it this is a dry run
//
// Always prints what else is open on the server first. A DigiToegankelijk
// organisation becomes one batch, planned the way the dashboard's import does;
// a plain site URL becomes a single unbatched crawl.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { api, fail, parseArgs, writeManifest, OPEN_STATUSES } from './api.mjs';
import { videoscanDir, heartbeats } from '../../videoscan-validate/scripts/lib.mjs';

const USAGE = 'usage: scan-start.mjs <digitoegankelijk org url | org id | site url> [--shared h1,h2] [--shared-max-pages N] [--exclude h1,h2] [--max-pages N] [--delay MS] [--title "…"] [--cover <url>] [--apply]';
const { target, flags } = parseArgs(process.argv.slice(2), {
  '--shared': 'value', '--shared-max-pages': 'value', '--exclude': 'value', '--max-pages': 'value',
  '--delay': 'value', '--title': 'value', '--cover': 'value', '--apply': 'bool',
}, USAGE);
const maxPages = Number(flags['--max-pages'] ?? 20000);
const sharedMaxPages = Number(flags['--shared-max-pages'] ?? 499);
const delay = Number(flags['--delay'] ?? 200);
const apply = !!flags['--apply'];
for (const [name, n] of [['--max-pages', maxPages], ['--shared-max-pages', sharedMaxPages]]) {
  if (!Number.isInteger(n) || n < 1) fail(`${name} must be a positive integer`);
}
if (!Number.isFinite(delay) || delay < 0) fail('--delay must be a number of milliseconds');

const bare = (host) => host.toLowerCase().replace(/^www\./, '');
const hostList = (v) => new Set((v || '').split(',').map(h => bare(h.trim())).filter(Boolean));
const excluded = hostList(flags['--exclude']);
const shared = hostList(flags['--shared']);

// ── What else is the server doing? ──
// /api/tasks returns the 100 newest tasks only, so an open task older than that
// is not listed here; scan-status.mjs (heartbeats) is the check for live crawls.
const tasks = await api('/api/tasks');
const open = tasks.filter(t => OPEN_STATUSES.includes(t.status));
console.log('── Open tasks on the server ──');
if (!open.length) console.log('  none');
for (const t of open) console.log(`  #${t.id}  ${t.type}  ${t.status}  ${t.context?.title || t.repo}${t.context?.batchLabel ? `  [${t.context.batchLabel}]` : ''}`);

// ── Plan ──
const digi = target.match(/^https?:\/\/dashboard\.digitoegankelijk\.nl\/organisaties\/(\d+)/) || target.match(/^(\d+)$/);
let plan; // [{ kind: 'crawl', url, maxPages } | { kind: 'urls', urls, domain }]
let batch = null;
let orgSlug = '';
const skipped = [];

if (digi) {
  const org = await api('/api/videoscans/import-digitoegankelijk', { id: Number(digi[1]) });
  console.log(`\n── DigiToegankelijk organisation ${digi[1]}: ${org.orgName} ──`);
  console.log(`  ${org.totalSites} sites on ${org.groups.length} domains, ${org.skippedApps} apps skipped`);
  orgSlug = org.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'import';
  // Same id and label shape as VideoscanPage.svelte's handleBulkStart, so the
  // batch groups and wraps up in the dashboard like one started there.
  batch = { batchId: `digi-${orgSlug}-${Date.now()}`, batchLabel: `Digi import — ${org.orgName}` };
  plan = [];
  for (const group of org.groups) {
    const urls = group.sites.map(s => s.url).filter(u => {
      const keep = !excluded.has(bare(new URL(u).hostname));
      if (!keep) skipped.push(u);
      return keep;
    });
    const { crawls, explicit } = classifyGroupUrls(urls);
    for (const url of crawls) plan.push(crawl(url));
    if (explicit.length) plan.push({ kind: 'urls', urls: explicit, domain: group.rootDomain });
  }
} else {
  let url;
  try { url = new URL(/^https?:\/\//.test(target) ? target : `https://${target}`).href; } catch { fail(`Not a URL or organisation id: ${target}`); }
  plan = [crawl(url)];
}

const crawlHosts = new Set(plan.filter(p => p.kind === 'crawl').map(p => bare(new URL(p.url).hostname)));
const planHosts = new Set([...crawlHosts, ...skipped.map(u => bare(new URL(u).hostname))]);
const strangers = [...excluded].filter(h => !planHosts.has(h)).concat([...shared].filter(h => !crawlHosts.has(h)));
if (strangers.length) fail(`--exclude / --shared name hosts that are not a crawl in this plan: ${strangers.join(', ')}`);

console.log(`\n── Plan: ${plan.length} tasks, max ${maxPages} pages per crawl, delay ${delay}ms ──`);
const dir = videoscanDir();
const live = new Set(heartbeats(dir).filter(h => h.live && h.hostname).map(h => bare(h.hostname)));
for (const p of plan) {
  if (p.kind === 'urls') { console.log(`  pages  ${p.domain}: ${p.urls.join('  ')}`); continue; }
  const host = bare(new URL(p.url).hostname);
  const cap = p.maxPages === maxPages ? '' : `  (shared — max ${p.maxPages} pages)`;
  // Only a hint: the organisation's own tenant on a supplier platform fails
  // this test too, and so does a project site with a name of its own.
  const hint = orgSlug && !cap && !host.includes(orgSlug.replace(/-/g, '')) && !host.includes(orgSlug) ? '  ? name does not carry the organisation — shared site?' : '';
  console.log(`  crawl  ${p.url}${cap}${hint}${checkpointNote(host)}`);
}
for (const u of skipped) console.log(`  skip   ${u}  (--exclude)`);

if (!apply) {
  console.log('\nDry run — nothing started. Re-run with --apply to create the tasks.');
  process.exit(0);
}

// ── Launch ──
const started = [];
const errors = [];
for (const p of plan) {
  try {
    const r = p.kind === 'crawl'
      ? await api('/api/actions/start-videoscan', { url: p.url, maxPages: p.maxPages, delay, ...(batch || {}) })
      : await api('/api/actions/start-videoscan-urls', { urls: p.urls, maxPages, delay, ...(batch || {}) });
    started.push({ taskId: r.taskId, kind: p.kind, target: p.kind === 'crawl' ? p.url : p.urls.join(' '), ...(p.kind === 'crawl' ? { maxPages: p.maxPages } : {}) });
  } catch (err) {
    errors.push(`${p.kind === 'crawl' ? p.url : p.domain}: ${err.message}`);
  }
}

console.log(`\nStarted ${started.length}/${plan.length} tasks${started.length ? ` (#${started[0].taskId}–#${started.at(-1).taskId})` : ''}`);
for (const e of errors) console.log(`  FAILED to start  ${e}`);
if (started.length) {
  const report = { ...(flags['--title'] ? { title: flags['--title'] } : {}), ...(flags['--cover'] ? { cover: flags['--cover'] } : {}) };
  const manifest = { ...(batch || { batchId: `single-${started[0].taskId}`, batchLabel: target }), target, maxPages, delay, startedAt: new Date().toISOString(), tasks: started, skipped, report };
  writeManifest(manifest);
  console.log(`batch: ${manifest.batchId}`);
  console.log(`watch: node .claude/skills/videoscan-start/scripts/scan-watch.mjs ${manifest.batchId}`);
}
process.exit(errors.length ? 1 : 0);

function crawl(url) {
  return { kind: 'crawl', url, maxPages: shared.has(bare(new URL(url).hostname)) ? sharedMaxPages : maxPages };
}

/**
 * Per host: its root URL is a crawl seed, anything else is scanned as the
 * listed pages only (a login page or one municipality's path on a supplier's
 * domain is not a reason to crawl the whole host). Mirrors classifyGroupUrls in
 * src/dashboard/stores/videoscan.svelte.ts — keep the two in step.
 */
function classifyGroupUrls(urls) {
  const buckets = new Map();
  for (const u of urls) {
    const host = bare(new URL(u).hostname);
    if (!buckets.has(host)) buckets.set(host, []);
    buckets.get(host).push(u);
  }
  const crawls = [];
  const explicit = [];
  for (const bucketUrls of buckets.values()) {
    const root = bucketUrls.find(u => new URL(u).pathname === '/');
    if (root) crawls.push(root);
    else explicit.push(...bucketUrls);
  }
  return { crawls, explicit };
}

/**
 * scan.mjs checkpoints to one fixed name per host, so a fresh crawl overwrites
 * whatever an earlier crawl of that host left behind — and two crawls of one
 * host at once write over each other.
 */
function checkpointNote(host) {
  if (live.has(host)) return '\n         ! a crawl of this host is LIVE right now — a second one fights it over the same checkpoint file';
  const file = join(dir, `videoscan-${host}-INPROGRESS.json`);
  if (!existsSync(file)) return '';
  try {
    const d = JSON.parse(readFileSync(file, 'utf-8'));
    return `\n         ! overwrites a stopped crawl's checkpoint: ${d.pagesScanned ?? '?'} scanned, ${d._state?.queue?.length ?? '?'} queued, ${d.details?.length ?? '?'} with video (${(d.scanDate || '').slice(0, 10)})`;
  } catch {
    return '\n         ! overwrites an unreadable INPROGRESS checkpoint';
  }
}
