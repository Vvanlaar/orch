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
    canResume: row.can_resume,
  };
}

export async function dbListScans(): Promise<ScanSummary[]> {
  const { data, error } = await getSupabase()
    .from('videoscans')
    .select()
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
