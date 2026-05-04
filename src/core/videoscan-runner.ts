import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from 'playwright';
import { claudeEmitter } from './claude-runner.js';
import { createLogger } from './logger.js';
import { isSupabaseConfigured } from './db/client.js';
import { dbListScans, dbUpsertVideoscan } from './db/videoscans.js';
import { downloadFile, uploadScanFiles } from './db/storage.js';

const log = createLogger('videoscan-runner');

/** Silent unlink — ignores errors (file already gone, etc.) */
function tryUnlink(path: string): void {
  try { unlinkSync(path); } catch {}
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../../');
const VIDEOSCAN_DIR = process.env.VIDEOSCAN_DIR || join(PROJECT_ROOT, 'videoscans');

// report.mjs is always in src/ (not compiled to dist/)
const REPORT_SCRIPT = join(PROJECT_ROOT, 'src/videoscan/report.mjs');

// Ensure output directory exists
mkdirSync(VIDEOSCAN_DIR, { recursive: true });

export function getVideoscanDir(): string {
  return VIDEOSCAN_DIR;
}

// Running videoscan processes (for kill support)
const runningProcesses = new Map<number, ChildProcess>();

export interface VideoscanResult {
  success: boolean;
  jsonFile?: string;
  htmlFile?: string;
  pdfFile?: string;
  error?: string;
}

export interface ReportOptions {
  orgName?: string;
  coverImageUrl?: string;
  contactImageUrl?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
}

function reportOptionsToArgs(options?: ReportOptions): string[] {
  if (!options) return [];
  const args: string[] = [];
  // Quote values to handle spaces (spawn with shell: true joins args)
  const q = (v: string) => `"${v.replace(/"/g, '\\"')}"`;
  if (options.orgName) args.push('--org-name', q(options.orgName));
  if (options.coverImageUrl) args.push('--cover-image', q(options.coverImageUrl));
  if (options.contactImageUrl) args.push('--contact-image', q(options.contactImageUrl));
  if (options.contactName) args.push('--contact-name', q(options.contactName));
  if (options.contactPhone) args.push('--contact-phone', q(options.contactPhone));
  if (options.contactEmail) args.push('--contact-email', q(options.contactEmail));
  return args;
}

export interface VideoscanOptions {
  scanUrl: string;
  maxPages?: number;
  concurrency?: number;
  resumeFile?: string;
  delay?: number;
  urls?: string[];
  targetFilename?: string;
}

export async function runVideoscan(taskId: number, options: VideoscanOptions): Promise<VideoscanResult> {
  const scanScript = join(PROJECT_ROOT, 'src/videoscan/scan.mjs');

  if (!existsSync(scanScript)) {
    return { success: false, error: `scan.mjs not found at ${scanScript}` };
  }

  // Write temp URL file for --urls mode
  let tempUrlFile: string | undefined;
  if (options.urls?.length) {
    tempUrlFile = join(VIDEOSCAN_DIR, `_temp-urls-${taskId}.json`);
    writeFileSync(tempUrlFile, JSON.stringify(options.urls));
  }

  const args = [scanScript];
  if (tempUrlFile) {
    args.push('--urls', tempUrlFile);
  } else {
    args.push(options.scanUrl);
  }
  if (options.maxPages && !tempUrlFile) args.push('--max-pages', String(options.maxPages));
  if (options.concurrency) args.push('--concurrency', String(options.concurrency));
  if (options.resumeFile) args.push('--resume', options.resumeFile);
  if (options.delay) args.push('--delay', String(options.delay));

  log.info(`Task #${taskId} Starting videoscan: ${tempUrlFile ? `${options.urls!.length} explicit URLs` : options.scanUrl} (max ${options.maxPages || 50} pages)`);

  return new Promise((resolve) => {
    const proc = spawn('node', args, {
      cwd: VIDEOSCAN_DIR,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' }, // disable chalk colors for clean output
    });

    runningProcesses.set(taskId, proc);

    if (proc.pid) {
      claudeEmitter.emit('pid', taskId, proc.pid);
    }

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const fail = (error: string) => {
      if (resolved) return;
      resolved = true;
      runningProcesses.delete(taskId);
      resolve({ success: false, error });
    };

    proc.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      claudeEmitter.emit('output', taskId, chunk);
    });

    proc.stderr?.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      claudeEmitter.emit('output', taskId, `[stderr] ${chunk}`);
    });

    proc.on('close', async (code) => {
      if (resolved) return;
      runningProcesses.delete(taskId);

      // Clean up temp URL file
      if (tempUrlFile && existsSync(tempUrlFile)) tryUnlink(tempUrlFile);

      if (code !== 0) {
        resolved = true;
        resolve({ success: false, error: stderr || `scan.mjs exited with code ${code}` });
        return;
      }

      // Find the JSON file that was just created (most recent in VIDEOSCAN_DIR)
      let jsonFile = findLatestScanFile();
      if (!jsonFile) {
        resolved = true;
        resolve({ success: true }); // scan succeeded but no file found
        return;
      }

      // If targetFilename set, merge new scan into existing scan
      if (options.targetFilename) {
        claudeEmitter.emit('output', taskId, `\nMerging into ${options.targetFilename}...\n`);
        try {
          const targetPath = join(VIDEOSCAN_DIR, options.targetFilename);
          if (!existsSync(targetPath)) {
            await downloadFile(options.targetFilename, VIDEOSCAN_DIR);
          }
          const targetData = JSON.parse(readFileSync(targetPath, 'utf-8')) as ScanData;
          const newData = JSON.parse(readFileSync(join(VIDEOSCAN_DIR, jsonFile), 'utf-8')) as ScanData;
          const merged = mergeScansData([targetData, newData]);
          writeFileSync(targetPath, JSON.stringify(merged, null, 2));
          // Delete the temporary new scan file and its HTML/PDF if generated
          for (const ext of ['.json', '.html', '.pdf']) {
            tryUnlink(join(VIDEOSCAN_DIR, jsonFile.replace('.json', ext)));
          }
          jsonFile = options.targetFilename;
          claudeEmitter.emit('output', taskId, `Merged successfully (${merged.pagesScanned} pages, ${merged.pagesWithVideo} with video)\n`);
        } catch (err) {
          claudeEmitter.emit('output', taskId, `[warn] Merge failed: ${err}, keeping new scan as-is\n`);
        }
      }

      // Generate HTML report
      claudeEmitter.emit('output', taskId, '\nGenerating HTML report...\n');
      try {
        const reportProc = spawn('node', [REPORT_SCRIPT, jsonFile], {
          cwd: VIDEOSCAN_DIR,
          shell: true,
        });

        let reportOut = '';
        reportProc.stdout?.on('data', (d) => {
          const chunk = d.toString();
          reportOut += chunk;
          claudeEmitter.emit('output', taskId, chunk);
        });
        reportProc.stderr?.on('data', (d) => {
          claudeEmitter.emit('output', taskId, `[stderr] ${d.toString()}`);
        });

        reportProc.on('close', async (reportCode) => {
          const htmlFile = jsonFile!.replace('.json', '.html');
          const htmlPath = join(VIDEOSCAN_DIR, htmlFile);
          const htmlExists = existsSync(htmlPath);

          // Generate PDF from HTML report
          let pdfFile: string | undefined;
          if (htmlExists) {
            claudeEmitter.emit('output', taskId, 'Generating PDF report...\n');
            try {
              pdfFile = await generatePdf(htmlPath);
              claudeEmitter.emit('output', taskId, `PDF generated: ${pdfFile}\n`);
            } catch (err) {
              claudeEmitter.emit('output', taskId, `[warn] PDF generation failed: ${err}\n`);
            }
          }

          // Sync to Supabase (files + metadata)
          await syncScanToSupabase(jsonFile!);

          resolved = true;
          resolve({
            success: true,
            jsonFile: jsonFile!,
            htmlFile: htmlExists ? htmlFile : undefined,
            pdfFile,
          });
        });

        reportProc.on('error', async (err) => {
          await syncScanToSupabase(jsonFile!);
          resolved = true;
          resolve({ success: true, jsonFile: jsonFile! }); // scan worked, report failed
        });
      } catch {
        if (jsonFile) await syncScanToSupabase(jsonFile);
        resolved = true;
        resolve({ success: true, jsonFile });
      }
    });

    proc.on('error', (err) => fail(err.message));
  });
}

