#!/usr/bin/env node
// Is a media URL real? Prints "<status> <content-type>" and exits 0 only for a
// 2xx answer that is not an HTML page (a Range request makes a healthy file
// answer 206). Exit 1: not media, or the fetch failed. Exit 2: bad input.
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

let raw;
try {
  raw = readFileSync(file, 'utf-8').trim();
} catch (err) {
  console.error(`cannot read ${file}: ${err.message}`);
  process.exit(2);
}
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
// The URL is page-controlled: never let it point this machine at itself or the
// LAN (the orch API listens on 127.0.0.1:3011). Literal addresses only — a
// public name resolving to a private address is out of reach of this check.
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i;
if (PRIVATE_HOST.test(url.hostname)) {
  console.error(`refusing local/private host ${url.hostname}`);
  process.exit(2);
}

// GET with a one-byte range rather than HEAD: some CDNs answer HEAD with 403 or
// 405 while serving the file fine.
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 15_000);
try {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: ctrl.signal, redirect: 'follow' });
  const type = res.headers.get('content-type') || '';
  console.log(`${res.status} ${type || '(no content-type)'}`);
  await res.body?.cancel();
  // A soft 404 answers 200 with an HTML error page.
  if (!res.ok || /text\/html/i.test(type)) {
    console.log('not media');
    process.exitCode = 1;
  }
} catch (err) {
  // undici's message is always "fetch failed"; the cause names the real error.
  const why = err.name === 'AbortError' ? 'timeout after 15s' : (err.cause?.code || err.cause?.message || err.message);
  console.log(`failed: ${why}`);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
