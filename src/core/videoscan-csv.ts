// Scan JSON → CSV. Kept in its own module (like report-args.ts) so the pure
// serialization can be unit-tested without videoscan-runner.ts's heavy graph
// (playwright, supabase) or its import-time mkdirSync.

/**
 * The subset of the scan JSON we read. Everything is optional and untrusted:
 * the route hands us a raw `JSON.parse` of a file that may predate the current
 * writer, or have been merged/hand-edited — so treat every field as unknown
 * and coerce rather than throw a 500 over one bad entry.
 */
export interface ScanCsvInput {
  domain?: unknown;
  scanDate?: unknown;
  details?: unknown;
}

const COLUMNS = ['domain', 'scanDate', 'url', 'player', 'evidence'] as const;

/** Download name for a scan's CSV, safe to interpolate into a header. */
export function csvFilename(jsonFilename: string): string {
  return jsonFilename.replace(/\.json$/, '').replace(/[^\w.-]/g, '_') + '.csv';
}

/**
 * RFC 4180 field. Also neutralizes spreadsheet formula injection: a leading
 * =, +, -, @, tab or CR makes Excel/Sheets evaluate the cell, and `domain` /
 * `url` come straight off the scanned site.
 */
function csvField(value: unknown): string {
  const str = value == null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * One row per (page, player) pair — a page with two players yields two rows,
 * which pivots cleanly in a spreadsheet. Pages without video aren't in
 * `details` at all (scan.mjs only records pages where a player was detected).
 * Excel only auto-detects UTF-8 with a BOM, so the output is BOM-prefixed.
 */
export function scanToCsv(data: ScanCsvInput): string {
  const domain = data.domain;
  const scanDate = data.scanDate;
  const rows: string[] = [COLUMNS.join(',')];

  for (const detail of asArray(data.details)) {
    const d = (detail ?? {}) as { url?: unknown; players?: unknown };
    const players = asArray(d.players);
    // `[{}]` keeps the page as one player-less row — defensive only, a scan's
    // `details` should never hold an entry with an empty player list.
    for (const player of players.length > 0 ? players : [{}]) {
      const p = (player ?? {}) as { name?: unknown; evidence?: unknown };
      rows.push([
        domain,
        scanDate,
        d.url,
        p.name,
        asArray(p.evidence).map(e => (e == null ? '' : String(e))).join(' | '),
      ].map(csvField).join(','));
    }
  }

  return `﻿${rows.join('\r\n')}\r\n`;
}
