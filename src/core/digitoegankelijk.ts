// DigiToegankelijk organisation import: the organisation's site list (CSV
// export) grouped by root domain. Shared by the import route and the bb-core
// runner's videoscan_org recipe.
import { VideoscanRequestError } from './videoscan-start.js';

export interface DigiImportResult {
  orgName: string;
  totalSites: number;
  skippedApps: number;
  groups: { rootDomain: string; sites: { name: string; url: string; status: string }[] }[];
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { fields.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  fields.push(current.trim());
  return fields;
}

function ensureHttp(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

export async function importDigitoegankelijk(id: number): Promise<DigiImportResult> {
  if (!Number.isInteger(id) || id < 1 || id > 999999) throw new VideoscanRequestError(400, 'id must be a positive integer');

  const csvUrl = `https://dashboard.digitoegankelijk.nl/organisaties/download/${id}`;
  const csvRes = await fetch(csvUrl, { signal: AbortSignal.timeout(15_000) });
  if (!csvRes.ok) {
    throw new VideoscanRequestError(502, `Failed to fetch CSV: HTTP ${csvRes.status}`);
  }
  const MAX_CSV_SIZE = 5 * 1024 * 1024;
  const contentLength = parseInt(csvRes.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_CSV_SIZE) {
    throw new VideoscanRequestError(413, 'CSV too large');
  }
  const csvText = await csvRes.text();
  if (csvText.length > MAX_CSV_SIZE) {
    throw new VideoscanRequestError(413, 'CSV too large');
  }
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) {
    throw new VideoscanRequestError(400, 'CSV has no data rows');
  }

  const headers = parseCsvLine(lines[0]);
  const nameIdx = headers.findIndex(h => /^naam/i.test(h));
  // Some exports carry the organisation itself as a column. Prefer it over any
  // guess we make from the rows — but never confuse it with "Naam", which names
  // the *website* on that row, not its owner.
  // Anchored at both ends: a prefix match also hits "Organisatietype" and
  // "Organisatiecode", which would name every batch after a category ("Gemeente")
  // rather than an organisation.
  const orgIdx = headers.findIndex(h => /^(organisatie|organization|instantie|bedrijf)$/i.test(h.trim()));
  let urlIdx = headers.findIndex(h => /^url$/i.test(h));
  const typeIdx = headers.findIndex(h => /site of app/i.test(h));
  const statusIdx = headers.findIndex(h => /^status/i.test(h));

  // "Naam/URL" combined header → col 0 = name, col 1 = url
  if (urlIdx === -1 && nameIdx !== -1 && /\/url/i.test(headers[nameIdx])) {
    urlIdx = nameIdx + 1;
  }

  // Last resort: find first column whose data looks like a URL
  if (urlIdx === -1) {
    const sample = parseCsvLine(lines[1]);
    urlIdx = sample.findIndex(f => /^https?:\/\//i.test(f));
  }

  if (urlIdx === -1) {
    throw new VideoscanRequestError(400, 'CSV missing URL column');
  }

  let skippedApps = 0;
  const sites: { name: string; url: string; status: string; rootDomain: string; org: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (typeIdx !== -1 && /app/i.test(fields[typeIdx] || '')) {
      skippedApps++;
      continue;
    }
    const siteUrl = fields[urlIdx] || '';
    if (!siteUrl) continue;
    let hostname: string;
    try { hostname = new URL(ensureHttp(siteUrl)).hostname; } catch { continue; }
    const parts = hostname.replace(/^www\./, '').split('.');
    const rootDomain = parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
    sites.push({
      name: nameIdx !== -1 ? (fields[nameIdx] || '') : '',
      url: ensureHttp(siteUrl),
      status: statusIdx !== -1 ? (fields[statusIdx] || '') : '',
      rootDomain,
      org: orgIdx !== -1 ? (fields[orgIdx] || '').trim() : '',
    });
  }

  // Group by root domain
  const groupMap = new Map<string, typeof sites>();
  for (const site of sites) {
    if (!groupMap.has(site.rootDomain)) groupMap.set(site.rootDomain, []);
    groupMap.get(site.rootDomain)!.push(site);
  }

  const groups = [...groupMap.entries()]
    // Site count first, then domain name, so a tie resolves the same way every
    // time instead of by CSV row order — orgName below reads groups[0].
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([rootDomain, domainSites]) => ({
      rootDomain,
      sites: domainSites.map(({ name, url, status }) => ({ name, url, status })),
    }));

  // The organisation this import is named after. `Naam` is the name of the
  // website on that row, so reading row 0 named whole batches after whichever
  // site happened to sort first \u2014 a Krimpenerwaard import came out as
  // "Agenda vergaderingen Krimpenerwaard", and that name propagates all the way
  // into the merged scan's filename and the dashboard's domain column.
  //
  // Prefer an explicit organisation column; otherwise fall back to the domain
  // the most sites share, which is what the batch actually spans (four of
  // Krimpenerwaard's eight sites sit on krimpenerwaard.nl). `groups` is sorted
  // by site count, so groups[0] is that domain.
  //
  // The fallback is only taken when one domain OUTNUMBERS the rest. On a tie
  // there is no dominant domain to speak of, and picking either one would be the
  // same arbitrary choice this replaced — so the import stays explicitly unnamed
  // instead of asserting something wrong.
  //
  // Known limit: this names the batch after the most common domain, which for an
  // organisation whose sites are mostly hosted by one supplier is the supplier's
  // domain, not theirs. An explicit organisation column is the only real fix;
  // today's digitoegankelijk export has no such column.
  const orgFromColumn = sites.find(s => s.org)?.org;
  const hasDominantDomain = groups.length > 0 && (groups.length === 1 || groups[0].sites.length > groups[1].sites.length);
  // rootDomain is always "name.tld", so the first label is the name.
  const domainName = hasDominantDomain ? groups[0].rootDomain.split('.')[0] : '';
  const orgName = orgFromColumn || domainName || `Organisation ${id}`;

  return { orgName, totalSites: sites.length, skippedApps, groups };
}

/** Organisation id from a dashboard.digitoegankelijk.nl/organisaties/<id> URL or a bare id. */
export function parseDigiOrgId(digi: unknown): number | null {
  const s = typeof digi === 'number' ? String(digi) : typeof digi === 'string' ? digi.trim() : '';
  const m = s.match(/^https?:\/\/dashboard\.digitoegankelijk\.nl\/organisaties\/(\d+)/) || s.match(/^(\d+)$/);
  return m ? Number(m[1]) : null;
}
