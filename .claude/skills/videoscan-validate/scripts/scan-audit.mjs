#!/usr/bin/env node
// Phase 2 — what did this scan claim, and which claims look shaky?
//
//   node scan-audit.mjs <file|batch|domain> [--json] [--samples N]
//
// Prints, per detected player: page count, what evidence actually fired, which
// hosts it fired on, sample URLs to open, and a risk verdict. It never decides
// a detection is wrong — it ranks what to open in a browser first. Only the
// live page decides.

import { join } from 'path';
import { readJson, resolveTarget, videoscanDir } from './lib.mjs';

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
const asJson = args.includes('--json');
const sampleCount = Number((args.find(a => a.startsWith('--samples=')) || '').split('=')[1]) || 3;
if (!target) {
  console.error('usage: scan-audit.mjs <file|batch|domain> [--json] [--samples=N]');
  process.exit(2);
}

const dir = videoscanDir();
const { scans } = resolveTarget(target, dir);
// A batch summary already contains every member's details — auditing both the
// summary and its members would double every count.
const files = scans.some(s => s.isSummary) ? scans.filter(s => s.isSummary) : scans;

const details = [];
for (const s of files) {
  const d = readJson(join(dir, s.filename));
  for (const row of d.details || []) details.push(row);
}

// Tier 5 in scan.mjs: the generic players that wrap a plain <video> element, so
// they legitimately co-occur with "HTML5 native" on one page. Counting them as
// separate findings double-reads the same embed.
const GENERIC = new Set(['Video.js', 'HTML5 native', 'MediaElement.js', 'Plyr', 'Clappr', 'Shaka Player']);

// Evidence that is a share/watch URL rather than an embed. Both known false
// positives so far were this shape: a link to the recording in body text or a
// JSON payload, with no player on the page at all.
const SHARE_SHAPE = [
  /youtu\.be\//i,
  /vimeo\.com\/\d+/i,
  /(?:facebook|instagram|tiktok|linkedin)\.com\/(?!.*(?:embed|plugins))/i,
  /youtube\.com\/watch/i,
];

/**
 * Collapse one evidence string to the kind of thing that matched, so counting
 * kinds says something. Network evidence reads
 * `Network: <url> [matched: "x" in "…"]`, and older scans stored the bare URL
 * with no bracket at all — keeping either verbatim would just list per-page
 * URLs, which aggregates to nothing.
 */
function evidenceKind(ev) {
  if (!ev.startsWith('Network:')) return ev.slice(0, 80);
  const matched = ev.match(/\[matched: "([^"]+)"/);
  if (matched) return `Network: ${matched[1]}`;
  const url = ev.slice('Network:'.length).trim();
  try {
    return `Network: ${new URL(url).host}`;
  } catch {
    return `Network: ${url.slice(0, 60)}`;
  }
}

const players = new Map();
for (const row of details) {
  if (!Array.isArray(row?.players)) continue;
  const names = row.players.map(p => p.name);
  for (const p of row.players) {
    if (!players.has(p.name)) players.set(p.name, { name: p.name, pages: [], evidence: new Map(), hosts: new Map(), coGeneric: 0 });
    const e = players.get(p.name);
    e.pages.push(row.url);
    if (GENERIC.has(p.name) && names.some(n => n !== p.name && GENERIC.has(n))) e.coGeneric++;
    let host = 'unknown';
    try { host = new URL(row.url).host; } catch {}
    e.hosts.set(host, (e.hosts.get(host) || 0) + 1);
    for (const ev of p.evidence || []) {
      e.evidence.set(evidenceKind(ev), (e.evidence.get(evidenceKind(ev)) || 0) + 1);
    }
  }
}

// Markers that name the player's own delivery path or its vendor-prefixed
// class/id namespace (`mejs__container`, `vjs-tech`, `jw-reset`) are hard to hit
// by accident. A bare dictionary word is not.
const EMBED_SHAPE = /embed|player\.|iframe_api|cdn|\.js\b|data-[a-z]+-(?:id|url)|[a-z]{2,}(?:__|--)|class="|id="/i;