export async function generateReport(jsonFilename: string, options?: ReportOptions): Promise<{ htmlFile?: string; pdfFile?: string }> {
  const jsonPath = join(VIDEOSCAN_DIR, jsonFilename);
  if (!existsSync(jsonPath)) await downloadFile(jsonFilename, VIDEOSCAN_DIR);
  if (!existsSync(jsonPath)) throw new Error(`JSON file not found: ${jsonFilename}`);

  // Generate HTML
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('node', [REPORT_SCRIPT, jsonFilename, ...reportOptionsToArgs(options)], { cwd: VIDEOSCAN_DIR, shell: true });
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`report.mjs exited with code ${code}`)));
    proc.on('error', reject);
  });

  const htmlFile = jsonFilename.replace('.json', '.html');
  const htmlPath = join(VIDEOSCAN_DIR, htmlFile);
  if (!existsSync(htmlPath)) return {};

  // Generate PDF
  let pdfFile: string | undefined;
  try {
    pdfFile = await generatePdf(htmlPath);
  } catch (err) {
    log.warn(`PDF generation failed for ${jsonFilename}: ${err}`);
  }

  await syncScanToSupabase(jsonFilename);
  return { htmlFile, pdfFile };
}

export async function generatePreview(jsonFilename: string, options?: ReportOptions): Promise<{ htmlFile?: string; pdfFile?: string }> {
  const jsonPath = join(VIDEOSCAN_DIR, jsonFilename);
  if (!existsSync(jsonPath)) await downloadFile(jsonFilename, VIDEOSCAN_DIR);
  if (!existsSync(jsonPath)) throw new Error(`JSON file not found: ${jsonFilename}`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('node', [REPORT_SCRIPT, jsonFilename, '--preview', ...reportOptionsToArgs(options)], { cwd: VIDEOSCAN_DIR, shell: true });
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`report.mjs --preview exited with code ${code}`)));
    proc.on('error', reject);
  });

  const htmlFile = jsonFilename.replace('.json', '-preview.html');
  const htmlPath = join(VIDEOSCAN_DIR, htmlFile);
  if (!existsSync(htmlPath)) return {};

  let pdfFile: string | undefined;
  try {
    pdfFile = await generatePdf(htmlPath);
  } catch (err) {
    log.warn(`Preview PDF generation failed for ${jsonFilename}: ${err}`);
  }

  await syncScanToSupabase(jsonFilename);
  return { htmlFile, pdfFile };
}

