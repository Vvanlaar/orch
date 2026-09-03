import { describe, it, expect } from 'vitest';
import { csvFilename, scanToCsv } from './videoscan-csv.js';

const BOM = '\uFEFF';
const HEADER = 'domain,scanDate,url,player,evidence';

function rows(csv: string): string[] {
  return csv.replace(BOM, '').trimEnd().split('\r\n');
}

describe('scanToCsv', () => {
  it('emits a BOM + header even for an empty scan (Excel needs the BOM for UTF-8)', () => {
    const csv = scanToCsv({});
    expect(csv.startsWith(BOM)).toBe(true);
    expect(rows(csv)).toEqual([HEADER]);
  });

  it('emits one row per (page, player) pair', () => {
    const csv = scanToCsv({
      domain: 'example.nl',
      scanDate: '2026-09-03T10:00:00.000Z',
      details: [
        { url: 'https://example.nl/a', players: [{ name: 'Blue Billywig', evidence: ['bbvms.com/p/123'] }] },
        {
          url: 'https://example.nl/b',
          players: [
            { name: 'YouTube', evidence: ['youtube.com/embed/x', 'ytimg'] },
            { name: 'Vimeo', evidence: [] },
          ],
        },
      ],
    });
    expect(rows(csv)).toEqual([
      HEADER,
      'example.nl,2026-09-03T10:00:00.000Z,https://example.nl/a,Blue Billywig,bbvms.com/p/123',
      'example.nl,2026-09-03T10:00:00.000Z,https://example.nl/b,YouTube,youtube.com/embed/x | ytimg',
      'example.nl,2026-09-03T10:00:00.000Z,https://example.nl/b,Vimeo,',
    ]);
  });

  it('quotes commas, quotes and newlines per RFC 4180', () => {
    const csv = scanToCsv({
      details: [{ url: 'https://x.nl/?a=1,2', players: [{ name: 'He said "hi"', evidence: ['line1\nline2'] }] }],
    });
    expect(rows(csv.replace(/line1\nline2/, 'line1<NL>line2'))).toEqual([
      HEADER,
      ',,"https://x.nl/?a=1,2","He said ""hi""","line1<NL>line2"',
    ]);
  });

  it('neutralizes leading =, +, -, @ and tab (spreadsheet formula injection)', () => {
    const csv = scanToCsv({
      details: [
        { url: 'https://x.nl/a', players: [{ name: '=cmd|calc', evidence: ['+1', '-2'] }] },
        { url: '@x.nl', players: [{ name: '\tp', evidence: [] }] },
      ],
    });
    expect(rows(csv)).toEqual([
      HEADER,
      ",,https://x.nl/a,'=cmd|calc,'+1 | -2",
      ",,'@x.nl,'\tp,",
    ]);
  });

  // Defensive paths: the JSON is parsed unchecked from a file that may predate
  // the current writer or have been hand-edited, so a bad shape must degrade to
  // a partial CSV rather than throwing (which the route would turn into a 500).
  it('degrades on missing fields instead of throwing', () => {
    expect(rows(scanToCsv({ details: [{}, { players: [{}] }] }))).toEqual([HEADER, ',,,,', ',,,,']);
  });

  it('degrades on wrong types instead of throwing', () => {
    const csv = scanToCsv({
      domain: 42,
      details: [
        { url: 'https://x.nl/a', players: 'nope' },
        { url: 'https://x.nl/b', players: [{ name: 7, evidence: 'not-an-array' }] },
        null,
      ],
    });
    expect(rows(csv)).toEqual([HEADER, '42,,https://x.nl/a,,', '42,,https://x.nl/b,7,', '42,,,,']);
  });

  it('yields no rows when details is not an array', () => {
    expect(rows(scanToCsv({ details: { url: 'https://x.nl/a' } }))).toEqual([HEADER]);
  });
});

describe('csvFilename', () => {
  it('swaps the .json suffix for .csv', () => {
    expect(csvFilename('videoscan-example.nl-2026-09-03T10-00-00.json'))
      .toBe('videoscan-example.nl-2026-09-03T10-00-00.csv');
  });

  it('strips characters that would break a Content-Disposition header', () => {
    expect(csvFilename('videoscan-"x y".json')).toBe('videoscan-_x_y_.csv');
    expect(csvFilename('scan\r\n.json')).toBe('scan__.csv');
  });

  it('still yields a .csv name for a non-.json input', () => {
    expect(csvFilename('scan')).toBe('scan.csv');
  });
});
