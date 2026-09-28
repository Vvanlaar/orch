#!/usr/bin/env node
// Is a media URL real? Prints "<status> <content-type>" for it.
//
//   node probe-media.mjs <file holding the URL>
//
// Takes the URL from a file, never from the command line: it comes from the
// scanned page (a player's getPlaylist()), and a page can put `$(…)` or a quote
// in it that a shell would run. Write it to a scratch file with the Write tool.

import { readFileSync } from 'fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: probe-media.mjs <file holding the URL>');
  process.exit(2);
}

const raw = readFileSync(file, 'utf-8').trim();
let url;
try {
  url = new URL(raw);
} catch {
  console.error(`not a URL: ${JSON.stringify(raw.slice(0, 200))}`);
  process.exit(2);
}
if (url.protocol !== 'http:' && url.protocol !== 'https:') {
  console.error(`refusing ${url.protocol} — only http(s) media URLs`);
  process.exit(2);
}

// GET with a one-byte range rather than HEAD: some CDNs answer HEAD with 403 or
// 405 while serving the file fine.
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 15_000);
try {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: ctrl.signal, redirect: 'follow' });
  console.log(`${res.status} ${res.headers.get('content-type') || '(no content-type)'}`);
  await res.body?.cancel();
} catch (err) {
  console.log(`failed: ${err.name === 'AbortError' ? 'timeout after 15s' : err.message}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
