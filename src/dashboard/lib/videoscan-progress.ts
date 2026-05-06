export interface ScanProgress {
  visited: number;
  queue: number;
  pagesPerMin: number | null;
  etaMin: number | null;
  maxPages: number;
  concurrency: number | null;
  baseConcurrency: number | null;
  hasData: boolean;
}

const ANSI = /\x1b\[[0-9;]*m/g;

const SUMMARY = /(\d+(?:\.\d+)?)\s*pages\/min\s*\|\s*queue=(\d+)\s*\|\s*~(\d+(?:\.\d+)?|\?)\s*min\s*left/i;
const SUMMARY_CONC = /\bconcurrency=(\d+)/i;
const CONTROL = /Live control:\s*concurrency=(\d+)(?:\s*\(base=(\d+)\))?/i;
const PER_URL = /\[(\d+)\/(\d+)\](?:\s*\(queue:\s*(\d+)\))?/;
const RESUME = /Previously scanned:\s*(\d+)\s*pages,\s*Queue:\s*(\d+)\s*URLs/i;
const FINAL = /Pagina['']s gescand:\s*(\d+)/i;

export function parseScanProgress(rawOutput: string, maxPagesHint: number): ScanProgress {
  const out = rawOutput.replace(ANSI, '');
  const result: ScanProgress = {
    visited: 0,
    queue: 0,
    pagesPerMin: null,
    etaMin: null,
    maxPages: maxPagesHint || 0,
    concurrency: null,
    baseConcurrency: null,
    hasData: false,
  };

  const lines = out.split('\n');
  let summarySeen = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(SUMMARY);
    if (m) {
      result.pagesPerMin = parseFloat(m[1]);
      result.queue = parseInt(m[2], 10);
      result.etaMin = m[3] === '?' ? null : parseFloat(m[3]);
      const c = lines[i].match(SUMMARY_CONC);
      if (c) result.concurrency = parseInt(c[1], 10);
      result.hasData = true;
      summarySeen = true;
      break;
    }
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(CONTROL);
    if (m) {
      const cur = parseInt(m[1], 10);
      result.concurrency = cur;
      result.baseConcurrency = m[2] ? parseInt(m[2], 10) : cur;
      break;
    }
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(PER_URL);
    if (m) {
      const visited = parseInt(m[1], 10);
      const max = parseInt(m[2], 10);
      if (visited > result.visited) result.visited = visited;
      if (max > result.maxPages) result.maxPages = max;
      if (m[3] && !summarySeen) result.queue = parseInt(m[3], 10);
      result.hasData = true;
      break;
    }
  }

  if (!result.hasData) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(RESUME);
      if (m) {
        result.visited = parseInt(m[1], 10);
        result.queue = parseInt(m[2], 10);
        result.hasData = true;
        break;
      }
    }
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(FINAL);
    if (m) {
      const v = parseInt(m[1], 10);
      if (v > result.visited) result.visited = v;
      break;
    }
  }

  return result;
}

export function formatDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '0s';
  const s = Math.floor(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function formatEta(min: number | null): string {
  if (min === null || !Number.isFinite(min)) return '—';
  if (min < 1) return '<1m';
  if (min < 60) return `~${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `~${h}h ${m}m`;
}
