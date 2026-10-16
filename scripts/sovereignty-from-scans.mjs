#!/usr/bin/env node
// Market view: a sovereignty grade for every domain in the scan dir, from the
// newest finished scan per domain. Plain videoscans have no measurements, so
// their grades are desk-only (vendors.json); sovereignty scans use what they
// measured. Read-only on the scans; writes one markdown and one CSV file.
//
//   node scripts/sovereignty-from-scans.mjs [scanDir] [outDir]
// scanDir defaults to $VIDEOSCAN_DIR or ./videoscans; outDir to <scanDir>/_reports.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { GRADE_ORDER, loadVendors, scoreSite } from '../src/videoscan/sovereignty/score.mjs';

const scanDir = process.argv[2] || process.env.VIDEOSCAN_DIR || 'videoscans';
const outDir = process.argv[3] || join(scanDir, '_reports');
const vendors = loadVendors();

// Newest finished scan per domain. Filenames sort by timestamp within a domain.
const newest = new Map();
for (const f of readdirSync(scanDir).sort()) {
  if (!/^videoscan-.*\.json$/.test(f) || /INPROGRESS|-summary|-merged/.test(f)) continue;
  let scan;
  try { scan = JSON.parse(readFileSync(join(scanDir, f), 'utf-8')); } catch { continue; }
  if (!scan.domain || scan.isSummary) continue;
  newest.set(scan.domain, { file: f, scan });
}

const sites = [...newest.values()].map(({ file, scan }) => ({ file, pages: scan.pagesScanned, ...scoreSite(scan, vendors) }));
const withVideo = sites.filter((s) => s.players.length);

const count = (list, key) => list.reduce((m, x) => ((m[key(x)] = (m[key(x)] || 0) + 1), m), {});
const siteGrades = count(withVideo, (s) => s.grade ?? 'unrated');
const players = {};
for (const s of withVideo) {
  for (const p of s.players) {
    const e = (players[p.player] ??= { sites: 0, pages: 0, grade: p.rated ? p.grade : 'unrated', verified: p.verified });
    e.sites++;
    e.pages += p.pages;
  }
}

const date = new Date().toISOString().slice(0, 10);
const pct = (n) => `${Math.round((n / withVideo.length) * 100)}%`;
const md = [
  `# Sovereignty market view — ${date}`,
  '',
  `${sites.length} domains, ${withVideo.length} with video. ${withVideo.filter((s) => s.measured).length} measured with --mode sovereignty; the rest are desk-only grades (vendor table, no measurement).`,
  '',
  '## Site grade (worst player on the site)',
  '',
  '| Grade | Sites | Share |',
  '|---|---|---|',
  ...[...GRADE_ORDER, 'unrated'].filter((g) => siteGrades[g]).map((g) => `| ${g} | ${siteGrades[g]} | ${pct(siteGrades[g])} |`),
  '',
  '## Players',
  '',
  '| Player | Sites | Pages | Grade (desk) | Facts verified |',
  '|---|---|---|---|---|',
  ...Object.entries(players).sort((a, b) => b[1].sites - a[1].sites)
    .map(([name, p]) => `| ${name} | ${p.sites} | ${p.pages} | ${p.grade} | ${p.grade === 'unrated' ? '—' : p.verified ? 'yes' : 'no'} |`),
  '',
  '## Sites',
  '',
  '| Domain | Grade | Players (grade) | Video pages per grade |',
  '|---|---|---|---|',
  ...withVideo.sort((a, b) => GRADE_ORDER.indexOf(b.grade) - GRADE_ORDER.indexOf(a.grade) || a.domain.localeCompare(b.domain))
    .map((s) => `| ${s.domain} | ${s.grade ?? 'unrated'} | ${s.players.map((p) => `${p.player} (${p.rated ? p.grade : '?'})`).join(', ')} | ${Object.entries(s.pagesPerGrade).map(([g, n]) => `${g}:${n}`).join(' ')} |`),
  '',
].join('\n');

const csvCell = (v) => `"${String(v).replace(/"/g, '""')}"`;
const csv = [
  ['domain', 'grade', 'measured', 'players', 'pages_scanned', 'file'].join(','),
  ...withVideo.map((s) => [s.domain, s.grade ?? 'unrated', s.measured, s.players.map((p) => `${p.player}:${p.rated ? p.grade : '?'}`).join(' '), s.pages, s.file].map(csvCell).join(',')),
].join('\n');

mkdirSync(outDir, { recursive: true });
const base = join(outDir, `sovereignty-market-${date}`);
writeFileSync(`${base}.md`, md);
writeFileSync(`${base}.csv`, csv);
console.log(`${withVideo.length} sites with video → ${base}.md / .csv`);
console.log('Site grades:', JSON.stringify(siteGrades));
