import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isProvided, applyStickyReportOptions } from './report-sticky.js';

describe('isProvided', () => {
  it('treats undefined/null/empty-string/empty-array as NOT provided', () => {
    expect(isProvided(undefined)).toBe(false);
    expect(isProvided(null)).toBe(false);
    expect(isProvided('')).toBe(false);
    expect(isProvided('   ')).toBe(false);
    expect(isProvided([])).toBe(false);
  });
  it('treats real values (incl. boolean false and 0) as provided', () => {
    expect(isProvided('x')).toBe(true);
    expect(isProvided(['a'])).toBe(true);
    expect(isProvided(false)).toBe(true); // lets the dashboard toggle a flag off
    expect(isProvided(true)).toBe(true);
    expect(isProvided(0)).toBe(true);
  });
});

describe('applyStickyReportOptions', () => {
  let dir: string;
  let path: string;
  const write = (obj: unknown) => writeFileSync(path, JSON.stringify(obj, null, 2));
  const read = () => JSON.parse(readFileSync(path, 'utf-8'));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sticky-'));
    path = join(dir, 'scan.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('persists a provided value into the scan JSON and returns it', () => {
    write({ domain: 'ing.com', reportOptions: {} });
    const eff = applyStickyReportOptions(path, { orgName: 'ING.com', allVideoPages: true });
    expect(eff).toEqual({ orgName: 'ING.com', allVideoPages: true });
    expect(read().reportOptions).toEqual({ orgName: 'ING.com', allVideoPages: true });
  });

  it('falls back to persisted value when the caller omits/empties it (does NOT clear)', () => {
    write({ reportOptions: { orgName: 'ING.com', excludeExampleSections: ['zakelijk'] } });
    // caller supplies nothing meaningful — empty string and empty array
    const eff = applyStickyReportOptions(path, { orgName: '', excludeExampleSections: [] });
    expect(eff).toEqual({ orgName: 'ING.com', excludeExampleSections: ['zakelijk'] });
    expect(read().reportOptions).toEqual({ orgName: 'ING.com', excludeExampleSections: ['zakelijk'] });
  });

  it('honours boolean false as a provided value (toggle a flag back off)', () => {
    write({ reportOptions: { allVideoPages: true } });
    const eff = applyStickyReportOptions(path, { allVideoPages: false });
    expect(eff.allVideoPages).toBe(false);
    expect(read().reportOptions.allVideoPages).toBe(false);
  });

  it('does not rewrite the file when nothing changes (content stays byte-identical)', () => {
    write({ domain: 'ing.com', reportOptions: { orgName: 'ING.com' } });
    const before = readFileSync(path, 'utf-8');
    const eff = applyStickyReportOptions(path, { orgName: '' }); // empty → no change
    expect(eff).toEqual({ orgName: 'ING.com' });
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('preserves all other scan fields on rewrite', () => {
    write({ domain: 'ing.com', pagesWithVideo: 22, details: [{ url: 'x' }], reportOptions: {} });
    applyStickyReportOptions(path, { coverImageUrl: 'https://x/y.jpg' });
    const j = read();
    expect(j.domain).toBe('ing.com');
    expect(j.pagesWithVideo).toBe(22);
    expect(j.details).toEqual([{ url: 'x' }]);
    expect(j.reportOptions).toEqual({ coverImageUrl: 'https://x/y.jpg' });
  });

  it('merges new keys over a pre-existing reportOptions block', () => {
    write({ reportOptions: { orgName: 'ING.com' } });
    const eff = applyStickyReportOptions(path, { coverImageUrl: 'https://x/y.jpg' });
    expect(eff).toEqual({ orgName: 'ING.com', coverImageUrl: 'https://x/y.jpg' });
  });

  it('returns options unchanged (no throw) when the JSON cannot be read', () => {
    const missing = join(dir, 'nope.json');
    const eff = applyStickyReportOptions(missing, { orgName: 'ING.com' });
    expect(eff).toEqual({ orgName: 'ING.com' });
  });
});
