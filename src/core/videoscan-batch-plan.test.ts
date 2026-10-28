import { describe, expect, it } from 'vitest';
import { buildPlan, classifyGroupUrls } from './videoscan-batch-plan.js';
// @ts-expect-error — plain .mjs skill script, no types
import * as skill from '../../.claude/skills/videoscan-start/scripts/logic.mjs';

const GROUPS = [
  { rootDomain: 'gemeente.nl', sites: [{ url: 'https://www.gemeente.nl' }, { url: 'https://zaken.gemeente.nl/p/login' }] },
  { rootDomain: 'verlorenofgevonden.nl', sites: [{ url: 'https://www.verlorenofgevonden.nl' }] },
  { rootDomain: 'leverancier.nl', sites: [{ url: 'https://leverancier.nl/gemeente' }] },
];
const OPTS = { maxPages: 20000, sharedMaxPages: 499 };

describe('classifyGroupUrls', () => {
  it('a root URL makes the host a crawl, anything else is listed pages', () => {
    const { crawls, explicit } = classifyGroupUrls([
      'https://www.gemeente.nl',
      'https://www.gemeente.nl/contact',
      'https://zaken.gemeente.nl/p/login',
      'https://raad.gemeente.nl/',
      'https://archief.gemeente.nl/#archive',
    ]);
    expect(crawls).toEqual(['https://www.gemeente.nl', 'https://raad.gemeente.nl/', 'https://archief.gemeente.nl/#archive']);
    expect(explicit).toEqual(['https://zaken.gemeente.nl/p/login']);
  });

  it('www. and bare host are one host', () => {
    expect(classifyGroupUrls(['https://gemeente.nl/over', 'https://www.gemeente.nl/'])).toEqual({ crawls: ['https://www.gemeente.nl/'], explicit: [] });
  });
});

describe('buildPlan', () => {
  it('a shared host is still crawled, at the shared cap', () => {
    const { plan, skipped, unknown } = buildPlan(GROUPS, { ...OPTS, shared: new Set(['verlorenofgevonden.nl']) });
    expect(plan).toEqual([
      { kind: 'crawl', url: 'https://www.gemeente.nl', maxPages: 20000 },
      { kind: 'urls', urls: ['https://zaken.gemeente.nl/p/login'], domain: 'gemeente.nl' },
      { kind: 'crawl', url: 'https://www.verlorenofgevonden.nl', maxPages: 499 },
      { kind: 'urls', urls: ['https://leverancier.nl/gemeente'], domain: 'leverancier.nl' },
    ]);
    expect(skipped).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('an excluded host is left out and recorded, crawl or listed page alike', () => {
    const { plan, skipped, unknown } = buildPlan(GROUPS, { ...OPTS, excluded: new Set(['verlorenofgevonden.nl', 'leverancier.nl']) });
    expect(plan.map(p => (p.kind === 'crawl' ? p.url : p.urls[0]))).toEqual(['https://www.gemeente.nl', 'https://zaken.gemeente.nl/p/login']);
    expect(skipped).toEqual(['https://www.verlorenofgevonden.nl', 'https://leverancier.nl/gemeente']);
    expect(unknown).toEqual([]);
  });

  it('a host the plan has no use for is reported, not ignored', () => {
    expect(buildPlan(GROUPS, { ...OPTS, excluded: new Set(['verlorenofgevonden.n']) }).unknown).toEqual(['verlorenofgevonden.n']);
    expect(buildPlan(GROUPS, { ...OPTS, shared: new Set(['leverancier.nl']) }).unknown).toEqual(['leverancier.nl']);
    expect(buildPlan(GROUPS, { ...OPTS, excluded: new Set(['gemeente.nl']), shared: new Set(['gemeente.nl']) }).unknown).toEqual(['gemeente.nl']);
  });
});

describe('parity with the videoscan-start skill (logic.mjs)', () => {
  const urlSets = [
    GROUPS.flatMap(g => g.sites.map(s => s.url)),
    ['https://a.nl/x', 'https://www.a.nl/y', 'https://b.nl/', 'https://B.nl/z', 'http://c.nl', 'https://c.nl/q?x=1'],
    [],
  ];
  it.each(urlSets.map((u, i) => [i, u] as const))('classifyGroupUrls set %i', (_i, urls) => {
    expect(classifyGroupUrls(urls)).toEqual(skill.classifyGroupUrls(urls));
  });

  const flagSets = [
    {},
    { shared: new Set(['verlorenofgevonden.nl']) },
    { excluded: new Set(['gemeente.nl', 'nope.nl']), shared: new Set(['leverancier.nl']) },
  ];
  it.each(flagSets.map((f, i) => [i, f] as const))('buildPlan flags %i', (_i, flags) => {
    expect(buildPlan(GROUPS, { ...OPTS, ...flags })).toEqual(skill.buildPlan(GROUPS, { ...OPTS, ...flags }));
  });
});
