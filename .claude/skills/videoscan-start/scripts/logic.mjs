// The decisions the videoscan-start scripts make, as pure functions: no network,
// no disk, no process.exit. The scripts do the I/O and call these; the tests in
// logic.test.mjs call them directly.

export const bare = (host) => host.toLowerCase().replace(/^www\./, '');

const hostOf = (url) => bare(new URL(url).hostname);

/**
 * Per host: its root URL is a crawl seed, anything else is scanned as the
 * listed pages only (a login page or one municipality's path on a supplier's
 * domain is not a reason to crawl the whole host). Mirrors classifyGroupUrls in
 * src/dashboard/stores/videoscan.svelte.ts — keep the two in step.
 */
export function classifyGroupUrls(urls) {
  const buckets = new Map();
  for (const u of urls) {
    const host = hostOf(u);
    if (!buckets.has(host)) buckets.set(host, []);
    buckets.get(host).push(u);
  }
  const crawls = [];
  const explicit = [];
  for (const bucketUrls of buckets.values()) {
    const root = bucketUrls.find(u => new URL(u).pathname === '/');
    if (root) crawls.push(root);
    else explicit.push(...bucketUrls);
  }
  return { crawls, explicit };
}

/**
 * The tasks an import becomes. `groups` is the server's import result
 * ([{ rootDomain, sites: [{ url }] }]); `excluded` and `shared` are sets of
 * bare hosts. Returns the plan, the URLs left out, and `unknown`: hosts named
 * in a flag that the plan has no use for — a typo there would otherwise crawl
 * the very site the flag was meant to hold back.
 */
export function buildPlan(groups, { excluded = new Set(), shared = new Set(), maxPages, sharedMaxPages }) {
  const plan = [];
  const skipped = [];
  for (const group of groups) {
    const urls = group.sites.map(s => s.url).filter(u => {
      const keep = !excluded.has(hostOf(u));
      if (!keep) skipped.push(u);
      return keep;
    });
    const { crawls, explicit } = classifyGroupUrls(urls);
    for (const url of crawls) plan.push({ kind: 'crawl', url, maxPages: shared.has(hostOf(url)) ? sharedMaxPages : maxPages });
    if (explicit.length) plan.push({ kind: 'urls', urls: explicit, domain: group.rootDomain });
  }
  const crawlHosts = new Set(plan.filter(p => p.kind === 'crawl').map(p => hostOf(p.url)));
  const skippedHosts = new Set(skipped.map(hostOf));
  const unknown = [...excluded].filter(h => !skippedHosts.has(h)).concat([...shared].filter(h => !crawlHosts.has(h)));
  return { plan, skipped, unknown };
}

// Worth a second try: the page may well exist. An expired certificate, a dead
// host name or a refusal will fail the same way again.
const TRANSIENT = /Timeout|ERR_TIMED_OUT|ERR_CONNECTION_(RESET|CLOSED|TIMED_OUT)|ERR_NETWORK_CHANGED|ERR_EMPTY_RESPONSE|ERR_ABORTED|ERR_HTTP2_PROTOCOL_ERROR/i;
export const isTransient = (error) => TRANSIENT.test(error || '');

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The original scan plus two re-scans; after that a page is reported unchecked. */
export const MAX_ATTEMPTS = 3;

/**
 * What to do with the pages a batch's scans could not load, per domain.
 *
 * `files`: the batch's own scan files (not merges, not checkpoints) as
 * { domain, pagesFailed, visited: [url], failedUrls: [{ url, error }] }. A
 * re-scan is one more such file for the same domain, so the state of a page is
 * read from the files themselves: loaded in any of them = done; failed in
 * MAX_ATTEMPTS of them = given up. Nothing is remembered between runs.
 * `inFlight`: URLs of re-scans that are queued or running — their file does not
 * exist yet, and queueing them again would scan them twice.
 */
