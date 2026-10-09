#!/usr/bin/env node
// Put the customer's title and cover image on a finished batch's report.
//
//   node scan-report.mjs <batchId | scan.json> [--title "Gemeente X"] [--cover <image url>]
//   node scan-report.mjs <batchId> --title … --cover … --save   # remember for later, generate nothing
//
// Title and cover default to what scan-start.mjs (or --save) stored in the launch
// manifest, so the answers given at launch are still there hours later. The
// server keeps both inside the scan JSON, so later regenerations reuse them.

import { api, fail, parseArgs, readManifest, writeManifest } from './api.mjs';
import { listScans, isDerivedScan } from '../../videoscan-validate/scripts/lib.mjs';

const { target, flags } = parseArgs(process.argv.slice(2), { '--title': 'value', '--cover': 'value', '--save': 'bool' },
  'usage: scan-report.mjs <batchId | scan.json> [--title "…"] [--cover <image url>] [--save]');
let title = flags['--title'];
let cover = flags['--cover'];

const manifest = readManifest(target);
if (flags['--save']) {
  if (!manifest) fail(`No launch manifest for "${target}" — --save needs a batch started by scan-start.mjs`);
  if (!title && !cover) fail('--save needs --title and/or --cover');
  const report = { ...manifest.report, ...(title ? { title } : {}), ...(cover ? { cover } : {}) };
  writeManifest({ ...manifest, report });
  console.log(`Saved for ${target}: ${JSON.stringify(report)}`);
  process.exit(0);
}
title ??= manifest?.report?.title;
cover ??= manifest?.report?.cover;
if (!title && !cover) fail('Nothing to apply — pass --title and/or --cover (none stored in the launch manifest either)');

// A broken cover URL does not fail the report; it renders an empty cover.
if (cover) {
  let res;
  try {
    res = await fetch(cover, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    // Some image hosts refuse HEAD outright.
    if (!res.ok) res = await fetch(cover, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    fail(`Cover image unreachable: ${err.cause?.code || err.message}`, 1);
  }
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) fail(`Cover image is not an image: HTTP ${res.status} ${type || '(no content-type)'}`, 1);
}

// ── Which file is the batch's report? ──
// The organisation report is a derived scan: the "<slug>-organisatie…-merged"
// the service writes when the batch's last task completes, or the "…-summary"
// a manual wrap-up writes. Members keep their own reports and are left alone.
let files;
if (target.endsWith('.json')) {
  files = [target];
} else {
  const slug = target.match(/^(?:digi|urls)-(.+)-\d+$/)?.[1];
  const since = manifest?.startedAt || '';
  files = listScans()
    .filter(s => !s.unreadable && isDerivedScan(s.filename))
    .filter(s => s.batchId === target
      || (slug && s.filename.startsWith(`videoscan-${slug}-organisatie-`) && s.scanDate >= since))
    .map(s => s.filename);
  if (!files.length) fail(`No merged or summary report for "${target}" yet — the batch has not settled (or fewer than two scans completed). Pass the scan .json explicitly to report on one file.`, 1);
}

for (const filename of files) {
  // Renders the report and its preview, HTML and PDF each — minutes for a large batch.
  const r = await api('/api/videoscans/generate-report', { filename, ...(title ? { orgName: title } : {}), ...(cover ? { coverImageUrl: cover } : {}) }, 600_000);
  console.log(`${filename}\n  → ${r.htmlFile || '(no html)'}  ${r.pdfFile || '(no pdf)'}`);
}
