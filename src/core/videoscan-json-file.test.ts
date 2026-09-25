import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeTargetFor, resolveScanJsonFile } from './videoscan-runner.js';

let dir: string;
let clock: number;

/** Create files oldest-first: each call gets a later mtime than the previous one. */
function touch(...names: string[]): void {
  for (const name of names) {
    const path = join(dir, name);
    writeFileSync(path, '{}');
    clock += 10;
    utimesSync(path, clock, clock);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'videoscan-json-'));
  clock = Math.floor(Date.now() / 1000);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveScanJsonFile', () => {
  it('takes the file scan.mjs printed, not the newest file of a concurrent scan', () => {
    // #696: raad.purmerend.nl got doemee.oosterhout.nl's checkpoint
    // A newer same-domain file too, so only the printed name picks the right one
    touch(
      'videoscan-raad.purmerend.nl-2026-09-24T10-00-00.json',
      'videoscan-raad.purmerend.nl-2026-09-24T11-00-00.json',
      'videoscan-doemee.oosterhout.nl-INPROGRESS.json',
    );
    const stdout = [
      '  Rapport opgeslagen: videoscan-raad.purmerend.nl-2026-09-24T10-00-00.json',
      'VIDEOSCAN_JSON: videoscan-raad.purmerend.nl-2026-09-24T10-00-00.json\r',
      '',
    ].join('\n');
    expect(resolveScanJsonFile(stdout, { scanUrl: 'https://raad.purmerend.nl/' }, dir))
      .toBe('videoscan-raad.purmerend.nl-2026-09-24T10-00-00.json');
  });

  it('prefers the printed file over the resume file, and takes the last marker', () => {
    touch('videoscan-gouda.nl-INPROGRESS.json', 'videoscan-gouda.nl-2026-09-24T12-00-00.json');
    const stdout = `VIDEOSCAN_JSON: stale.json\nVIDEOSCAN_JSON: ${join(dir, 'videoscan-gouda.nl-2026-09-24T12-00-00.json')}\n`;
    expect(resolveScanJsonFile(stdout, {
      scanUrl: 'https://gouda.nl',
      resumeFile: 'videoscan-gouda.nl-INPROGRESS.json',
    }, dir)).toBe('videoscan-gouda.nl-2026-09-24T12-00-00.json');
  });

  it('ignores a printed file that does not exist', () => {
    touch('videoscan-gouda.nl-2026-09-24T09-00-00.json');
    const stdout = 'VIDEOSCAN_JSON: videoscan-gouda.nl-missing.json\n';
    expect(resolveScanJsonFile(stdout, { scanUrl: 'https://www.gouda.nl' }, dir))
      .toBe('videoscan-gouda.nl-2026-09-24T09-00-00.json');
  });

  it('on resume, falls back to the resume file, which keeps its INPROGRESS name', () => {
    touch('videoscan-gouda.nl-INPROGRESS.json', 'videoscan-gouda.nl-2026-09-24T12-00-00.json', 'videoscan-lansingerland.nl-INPROGRESS.json');
    expect(resolveScanJsonFile('', {
      scanUrl: 'https://www.gouda.nl',
      resumeFile: join(tmpdir(), 'elsewhere','videoscan-gouda.nl-INPROGRESS.json'),
    }, dir)).toBe('videoscan-gouda.nl-INPROGRESS.json');
  });

  it('without a marker, takes the newest final file of this domain only', () => {
    // #655: gouda.nl got lansingerland.nl's file
    touch(
      'videoscan-gouda.nl-2026-09-23T08-00-00.json',
      'videoscan-gouda.nl-2026-09-24T08-00-00.json',
      'videoscan-gouda.nl-INPROGRESS.json',
      'videoscan-lansingerland.nl-2026-09-24T08-05-00.json',
    );
    expect(resolveScanJsonFile('', { scanUrl: 'https://www.gouda.nl/home' }, dir))
      .toBe('videoscan-gouda.nl-2026-09-24T08-00-00.json');
  });

  it('without a marker, never takes a report older than this run', () => {
    touch('videoscan-gouda.nl-2026-09-23T08-00-00.json');
    const runStartMs = (clock + 5) * 1000;
    expect(resolveScanJsonFile('', { scanUrl: 'https://gouda.nl' }, dir, runStartMs)).toBeUndefined();
    touch('videoscan-gouda.nl-2026-09-24T08-00-00.json');
    expect(resolveScanJsonFile('', { scanUrl: 'https://gouda.nl' }, dir, runStartMs))
      .toBe('videoscan-gouda.nl-2026-09-24T08-00-00.json');
  });

  it('does not confuse a domain with a longer one sharing its suffix', () => {
    touch('videoscan-gouda.nl-2026-09-24T08-00-00.json', 'videoscan-raad.gouda.nl-2026-09-24T09-00-00.json');
    expect(resolveScanJsonFile('', { scanUrl: 'https://gouda.nl' }, dir))
      .toBe('videoscan-gouda.nl-2026-09-24T08-00-00.json');
  });

  it('in --urls mode, uses the host of the first URL', () => {
    touch('videoscan-a.nl-2026-09-24T08-00-00.json', 'videoscan-b.nl-2026-09-24T09-00-00.json');
    expect(resolveScanJsonFile('', { scanUrl: 'https://b.nl', urls: ['https://a.nl/x', 'https://a.nl/y'] }, dir))
      .toBe('videoscan-a.nl-2026-09-24T08-00-00.json');
  });

  it('returns undefined rather than another scan\'s file', () => {
    touch('videoscan-lansingerland.nl-2026-09-24T08-05-00.json');
    expect(resolveScanJsonFile('', { scanUrl: 'https://gouda.nl' }, dir)).toBeUndefined();
    expect(resolveScanJsonFile('', { scanUrl: 'not a url' }, dir)).toBeUndefined();
  });
});

describe('mergeTargetFor', () => {
  it('merges a new scan into its target', () => {
    expect(mergeTargetFor('videoscan-a.nl-2026-09-24T09-00-00.json', 'videoscan-a.nl-2026-09-01T08-00-00.json'))
      .toBe('videoscan-a.nl-2026-09-01T08-00-00.json');
  });

  it('never merges the target into itself, as the cleanup would delete it', () => {
    expect(mergeTargetFor('videoscan-a.nl-2026-09-01T08-00-00.json', 'videoscan-a.nl-2026-09-01T08-00-00.json')).toBeUndefined();
  });

  it('does not merge without a target', () => {
    expect(mergeTargetFor('videoscan-a.nl-2026-09-24T09-00-00.json')).toBeUndefined();
  });
});
