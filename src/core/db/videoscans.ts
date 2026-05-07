import { getSupabase } from './client.js';
import type { ScanSummary } from '../videoscan-runner.js';

interface VideoscanRow {
  id: string;
  filename: string;
  domain: string;
  scan_date: string;
  pages_scanned: number;
  pages_with_video: number;
  unique_players: number;
  player_summary: Record<string, unknown>;
  details: unknown[];
  scan_state: Record<string, unknown>;
  has_report: boolean;
  has_pdf: boolean;
  has_preview: boolean;
  has_preview_pdf: boolean;
  can_resume: boolean;
  archived: boolean;
  created_at: string;
}

function rowToSummary(row: VideoscanRow): ScanSummary {
  return {
    filename: row.filename,
    domain: row.domain,
    scanDate: row.scan_date,
    pagesScanned: row.pages_scanned,
    pagesWithVideo: row.pages_with_video,
    uniquePlayers: row.unique_players,
    hasReport: row.has_report,
    hasPdf: row.has_pdf,
    hasPreview: row.has_preview,
    hasPreviewPdf: row.has_preview_pdf,
    canResume: row.can_resume,
  };
}

export async function dbListScans(): Promise<ScanSummary[]> {
  // Only select columns used by rowToSummary — exclude large details/scan_state/player_summary JSONB
  const { data, error } = await getSupabase()
    .from('videoscans')
    .select('filename, domain, scan_date, pages_scanned, pages_with_video, unique_players, has_report, has_pdf, has_preview, has_preview_pdf, can_resume')
    .eq('archived', false)
    .order('scan_date', { ascending: false });

  if (error) return [];
  return (data as VideoscanRow[]).map(rowToSummary);
}

export async function dbUpsertVideoscan(scan: {
  filename: string;
  domain: string;
  scanDate: string;
  pagesScanned: number;
  pagesWithVideo: number;
  uniquePlayers: number;
  playerSummary: Record<string, unknown>;
  details: unknown[];
  scanState: Record<string, unknown>;
  hasReport: boolean;
  hasPdf: boolean;
  hasPreview: boolean;
  hasPreviewPdf: boolean;
  canResume: boolean;
}): Promise<void> {
  const { error } = await getSupabase()
    .from('videoscans')
    .upsert(
      {
        filename: scan.filename,
        domain: scan.domain,
        scan_date: scan.scanDate,
        pages_scanned: scan.pagesScanned,
        pages_with_video: scan.pagesWithVideo,
        unique_players: scan.uniquePlayers,
        player_summary: scan.playerSummary,
        details: scan.details,
        scan_state: scan.scanState,
        has_report: scan.hasReport,
        has_pdf: scan.hasPdf,
        has_preview: scan.hasPreview,
        has_preview_pdf: scan.hasPreviewPdf,
        can_resume: scan.canResume,
      },
      { onConflict: 'filename' }
    );
  if (error) throw new Error(`Failed to upsert videoscan: ${error.message}`);
}

export async function dbArchiveVideoscans(filenames: string[]): Promise<void> {
  const { error } = await getSupabase()
    .from('videoscans')
    .update({ archived: true })
    .in('filename', filenames);
  if (error) throw new Error(`Failed to archive videoscans: ${error.message}`);
}

export async function dbDeleteVideoscans(filenames: string[]): Promise<void> {
  const { error } = await getSupabase()
    .from('videoscans')
    .delete()
    .in('filename', filenames);
  if (error) throw new Error(`Failed to delete videoscans: ${error.message}`);
}
