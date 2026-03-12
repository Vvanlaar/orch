export interface ScanSummary {
  filename: string;
  domain: string;
  scanDate: string;
  pagesScanned: number;
  pagesWithVideo: number;
  uniquePlayers: number;
  hasReport: boolean;
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

export function startScan(url: string, maxPages: number, concurrency: number) {
  return postJson('/api/actions/start-videoscan', { url, maxPages, concurrency });
}

export function resumeScan(filename: string, maxPages: number, concurrency: number) {
  return postJson('/api/actions/resume-videoscan', { filename, maxPages, concurrency });
}
