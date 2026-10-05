// Shared helpers for the videoscan-validate scripts.
//
// The live scans always live in the MAIN checkout (C:\dev\orch\videoscans) —
// that is where the always-on LAN service writes. A worktree has no videoscans
// dir of its own, so resolve the main checkout rather than process.cwd().

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The main checkout, even when this skill runs from a worktree copy of it. */
export function repoRoot() {
  // .../<repo>/.claude/skills/videoscan-validate/scripts → <repo>
  const repo = resolve(HERE, '../../../..');
  // In a worktree (<repo>/.claude/worktrees/<name>/.claude/skills/...) the scans
  // and the batch state live in the checkout the service runs from.
  const posix = repo.replace(/\\/g, '/');
  const idx = posix.indexOf('.claude/worktrees/');
  return idx >= 0 ? posix.slice(0, idx).replace(/\/$/, '') : repo;
}

/** Main-checkout videoscans dir: $VIDEOSCAN_DIR, else <repo>/videoscans. */
export function videoscanDir() {
  return process.env.VIDEOSCAN_DIR || join(repoRoot(), 'videoscans');
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * A merge or a summary: the runner (isDerivedScan) never resumes one and
 * wrap-up never needs to, so a queue left on it is not unfinished work.
 */
export function isDerivedScan(filename) {
  const f = filename.toLowerCase().replace(/[.\s]+$/, '');
  return f.endsWith('-merged.json') || f.endsWith('-summary.json');
}

/** Every videoscan-*.json in the dir, cheapest fields only. */
export function listScans(dir = videoscanDir()) {
  return readdirSync(dir)
    .filter(f => f.startsWith('videoscan-') && f.endsWith('.json'))
    .map(filename => {
      try {
        const d = readJson(join(dir, filename));
        return {
          filename,
          domain: d.domain || 'unknown',
          scanDate: d.scanDate || '',
          pagesScanned: d.pagesScanned || 0,
          pagesWithVideo: d.pagesWithVideo ?? (d.details?.length || 0),
          uniquePlayers: d.uniquePlayers ?? Object.keys(d.playerSummary || {}).length,
          queued: d._state?.queue?.length || 0,
          batchId: d.batchId,
          batchLabel: d.batchLabel,
          // The flag is lost when a summary goes through a merge ("+ URLs"), so
          // the filename counts too — the runner's isBatchSummary reads only that.
          isSummary: !!d.isSummary || filename.toLowerCase().endsWith('-summary.json'),
          pagesFailed: d.pagesFailed || 0,
          failureRate: d.failureRate || 0,
        };
      } catch {
        return { filename, domain: 'unreadable', unreadable: true };
      }
    });
}

/**
 * Heartbeats newer than 5 minutes mean a scan.mjs subprocess may be alive.
 * scan.mjs writes its `_heartbeat-<taskId>.json` at start and then once per
 * crawl batch, and a batch of slow pages under rate-limit backoff runs well
 * past a minute — so a short window reads a live crawl as dead and lets
 * scan-status call a batch ready. Erring long only delays "ready". Anything
 * older is a crashed run whose heartbeat was never cleaned up.
 */
export const HEARTBEAT_FRESH_MS = 5 * 60_000;

export function heartbeats(dir = videoscanDir(), freshMs = HEARTBEAT_FRESH_MS) {
  const now = Date.now();
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('_heartbeat-') || !f.endsWith('.json')) continue;
    try {
      const d = readJson(join(dir, f));
      out.push({ file: f, taskId: d.taskId, hostname: d.hostname, concurrency: d.concurrency, ageMs: now - d.ts, live: now - d.ts <= freshMs });
    } catch {
      out.push({ file: f, unreadable: true, live: false });
    }
  }
  return out.sort((a, b) => (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity));
}

/**
 * Batch ids the dashboard has marked closed. batch-state.ts writes the file at
 * the SERVER's cwd, which is the repo root — that is the scans dir's parent in
 * the default layout, but not when VIDEOSCAN_DIR points elsewhere, so fall back
 * to the repo this skill lives in.
 */
export function closedBatches(dir = videoscanDir()) {
  const candidates = [join(dirname(dir), '.orch-batches.json'), join(repoRoot(), '.orch-batches.json')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const d = readJson(path);
      return Array.isArray(d.closed) ? d.closed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Resolve a batch id, a batch label substring, or a filename to scan files. */
export function resolveTarget(target, dir = videoscanDir(), all = listScans(dir)) {
  const byFile = all.find(s => s.filename === target || s.filename === `videoscan-${target}.json`);
  if (byFile) return { kind: 'file', scans: [byFile] };

  const exact = all.filter(s => s.batchId === target);
  if (exact.length) return { kind: 'batch', batchId: target, scans: exact };

  const needle = target.toLowerCase();
  // An exact host before any fuzzy match, batch labels included: a substring
  // match on "oss.nl" also takes werkenbijoss.nl (or a batch labelled after
  // it), and scan-prune --apply would rewrite all of those too. Hosts only
  // (a dot in the name): a summary's `domain` is its batch label and a
  // cross-domain merge's is its merge label, and matching those here would
  // return that one file without the batch's members.
  const bare = (d) => d.toLowerCase().replace(/^www\./, '');
  const exactDomain = all.filter(s => !s.isSummary && s.domain.includes('.') && bare(s.domain) === bare(needle));
  if (exactDomain.length) return { kind: 'domain', scans: exactDomain };
  const fuzzy = all.filter(s => s.batchId && (s.batchId.toLowerCase().includes(needle) || (s.batchLabel || '').toLowerCase().includes(needle)));
  if (fuzzy.length) {
    const ids = [...new Set(fuzzy.map(s => s.batchId))];
    if (ids.length > 1) throw new TargetError(`"${target}" matches ${ids.length} batches: ${ids.join(', ')}`);
    // Every member of that batch, not just the files whose label matched: a
    // member without batchLabel would otherwise drop out of audit and prune.
    return { kind: 'batch', batchId: ids[0], scans: all.filter(s => s.batchId === ids[0]) };
  }

  const domain = all.filter(s => s.domain.toLowerCase().includes(needle));
  const hosts = [...new Set(domain.map(s => s.domain))];
  if (hosts.length > 1) throw new TargetError(`"${target}" matches ${hosts.length} domains: ${hosts.join(', ')} — pass the exact host`);
  if (domain.length) return { kind: 'domain', scans: domain };

  throw new TargetError(`No scan, batch or domain matches "${target}"`);
}

/** A target that names nothing, or too much — the user's error, not the script's. */
class TargetError extends Error {}

/**
 * resolveTarget for the CLI scripts: a bad target is a usage error, not a stack
 * trace. Anything else (a missing scans dir, a bug) still throws with its stack.
 */
export function resolveTargetOrExit(target, dir, all) {
  try {
    return resolveTarget(target, dir, all);
  } catch (err) {
    if (!(err instanceof TargetError)) throw err;
    console.error(err.message);
    process.exit(2);
  }
}

export function fmtAge(ms) {
  if (ms == null || !isFinite(ms)) return '?';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}`;
}
