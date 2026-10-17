// Shared helpers for the videoscan-start scripts: the orch API, argv parsing and
// the launch manifest that scan-start.mjs leaves behind for the later steps.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const ORCH_URL = (process.env.ORCH_URL || 'http://127.0.0.1:3011').replace(/\/$/, '');

let token;
/**
 * $ORCH_TOKEN, else the first admin token in tokens.json (the file's keys are
 * the tokens). Admin rather than videoscan scope: a videoscan-scoped caller is
 * shown videoscan tasks only and may not read a task by id, so both the "what
 * else is open" check and the watcher need admin. Never printed.
 */
export function orchToken() {
  if (token) return token;
  if (process.env.ORCH_TOKEN) return (token = process.env.ORCH_TOKEN);
  const dataDir = process.env.BB_SUPPORT_DATA_DIR || join(homedir(), '.claude', 'bb-support-web');
  const file = join(dataDir, 'tokens.json');
  if (!existsSync(file)) fail(`No ORCH_TOKEN and no ${file}`);
  const tokens = JSON.parse(readFileSync(file, 'utf-8'));
  // '*' is auth.ts's legacy spelling of admin.
  const admin = Object.keys(tokens).find(t => Array.isArray(tokens[t]?.scopes) && tokens[t].scopes.some(s => s === 'admin' || s === '*'));
  if (!admin) fail(`No admin token in ${file} — set ORCH_TOKEN`);
  return (token = admin);
}

/**
 * GET, or POST when a body is given. Throws with `.status` set on an HTTP error
 * and unset on a network one, so a caller can tell "the server said no" (a
 * retry will not help) from "the server is not there".
 */
export async function api(path, body, timeoutMs = 30_000) {
  let res;
  try {
    res = await fetch(`${ORCH_URL}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${orchToken()}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`${path}: ${err.cause?.code || err.message} — is the orch service up on ${ORCH_URL}?`);
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  if (!res.ok) throw Object.assign(new Error(`${path}: HTTP ${res.status} ${json?.error || text.slice(0, 200)}`.trim()), { status: res.status });
  // A 200 that is not JSON is not this API: ORCH_URL points at the Vite dev
  // server or some other app, whose HTML would otherwise pass for a result.
  if (json === undefined) throw Object.assign(new Error(`${path}: HTTP ${res.status} but not JSON — is ${ORCH_URL} the orch service?`), { status: 421 });
  return json;
}

/** Not finished: waiting, working, or parked until someone acts on it. */
export const OPEN_STATUSES = ['pending', 'running', 'paused', 'needs-repo'];

/**
 * Split argv into the one positional target and its flags. Strict on purpose:
 * `--exclude a.nl, b.nl` (a stray space) would otherwise drop b.nl without a
 * word and crawl it anyway.
 *   spec: { '--name': 'value' | 'bool' }
 */
export function parseArgs(argv, spec, usage) {
  const out = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    if (!(a in spec)) fail(`Unknown option ${a}\n${usage}`);
    if (spec[a] === 'bool') { out[a] = true; continue; }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) fail(`${a} needs a value\n${usage}`);
    out[a] = v;
  }
  if (positionals.length !== 1) fail(`Expected one target, got ${positionals.length}${positionals.length ? `: ${positionals.join(' | ')}` : ''}\n${usage}`);
  return { target: positionals[0], flags: out };
}

// Under the home directory, not the temp dir: a batch runs for hours or days,
// and the manifest holds what nothing else does (the report title and cover the
// user gave at launch, the sites that failed to start).
export function manifestPath(batchId) {
  const dir = join(homedir(), '.claude', 'orch-videoscan-batches');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${batchId.replace(/[^a-z0-9._-]/gi, '_')}.json`);
}

export function writeManifest(manifest) {
  const path = manifestPath(manifest.batchId);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

export function readManifest(batchId) {
  const path = manifestPath(batchId);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
}

export function fail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}
