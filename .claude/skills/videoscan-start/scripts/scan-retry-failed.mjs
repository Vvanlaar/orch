#!/usr/bin/env node
// Re-scan the pages a batch's finished scans lost to timeouts, into the same file.
//
//   node scan-retry-failed.mjs <batchId>           # what failed, and how earlier retries went
//   node scan-retry-failed.mjs <batchId> --apply   # queue the re-scans
//
// A crawl records every page it could not load. Timeouts are mostly this machine
// (ten crawls at once) or a slow site, not a missing page — and a page that
// timed out is a page nobody checked for video. Each re-scan is an "add URLs"
// task: it scans just those pages and folds the result into the scan's own file.
//
// Run it while the batch is still crawling. The service builds the organisation
// report the moment the batch's last crawl finishes, from the files as they are
// then, and an add-URLs task is not part of the batch — nothing waits for it.

import { readFileSync } from 'fs';
import { join } from 'path';
import { api, fail, parseArgs, readManifest, writeManifest } from './api.mjs';
import { listScans, videoscanDir, isDerivedScan } from '../../videoscan-validate/scripts/lib.mjs';

const { target: batchId, flags } = parseArgs(process.argv.slice(2), { '--apply': 'bool' },
  'usage: scan-retry-failed.mjs <batchId> [--apply]');
const manifest = readManifest(batchId);
if (!manifest) fail(`No launch manifest for "${batchId}" — this needs a batch started by scan-start.mjs`);
manifest.retries ??= []; // [{ taskId, filename, urls }]

// Worth a second try: the page may well exist. An expired certificate, a dead
// host name or a refusal will fail the same way again.
const TRANSIENT = /Timeout|ERR_TIMED_OUT|ERR_CONNECTION_(RESET|CLOSED|TIMED_OUT)|ERR_NETWORK_CHANGED|ERR_EMPTY_RESPONSE|ERR_ABORTED|ERR_HTTP2_PROTOCOL_ERROR/i;
const MAX_URLS_PER_TASK = 100; // the endpoint's limit

// ── Earlier retries ──
if (manifest.retries.length) {
  console.log('── Earlier retries ──');
  for (const r of manifest.retries) {
    let t;
    try { t = await api(`/api/tasks/${r.taskId}`); } catch (err) { console.log(`  #${r.taskId}  ${r.filename}: ${err.message}`); continue; }
    // The re-scan's own file is deleted once merged, so the task output is the
    // only record of which of these pages failed a second time.
    const out = String(t.output || '');
    const stillFailing = r.urls.filter(u => new RegExp(`(fail|timeout|error)[^\\n]*${escapeRe(u)}|${escapeRe(u)}[^\\n]*(fail|timeout|error)`, 'i').test(out));
    const merged = out.match(/Merged successfully \(([^)]*)\)/)?.[1];
    console.log(`  #${r.taskId}  ${t.status}  ${r.filename}: ${r.urls.length} pages re-scanned${merged ? `, file now ${merged}` : ''}${t.status === 'completed' ? `, ${stillFailing.length} failed again` : ''}`);
    for (const u of stillFailing) console.log(`      still failing  ${u}`);
  }
  console.log('');
}

// ── What is there to retry ──
const dir = videoscanDir();
const retried = new Set(manifest.retries.map(r => r.filename));
const plan = [];
console.log('── Failed pages in finished scans ──');
for (const s of listScans(dir).filter(s => s.batchId === batchId && !s.unreadable && !isDerivedScan(s.filename) && !s.filename.includes('INPROGRESS'))) {
  if (!s.pagesFailed) continue;
  const failed = JSON.parse(readFileSync(join(dir, s.filename), 'utf-8')).failedUrls || [];
  const urls = failed.filter(f => TRANSIENT.test(f.error || '')).map(f => f.url);
  const rest = failed.length - urls.length;
  const state = retried.has(s.filename) ? 'already retried' : urls.length ? 'retry' : 'nothing a retry would fix';
  console.log(`  ${s.domain}: ${s.pagesFailed} of ${s.pagesScanned} failed — ${urls.length} transient${rest ? `, ${rest} permanent (${[...new Set(failed.filter(f => !TRANSIENT.test(f.error || '')).map(f => String(f.error).match(/ERR_\w+|Access refused|HTTP \d+/)?.[0] || 'other'))].join(', ')})` : ''}  [${state}]`);
  if (urls.length && !retried.has(s.filename)) plan.push({ filename: s.filename, urls });
}
if (!plan.length) { console.log('\nNothing to queue.'); process.exit(0); }

if (!flags['--apply']) {
  console.log(`\nDry run — ${plan.reduce((n, p) => n + p.urls.length, 0)} pages in ${plan.length} scans would be re-scanned. Re-run with --apply.`);
  process.exit(0);
}

let errors = 0;
for (const p of plan) {
  for (let i = 0; i < p.urls.length; i += MAX_URLS_PER_TASK) {
    const urls = p.urls.slice(i, i + MAX_URLS_PER_TASK);
    try {
      const r = await api('/api/actions/add-urls-to-scan', { filename: p.filename, urls, delay: manifest.delay });
      manifest.retries.push({ taskId: r.taskId, filename: p.filename, urls });
      // In `tasks` too, so scan-watch.mjs keeps watching until the re-scan is in.
      manifest.tasks.push({ taskId: r.taskId, kind: 'retry', target: `${urls.length} failed pages of ${p.filename}` });
      console.log(`  queued #${r.taskId}  ${urls.length} pages → ${p.filename}`);
    } catch (err) {
      errors++;
      console.log(`  FAILED to queue ${p.filename}: ${err.message}`);
    }
    writeManifest(manifest);
  }
}
process.exit(errors ? 1 : 0);

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
