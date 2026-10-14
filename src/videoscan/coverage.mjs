// Coverage flags: how a scan JSON says its crawl left links it found and never
// followed. Each is top-level, present only when true, and sticks once set: a
// --resume, a checkpoint and a merge keep it.
// - queueCapped: scan.mjs's queue bound dropped URLs, on filter mazes like
//   www.ha-meer.nl's;
// - queueCleared: wrap-up accepted a crawl that stopped with links queued as
//   final and emptied its queue (finalizeScan), so only the mark is left.
//
// scan.mjs and report.mjs read this list. A new flag also goes in
// videoscan-runner.ts's copy of it, for mergeScansData (dist/ has no
// src/videoscan to import from). To show it in the dashboard and the
// videoscan-validate skill, also in: videoscan-runner.ts ScanData, ScanSummary,
// listScansFromDisk and syncScanToSupabase; db/videoscans.ts, db/migrate.ts and
// supabase-schema.sql (a column, migrated before the code ships); the dashboard's
// stores/videoscan.svelte.ts and VideoscanPage.svelte; and the skill's
// scripts/lib.mjs and scan-status.mjs.
export const COVERAGE_FLAGS = ["queueCapped", "queueCleared"];

// The flags set on `data`, as an object to spread into a scan JSON. Only a real
// `true` counts, not a stray value in a hand-edited file.
export function coverageFlags(data) {
  return Object.fromEntries(COVERAGE_FLAGS.filter((flag) => data?.[flag] === true).map((flag) => [flag, true]));
}

// Partial: a flag is set, or the crawl stopped with links still queued — on its
// --max-pages budget, which is how most crawls of a large site end, or on a
// pause or a kill.
export function isPartialScan(data) {
  return Object.keys(coverageFlags(data)).length > 0 || (data?._state?.queue?.length || 0) > 0;
}
