// The videoscan recipes orch offers bb-core as a runner (bbcore-runner.ts).
// A job becomes ordinary videoscan tasks tagged with context.bbCoreJobId and
// pinned to this machine; the job follows them until they settle and reports
// their scan back.
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseScanProgress, effectivePlanned } from '../shared/videoscan-progress.js';
import { startRunner, MAX_ARTIFACT_BYTES, type JobContext, type Recipe, type RunnerHandle, type RunnerJob, type RunnerState } from './bbcore-runner.js';
import { bare, buildPlan } from './videoscan-batch-plan.js';
import { MACHINE_ID } from './db/client.js';
import { importDigitoegankelijk, parseDigiOrgId } from './digitoegankelijk.js';
import { createLogger } from './logger.js';
import { triggerUpdate } from './task-processor.js';
import { getAllTasks, getStreamingOutput, getTask, getTasksByBatchId, updateTaskContext, failTask } from './task-queue.js';
import { stopRunningTask } from './task-stop.js';
import type { Task } from './types.js';
import { ensureLocal, getVideoscanDir, isDerivedScan, listScans, type ScanSummary } from './videoscan-runner.js';
import { isBatchSummary } from './videoscan-row.js';
import { startVideoscanTask, startVideoscanUrlsTask } from './videoscan-start.js';

const log = createLogger('bbcore-recipes');

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../');
const PACKAGE = 'commercieel';
const POLL_MS = 5_000;
const MAX_PAGES = 20_000;
/** After the batch settled: how long to wait for the auto-merge, then for its report. */
const MERGE_WAIT_MS = 15 * 60_000;
/** An auto-resume fails the old task before it creates the new one. */
const SUCCESSOR_WAIT_MS = 60_000;
const TERMINAL = new Set(['completed', 'failed', 'dismissed']);
const JSON_LINE = /^JSON:\s*(.+\.json)\s*$/m;
const TOP_PLAYERS = 20;
const DETAIL_PAGES = 50;

type Mode = 'video' | 'sovereignty';

// Tasks each job has spawned, so a settled job can mark them all reported.
const jobTasks = new Map<string, Set<number>>();

function track(jobId: string, ids: number[]): void {
  if (!jobTasks.has(jobId)) jobTasks.set(jobId, new Set());
  for (const id of ids) jobTasks.get(jobId)!.add(id);
}

async function markReported(jobId: string): Promise<void> {
  const ids = jobTasks.get(jobId);
  jobTasks.delete(jobId);
  for (const id of ids ?? []) {
    try { await updateTaskContext(id, { bbCoreReported: true }); } catch (err) { log.warn(`Task #${id}: could not mark bb-core job ${jobId} reported: ${err}`); }
  }
}

// --- input ---

function optInt(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Error(`${name} must be an integer ${min}-${max}`);
  return v as number;
}

function optMode(v: unknown): Mode {
  if (v === undefined || v === null || v === 'video') return 'video';
  if (v === 'sovereignty') return 'sovereignty';
  throw new Error('mode must be "video" or "sovereignty"');
}

