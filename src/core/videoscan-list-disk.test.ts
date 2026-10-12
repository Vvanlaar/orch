import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync, writeSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Counts the full reads of a scan JSON: the listing must not repeat them.
vi.mock('fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('fs')>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});
vi.mock('./db/client.js', async (importOriginal) => ({ ...await importOriginal<typeof import('./db/client.js')>(), isSupabaseConfigured: () => false }));

// VIDEOSCAN_DIR is read when the runner loads, so point it at a temp dir first.
const dir = mkdtempSync(join(tmpdir(), 'orch-list-disk-'));
process.env.VIDEOSCAN_DIR = dir;
const { listScans } = await import('./videoscan-runner.js');

// One byte past what the listing still parses.
const OVER_LIMIT = 128 * 1024 * 1024 + 1;

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

afterAll(() => {
  warn.mockRestore();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VIDEOSCAN_DIR;
});

beforeEach(() => {
  vi.mocked(readFileSync).mockClear();
  warn.mockClear();
});

/** Written the way scan.mjs and the runner write a scan: two-space indent. */
function write(filename: string, data: Record<string, unknown>): void {
  writeFileSync(join(dir, filename), JSON.stringify(data, null, 2));
}

function fullReads(filename: string): number {
  return vi.mocked(readFileSync).mock.calls.filter(([path]) => path === join(dir, filename)).length;
}

async function listed(filename: string) {
  return (await listScans()).find(s => s.filename === filename);
}

describe('listScans from disk', () => {
  it('summarises a scan from its JSON and the files next to it', async () => {
    const name = 'videoscan-a.nl-2026-01-01T00-00-00.json';
    write(name, {
      domain: 'a.nl', scanDate: '2026-01-01T00:00:00.000Z', pagesScanned: 9, batchId: 'b1', batchLabel: 'Batch 1',
      playerSummary: { YouTube: {}, Vimeo: {} }, details: [{}, {}, {}], _state: { visited: [], queue: ['https://a.nl/x'] },
    });
    writeFileSync(join(dir, name.replace('.json', '.html')), '');
    writeFileSync(join(dir, name.replace('.json', '-preview.pdf')), '');

    expect(await listed(name)).toEqual({
      filename: name, domain: 'a.nl', scanDate: '2026-01-01T00:00:00.000Z', pagesScanned: 9,
      pagesWithVideo: 3, uniquePlayers: 2, canResume: true, batchId: 'b1', batchLabel: 'Batch 1',
      hasReport: true, hasPdf: false, hasPreview: false, hasPreviewPdf: true,
    });
  });

  it('reads an unchanged scan once, and again when it is rewritten', async () => {
    const name = 'videoscan-b.nl-2026-01-01T00-00-00.json';
    write(name, { domain: 'b.nl', pagesScanned: 100 });

    expect((await listed(name))?.pagesScanned).toBe(100);
    expect((await listed(name))?.pagesScanned).toBe(100);
    expect(fullReads(name)).toBe(1);

    // Same size, so only the mtime tells the two apart.
    write(name, { domain: 'b.nl', pagesScanned: 200 });
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, name), later, later);

    expect((await listed(name))?.pagesScanned).toBe(200);
    expect(fullReads(name)).toBe(2);
  });

  it('picks up a report written next to an unchanged scan', async () => {
    const name = 'videoscan-c.nl-2026-01-01T00-00-00.json';
    write(name, { domain: 'c.nl', pagesScanned: 1 });
    expect((await listed(name))?.hasReport).toBe(false);

    writeFileSync(join(dir, name.replace('.json', '.html')), '');

    expect((await listed(name))?.hasReport).toBe(true);
    expect(fullReads(name)).toBe(1);
  });

  it('lists an oversized checkpoint from its header without parsing it', async () => {
    const name = 'videoscan-huge.nl-INPROGRESS.json';
    // The start of a real checkpoint, then padded past the limit: no longer valid JSON,
    // so a row with these values can only have come from the header.
    writeFileSync(join(dir, name), [
      '{',
      '  "domain": "huge.nl",',
      '  "checkpoint": true,',
      '  "scanDate": "2026-10-10T22:53:06.708Z",',
      '  "pagesScanned": 7973,',
      '  "_state": {',
      '    "pagesWithVideo": 5,',
      '    "visited": [',
      '      "https://huge.nl/"',
    ].join('\n'));
    truncateSync(join(dir, name), OVER_LIMIT);

    // Resumable, as an unfinished crawl: not to be shown as done.
    expect(await listed(name)).toEqual({
      filename: name, domain: 'huge.nl', scanDate: '2026-10-10T22:53:06.708Z', pagesScanned: 7973,
      pagesWithVideo: 0, uniquePlayers: 0, canResume: true,
      hasReport: false, hasPdf: false, hasPreview: false, hasPreviewPdf: false,
    });
    await listScans();
    expect(fullReads(name)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(name));

    rmSync(join(dir, name));
    expect(await listed(name)).toBeUndefined();
  });

  it('finds the counts at the start and the batch at the end of an oversized merge', async () => {
    const name = 'videoscan-big-org-2026-01-01T00-00-00-000-merged.json';
    const tail = [
      '    ]',
      '  },',
      '  "batchId": "digi-big-1",',
      '  "batchLabel": "Digi import — \\"big\\"",',
      '  "reportOptions": {',
      '    "orgName": "Gemeente Big"',
      '  }',
      '}',
    ].join('\n');
    const fd = openSync(join(dir, name), 'w');
    writeSync(fd, [
      '{',
      '  "domain": "big \\"org\\"",',
      '  "scanDate": "2026-01-01T00:00:00.000Z",',
      '  "pagesScanned": 67382,',
      '  "pagesWithVideo": 4135,',
      '  "uniquePlayers": 6,',
      '  "playerSummary": {',
    ].join('\n'), 0);
    writeSync(fd, tail, OVER_LIMIT - Buffer.byteLength(tail));
    closeSync(fd);

    expect(await listed(name)).toMatchObject({
      domain: 'big "org"', scanDate: '2026-01-01T00:00:00.000Z', pagesScanned: 67382, pagesWithVideo: 4135, uniquePlayers: 6,
      canResume: false, batchId: 'digi-big-1', batchLabel: 'Digi import — "big"',
    });
    expect(fullReads(name)).toBe(0);

    rmSync(join(dir, name));
  });

  it('reads a scan again after a read that failed', async () => {
    const name = 'videoscan-locked.nl-2026-01-01T00-00-00.json';
    write(name, { domain: 'locked.nl', pagesScanned: 4, batchId: 'b1' });
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); });

    expect(await listed(name)).toMatchObject({ domain: 'unknown', pagesScanned: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EBUSY'));
    expect(await listed(name)).toMatchObject({ domain: 'locked.nl', pagesScanned: 4, batchId: 'b1' });
  });

  it('lists a scan it cannot parse as unknown, without reading it again', async () => {
    const name = 'videoscan-broken.nl-2026-01-01T00-00-00.json';
    writeFileSync(join(dir, name), '{ "domain": "broken.nl", ');

    expect(await listed(name)).toMatchObject({ filename: name, domain: 'unknown', pagesScanned: 0, canResume: false });
    await listScans();
    expect(fullReads(name)).toBe(1);
  });
});