async function generatePdf(htmlPath: string): Promise<string> {
  const pdfPath = htmlPath.replace('.html', '.pdf');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle', timeout: 60000 });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
  } finally {
    await browser.close();
  }
  const filename = pdfPath.split(/[/\\]/).pop()!;
  return filename;
}

function findLatestScanFile(): string | undefined {
  try {
    const files = readdirSync(VIDEOSCAN_DIR)
      .filter(f => f.startsWith('videoscan-') && f.endsWith('.json'))
      .map(f => ({ name: f, mtime: statSync(join(VIDEOSCAN_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.name;
  } catch {
    return undefined;
  }
}

export function findLatestScanFileForDomain(domain: string): string | null {
  if (!domain) return null;
  const prefix = `videoscan-${domain}-`;
  try {
    const files = readdirSync(VIDEOSCAN_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .map(f => ({ name: f, mtime: statSync(join(VIDEOSCAN_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.name ?? null;
  } catch {
    return null;
  }
}

export function killVideoscan(taskId: number): boolean {
  const proc = runningProcesses.get(taskId);
  if (!proc) return false;
  proc.kill('SIGTERM');
  runningProcesses.delete(taskId);
  return true;
}

export interface MergeResult {
  filename: string;
  archivedFiles: string[];
}

interface ScanDetail {
  url: string;
  players: { name: string; evidence: string[] }[];
}

interface ScanData {
  domain: string;
  scanDate: string;
  pagesScanned: number;
  pagesWithVideo: number;
  uniquePlayers: number;
  playerSummary: Record<string, { count: number; pages: string[] }>;
  details: ScanDetail[];
  _state: { visited: string[]; queue: string[] };
}

export function mergeScansData(scansData: ScanData[]): ScanData {
  // Merge details — dedupe by URL, keep entry with more players
  const detailMap = new Map<string, ScanDetail>();
  for (const scan of scansData) {
    for (const detail of scan.details) {
      const existing = detailMap.get(detail.url);
      if (!existing || detail.players.length > existing.players.length) {
        detailMap.set(detail.url, detail);
      }
    }
  }
  const mergedDetails = [...detailMap.values()];

  // Merge visited URLs (union)
  const visitedSet = new Set<string>();
  for (const scan of scansData) {
    for (const url of (scan._state?.visited || [])) visitedSet.add(url);
  }

  // Merge queue (union minus visited)
  const queueSet = new Set<string>();
  for (const scan of scansData) {
    for (const url of (scan._state?.queue || [])) {
      if (!visitedSet.has(url)) queueSet.add(url);
    }
  }

  // Recalculate player summary with { count, pages } structure
  const playerMap = new Map<string, { count: number; pages: string[] }>();
  for (const detail of mergedDetails) {
    for (const p of detail.players) {
      const entry = playerMap.get(p.name) || { count: 0, pages: [] };
      entry.count++;
      entry.pages.push(detail.url);
      playerMap.set(p.name, entry);
    }
  }

  // Use latest scan date
  const latestDate = scansData.reduce((latest, s) =>
    s.scanDate > latest ? s.scanDate : latest, scansData[0].scanDate);

  return {
    domain: scansData[0].domain,
    scanDate: latestDate,
    pagesScanned: visitedSet.size,
    pagesWithVideo: mergedDetails.length,
    uniquePlayers: playerMap.size,
    playerSummary: Object.fromEntries(playerMap),
    details: mergedDetails,
    _state: { visited: [...visitedSet], queue: [...queueSet] },
  };
}

export function mergeScans(filenames: string[], label?: string): MergeResult {
  if (filenames.length < 2) throw new Error('Need at least 2 scans to merge');

  const scansData = filenames.map(f => {
    const path = join(VIDEOSCAN_DIR, f);
    if (!existsSync(path)) throw new Error(`File not found: ${f}`);
    return JSON.parse(readFileSync(path, 'utf-8')) as ScanData;
  });

  // Verify same domain unless label provided (cross-domain merge)
  const domains = new Set(scansData.map(d => d.domain));
  if (!label && domains.size > 1) throw new Error(`Cannot merge scans from different domains: ${[...domains].join(', ')}. Use label param for cross-domain merge.`);

  const merged = mergeScansData(scansData);
  if (label) merged.domain = label;

  // Write merged file
  const ts = merged.scanDate.replace(/[:.]/g, '-').replace('Z', '');
  const mergedFilename = `videoscan-${merged.domain}-${ts}-merged.json`;
  writeFileSync(join(VIDEOSCAN_DIR, mergedFilename), JSON.stringify(merged, null, 2));

  // Archive source files (move to archived/ subdir)
  const archiveDir = join(VIDEOSCAN_DIR, 'archived');
  mkdirSync(archiveDir, { recursive: true });
  const archived: string[] = [];
  for (const f of filenames) {
    // Move JSON + associated HTML/PDF
    for (const ext of ['.json', '.html', '.pdf']) {
      const src = join(VIDEOSCAN_DIR, f.replace('.json', ext));
      if (existsSync(src)) {
        renameSync(src, join(archiveDir, f.replace('.json', ext)));
        archived.push(f.replace('.json', ext));
      }
    }
  }

  log.info(`Merged ${filenames.length} scans into ${mergedFilename} (${merged.pagesScanned} pages, ${merged.pagesWithVideo} with video)`);
  return { filename: mergedFilename, archivedFiles: archived };
}

/**
 * Sync a scan's files + metadata to Supabase (storage + DB row).
 */
export async function syncScanToSupabase(jsonFilename: string): Promise<void> {
  if (!isSupabaseConfigured()) return;

  const jsonPath = join(VIDEOSCAN_DIR, jsonFilename);
  if (!existsSync(jsonPath)) return;

  try {
    const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const htmlFile = jsonFilename.replace('.json', '.html');
    const pdfFile = jsonFilename.replace('.json', '.pdf');
    const previewFile = jsonFilename.replace('.json', '-preview.html');
    const previewPdfFile = jsonFilename.replace('.json', '-preview.pdf');

    // Upload files to Supabase Storage
    await uploadScanFiles(jsonFilename, VIDEOSCAN_DIR);

    // Upsert metadata row
    await dbUpsertVideoscan({
      filename: jsonFilename,
      domain: data.domain || 'unknown',
      scanDate: data.scanDate || new Date().toISOString(),
      pagesScanned: data.pagesScanned || 0,
      pagesWithVideo: data.pagesWithVideo || data.details?.length || 0,
      uniquePlayers: data.uniquePlayers || Object.keys(data.playerSummary || {}).length,
      playerSummary: data.playerSummary || {},
      details: data.details || [],
      scanState: data._state || {},
      hasReport: existsSync(join(VIDEOSCAN_DIR, htmlFile)),
      hasPdf: existsSync(join(VIDEOSCAN_DIR, pdfFile)),
      hasPreview: existsSync(join(VIDEOSCAN_DIR, previewFile)),
      hasPreviewPdf: existsSync(join(VIDEOSCAN_DIR, previewPdfFile)),
      canResume: (data._state?.queue?.length || 0) > 0,
    });

    log.info(`Synced ${jsonFilename} to Supabase`);
  } catch (err) {
    log.error(`Failed to sync ${jsonFilename}: ${err}`);
  }
}

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

function listScansFromDisk(): ScanSummary[] {
  try {
    const files = readdirSync(VIDEOSCAN_DIR)
      .filter(f => f.startsWith('videoscan-') && f.endsWith('.json'))
      .sort().reverse();

    return files.map(filename => {
      try {
        const data = JSON.parse(readFileSync(join(VIDEOSCAN_DIR, filename), 'utf-8'));
        const htmlFile = filename.replace('.json', '.html');
        const pdfFile = filename.replace('.json', '.pdf');
        const previewFile = filename.replace('.json', '-preview.html');
        const previewPdfFile = filename.replace('.json', '-preview.pdf');
        return {
          filename,
          domain: data.domain || 'unknown',
          scanDate: data.scanDate || '',
          pagesScanned: data.pagesScanned || 0,
          pagesWithVideo: data.pagesWithVideo || data.details?.length || 0,
          uniquePlayers: data.uniquePlayers || Object.keys(data.playerSummary || {}).length,
          hasReport: existsSync(join(VIDEOSCAN_DIR, htmlFile)),
          hasPdf: existsSync(join(VIDEOSCAN_DIR, pdfFile)),
          hasPreview: existsSync(join(VIDEOSCAN_DIR, previewFile)),
          hasPreviewPdf: existsSync(join(VIDEOSCAN_DIR, previewPdfFile)),
          canResume: (data._state?.queue?.length || 0) > 0,
        };
      } catch {
        return {
          filename,
          domain: 'unknown',
          scanDate: '',
          pagesScanned: 0,
          pagesWithVideo: 0,
          uniquePlayers: 0,
          hasReport: false,
          hasPdf: false,
          hasPreview: false,
          hasPreviewPdf: false,
          canResume: false,
        };
      }
    });
  } catch {
    return [];
  }
}

export async function listScans(): Promise<ScanSummary[]> {
  if (isSupabaseConfigured()) {
    try {
      return await dbListScans();
    } catch {
      return listScansFromDisk();
    }
  }
  return listScansFromDisk();
}
