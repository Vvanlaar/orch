import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { chromium } from 'playwright';
import { claudeEmitter } from './claude-runner.js';
import { createLogger } from './logger.js';
import { isSupabaseConfigured } from './db/client.js';
import { dbListScans } from './db/videoscans.js';

const log = createLogger('videoscan-runner');

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

export interface VideoscanOptions {
  scanUrl: string;
  maxPages?: number;
  concurrency?: number;
  resumeFile?: string;
  delay?: number;
}

export async function runVideoscan(taskId: number, options: VideoscanOptions): Promise<VideoscanResult> {
  const scanScript = join(PROJECT_ROOT, 'src/videoscan/scan.mjs');

  if (!existsSync(scanScript)) {
    return { success: false, error: `scan.mjs not found at ${scanScript}` };
  }

  const args = [scanScript, options.scanUrl];
  if (options.maxPages) args.push('--max-pages', String(options.maxPages));
  if (options.concurrency) args.push('--concurrency', String(options.concurrency));
  if (options.resumeFile) args.push('--resume', options.resumeFile);
  if (options.delay) args.push('--delay', String(options.delay));

  log.info(`Task #${taskId} Starting videoscan: ${options.scanUrl} (max ${options.maxPages || 50} pages)`);

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

      if (code !== 0) {
        resolved = true;
        resolve({ success: false, error: stderr || `scan.mjs exited with code ${code}` });
        return;
      }

      // Find the JSON file that was just created (most recent in VIDEOSCAN_DIR)
      const jsonFile = findLatestScanFile();
      if (!jsonFile) {
        resolved = true;
        resolve({ success: true }); // scan succeeded but no file found
        return;
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
          const htmlFile = jsonFile.replace('.json', '.html');
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

          resolved = true;
          resolve({
            success: true,
            jsonFile,
            htmlFile: htmlExists ? htmlFile : undefined,
            pdfFile,
          });
        });

        reportProc.on('error', (err) => {
          resolved = true;
          resolve({ success: true, jsonFile }); // scan worked, report failed
        });
      } catch {
        resolved = true;
        resolve({ success: true, jsonFile });
      }
    });

    proc.on('error', (err) => fail(err.message));
  });
}

export async function generateReport(jsonFilename: string): Promise<{ htmlFile?: string; pdfFile?: string }> {
  const jsonPath = join(VIDEOSCAN_DIR, jsonFilename);
  if (!existsSync(jsonPath)) throw new Error(`JSON file not found: ${jsonFilename}`);

  // Generate HTML
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('node', [REPORT_SCRIPT, jsonFilename], { cwd: VIDEOSCAN_DIR, shell: true });
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

  return { htmlFile, pdfFile };
}

export async function generatePreview(jsonFilename: string): Promise<{ htmlFile?: string; pdfFile?: string }> {
  const jsonPath = join(VIDEOSCAN_DIR, jsonFilename);
  if (!existsSync(jsonPath)) throw new Error(`JSON file not found: ${jsonFilename}`);

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('node', [REPORT_SCRIPT, jsonFilename, '--preview'], { cwd: VIDEOSCAN_DIR, shell: true });
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

  return { htmlFile, pdfFile };
}

async function generatePdf(htmlPath: string): Promise<string> {
  const pdfPath = htmlPath.replace('.html', '.pdf');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1000); // let CSS/fonts settle
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

export function mergeScans(filenames: string[]): MergeResult {
  if (filenames.length < 2) throw new Error('Need at least 2 scans to merge');

  const scansData = filenames.map(f => {
    const path = join(VIDEOSCAN_DIR, f);
    if (!existsSync(path)) throw new Error(`File not found: ${f}`);
    return JSON.parse(readFileSync(path, 'utf-8')) as ScanData;
  });

  // Verify same domain
  const domains = new Set(scansData.map(d => d.domain));
  if (domains.size > 1) throw new Error(`Cannot merge scans from different domains: ${[...domains].join(', ')}`);

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

  const merged: ScanData = {
    domain: scansData[0].domain,
    scanDate: latestDate,
    pagesScanned: visitedSet.size,
    pagesWithVideo: mergedDetails.length,
    uniquePlayers: playerMap.size,
    playerSummary: Object.fromEntries(playerMap),
    details: mergedDetails,
    _state: { visited: [...visitedSet], queue: [...queueSet] },
  };

  // Write merged file
  const ts = latestDate.replace(/[:.]/g, '-').replace('Z', '');
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
