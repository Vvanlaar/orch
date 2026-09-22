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
          isSummary: !!d.isSummary,
          pagesFailed: d.pagesFailed || 0,
          failureRate: d.failureRate || 0,
        };
      } catch {
        return { filename, domain: 'unreadable', unreadable: true };
      }
    });
}

/**
 * Heartbeats newer than 60s mean a scan.mjs subprocess is alive; scan.mjs
 * rewrites its `_heartbeat-<taskId>.json` once per crawl batch and itself
 * treats peers older than 30s as gone. Anything older is a crashed run whose
 * heartbeat was never cleaned up — report it, don't count it as running.
 */
export function heartbeats(dir = videoscanDir(), freshMs = 60_000) {
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
export function resolveTarget(target, dir = videoscanDir()) {
  const all = listScans(dir);
  const byFile = all.find(s => s.filename === target || s.filename === `videoscan-${target}.json`);
  if (byFile) return { kind: 'file', scans: [byFile] };

  const exact = all.filter(s => s.batchId === target);
  if (exact.length) return { kind: 'batch', batchId: target, scans: exact };

  const needle = target.toLowerCase();
  const fuzzy = all.filter(s => (s.batchId || '').toLowerCase().includes(needle) || (s.batchLabel || '').toLowerCase().includes(needle));
  if (fuzzy.length) {
    const ids = [...new Set(fuzzy.map(s => s.batchId))];
    if (ids.length > 1) throw new Error(`"${target}" matches ${ids.length} batches: ${ids.join(', ')}`);
    return { kind: 'batch', batchId: ids[0], scans: fuzzy };
  }

  const domain = all.filter(s => s.domain.toLowerCase().includes(needle));
  if (domain.length) return { kind: 'domain', scans: domain };

  throw new Error(`No scan, batch or domain matches "${target}"`);
}

export function fmtAge(ms) {
  if (ms == null || !isFinite(ms)) return '?';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}`;
}
