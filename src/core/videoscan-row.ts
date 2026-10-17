import { existsSync } from 'fs';
import { join } from 'path';
import type { dbUpsertVideoscan } from './db/videoscans.js';

/**
 * True for scans that are derived artifacts of other scans — a merge or a batch
 * summary — rather than the output of a crawl.
 *
 * These carry a `_state.queue` built from their sources (union minus visited),
 * so a queue-length test alone reads them as resumable. Resuming one would crawl
 * a queue no single run ever owned and write the results back over the merge, so
 * every caller that asks "can this be continued?" has to exclude them.
 *
 * Detected by filename because that is what merges and summaries have in common
 * on disk, including the ones written before this flag existed. Compared the
 * way NTFS resolves the name — case-insensitive, trailing dots and spaces
 * dropped — or `x-merged.JSON` passes the resume guard and opens the merge.
 */
export function isDerivedScan(filename: string): boolean {
  const f = diskName(filename);
  return f.endsWith('-merged.json') || f.endsWith('-summary.json');
}

function diskName(filename: string): string {
  return filename.toLowerCase().replace(/[.\s]+$/, '');
}

/**
 * A batch summary is wrap-up's own output, so a re-wrap must not read it back.
 * Narrower than isDerivedScan on purpose: a `-merged.json` is a real domain's
 * scan whose sources mergeScans archived, so dropping it would lose the domain.
 */
export function isBatchSummary(filename: string): boolean {
  return diskName(filename).endsWith('-summary.json');
}

export type ScanRow = Parameters<typeof dbUpsertVideoscan>[0];

/**
 * The stored row of a scan JSON, for syncScanToSupabase and the one-time
 * migrate script. Their two copies had drifted: migrate wrote no preview or
 * batch fields and called a merge resumable. listScansFromDisk reads the same
 * fields its own way, without the large ones.
 */
export function scanRow(data: any, filename: string, dir: string): ScanRow {
  const sibling = (suffix: string) => existsSync(join(dir, filename.replace('.json', suffix)));
  return {
    filename,
    domain: data.domain || 'unknown',
    scanDate: data.scanDate || new Date().toISOString(),
    pagesScanned: data.pagesScanned || 0,
    pagesWithVideo: data.pagesWithVideo || data.details?.length || 0,
    uniquePlayers: data.uniquePlayers || Object.keys(data.playerSummary || {}).length,
    playerSummary: data.playerSummary || {},
    details: data.details || [],
    scanState: data._state || {},
    hasReport: sibling('.html'),
    hasPdf: sibling('.pdf'),
    hasPreview: sibling('-preview.html'),
    hasPreviewPdf: sibling('-preview.pdf'),
    canResume: (data._state?.queue?.length || 0) > 0 && !isDerivedScan(filename),
    queueCapped: data.queueCapped === true,
    queueCleared: data.queueCleared === true,
    batchId: typeof data.batchId === 'string' ? data.batchId : undefined,
    batchLabel: typeof data.batchLabel === 'string' ? data.batchLabel : undefined,
    scanMode: data.mode === 'sovereignty' ? 'sovereignty' : undefined,
  };
}
