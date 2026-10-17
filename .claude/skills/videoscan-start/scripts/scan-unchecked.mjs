#!/usr/bin/env node
// Look by hand at the pages a batch gave up on.
//
//   node scan-unchecked.mjs <batchId>
//
// A page that failed in the scan and in both re-scans was never checked for
// video. Many of those answer a plain HTTP request in a second — it is the
// browser that never reaches "loaded" on them. This fetches each one's served
// HTML and prints whatever player markup is in it, so the report can say
// "not rendered, HTML has no player" instead of nothing at all. It cannot see
// a player that only JavaScript puts on the page.

import { readFileSync } from 'fs';
import { join } from 'path';
import { fail, parseArgs } from './api.mjs';
import { retryPlan, bare } from './logic.mjs';
import { listScans, videoscanDir, isDerivedScan } from '../../videoscan-validate/scripts/lib.mjs';

const { target: batchId } = parseArgs(process.argv.slice(2), {}, 'usage: scan-unchecked.mjs <batchId>');
const dir = videoscanDir();
const members = listScans(dir).filter(s => s.batchId === batchId && !s.unreadable && !isDerivedScan(s.filename) && !s.filename.includes('INPROGRESS'));
if (!members.length) fail(`No finished scan files for batch "${batchId}"`, 1);
const files = members.map(s => {
  const d = JSON.parse(readFileSync(join(dir, s.filename), 'utf-8'));
  return { domain: s.domain, pagesFailed: d.pagesFailed || 0, visited: d._state?.visited || [], failedUrls: d.failedUrls || [] };
});

const PLAYER = /<video\b[^>]{0,200}>|<iframe\b[^>]{0,300}>|youtube(?:-nocookie)?\.com\/embed\/[\w-]+|img\.youtube\.com\/vi\/[\w-]+|player\.vimeo\.com\/video\/\d+|vimeocdn\.com\/video|open\.spotify\.com\/embed|[\w./-]+\.(?:mp4|m3u8|mpd)\b/gi;

let pages = 0;
for (const row of retryPlan(files)) {
  for (const url of row.gaveUp) {
    // Only the site the batch scanned: these URLs come out of scan files.
    if (bare(new URL(url).hostname) !== bare(row.domain)) { console.log(`skip  ${url}  (not on ${row.domain})`); continue; }
    pages++;
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000), headers: { 'user-agent': 'Mozilla/5.0' } });
      const html = await res.text();
      const hits = [...new Set((html.match(PLAYER) || []).map(h => h.replace(/\s+/g, ' ').slice(0, 140)))];
      console.log(`${res.status}  ${hits.length ? `${hits.length} player-like strings` : 'no player markup'}  ${url}`);
      for (const h of hits.slice(0, 5)) console.log(`        ${h}`);
    } catch (err) {
      console.log(`ERR   ${err.cause?.code || err.name}  ${url}`);
    }
  }
}
if (!pages) console.log('No page was given up on.');
