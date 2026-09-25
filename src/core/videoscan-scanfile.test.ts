import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// VIDEOSCAN_DIR is read when videoscan-runner loads, so set it before the dynamic import.
const dir = mkdtempSync(join(tmpdir(), 'orch-scanfile-'));
process.env.VIDEOSCAN_DIR = dir;
let readScanFileInfo: typeof import('./videoscan-runner.js').readScanFileInfo;

beforeAll(async () => {
  ({ readScanFileInfo } = await import('./videoscan-runner.js'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readScanFileInfo', () => {
  it('recognises a scan.mjs checkpoint by content', () => {
    writeFileSync(join(dir, 'videoscan-a.nl-INPROGRESS.json'), JSON.stringify({ domain: 'a.nl', checkpoint: true, pagesScanned: 10 }));
    expect(readScanFileInfo('videoscan-a.nl-INPROGRESS.json')).toMatchObject({ name: 'videoscan-a.nl-INPROGRESS.json', checkpoint: true });
  });

  it('treats a finished report as final, whatever its name', () => {
    writeFileSync(join(dir, 'videoscan-b.nl-INPROGRESS.json'), JSON.stringify({ domain: 'b.nl', pagesScanned: 10, playerSummary: {} }));
    const info = readScanFileInfo('videoscan-b.nl-INPROGRESS.json');
    expect(info?.checkpoint).toBe(false);
    expect(info?.mtimeMs).toBeGreaterThan(0);
  });

  it('returns null for a file cut off mid-write', () => {
    writeFileSync(join(dir, 'videoscan-c.nl-2026-09-24T12-00-00.json'), '{"domain": "c.nl", "pages');
    expect(readScanFileInfo('videoscan-c.nl-2026-09-24T12-00-00.json')).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(readScanFileInfo('videoscan-missing.nl-2026-09-24T12-00-00.json')).toBeNull();
  });
});
