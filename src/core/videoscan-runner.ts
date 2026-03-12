import { spawn, ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { claudeEmitter } from './claude-runner.js';
import { createLogger } from './logger.js';

const log = createLogger('videoscan-runner');

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIDEOSCAN_DIR = process.env.VIDEOSCAN_DIR || join(__dirname, '../../videoscans');

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
  error?: string;
}

export interface VideoscanOptions {
  scanUrl: string;
  maxPages?: number;
  concurrency?: number;
  resumeFile?: string;
}

export async function runVideoscan(taskId: number, options: VideoscanOptions): Promise<VideoscanResult> {
  const scanScript = join(__dirname, '../videoscan/scan.mjs');
  const reportScript = join(__dirname, '../videoscan/report.mjs');

  if (!existsSync(scanScript)) {
    return { success: false, error: `scan.mjs not found at ${scanScript}` };
  }

  const args = [scanScript, options.scanUrl];
  if (options.maxPages) args.push('--max-pages', String(options.maxPages));
  if (options.concurrency) args.push('--concurrency', String(options.concurrency));
  if (options.resumeFile) args.push('--resume', options.resumeFile);

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
        const reportProc = spawn('node', [reportScript, jsonFile], {
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

        reportProc.on('close', (reportCode) => {
          resolved = true;
          const htmlFile = jsonFile.replace('.json', '.html');
          const htmlExists = existsSync(join(VIDEOSCAN_DIR, htmlFile));
          resolve({
            success: true,
            jsonFile,
            htmlFile: htmlExists ? htmlFile : undefined,
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

export function listScans(): ScanSummary[] {
  try {
    const files = readdirSync(VIDEOSCAN_DIR)
      .filter(f => f.startsWith('videoscan-') && f.endsWith('.json'))
      .sort().reverse();

    return files.map(filename => {
      try {
        const data = JSON.parse(readFileSync(join(VIDEOSCAN_DIR, filename), 'utf-8'));
        const htmlFile = filename.replace('.json', '.html');
        return {
          filename,
          domain: data.domain || 'unknown',
          scanDate: data.scanDate || '',
          pagesScanned: data.pagesScanned || 0,
          pagesWithVideo: data.pagesWithVideo || data.details?.length || 0,
          uniquePlayers: data.uniquePlayers || Object.keys(data.playerSummary || {}).length,
          hasReport: existsSync(join(VIDEOSCAN_DIR, htmlFile)),
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
          canResume: false,
        };
      }
    });
  } catch {
    return [];
  }
}
