// Server-side port of classifyGroupUrls/buildPlan from
// .claude/skills/videoscan-start/scripts/logic.mjs — keep the two in step
// (videoscan-batch-plan.test.ts runs both on the same inputs).

export interface PlanGroup {
  rootDomain: string;
  sites: { url: string }[];
}

export type PlanItem =
  | { kind: 'crawl'; url: string; maxPages: number }
  | { kind: 'urls'; urls: string[]; domain: string };

export const bare = (host: string): string => host.toLowerCase().replace(/^www\./, '');

const hostOf = (url: string): string => bare(new URL(url).hostname);

/**
 * Per host: its root URL is a crawl seed, anything else is scanned as the
 * listed pages only (a login page or one municipality's path on a supplier's
 * domain is not a reason to crawl the whole host).
 */
export function classifyGroupUrls(urls: string[]): { crawls: string[]; explicit: string[] } {
  const buckets = new Map<string, string[]>();
  for (const u of urls) {
    const host = hostOf(u);
    if (!buckets.has(host)) buckets.set(host, []);
    buckets.get(host)!.push(u);
  }
  const crawls: string[] = [];
  const explicit: string[] = [];
  for (const bucketUrls of buckets.values()) {
    const root = bucketUrls.find(u => new URL(u).pathname === '/');
    if (root) crawls.push(root);
    else explicit.push(...bucketUrls);
  }
  return { crawls, explicit };
}

/**
 * The tasks an import becomes. `excluded` and `shared` are sets of bare hosts.
 * Returns the plan, the URLs left out, and `unknown`: hosts named in a flag that
 * the plan has no use for — a typo there would otherwise crawl the very site the
 * flag was meant to hold back.
 */
export function buildPlan(
  groups: PlanGroup[],
  { excluded = new Set<string>(), shared = new Set<string>(), maxPages, sharedMaxPages }: {
    excluded?: Set<string>;
    shared?: Set<string>;
    maxPages: number;
    sharedMaxPages: number;
  },
): { plan: PlanItem[]; skipped: string[]; unknown: string[] } {
  const plan: PlanItem[] = [];
  const skipped: string[] = [];
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
  const crawlHosts = new Set(plan.flatMap(p => (p.kind === 'crawl' ? [hostOf(p.url)] : [])));
  const skippedHosts = new Set(skipped.map(hostOf));
  const unknown = [...excluded].filter(h => !skippedHosts.has(h)).concat([...shared].filter(h => !crawlHosts.has(h)));
  return { plan, skipped, unknown };
}
