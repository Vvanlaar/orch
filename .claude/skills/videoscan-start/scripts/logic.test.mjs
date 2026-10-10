// node --test .claude/skills/videoscan-start/scripts/logic.test.mjs   (part of `pnpm test`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGroupUrls, buildPlan, isTransient, chunk, retryPlan, pickReportFiles, scanKey, settle, MAX_ATTEMPTS } from './logic.mjs';

const isDerived = (f) => f.endsWith('-merged.json') || f.endsWith('-summary.json');

test('classifyGroupUrls: a root URL makes the host a crawl, anything else is listed pages', () => {
  const { crawls, explicit } = classifyGroupUrls([
    'https://www.gemeente.nl',
    'https://www.gemeente.nl/contact',
    'https://zaken.gemeente.nl/p/login',
    'https://raad.gemeente.nl/',
    'https://archief.gemeente.nl/#archive',
  ]);
  assert.deepEqual(crawls, ['https://www.gemeente.nl', 'https://raad.gemeente.nl/', 'https://archief.gemeente.nl/#archive']);
  assert.deepEqual(explicit, ['https://zaken.gemeente.nl/p/login']);
});

test('classifyGroupUrls: www. and bare host are one host', () => {
  const { crawls, explicit } = classifyGroupUrls(['https://gemeente.nl/over', 'https://www.gemeente.nl/']);
  assert.deepEqual(crawls, ['https://www.gemeente.nl/']);
  assert.deepEqual(explicit, []);
});

const GROUPS = [
  { rootDomain: 'gemeente.nl', sites: [{ url: 'https://www.gemeente.nl' }, { url: 'https://zaken.gemeente.nl/p/login' }] },
  { rootDomain: 'verlorenofgevonden.nl', sites: [{ url: 'https://www.verlorenofgevonden.nl' }] },
  { rootDomain: 'leverancier.nl', sites: [{ url: 'https://leverancier.nl/gemeente' }] },
];
const OPTS = { maxPages: 20000, sharedMaxPages: 499 };

