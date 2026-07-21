// Sticky report-option persistence, split out of videoscan-runner.ts so the
// (fs-only) merge logic can be unit-tested without importing that module's heavy
// graph (playwright, supabase client) or its import-time mkdirSync side effect.

import { readFileSync, writeFileSync } from 'fs';
import type { ReportOptions } from './report-args.js';

/**
 * A value is "provided" (and therefore wins over any persisted value) unless it
 * is undefined/null, an empty/whitespace string, or an empty array. A boolean
 * `false` IS provided — that lets the dashboard toggle a flag back off.
 */
export function isProvided(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

/**
 * Sticky report options: report preferences must survive regenerations
 * (dashboard, any browser, cross-machine), so we persist them inside the scan
 * JSON — which is synced to storage — rather than relying on the caller /
 * localStorage to re-supply them every time. This is what makes "reuse the same
 * cover image / org name / page-list mode on the next regen" work by default.
 *
 * Merge rule per option: a value that is *actually provided* (see {@link isProvided})
 * wins and is written back; otherwise the previously-persisted value is applied.
 * An empty field therefore does NOT clear a persisted value — set a new value to
 * change it. All other scan fields round-trip untouched. `report.mjs` ignores the
 * `reportOptions` block and `syncScanToSupabase` never reads/writes it, so the
 * persisted block survives download → regenerate.
 *
 * @param onWarn called (non-fatally) if the JSON can be read but not written back.
 */
export function applyStickyReportOptions(
  jsonPath: string,
  options?: ReportOptions,
  onWarn: (msg: string) => void = () => {},
): ReportOptions {
  let json: { reportOptions?: ReportOptions };
  try {
    json = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  } catch {
    return options ?? {};
  }
  const persisted: ReportOptions = json.reportOptions ?? {};
  const merged: ReportOptions = { ...persisted };
  for (const [key, value] of Object.entries(options ?? {})) {
    if (isProvided(value)) (merged as Record<string, unknown>)[key] = value;
  }
  // Both sides derive from the same key order (persisted spread first), so this
  // string compare is a safe value+order equality check — no spurious rewrites.
  if (JSON.stringify(merged) !== JSON.stringify(persisted)) {
    json.reportOptions = merged;
    try { writeFileSync(jsonPath, JSON.stringify(json, null, 2)); }
    catch (err) { onWarn(`Could not persist reportOptions for ${jsonPath}: ${err}`); }
  }
  return merged;
}
