import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// A fake Supabase client: records what the code sends and answers with fixed
// rows. Never the real one — a checkout with a .env has it configured.
const { sent, storageError } = vi.hoisted(() => ({
  sent: { select: '', upsert: null as Record<string, unknown> | null },
  storageError: { forFile: (_name: string): string | null => null },
}));
vi.mock('./client.js', () => ({
  isSupabaseConfigured: () => true,
  getSupabase: () => ({
    from: () => ({
      select(columns: string) {
        sent.select = columns;
        const rows = [{
          filename: 'videoscan-x.nl-2026-07-01T00-00-00.json', domain: 'x.nl', scan_date: '2026-07-01T00:00:00Z',
          pages_scanned: 3, pages_with_video: 1, unique_players: 1, has_report: true, has_pdf: false,
          has_preview: false, has_preview_pdf: false, can_resume: false, batch_id: null, batch_label: null,
          queue_capped: false, queue_cleared: true, scan_mode: 'sovereignty',
        }];
        return { eq: () => ({ order: async () => ({ data: rows, error: null }) }) };
      },
      upsert: async (row: Record<string, unknown>) => {
        sent.upsert = row;
        return { error: null };
      },
    }),
    storage: {
      getBucket: async () => ({ data: {}, error: null }),
      createBucket: async () => ({ error: null }),
      from: () => ({
        upload: async (name: string) => {
          const message = storageError.forFile(name);
          return { error: message ? { message } : null };
        },
      }),
    },
  }),
}));

const { dbListScans, dbUpsertVideoscan } = await import('./videoscans.js');
const { uploadScanFiles } = await import('./storage.js');

const dir = mkdtempSync(join(tmpdir(), 'orch-db-columns-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('queue_cleared column', () => {
  it('is selected and read back as queueCleared', async () => {
    const [scan] = await dbListScans();
    expect(sent.select).toContain('queue_cleared');
    expect(scan.queueCleared).toBe(true);
    expect('queueCapped' in scan).toBe(false);
  });

  it('is written from queueCleared', async () => {
    await dbUpsertVideoscan({
      filename: 'f.json', domain: 'x.nl', scanDate: '', pagesScanned: 0, pagesWithVideo: 0, uniquePlayers: 0,
      playerSummary: {}, details: [], scanState: {}, hasReport: false, hasPdf: false, hasPreview: false,
      hasPreviewPdf: false, canResume: false, queueCapped: false, queueCleared: true,
    });
    expect(sent.upsert).toMatchObject({ queue_cleared: true, queue_capped: false });
  });
});

describe('scan_mode column', () => {
  it('is selected and read back as scanMode', async () => {
    const [scan] = await dbListScans();
    expect(sent.select).toContain('scan_mode');
    expect(scan.scanMode).toBe('sovereignty');
  });

  it('is written from scanMode, null for a plain scan', async () => {
    const row = {
      filename: 'f.json', domain: 'x.nl', scanDate: '', pagesScanned: 0, pagesWithVideo: 0, uniquePlayers: 0,
      playerSummary: {}, details: [], scanState: {}, hasReport: false, hasPdf: false, hasPreview: false,
      hasPreviewPdf: false, canResume: false, queueCapped: false, queueCleared: false,
    };
    await dbUpsertVideoscan({ ...row, scanMode: 'sovereignty' });
    expect(sent.upsert).toMatchObject({ scan_mode: 'sovereignty' });
    await dbUpsertVideoscan(row);
    expect(sent.upsert).toMatchObject({ scan_mode: null });
  });
});

describe('uploadScanFiles', () => {
  it('fails when storage refuses a file, so a sync is not reported as done', async () => {
    writeFileSync(join(dir, 'videoscan-y.nl-1.json'), '{}');
    writeFileSync(join(dir, 'videoscan-y.nl-1.html'), '<html></html>');
    storageError.forFile = (name) => (name.endsWith('.json') ? 'quota exceeded' : null);

    await expect(uploadScanFiles('videoscan-y.nl-1.json', dir)).rejects.toThrow('Upload failed: videoscan-y.nl-1.json');

    storageError.forFile = () => null;
    await expect(uploadScanFiles('videoscan-y.nl-1.json', dir)).resolves.toBeUndefined();
  });
});