function httpUrl(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error('url required');
  const s = v.trim();
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new Error(`Invalid URL: ${s}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('url must be http(s)');
  return u.href;
}

function scanFilename(v: unknown): string {
  // Same guard as the HTTP routes: the name is joined onto the scans dir.
  if (typeof v !== 'string' || !v || v.includes('..') || /[/\\:]/.test(v) || !v.endsWith('.json')) {
    throw new Error('filename must be a scan JSON file name (from videoscan_list)');
  }
  return v;
}

const extra = (jobId: string) => ({ bbCoreJobId: jobId, targetMachineId: MACHINE_ID });

// --- reading scans ---

type ScanJson = {
  domain?: string;
  scanDate?: string;
  pagesScanned?: number;
  pagesWithVideo?: number;
  mode?: string;
  batchId?: string;
  playerSummary?: Record<string, { count?: number }>;
  details?: { url: string; players?: { name: string }[] }[];
};

/** Where a scan file is on disk: the scans dir, or archived/ once a merge took it in. */
function scanFileDir(filename: string): string | null {
  for (const dir of [getVideoscanDir(), join(getVideoscanDir(), 'archived')]) {
    if (existsSync(join(dir, filename))) return dir;
  }
  return null;
}

/** Reads a scan, fetching it from storage only when it is nowhere on disk. */
async function loadScan(filename: string): Promise<{ scan: ScanJson; dir: string }> {
  let dir = scanFileDir(filename);
  if (!dir) {
    // Never for an archived scan: fetched back into the scans dir it would undo its merge
    await ensureLocal([filename]);
    dir = getVideoscanDir();
  }
  return { scan: JSON.parse(readFileSync(join(dir, filename), 'utf-8')), dir };
}

type ScoreModule = {
  loadVendors(): Record<string, unknown>;
  scoreSite(scan: ScanJson, vendors: Record<string, unknown>): {
    grade: string | null;
    players: { player: string; rated: boolean; grade?: string; score?: number; pages: number }[];
    pagesPerGrade: Record<string, number>;
    unrated: string[];
  };
  GRADE_ORDER: string[];
};
let scoreModule: Promise<ScoreModule> | null = null;
function loadScore(): Promise<ScoreModule> {
  // score.mjs is not compiled to dist/; always load it from src/
  scoreModule ??= import(pathToFileURL(join(PROJECT_ROOT, 'src/videoscan/sovereignty/score.mjs')).href);
  return scoreModule;
}

async function sovereigntyOf(scan: ScanJson) {
  const { loadVendors, scoreSite } = await loadScore();
  const site = scoreSite(scan, loadVendors());
  return {
    grade: site.grade,
    pagesPerGrade: site.pagesPerGrade,
    players: site.players.map(p => ({ player: p.player, pages: p.pages, ...(p.rated ? { grade: p.grade, score: p.score } : { rated: false }) })),
    unrated: site.unrated,
  };
}

function summarize(filename: string, scan: ScanJson) {
  const players = Object.entries(scan.playerSummary ?? {})
    .map(([player, s]) => ({ player, pages: s?.count ?? 0 }))
    .sort((a, b) => b.pages - a.pages);
  return {
    filename,
    domain: scan.domain ?? 'unknown',
    scanDate: scan.scanDate ?? '',
    pagesScanned: scan.pagesScanned ?? 0,
    pagesWithVideo: scan.pagesWithVideo ?? scan.details?.length ?? 0,
    uniquePlayers: players.length,
    mode: scan.mode === 'sovereignty' ? 'sovereignty' : 'video',
    ...(scan.batchId ? { batchId: scan.batchId } : {}),
    playerSummary: players.slice(0, TOP_PLAYERS),
    ...(players.length > TOP_PLAYERS ? { morePlayers: players.length - TOP_PLAYERS } : {}),
  };
}

/** Uploads the scan's HTML report (and PDF) beside it; returns what the result can name. */
async function uploadReport(ctx: JobContext, filename: string, dir: string) {
  const uploaded: { name: string; contentType: string }[] = [];
  const notes: string[] = [];
  for (const [ext, contentType] of [['.html', 'text/html'], ['.pdf', 'application/pdf']] as const) {
    const name = filename.replace(/\.json$/, ext);
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    if (statSync(p).size > MAX_ARTIFACT_BYTES) {
      notes.push(`${name} is over the 20 MB artifact limit; open it in orch`);
      continue;
    }
    try {
      await ctx.artifact(name, contentType, readFileSync(p));
      uploaded.push({ name, contentType });
    } catch (err) {
      notes.push(`${name} upload failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return {
    ...(uploaded[0] ? { artifact: uploaded[0] } : {}),
    ...(uploaded.length ? { artifacts: uploaded } : {}),
    ...(notes.length ? { artifactNotes: notes } : {}),
  };
}

async function scanResult(ctx: JobContext, filename: string, { sovereignty }: { sovereignty?: boolean } = {}) {
  const { scan, dir } = await loadScan(filename);
  return {
    scan,
    result: {
      ...summarize(filename, scan),
      ...(sovereignty || scan.mode === 'sovereignty' ? { sovereignty: await sovereigntyOf(scan) } : {}),
      ...(await uploadReport(ctx, filename, dir)),
    },
  };
}

// --- following tasks ---

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function taskProgress(task: Task) {
  const p = parseScanProgress(getStreamingOutput(task.id), task.context.maxPages ?? 0);
  let domain = '';
  try { domain = new URL(task.context.scanUrl ?? '').hostname; } catch { /* no URL */ }
  return {
    taskId: task.id,
    domain,
    status: task.status,
    visited: p.visited,
    planned: effectivePlanned(p, task.context.urls?.length ?? 0),
    maxPages: p.maxPages,
    ...(p.pagesPerMin !== null ? { pagesPerMin: p.pagesPerMin } : {}),
    ...(p.etaMin !== null ? { etaMin: p.etaMin } : {}),
  };
}

/** The task an auto-resume created for this job after `afterId`, if any. */
async function successorOf(jobId: string, afterId: number): Promise<Task | undefined> {
  return (await getAllTasks(100))
    .filter(t => t.type === 'videoscan' && t.context.bbCoreJobId === jobId && t.id > afterId)
    .sort((a, b) => b.id - a.id)[0];
}

/** Fails what is still open of the job's tasks; bb-core cancelled it. */
async function cancelTasks(ids: number[]): Promise<void> {
  for (const id of ids) {
    const t = await getTask(id);
    if (!t || TERMINAL.has(t.status)) continue;
    if (t.status === 'running') {
      const killError = await stopRunningTask(t, 'bb-core');
      if (killError) log.error(`Task #${id}: cancel requested but process still alive: ${killError}`);
    } else {
      await failTask(id, 'Cancelled via bb-core');
    }
    triggerUpdate(id);
  }
}

/** Ends a watch loop that stopped before the work did. */
async function stopped(ctx: JobContext, ids: number[]): Promise<never> {
  if (ctx.cancelRequested) {
    await cancelTasks(ids);
    throw new Error('Cancelled');
  }
  throw new Error('Stopped reporting (runner stopping or job gone)');
}

async function watchSite(ctx: JobContext, taskId: number, sovereignty: boolean) {
  let id = taskId;
  let failedSeenAt: number | null = null;
  track(ctx.job.id, [id]);
  while (!ctx.signal.aborted) {
    const task = await getTask(id);
    if (!task) throw new Error(`Task #${id} not found`);
    if (task.status === 'failed') {
      const next = await successorOf(ctx.job.id, id);
      if (next) {
        log.info(`Job ${ctx.job.id}: following auto-resume #${id} → #${next.id}`);
        id = next.id;
        track(ctx.job.id, [id]);
        failedSeenAt = null;
        continue;
      }
      failedSeenAt ??= Date.now();
      const resuming = /auto-resuming/.test(task.error ?? '') && Date.now() - failedSeenAt < SUCCESSOR_WAIT_MS;
      if (!resuming) throw new Error(task.error || `Videoscan task #${id} failed`);
    } else if (TERMINAL.has(task.status)) {
      if (task.status !== 'completed') throw new Error(`Videoscan task #${id} ${task.status}`);
      const file = task.result?.match(JSON_LINE)?.[1]?.trim();
      if (!file) throw new Error(`Videoscan task #${id} completed without a scan file`);
      return { taskId: id, ...(await scanResult(ctx, file, { sovereignty })).result };
    }
    await ctx.progress({ phase: 'scanning', ...taskProgress(task) });
    await sleep(POLL_MS, ctx.signal);
  }
  return stopped(ctx, [id]);
}

const completedFile = (t: Task) => (t.status === 'completed' ? t.result?.match(JSON_LINE)?.[1]?.trim() : undefined);

async function orgSovereignty(files: string[]) {
  const { GRADE_ORDER } = await loadScore();
  const sites: { domain: string; grade: string | null }[] = [];
  for (const f of files) {
    try {
      const { scan } = await loadScan(f);
      sites.push({ domain: scan.domain ?? f, grade: (await sovereigntyOf(scan)).grade });
    } catch (err) {
      log.warn(`Sovereignty grade of ${f} failed: ${err}`);
    }
  }
  const graded = sites.map(s => s.grade).filter((g): g is string => !!g);
  const worst = graded.length ? graded.reduce((a, b) => (GRADE_ORDER.indexOf(a) >= GRADE_ORDER.indexOf(b) ? a : b)) : null;
  return { grade: worst, sites };
}

async function watchOrg(ctx: JobContext, batchId: string, meta: { orgName?: string; sovereignty: boolean; notScanned?: string[]; startErrors?: string[] }) {
  let settledAt: number | null = null;
  let mergedAt: number | null = null;
  let ids: number[] = [];
  while (!ctx.signal.aborted) {
    const tasks = (await getTasksByBatchId(batchId)).filter(t => t.type === 'videoscan');
    ids = tasks.map(t => t.id);
    track(ctx.job.id, ids);
    // resolveDeadVideoscan fails a row before it creates the resumed one
    const autoResumed = (t: Task) => t.status === 'failed' && /auto-resuming/.test(t.error ?? '');
    const hasSuccessor = (t: Task) => tasks.some(o => o.id > t.id && o.context.scanUrl === t.context.scanUrl);
    const open = tasks.filter(t => !TERMINAL.has(t.status));
    const resumeDue = tasks.some(t => autoResumed(t) && !hasSuccessor(t)) && Date.now() - (settledAt ??= Date.now()) < SUCCESSOR_WAIT_MS;
    if (open.length || resumeDue) {
      settledAt = null;
      const counts: Record<string, number> = {};
      for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
      await ctx.progress({ phase: 'scanning', batchId, counts, sites: open.slice(0, 20).map(taskProgress) });
    } else {
      settledAt ??= Date.now();
      const files = [...new Set(tasks.map(completedFile).filter((f): f is string => !!f))];
      const failed = tasks.filter(t => t.status !== 'completed' && !(autoResumed(t) && hasSuccessor(t))).map(t => ({ taskId: t.id, url: t.context.scanUrl, error: t.error }));
      const base = {
        batchId,
        ...(meta.orgName ? { orgName: meta.orgName } : {}),
        tasks: tasks.length,
        ...(failed.length ? { failed } : {}),
        ...(meta.notScanned?.length ? { notScanned: meta.notScanned } : {}),
        ...(meta.startErrors?.length ? { startErrors: meta.startErrors } : {}),
      };
      if (!files.length) throw new Error(`No scan of batch ${batchId} completed`);
      const sovereignty = async () => (meta.sovereignty ? { sovereignty: await orgSovereignty(files) } : {});
      // tryAutoMergeBatch merges only 2+ tasks with 2+ distinct scan files
      if (tasks.length < 2 || files.length < 2) {
        return { ...base, ...(await scanResult(ctx, files[0])).result, ...(await sovereignty()) };
      }
      const merged = (await listScans()).find((s: ScanSummary) => s.batchId === batchId && isDerivedScan(s.filename) && !isBatchSummary(s.filename));
      if (merged) {
        mergedAt ??= Date.now();
        // The merge's report is generated after it is listed
        const hasReport = existsSync(join(getVideoscanDir(), merged.filename.replace(/\.json$/, '.html')));
        if (hasReport || Date.now() - mergedAt > MERGE_WAIT_MS) {
          return { ...base, members: files, ...(await scanResult(ctx, merged.filename)).result, ...(await sovereignty()) };
        }
      } else if (Date.now() - settledAt > MERGE_WAIT_MS) {
        return { ...base, members: files, note: 'The batch auto-merge produced no merged scan; see members', ...(await sovereignty()) };
      }
      await ctx.progress({ phase: 'merging', batchId, tasks: tasks.length });
    }
    await sleep(POLL_MS, ctx.signal);
  }
  return stopped(ctx, ids);
}

// --- recipes ---

const OPEN = new Set(['pending', 'running', 'paused']);

/**
 * An open crawl of this host, if any. Two crawls of one host write the same
 * checkpoint file and can take each other's result.
 */
async function openCrawlOf(url: string): Promise<Task | undefined> {
  const host = bare(new URL(url).hostname);
  return (await getAllTasks(200)).find(t => {
    if (t.type !== 'videoscan' || !OPEN.has(t.status) || t.context.urls?.length) return false;
    try { return bare(new URL(t.context.scanUrl ?? '').hostname) === host; } catch { return false; }
  });
}

async function refuseOpenCrawl(url: string): Promise<void> {
  const open = await openCrawlOf(url);
  if (open) throw new Error(`A crawl of ${new URL(url).hostname} is already ${open.status} in orch (task #${open.id}); wait for it or use its result`);
}

async function runSite(input: any, ctx: JobContext) {
  const url = httpUrl(input.url);
  const maxPages = optInt(input.maxPages, 'maxPages', 1, MAX_PAGES);
  const mode = optMode(input.mode);
  await refuseOpenCrawl(url);
  const task = await startVideoscanTask({ url, maxPages, mode }, extra(ctx.job.id));
  triggerUpdate(task.id);
  log.info(`Job ${ctx.job.id}: videoscan task #${task.id} for ${url}`);
  return watchSite(ctx, task.id, mode === 'sovereignty');
}

async function runOrg(input: any, ctx: JobContext) {
  const orgId = parseDigiOrgId(input.digi);
  if (!orgId) throw new Error('digi must be a dashboard.digitoegankelijk.nl/organisaties/<id> URL or the organisation id');
  const maxPages = optInt(input.maxPages, 'maxPages', 1, MAX_PAGES) ?? (input.mode === 'sovereignty' ? 500 : 2000);
  const mode = optMode(input.mode);
  const sovereignty = mode === 'sovereignty';
  const org = await importDigitoegankelijk(orgId);
  const { plan } = buildPlan(org.groups, { maxPages, sharedMaxPages: maxPages });
  if (!plan.length) throw new Error(`Organisation ${orgId} (${org.orgName}) lists no scannable sites`);

  // Same id and label shape as the dashboard's digi import, so it groups and auto-merges alike
  const slug = org.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'import';
  const batch = { batchId: `digi-${slug}-${Date.now()}`, batchLabel: `Digi import — ${org.orgName}` };
  const started: number[] = [];
  const notScanned: string[] = [];
  const startErrors: string[] = [];
  for (const p of plan) {
    try {
      if (p.kind === 'crawl') {
        await refuseOpenCrawl(p.url);
        started.push((await startVideoscanTask({ url: p.url, maxPages: p.maxPages, mode, ...batch }, extra(ctx.job.id))).id);
      } else if (sovereignty) {
        // scan.mjs runs a mode on a crawl only
        notScanned.push(...p.urls);
      } else {
        started.push((await startVideoscanUrlsTask({ urls: p.urls, maxPages, ...batch }, extra(ctx.job.id))).id);
      }
    } catch (err) {
      startErrors.push(`${p.kind === 'crawl' ? p.url : p.domain}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!started.length) throw new Error(`No scan started for ${org.orgName}${startErrors.length ? `: ${startErrors.join('; ')}` : ''}`);
  track(ctx.job.id, started);
  triggerUpdate();
  log.info(`Job ${ctx.job.id}: ${started.length} videoscan task(s) for ${org.orgName} in ${batch.batchId}`);
  return watchOrg(ctx, batch.batchId, { orgName: org.orgName, sovereignty, notScanned, startErrors });
}

async function runList(input: any) {
  const domain = typeof input.domain === 'string' ? input.domain.trim().toLowerCase().replace(/^www\./, '') : '';
  const batchId = typeof input.batchId === 'string' ? input.batchId.trim() : '';
  const limit = optInt(input.limit, 'limit', 1, 200) ?? 20;
  const scans = (await listScans())
    .filter(s => !s.filename.includes('INPROGRESS'))
    .filter(s => !domain || s.domain.toLowerCase().includes(domain))
    .filter(s => !batchId || s.batchId === batchId)
    .sort((a, b) => b.scanDate.localeCompare(a.scanDate));
  return {
    total: scans.length,
    scans: scans.slice(0, limit).map(s => ({
      filename: s.filename,
      domain: s.domain,
      scanDate: s.scanDate,
      pagesScanned: s.pagesScanned,
      pagesWithVideo: s.pagesWithVideo,
      uniquePlayers: s.uniquePlayers,
      hasReport: s.hasReport,
      mode: s.scanMode ?? 'video',
      ...(s.batchId ? { batchId: s.batchId } : {}),
      ...(isDerivedScan(s.filename) ? { merged: true } : {}),
    })),
  };
}

async function runGet(input: any, ctx: JobContext) {
  const filename = scanFilename(input.filename);
  const { scan, result } = await scanResult(ctx, filename);
  const pages = (scan.details ?? []).filter(d => d.players?.length);
  return {
    ...result,
    videoPages: pages.slice(0, DETAIL_PAGES).map(d => ({ url: d.url, players: [...new Set(d.players!.map(p => p.name))] })),
    ...(pages.length > DETAIL_PAGES ? { moreVideoPages: pages.length - DETAIL_PAGES } : {}),
  };
}

const MODE_SCHEMA = { type: 'string', enum: ['video', 'sovereignty'], description: '"sovereignty" adds the A–E sovereignty grade of the players found' };

export const RECIPES: Recipe[] = [
  {
    id: 'videoscan',
    description: 'Deep videoscan of one website: crawls it and reports the video players per page, with an HTML report.',
    mode: 'job',
    package: PACKAGE,
    timeoutMs: 24 * 3_600_000,
    input: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'Site to crawl, e.g. https://www.gemeente.nl' },
        maxPages: { type: 'integer', minimum: 1, maximum: MAX_PAGES, description: 'Page cap (default 50; 500 for sovereignty)' },
        mode: MODE_SCHEMA,
      },
    },
    run: runSite,
  },
  {
    id: 'videoscan_org',
    description: 'Videoscan of every website a DigiToegankelijk organisation lists, merged into one organisation report.',
    mode: 'job',
    package: PACKAGE,
    timeoutMs: 48 * 3_600_000,
    input: {
      type: 'object',
      required: ['digi'],
      properties: {
        digi: { type: ['string', 'integer'], description: 'dashboard.digitoegankelijk.nl/organisaties/<id> URL or the organisation id' },
        maxPages: { type: 'integer', minimum: 1, maximum: MAX_PAGES, description: 'Page cap per crawled site (default 2000; 500 for sovereignty)' },
        mode: MODE_SCHEMA,
      },
    },
    run: runOrg,
  },
  {
    id: 'videoscan_list',
    description: 'Lists finished videoscans in orch, newest first, optionally for one domain or batch.',
    mode: 'job',
    package: PACKAGE,
    timeoutMs: 60_000,
    input: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Part of the domain, e.g. "gemeente.nl"' },
        batchId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'default 20' },
      },
    },
    run: runList,
  },
  {
    id: 'videoscan_get',
    description: 'One videoscan in detail: players, video pages, sovereignty grade when measured, and its HTML report.',
    mode: 'job',
    package: PACKAGE,
    timeoutMs: 5 * 60_000,
    input: {
      type: 'object',
      required: ['filename'],
      properties: { filename: { type: 'string', description: 'Scan file name from videoscan_list' } },
    },
    run: runGet,
  },
];

/**
 * Jobs whose tasks outlived an orch restart: their outcome never reached bb-core.
 * Only the newest tasks are looked at; a job older than that is long failed in core.
 */
export async function recoverJobs(): Promise<{ job: RunnerJob; run: (ctx: JobContext) => Promise<unknown> }[]> {
  const byJob = new Map<string, Task[]>();
  for (const t of await getAllTasks(200)) {
    const jobId = t.context.bbCoreJobId;
    if (t.type !== 'videoscan' || !jobId || t.context.bbCoreReported || t.context.targetMachineId !== MACHINE_ID) continue;
    if (!byJob.has(jobId)) byJob.set(jobId, []);
    byJob.get(jobId)!.push(t);
  }
  return [...byJob].map(([jobId, tasks]) => {
    const batchId = tasks.find(t => t.context.batchId)?.context.batchId;
    const sovereignty = tasks.some(t => t.context.scanMode === 'sovereignty');
    const newest = tasks.reduce((a, b) => (b.id > a.id ? b : a));
    track(jobId, tasks.map(t => t.id));
    const job: RunnerJob = { id: jobId, type: batchId ? 'videoscan_org' : 'videoscan', input: {} };
    return {
      job,
      run: (ctx: JobContext) => (batchId ? watchOrg(ctx, batchId, { sovereignty }) : watchSite(ctx, newest.id, sovereignty)),
    };
  });
}

let runner: RunnerHandle | null = null;

export function startBbCoreRunner(url: string, key: string): void {
  if (runner) return;
  let version = 'unknown';
  try { version = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')).version; } catch { /* keep unknown */ }
  log.info(`Starting bb-core runner for ${url}`);
  runner = startRunner({ url, key, version: `orch/${version}`, recipes: RECIPES, recover: recoverJobs, onJobSettled: markReported });
}

export function getBbCoreRunnerState(): RunnerState | null {
  return runner?.state() ?? null;
}
