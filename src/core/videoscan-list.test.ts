import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// What the `videoscans` select resolves to; each test sets it.
const query = vi.hoisted(() => ({ result: { data: null as unknown, error: null as { message: string } | null } }));

vi.mock('./db/client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./db/client.js')>(),
  isSupabaseConfigured: () => true,
  getSupabase: () => {
    const builder = { select: () => builder, eq: () => builder, order: async () => query.result };
    return { from: () => builder };
  },
}));

// VIDEOSCAN_DIR is read when the runner loads, so point it at a temp dir first.
const dir = mkdtempSync(join(tmpdir(), 'orch-list-'));
process.env.VIDEOSCAN_DIR = dir;
const { listScans, wrapUpBatch } = await import('./videoscan-runner.js');
const { dbListScans } = await import('./db/videoscans.js');

const ON_DISK = 'videoscan-x.nl-2026-01-01T00-00-00.json';
writeFileSync(join(dir, ON_DISK), JSON.stringify({ domain: 'x.nl', scanDate: '2026-01-01T00:00:00.000Z', pagesScanned: 7, batchId: 'b1' }));

// A column the select names that the table lacks: PostgREST fails the whole query.
const MISSING_COLUMN = { data: null, error: { message: 'column videoscans.batch_label does not exist' } };

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

afterEach(() => warn.mockClear());

afterAll(() => {
  warn.mockRestore();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VIDEOSCAN_DIR;
});

describe('listScans', () => {
  it('lists from Supabase when the query succeeds', async () => {
    query.result = {
      data: [{ filename: 'videoscan-db.nl-2026-02-01T00-00-00.json', domain: 'db.nl', scan_date: '2026-02-01T00:00:00.000Z', pages_scanned: 3, pages_with_video: 1, unique_players: 1, has_report: false, has_pdf: false, has_preview: false, has_preview_pdf: false, can_resume: false, batch_id: null, batch_label: null }],
      error: null,
    };

    expect((await listScans()).map(s => s.filename)).toEqual(['videoscan-db.nl-2026-02-01T00-00-00.json']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the disk listing when the Supabase query errors', async () => {
    query.result = MISSING_COLUMN;

    const scans = await listScans();
    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatchObject({ filename: ON_DISK, domain: 'x.nl', pagesScanned: 7, batchId: 'b1' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('column videoscans.batch_label does not exist'));
  });
});

describe('dbListScans', () => {
  it('throws on a query error instead of reporting no scans', async () => {
    query.result = MISSING_COLUMN;

    await expect(dbListScans()).rejects.toThrow('Failed to list videoscans: column videoscans.batch_label does not exist');
  });
});

describe('wrapUpBatch', () => {
  it('does not wrap up from the disk listing when the Supabase query errors', async () => {
    query.result = MISSING_COLUMN;

    await expect(wrapUpBatch('b1')).rejects.toThrow('Failed to list videoscans');
    expect(readdirSync(dir)).toEqual([ON_DISK]);
  });
});
