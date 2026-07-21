import { describe, it, expect } from 'vitest';
import { reportOptionsToArgs } from './report-args.js';

describe('reportOptionsToArgs', () => {
  it('returns [] for undefined / empty options', () => {
    expect(reportOptionsToArgs()).toEqual([]);
    expect(reportOptionsToArgs({})).toEqual([]);
  });

  it('emits raw, UNQUOTED values (regression: literal quotes corrupted image URLs)', () => {
    const url = 'https://cdn.example.com/cover.png?v=2';
    const args = reportOptionsToArgs({ coverImageUrl: url, contactImageUrl: url });
    expect(args).toEqual([
      '--cover-image', url,
      '--contact-image', url,
    ]);
    // No element may be wrapped in quotes — those would reach report.mjs as part
    // of the value (spawn uses an args array, no shell to strip them).
    for (const a of args) expect(a).not.toMatch(/^".*"$/);
  });

  it('passes values with spaces as a single arg (no shell tokenisation needed)', () => {
    const args = reportOptionsToArgs({ contactName: 'Tom Kleijn' });
    expect(args).toEqual(['--contact-name', 'Tom Kleijn']);
  });

  it('omits flags for falsy/missing fields', () => {
    const args = reportOptionsToArgs({ orgName: 'Acme', contactName: '' });
    expect(args).toEqual(['--org-name', 'Acme']);
    expect(args).not.toContain('--contact-name');
  });

  it('joins excludeExampleSections into one comma-separated flag; omits when empty', () => {
    expect(reportOptionsToArgs({ excludeExampleSections: ['zakelijk', 'private-banking'] }))
      .toEqual(['--exclude-example-sections', 'zakelijk,private-banking']);
    // Empty array → no flag (report.mjs treats absent flag as "exclude nothing").
    expect(reportOptionsToArgs({ excludeExampleSections: [] })).toEqual([]);
  });

  it('emits --all-video-pages only when true (boolean flag, no value)', () => {
    expect(reportOptionsToArgs({ allVideoPages: true })).toEqual(['--all-video-pages']);
    expect(reportOptionsToArgs({ allVideoPages: false })).toEqual([]);
  });

  it('maps every field to its flag', () => {
    expect(
      reportOptionsToArgs({
        orgName: 'Acme',
        coverImageUrl: 'c',
        contactImageUrl: 'ci',
        contactName: 'n',
        contactPhone: 'p',
        contactEmail: 'e',
      }),
    ).toEqual([
      '--org-name', 'Acme',
      '--cover-image', 'c',
      '--contact-image', 'ci',
      '--contact-name', 'n',
      '--contact-phone', 'p',
      '--contact-email', 'e',
    ]);
  });
});