export function retryPlan(files, inFlight = new Set()) {
  const byDomain = new Map();
  for (const f of files) {
    if (!byDomain.has(f.domain)) byDomain.set(f.domain, []);
    byDomain.get(f.domain).push(f);
  }
  const out = [];
  for (const [domain, scans] of byDomain) {
    const attempts = new Map(); // url → [error, …], one per file it failed in
    const loaded = new Set();
    let unrecorded = 0;
    for (const s of scans) {
      const failed = new Set();
      for (const f of s.failedUrls || []) {
        failed.add(f.url);
        if (!attempts.has(f.url)) attempts.set(f.url, []);
        attempts.get(f.url).push(f.error || '');
      }
      for (const u of s.visited || []) if (!failed.has(u)) loaded.add(u);
      // scan.mjs stops listing failed URLs at 1000; the rest are only counted.
      unrecorded += Math.max(0, (s.pagesFailed || 0) - (s.failedUrls || []).length);
    }
    const row = { domain, retry: [], waiting: [], gaveUp: [], permanent: [], recovered: 0, unrecorded };
    for (const [url, errors] of attempts) {
      if (loaded.has(url)) row.recovered++;
      else if (!isTransient(errors.at(-1))) row.permanent.push({ url, error: errors.at(-1) });
      else if (inFlight.has(url)) row.waiting.push(url);
      else if (errors.length >= MAX_ATTEMPTS) row.gaveUp.push(url);
      else row.retry.push(url);
    }
    if (attempts.size || unrecorded) out.push(row);
  }
  return out;
}

/**
 * Which file is a batch's report. `scans`: every scan file as listScans() gives
 * them. The organisation report is a derived file of the batch that is not
 * simply one site's duplicates folded together: the cross-domain merge the
 * service writes when the batch's last task finishes (its `domain` is the merge
 * label, not a host of the batch), or the summary a manual wrap-up writes. A
 * batch of one site with a single file has no merge; that file is the report.
 */
export function pickReportFiles(scans, batchId, isDerived) {
  const mine = scans.filter(s => !s.unreadable && s.batchId === batchId && !s.filename.includes('INPROGRESS'));
  const members = mine.filter(s => !isDerived(s.filename));
  const memberHosts = new Set(members.map(s => bare(s.domain)));
  // A summary means a wrap-up ran, and a wrap-up also leaves per-site merges
  // behind whose members are archived by then — so the summary alone counts.
  const summaries = mine.filter(s => s.isSummary);
  const reports = summaries.length ? summaries : mine.filter(s => isDerived(s.filename) && !memberHosts.has(bare(s.domain)));
  if (reports.length) return reports.map(s => s.filename);
  return mine.length === 1 ? [mine[0].filename] : [];
}

/**
 * One scan can have several tasks over time: the service resumes a crawl it
 * lost in a restart as a NEW task, and a resume or retry by hand does the same.
 * Only the newest attempt says how the scan ended. A crawl is keyed by host,
 * not URL — a manual resume rewrites its start URL to https://www.<domain>.
 */
export function scanKey(task) {
  const ctx = task.context || {};
  if (ctx.urls?.length) return `pages:${[...ctx.urls].sort().join(' ')}`;
  try { return `crawl:${hostOf(ctx.scanUrl)}`; } catch { return `#${task.id}`; }
}

export function taskLabel(task) {
  const ctx = task.context || {};
  try {
    const host = new URL(ctx.scanUrl || ctx.urls?.[0]).hostname;
    return ctx.urls?.length ? `${host}(${ctx.urls.length}p)` : host;
  } catch {
    return `#${task.id}`;
  }
}

/**
 * Where a batch stands. `verdict`: 'busy' while anything is pending or running;
 * 'empty' when there is no task at all (never read that as done); 'paused' when
 * only paused tasks keep it open; otherwise 'clean' or 'failed'.
 */
export function settle(tasks) {
  const newest = new Map();
  for (const t of tasks) {
    const k = scanKey(t);
    if (!newest.has(k) || newest.get(k) < t.id) newest.set(k, t.id);
  }
  const current = tasks.filter(t => newest.get(scanKey(t)) === t.id);
  const by = {};
  for (const t of current) (by[t.status] ??= []).push(t);
  const busy = (by.pending?.length || 0) + (by.running?.length || 0);
  const verdict = !current.length ? 'empty'
    : busy ? 'busy'
    : by.paused?.length ? 'paused'
    : (by.completed?.length || 0) === current.length ? 'clean' : 'failed';
  return { current, by, busy, verdict };
}
