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

export function startScan(url: string, maxPages: number, concurrency: number, delay: number) {
  return postJson('/api/actions/start-videoscan', { url, maxPages, concurrency, delay });
}

export function startGroupScan(urls: string[], maxPages: number, concurrency: number, delay: number) {
  return postJson('/api/actions/start-videoscan-urls', { urls, maxPages, concurrency, delay });
}

export function resumeScan(filename: string, maxPages: number, concurrency: number, delay: number) {
  return postJson('/api/actions/resume-videoscan', { filename, maxPages, concurrency, delay });
}

export function addUrlsToScan(filename: string, urls: string[], concurrency: number, delay: number) {
  return postJson('/api/actions/add-urls-to-scan', { filename, urls, concurrency, delay });
}

export async function regenerateReport(filename: string) {
  const result = await postJson('/api/videoscans/generate-report', { filename });
  await fetchScans();
  return result;
}

export async function regeneratePreview(filename: string) {
  const result = await postJson('/api/videoscans/generate-preview', { filename });
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
