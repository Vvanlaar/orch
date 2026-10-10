#!/usr/bin/env node
// Re-scan the pages a batch's finished scans could not load.
//
//   node scan-retry-failed.mjs <batchId>           # where every failed page stands
//   node scan-retry-failed.mjs <batchId> --apply   # queue the re-scans
//
// A crawl lists the pages it could not load (the first 1000 of them). Timeouts
// are mostly this machine, busy with several crawls at once, or a slow site —
// not a missing page — and a page that timed out is a page nobody checked for
// video. Each re-scan is an ordinary URL-list scan IN THE SAME BATCH: the
// service waits for it before it builds the organisation report, and its result
// is a scan file of its own, so which pages failed again is on disk, not in a
// log. Nothing is remembered between runs — the state of a page is read from
// the batch's files and its open tasks every time.
//
// Run it while the batch is still crawling: once the report is built, the
// batch's scan files are archived and there is nothing left to read.

import { readFileSync } from 'fs';
import { join } from 'path';
import { api, fail, parseArgs, readManifest, OPEN_STATUSES } from './api.mjs';
import { retryPlan, chunk, MAX_ATTEMPTS } from './logic.mjs';
import { listScans, videoscanDir, isDerivedScan } from '../../videoscan-validate/scripts/lib.mjs';

const { target: batchId, flags } = parseArgs(process.argv.slice(2), { '--apply': 'bool' },
  'usage: scan-retry-failed.mjs <batchId> [--apply]');
const MAX_URLS_PER_TASK = 500; // the endpoint's limit

const dir = videoscanDir();
const members = listScans(dir).filter(s => s.batchId === batchId && !s.unreadable && !isDerivedScan(s.filename) && !s.filename.includes('INPROGRESS'));
if (!members.length) fail(`No finished scan files for batch "${batchId}" — nothing has completed yet, the id is wrong, or the batch was already merged`, 1);
const files = members.map(s => {
  const d = JSON.parse(readFileSync(join(dir, s.filename), 'utf-8'));
  return { domain: s.domain, pagesFailed: d.pagesFailed || 0, visited: d._state?.visited || [], failedUrls: d.failedUrls || [] };
});

// Re-scans that are queued or running have no file yet. /api/tasks shows the
// 100 newest tasks; a re-scan is always newer than the crawl it follows.
const open = (await api('/api/tasks')).filter(t => t.context?.batchId === batchId && OPEN_STATUSES.includes(t.status) && t.context?.urls?.length);
const inFlight = new Set(open.flatMap(t => t.context.urls));

const rows = retryPlan(files, inFlight);
if (!rows.length) { console.log('No failed pages in the finished scans.'); process.exit(0); }

console.log('── Failed pages in finished scans ──');
for (const r of rows) {
  const parts = [
    r.retry.length && `${r.retry.length} to re-scan`,
    r.waiting.length && `${r.waiting.length} re-scan queued`,
    r.recovered && `${r.recovered} loaded on a re-scan`,
    r.gaveUp.length && `${r.gaveUp.length} failed ${MAX_ATTEMPTS}× — unchecked`,
    r.permanent.length && `${r.permanent.length} permanent (${[...new Set(r.permanent.map(p => String(p.error).match(/ERR_\w+|Access refused|HTTP \d+/)?.[0] || 'other'))].join(', ')})`,
    r.unrecorded && `${r.unrecorded} more failed but not listed by the scan`,
  ].filter(Boolean);
  console.log(`  ${r.domain}: ${parts.join(', ')}`);
  for (const u of r.gaveUp) console.log(`      unchecked  ${u}`);
}

const todo = rows.filter(r => r.retry.length);
if (!todo.length) { console.log('\nNothing to queue.'); process.exit(0); }
if (!flags['--apply']) {
  console.log(`\nDry run — ${todo.reduce((n, r) => n + r.retry.length, 0)} pages on ${todo.length} sites would be re-scanned. Re-run with --apply.`);
  process.exit(0);
}

// Batch label and delay come from a batch member, so this also works on a
// batch that was not started by scan-start.mjs.
const manifest = readManifest(batchId);
const batchLabel = manifest?.batchLabel || members.find(s => s.batchLabel)?.batchLabel;
let errors = 0;
for (const r of todo) {
  for (const urls of chunk(r.retry, MAX_URLS_PER_TASK)) {
    try {
      // maxPages as the dashboard sends it for a URL list: the endpoint's own default is 50.
      const t = await api('/api/actions/start-videoscan-urls', { urls, maxPages: 20000, delay: manifest?.delay ?? 200, batchId, ...(batchLabel ? { batchLabel } : {}) });
      console.log(`  queued #${t.taskId}  ${urls.length} pages of ${r.domain}`);
    } catch (err) {
      errors++;
      console.log(`  FAILED to queue ${r.domain}: ${err.message}`);
    }
  }
}
process.exit(errors ? 1 : 0);
