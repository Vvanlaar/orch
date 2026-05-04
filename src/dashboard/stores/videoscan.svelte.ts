export interface ScanSummary {
  filename: string;
  domain: string;
  scanDate: string;
  pagesScanned: number;
  pagesWithVideo: number;
  uniquePlayers: number;
  hasReport: boolean;
  hasPdf: boolean;
  hasPreview: boolean;
  hasPreviewPdf: boolean;
  canResume: boolean;
}

let scans = $state<ScanSummary[]>([]);
let loading = $state(false);

export function getScans() { return scans; }
export function isLoading() { return loading; }

export async function fetchScans() {
  loading = true;
  try {
    const res = await fetch('/api/videoscans');
    scans = await res.json();
  } catch (err) {
    console.error('Failed to fetch scans:', err);
  } finally {
    loading = false;
  }
}

async function postJson(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export interface BatchCtx {
  id: string;
  label: string;
}

export function startScan(url: string, maxPages: number, concurrency: number, delay: number, batch?: BatchCtx) {
  return postJson('/api/actions/start-videoscan', {
    url, maxPages, concurrency, delay,
    ...(batch ? { batchId: batch.id, batchLabel: batch.label } : {}),
  });
}

export function startGroupScan(urls: string[], maxPages: number, concurrency: number, delay: number, batch?: BatchCtx) {
  return postJson('/api/actions/start-videoscan-urls', {
    urls, maxPages, concurrency, delay,
    ...(batch ? { batchId: batch.id, batchLabel: batch.label } : {}),
  });
}

export function resumeScan(filename: string, maxPages: number, concurrency: number, delay: number) {
  return postJson('/api/actions/resume-videoscan', { filename, maxPages, concurrency, delay });
}

export function addUrlsToScan(filename: string, urls: string[], concurrency: number, delay: number) {
  return postJson('/api/actions/add-urls-to-scan', { filename, urls, concurrency, delay });
}

export interface ReportOptions {
  orgName?: string;
  coverImageUrl?: string;
  contactImageUrl?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}

export async function regenerateReport(filename: string, options?: ReportOptions) {
  const result = await postJson('/api/videoscans/generate-report', { filename, ...options });
  await fetchScans();
  return result;
}

export async function regeneratePreview(filename: string, options?: ReportOptions) {
  const result = await postJson('/api/videoscans/generate-preview', { filename, ...options });
  await fetchScans();
  return result;
}

export interface DigiImportSite {
  name: string;
  url: string;
  status: string;
}

export interface DigiImportGroup {
  rootDomain: string;
  sites: DigiImportSite[];
}

export interface DigiImportResult {
  orgName: string;
  totalSites: number;
  skippedApps: number;
  groups: DigiImportGroup[];
}

export async function importDigiToegankelijk(id: number): Promise<DigiImportResult> {
  return postJson('/api/videoscans/import-digitoegankelijk', { id });
}

export async function mergeDomainScans(filenames: string[]) {
  const result = await postJson('/api/videoscans/merge', { filenames });
  await fetchScans();
  return result;
}

// Buckets a group's URLs by hostname (www-stripped). Per bucket: if any URL is
// a domain root (pathname === "/"), seed a crawl from the first such URL;
// otherwise fold subpages into a combined explicit-scan list. Subpages from
// hostnames without a root are merged together since scanExplicitUrls is
// hostname-agnostic.
export function classifyGroupUrls(urls: string[]): { crawls: string[]; explicit: string[] } {
  const buckets = new Map<string, string[]>();
  for (const u of urls) {
    let host: string;
    try { host = new URL(u).hostname.replace(/^www\./, ''); } catch { continue; }
    if (!buckets.has(host)) buckets.set(host, []);
    buckets.get(host)!.push(u);
  }

  const crawls: string[] = [];
  const explicit: string[] = [];
  for (const [, bucketUrls] of buckets) {
    const root = bucketUrls.find(u => {
      try { return new URL(u).pathname === '/'; } catch { return false; }
    });
    if (root) crawls.push(root);
    else explicit.push(...bucketUrls);
  }
  return { crawls, explicit };
}