test('buildPlan: a shared host is still crawled, at the shared cap', () => {
  const { plan, skipped, unknown } = buildPlan(GROUPS, { ...OPTS, shared: new Set(['verlorenofgevonden.nl']) });
  assert.deepEqual(plan, [
    { kind: 'crawl', url: 'https://www.gemeente.nl', maxPages: 20000 },
    { kind: 'urls', urls: ['https://zaken.gemeente.nl/p/login'], domain: 'gemeente.nl' },
    { kind: 'crawl', url: 'https://www.verlorenofgevonden.nl', maxPages: 499 },
    { kind: 'urls', urls: ['https://leverancier.nl/gemeente'], domain: 'leverancier.nl' },
  ]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(unknown, []);
});

test('buildPlan: an excluded host is left out and recorded, crawl or listed page alike', () => {
  const { plan, skipped, unknown } = buildPlan(GROUPS, { ...OPTS, excluded: new Set(['verlorenofgevonden.nl', 'leverancier.nl']) });
  assert.deepEqual(plan.map(p => p.url || p.urls[0]), ['https://www.gemeente.nl', 'https://zaken.gemeente.nl/p/login']);
  assert.deepEqual(skipped, ['https://www.verlorenofgevonden.nl', 'https://leverancier.nl/gemeente']);
  assert.deepEqual(unknown, []);
});

test('buildPlan: a host the plan has no use for is reported, not ignored', () => {
  // A typo in --exclude would crawl the site it was meant to hold back.
  assert.deepEqual(buildPlan(GROUPS, { ...OPTS, excluded: new Set(['verlorenofgevonden.n']) }).unknown, ['verlorenofgevonden.n']);
  // --shared caps a crawl; a host that is only a listed page has no crawl to cap.
  assert.deepEqual(buildPlan(GROUPS, { ...OPTS, shared: new Set(['leverancier.nl']) }).unknown, ['leverancier.nl']);
  // Excluding a host and capping it at once: the cap names nothing.
  assert.deepEqual(buildPlan(GROUPS, { ...OPTS, excluded: new Set(['gemeente.nl']), shared: new Set(['gemeente.nl']) }).unknown, ['gemeente.nl']);
});

test('isTransient: the error strings scan.mjs records', () => {
  assert.ok(isTransient('page.goto: Timeout 15000ms exceeded.\nCall log:'));
  assert.ok(isTransient('page.goto: net::ERR_CONNECTION_RESET at https://x.nl/'));
  assert.ok(!isTransient('page.goto: net::ERR_CERT_DATE_INVALID at https://x.nl/'));
  assert.ok(!isTransient('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.nl/'));
  assert.ok(!isTransient('Access refused: HTTP 403'));
  assert.ok(!isTransient(undefined));
});

test('chunk: at and around the size', () => {
  assert.deepEqual(chunk([], 2), []);
  assert.deepEqual(chunk([1, 2], 2), [[1, 2]]);
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
});

const TIMEOUT = 'page.goto: Timeout 15000ms exceeded.';
const failed = (...urls) => urls.map(url => ({ url, error: TIMEOUT }));

test('retryPlan: a timed-out page is re-scanned, a permanent failure is not', () => {
  const [row] = retryPlan([{
    domain: 'x.nl', pagesFailed: 2, visited: ['https://x.nl/', 'https://x.nl/a', 'https://x.nl/b'],
    failedUrls: [{ url: 'https://x.nl/a', error: TIMEOUT }, { url: 'https://x.nl/b', error: 'net::ERR_CERT_DATE_INVALID' }],
  }]);
  assert.deepEqual(row.retry, ['https://x.nl/a']);
  assert.deepEqual(row.permanent.map(p => p.url), ['https://x.nl/b']);
});

test('retryPlan: a page that loaded in a re-scan is done; one that failed again is tried once more', () => {
  const [row] = retryPlan([
    { domain: 'x.nl', pagesFailed: 2, visited: ['https://x.nl/a', 'https://x.nl/b'], failedUrls: failed('https://x.nl/a', 'https://x.nl/b') },
    { domain: 'x.nl', pagesFailed: 1, visited: ['https://x.nl/a', 'https://x.nl/b'], failedUrls: failed('https://x.nl/b') },
  ]);
  assert.equal(row.recovered, 1);
  assert.deepEqual(row.retry, ['https://x.nl/b']);
  assert.deepEqual(row.gaveUp, []);
});

test(`retryPlan: after ${MAX_ATTEMPTS} failures a page is given up as unchecked`, () => {
  const scan = { domain: 'x.nl', pagesFailed: 1, visited: ['https://x.nl/a'], failedUrls: failed('https://x.nl/a') };
  const [row] = retryPlan(Array(MAX_ATTEMPTS).fill(scan));
  assert.deepEqual(row.gaveUp, ['https://x.nl/a']);
  assert.deepEqual(row.retry, []);
});

test('retryPlan: a page with a re-scan queued is not queued twice', () => {
  const files = [{ domain: 'x.nl', pagesFailed: 1, visited: ['https://x.nl/a'], failedUrls: failed('https://x.nl/a') }];
  const [row] = retryPlan(files, new Set(['https://x.nl/a']));
  assert.deepEqual(row.retry, []);
  assert.deepEqual(row.waiting, ['https://x.nl/a']);
});

test('retryPlan: domains are kept apart, clean scans produce no row, unlisted failures are counted', () => {
  const rows = retryPlan([
    { domain: 'clean.nl', pagesFailed: 0, visited: ['https://clean.nl/'], failedUrls: [] },
    { domain: 'big.nl', pagesFailed: 1200, visited: [], failedUrls: failed('https://big.nl/a') },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].domain, 'big.nl');
  assert.equal(rows[0].unrecorded, 1199);
});

const scan = (filename, domain, extra = {}) => ({ filename, domain, batchId: 'digi-x-1', ...extra });

test('pickReportFiles: nothing while only member scans exist', () => {
  assert.deepEqual(pickReportFiles([scan('videoscan-a.nl-1.json', 'a.nl'), scan('videoscan-b.nl-1.json', 'b.nl')], 'digi-x-1', isDerived), []);
});

test('pickReportFiles: the organisation merge, not a site merge, not another batch', () => {
  const scans = [
    scan('videoscan-b.nl-2.json', 'b.nl'),
    scan('videoscan-b.nl-1-merged.json', 'b.nl'), // one site's duplicates folded together
    scan('videoscan-x-organisatie-1-merged.json', 'x-organisatie'),
    { ...scan('videoscan-x-organisatie-0-merged.json', 'x-organisatie'), batchId: 'digi-x-0' }, // last month's run
    scan('videoscan-c.nl-INPROGRESS.json', 'c.nl'),
  ];
  assert.deepEqual(pickReportFiles(scans, 'digi-x-1', isDerived), ['videoscan-x-organisatie-1-merged.json']);
});

test('pickReportFiles: after a wrap-up the summary is the report', () => {
  const scans = [
    scan('videoscan-b.nl-1-merged.json', 'b.nl'), // its members are archived, so it no longer looks like a site merge
    scan('videoscan-digi-import-x-1-summary.json', 'Digi import — x', { isSummary: true }),
  ];
  assert.deepEqual(pickReportFiles(scans, 'digi-x-1', isDerived), ['videoscan-digi-import-x-1-summary.json']);
});

test('pickReportFiles: a batch of one site with one file reports on that file', () => {
  assert.deepEqual(pickReportFiles([{ filename: 'videoscan-a.nl-1.json', domain: 'a.nl', batchId: 'site-a.nl-1' }], 'site-a.nl-1', isDerived), ['videoscan-a.nl-1.json']);
});

const task = (id, status, context) => ({ id, status, context });

test('scanKey: a crawl is one scan under www. and without; listed pages are their own scan', () => {
  assert.equal(scanKey(task(1, 'failed', { scanUrl: 'https://x.nl/' })), scanKey(task(2, 'running', { scanUrl: 'https://www.x.nl' })));
  // A re-scan of just the homepage must not pass for the crawl of that site.
  assert.notEqual(scanKey(task(1, 'completed', { scanUrl: 'https://x.nl/' })), scanKey(task(2, 'failed', { scanUrl: 'https://x.nl/', urls: ['https://x.nl/'] })));
});

test('settle: only the newest attempt of a scan counts', () => {
  const s = settle([
    task(1, 'failed', { scanUrl: 'https://x.nl/' }), // lost in a restart …
    task(5, 'completed', { scanUrl: 'https://www.x.nl' }), // … and resumed as a new task
    task(2, 'completed', { scanUrl: 'https://y.nl/' }),
  ]);
  assert.equal(s.verdict, 'clean');
  assert.deepEqual(s.current.map(t => t.id), [5, 2]);
});

test('settle: busy, paused, failed and empty are told apart', () => {
  const done = task(1, 'completed', { scanUrl: 'https://a.nl/' });
  assert.equal(settle([done, task(2, 'pending', { scanUrl: 'https://b.nl/' })]).verdict, 'busy');
  assert.equal(settle([done, task(2, 'paused', { scanUrl: 'https://b.nl/' })]).verdict, 'paused');
  assert.equal(settle([done, task(2, 'paused', { scanUrl: 'https://b.nl/' }), task(3, 'running', { scanUrl: 'https://c.nl/' })]).verdict, 'busy');
  assert.equal(settle([done, task(2, 'failed', { scanUrl: 'https://b.nl/' })]).verdict, 'failed');
  assert.equal(settle([done, task(2, 'dismissed', { scanUrl: 'https://b.nl/' })]).verdict, 'failed');
  assert.equal(settle([done, task(2, 'needs-repo', { scanUrl: 'https://b.nl/' })]).verdict, 'failed');
  // Every task deleted, or the wrong server: never "every scan completed".
  assert.equal(settle([]).verdict, 'empty');
});
