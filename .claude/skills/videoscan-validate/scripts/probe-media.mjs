#!/usr/bin/env node
// Is a media URL real? Prints "<status> <content-type>" per request.
//
//   node probe-media.mjs <file holding the URL>
//
// Exit 0: a 2xx answer with a media content-type (video/*, audio/*, an HLS or
// DASH manifest, octet-stream) — a Range request makes a healthy file answer
// 206. Exit 1: anything else (4xx, an HTML or JSON error page, no content-type,
// a dead host). Exit 2: bad input, or a URL that points at this machine or the LAN.
//
// Takes the URL from a file, never from the command line: it comes from the
// scanned page (a player's getPlaylist()), and a page can put `$(…)` or a quote
// in it that a shell would run. Write it to a scratch file with the Write tool.

import { readFileSync } from 'fs';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

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

class Refused extends Error {}

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses. */
function isPrivateAddress(ip) {
  let a = ip.toLowerCase();
  // IPv4-mapped IPv6, dotted (::ffff:127.0.0.1) or as WHATWG normalizes it (::ffff:7f00:1)
  const dotted = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const hex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (dotted) a = dotted[1];
  else if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    a = [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number);
    return p === 0 || p === 10 || p === 127 || p >= 224
      || (p === 100 && q >= 64 && q < 128)
      || (p === 169 && q === 254)
      || (p === 172 && q >= 16 && q < 32)
      || (p === 192 && q === 168);
  }
  return a === '::' || a === '::1' || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith('::ffff:');
}

/**
 * The URL is page-controlled: never let it point this machine at itself or the
 * LAN (the orch API listens on 127.0.0.1:3011). Checks every address the name
 * resolves to, so a public name that resolves privately (nip.io) is refused
 * too. fetch resolves again on its own; a DNS answer that changes between the
 * two lookups is out of reach of this check.
 */
async function assertPublic(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Refused(`refusing ${u.protocol} — only http(s) media URLs`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map(r => r.address);
  const bad = addrs.find(isPrivateAddress);
  if (bad) throw new Refused(`refusing ${u.hostname}: resolves to local/private ${bad}`);
}

const MEDIA_TYPE = /^(video|audio)\/|mpegurl|dash\+xml|octet-stream|^application\/mp4/i;
const MAX_REDIRECTS = 5;

let url;
try {
  url = new URL(raw);
} catch {
  console.error(`not a URL: ${JSON.stringify(raw.slice(0, 200))}`);
  process.exit(2);
}

// GET with a one-byte range rather than HEAD: some CDNs answer HEAD with 403 or
// 405 while serving the file fine.
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 15_000);
try {
  // Redirects by hand: an automatic follow would skip the check on every hop
  // after the first, and a public URL can 302 to 127.0.0.1.
  for (let hop = 0; ; hop++) {
    await assertPublic(url);
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: ctrl.signal, redirect: 'manual' });
    await res.body?.cancel();
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) {
        console.log(`failed: more than ${MAX_REDIRECTS} redirects`);
        process.exitCode = 1;
        break;
      }
      console.log(`${res.status} → ${location}`);
      url = new URL(location, url);
      continue;
    }
    const type = res.headers.get('content-type') || '';
    console.log(`${res.status} ${type || '(no content-type)'}`);
    // A soft 404 answers 200 with an HTML or JSON error page.
    if (!res.ok || !MEDIA_TYPE.test(type)) {
      console.log('not media');
      process.exitCode = 1;
    }
    break;
  }
} catch (err) {
  if (err instanceof Refused) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    // undici's message is always "fetch failed"; the cause names the real error.
    const why = err.name === 'AbortError' ? 'timeout after 15s' : (err.cause?.code || err.code || err.cause?.message || err.message);
    console.log(`failed: ${why}`);
    process.exitCode = 1;
  }
} finally {
  clearTimeout(timer);
}