function assess(p) {
  const kinds = [...p.evidence.keys()];
  const flags = [];
  const html = kinds.filter(k => k.startsWith('HTML:'));
  const network = kinds.filter(k => k.startsWith('Network:'));
  const loneWeakMarker = html.length === 1 && !network.length && !EMBED_SHAPE.test(html[0]);

  if (!network.length) flags.push('no network evidence — markup match only, nothing was actually loaded');
  if (html.length === 1 && !network.length) flags.push(`every hit rests on ONE marker: ${html[0]}`);
  for (const k of kinds) {
    if (SHARE_SHAPE.some(re => re.test(k))) flags.push(`share/watch link shape, not an embed: ${k}`);
  }
  if (p.pages.length <= 3) flags.push(`only ${p.pages.length} page(s) — cheap to verify all of them`);
  // One dominant host means one template — a near-total share counts, not just
  // a single host exactly.
  const [topHost, topCount] = [...p.hosts].sort((a, b) => b[1] - a[1])[0] || [];
  if (p.pages.length > 200 && topCount / p.pages.length >= 0.9) {
    const share = Math.round((topCount / p.pages.length) * 100);
    flags.push(`${share}% of ${p.pages.length} hits on ${topHost} — one template, so one page proves or kills them all`);
  }
  if (GENERIC.has(p.name) && p.coGeneric) flags.push(`${p.coGeneric} of ${p.pages.length} pages also report another generic player — same <video>, counted twice`);

  const risk = loneWeakMarker || flags.some(f => f.startsWith('share/watch')) ? 'HIGH'
    : flags.length ? 'CHECK' : 'OK';
  return { risk, flags };
}

// Spread samples over distinct hosts and URL shapes, so one sample does not
// stand in for another copy of the same template.
function samples(p, n) {
  const part = (url, depth) => {
    try {
      const u = new URL(url);
      return depth === 0 ? u.host : u.host + u.pathname;
    } catch {
      return url;
    }
  };
  const out = [];
  // One page per host first, then per distinct path — pages that differ only in
  // query string are the same template and prove nothing extra.
  for (const depth of [0, 1]) {
    const seen = new Set(out.map(u => part(u, depth)));
    for (const url of p.pages) {
      if (out.length >= n) break;
      const key = part(url, depth);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(url);
    }
  }
  return out;
}

const report = [...players.values()]
  .sort((a, b) => b.pages.length - a.pages.length)
  .map(p => ({
    player: p.name,
    pages: p.pages.length,
    hosts: Object.fromEntries([...p.hosts].sort((a, b) => b[1] - a[1]).slice(0, 5)),
    evidence: Object.fromEntries([...p.evidence].sort((a, b) => b[1] - a[1]).slice(0, 6)),
    ...assess(p),
    samples: samples(p, sampleCount),
  }));

if (asJson) {
  console.log(JSON.stringify({ files: files.map(f => f.filename), pagesWithVideo: details.length, players: report }, null, 2));
} else {
  console.log(`audited: ${files.map(f => f.filename).join(', ')}`);
  console.log(`${details.length} pages with a player, ${report.length} distinct players\n`);
  for (const r of report) {
    console.log(`${r.risk.padEnd(5)} ${r.player} — ${r.pages} page(s)`);
    console.log(`      hosts: ${Object.entries(r.hosts).map(([h, n]) => `${h} (${n})`).join(', ')}`);
    for (const [k, n] of Object.entries(r.evidence)) console.log(`      ${String(n).padStart(5)}  ${k}`);
    for (const f of r.flags) console.log(`      ! ${f}`);
    for (const u of r.samples) console.log(`      open: ${u}`);
    console.log('');
  }
  console.log('Verify every player marked HIGH or CHECK in a browser before trusting the report.');
}
