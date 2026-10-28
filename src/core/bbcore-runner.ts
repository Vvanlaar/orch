// Client side of bb-core's runner protocol: orch offers recipes to a bb-core
// server and runs the jobs it claims. Pull-based (hello heartbeat + long-poll
// claim), so orch can sit behind NAT. Generic: what a recipe does lives in
// bbcore-recipes.ts.
//
//   POST /v1/runner/hello {version, recipes}       every heartbeatMs; core calls a runner offline after 90 s
//   POST /v1/runner/claim?wait=25                  200 {job} | 204
//   POST /v1/runner/jobs/:id/progress {progress}   200 {cancel}; at least every 10 min or core fails the job
//   POST /v1/runner/jobs/:id/complete {result}|{error}   409 once the job is no longer running
//   PUT  /v1/runner/jobs/:id/artifact?name=…       raw body, ≤20 MB
import { createLogger } from './logger.js';

const log = createLogger('bbcore-runner');

export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
/** With the default backoff (1 s doubling, 60 s cap): about 9 minutes. */
const COMPLETE_ATTEMPTS = 14;

export type ArtifactContentType = 'text/html' | 'application/pdf' | 'application/json';

export interface RecipeSpec {
  id: string;
  description: string;
  mode: 'job';
  /** JSON schema of the job input */
  input: Record<string, unknown>;
  timeoutMs: number;
  package: string;
}

export interface RunnerJob {
  id: string;
  type: string;
  input: unknown;
  createdAt?: string;
}

export interface JobContext {
  job: RunnerJob;
  /**
   * Reports progress. Posted when it changed and minProgressIntervalMs passed,
   * or keepaliveMs passed; other calls only keep the value. Resolves true once
   * bb-core asked to cancel the job.
   */
  progress(progress: unknown): Promise<boolean>;
  artifact(name: string, contentType: ArtifactContentType, body: Buffer): Promise<void>;
  /** Aborted when bb-core cancels the job, no longer holds it, or the runner stops. */
  signal: AbortSignal;
  /** bb-core asked to cancel: stop the work. Otherwise an aborted signal means only "stop reporting". */
  readonly cancelRequested: boolean;
}

export type JobRun = (input: any, ctx: JobContext) => Promise<unknown>;

export interface Recipe extends RecipeSpec {
  run: JobRun;
}

export interface RunnerOptions {
  url: string;
  key: string;
  version: string;
  recipes: Recipe[];
  fetch?: typeof fetch;
  heartbeatMs?: number;
  claimWaitSec?: number;
  /** A 204 that came back sooner than this (a core that doesn't long-poll) waits out the rest. */
  minClaimIntervalMs?: number;
  maxJobs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  minProgressIntervalMs?: number;
  keepaliveMs?: number;
  /** Jobs this runner already held before a restart; reattached after the first hello. */
  recover?: () => Promise<{ job: RunnerJob; run: (ctx: JobContext) => Promise<unknown> }[]>;
  /** The job's outcome reached bb-core, or bb-core no longer holds the job. */
  onJobSettled?: (jobId: string) => void | Promise<void>;
}

export interface RunnerState {
  url: string;
  connected: boolean;
  lastHelloAt?: string;
  lastError?: string;
  activeJobs: string[];
}

export interface RunnerHandle {
  stop(): Promise<void>;
  state(): RunnerState;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function backoffMs(failures: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, failures - 1));
}

export function startRunner(opts: RunnerOptions): RunnerHandle {
  const base = opts.url.replace(/\/+$/, '');
  const doFetch = opts.fetch ?? fetch;
  const heartbeatMs = opts.heartbeatMs ?? 60_000;
  const claimWaitSec = opts.claimWaitSec ?? 25;
  const minClaimIntervalMs = opts.minClaimIntervalMs ?? 1_000;
  const maxJobs = opts.maxJobs ?? 4;
  const backoffBase = opts.backoffBaseMs ?? 1_000;
  const backoffMax = opts.backoffMaxMs ?? 60_000;
  const minProgressMs = opts.minProgressIntervalMs ?? 5_000;
  const keepaliveMs = opts.keepaliveMs ?? 60_000;
  const recipes = new Map(opts.recipes.map(r => [r.id, r]));
  const specs: RecipeSpec[] = opts.recipes.map(({ run: _run, ...spec }) => spec);

  const stopCtl = new AbortController();
  const active = new Map<string, Promise<void>>();
  let slotFreed: (() => void) | null = null;
  const state: RunnerState = { url: base, connected: false, activeJobs: [] };

  function sleep(ms: number, signal: AbortSignal = stopCtl.signal): Promise<void> {
    return new Promise(resolve => {
      if (signal.aborted) return resolve();
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  async function call(method: string, path: string, init: { json?: unknown; body?: Buffer; contentType?: string; timeoutMs?: number } = {}) {
    const headers: Record<string, string> = { authorization: `Bearer ${opts.key}` };
    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.body) {
      headers['content-type'] = init.contentType ?? 'application/octet-stream';
      body = new Uint8Array(init.body);
    }
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.any([stopCtl.signal, AbortSignal.timeout(init.timeoutMs ?? 30_000)]),
    });
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { status: res.status, json, text };
  }

  async function expectOk(method: string, path: string, init?: Parameters<typeof call>[2]) {
    const r = await call(method, path, init);
    if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, `${method} ${path} → HTTP ${r.status}${r.text ? `: ${r.text.slice(0, 200)}` : ''}`);
    return r;
  }

  async function hello(): Promise<void> {
    try {
      await expectOk('POST', '/v1/runner/hello', { json: { version: opts.version, recipes: specs } });
      if (!state.connected) log.info(`Connected to bb-core at ${base} (${specs.length} recipes)`);
      state.connected = true;
      state.lastHelloAt = new Date().toISOString();
      state.lastError = undefined;
    } catch (err) {
      noteError(err);
      throw err;
    }
  }

  function noteError(err: unknown): void {
    if (stopCtl.signal.aborted) return;
    const msg = errMsg(err);
    if (state.connected || state.lastError !== msg) log.warn(`bb-core: ${msg}`);
    state.connected = false;
    state.lastError = msg;
  }

  async function claim(): Promise<RunnerJob | null> {
    const r = await expectOk('POST', `/v1/runner/claim?wait=${claimWaitSec}`, { timeoutMs: (claimWaitSec + 15) * 1000 });
    if (r.status === 204) return null;
    const job = r.json?.job;
    if (!job || typeof job.id !== 'string' || typeof job.type !== 'string') throw new Error(`claim returned no job: ${r.text.slice(0, 200)}`);
    return job;
  }

  /**
   * Delivers the outcome; retried for about as long as core's 10-minute lease,
   * so a short outage doesn't lose a finished scan. Returns false when it gave up.
   */
  async function complete(jobId: string, outcome: { result: unknown } | { error: string }): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await call('POST', `/v1/runner/jobs/${encodeURIComponent(jobId)}/complete`, { json: outcome });
        if (r.status === 404 || r.status === 409) {
          log.info(`Job ${jobId}: bb-core no longer holds it (HTTP ${r.status}); outcome dropped`);
          return true;
        }
        if (r.status >= 200 && r.status < 300) return true;
        // Core refused this outcome (too large, malformed): sending it again won't help, an error might land
        if (r.status >= 400 && r.status < 500 && 'result' in outcome) {
          log.error(`Job ${jobId}: bb-core refused the result (HTTP ${r.status}): ${r.text.slice(0, 200)}`);
          return complete(jobId, { error: `bb-core refused the runner's result (HTTP ${r.status})` });
        }
        throw new HttpError(r.status, `complete → HTTP ${r.status}`);
      } catch (err) {
        if (stopCtl.signal.aborted || attempt >= COMPLETE_ATTEMPTS) {
          log.error(`Job ${jobId}: could not deliver its outcome to bb-core: ${errMsg(err)}`);
          return false;
        }
        await sleep(backoffMs(attempt, backoffBase, backoffMax));
      }
    }
  }

  function makeContext(job: RunnerJob, ctl: AbortController) {
    let cancelRequested = false;
    let lastPostAt = 0;
    let lastPosted: string | undefined;
    const path = `/v1/runner/jobs/${encodeURIComponent(job.id)}`;
    const ctx: JobContext & { gone: boolean } = {
      job,
      signal: ctl.signal,
      gone: false,
      get cancelRequested() { return cancelRequested; },
      async progress(progress) {
        if (ctl.signal.aborted) return cancelRequested;
        const body = JSON.stringify(progress);
        const since = Date.now() - lastPostAt;
        if (since < minProgressMs || (body === lastPosted && since < keepaliveMs)) return cancelRequested;
        lastPostAt = Date.now();
        try {
          const r = await call('POST', `${path}/progress`, { json: { progress } });
          if (r.status === 404 || r.status === 409) {
            // Core failed or forgot the job (restart, lease expiry): stop reporting, keep the work.
            log.warn(`Job ${job.id}: bb-core no longer holds it (HTTP ${r.status}); stopped reporting`);
            ctx.gone = true;
            ctl.abort();
          } else if (r.status < 200 || r.status >= 300) {
            log.warn(`Job ${job.id}: progress → HTTP ${r.status}`);
          } else {
            lastPosted = body;
            if (r.json?.cancel === true) {
              log.info(`Job ${job.id}: cancelled by bb-core`);
              cancelRequested = true;
              ctl.abort();
            }
          }
        } catch (err) {
          if (!stopCtl.signal.aborted) log.warn(`Job ${job.id}: progress failed: ${errMsg(err)}`);
        }
        return cancelRequested;
      },
      async artifact(name, contentType, body) {
        if (body.length > MAX_ARTIFACT_BYTES) throw new Error(`${name} is ${Math.round(body.length / 1048576)} MB, over bb-core's 20 MB artifact limit`);
        await expectOk('PUT', `${path}/artifact?name=${encodeURIComponent(name)}`, { body, contentType, timeoutMs: 120_000 });
      },
    };
    return ctx;
  }

  function launch(job: RunnerJob, run: (ctx: JobContext) => Promise<unknown>): void {
    // Core handed out a job this runner already works on (e.g. after it took the runner for offline)
    if (active.has(job.id)) {
      log.warn(`Job ${job.id} is already running here; ignoring the second claim`);
      return;
    }
    const ctl = new AbortController();
    const onStop = () => ctl.abort();
    stopCtl.signal.addEventListener('abort', onStop, { once: true });
    const ctx = makeContext(job, ctl);
    const p = (async () => {
      let outcome: { result: unknown } | { error: string };
      try {
        outcome = { result: await run(ctx) };
      } catch (err) {
        outcome = { error: errMsg(err) };
      }
      // Runner stopping: the job stays with this orch, recovered on the next start.
      if (stopCtl.signal.aborted) return;
      const settled = ctx.gone || await complete(job.id, outcome);
      if (!ctx.gone) log.info(`Job ${job.id} (${job.type}) ${'error' in outcome ? `failed: ${outcome.error}` : 'completed'}`);
      if (settled) await opts.onJobSettled?.(job.id);
    })()
      .catch(err => log.error(`Job ${job.id}: ${errMsg(err)}`))
      .finally(() => {
        stopCtl.signal.removeEventListener('abort', onStop);
        active.delete(job.id);
        state.activeJobs = [...active.keys()];
        slotFreed?.();
      });
    active.set(job.id, p);
    state.activeJobs = [...active.keys()];
  }

  function dispatch(job: RunnerJob): void {
    const recipe = recipes.get(job.type);
    log.info(`Claimed job ${job.id} (${job.type})`);
    launch(job, recipe
      ? ctx => recipe.run(job.input ?? {}, ctx)
      : async () => { throw new Error(`This runner has no recipe "${job.type}"`); });
  }

  function waitForSlot(): Promise<void> {
    return new Promise(resolve => {
      const done = () => {
        slotFreed = null;
        stopCtl.signal.removeEventListener('abort', done);
        resolve();
      };
      slotFreed = done;
      stopCtl.signal.addEventListener('abort', done, { once: true });
    });
  }

  // Independent of the claim loop, which may sit in waitForSlot for hours while
  // every slot runs a long scan. A failure is noted in state; the next beat retries.
  const heartbeat = setInterval(() => { hello().catch(() => {}); }, heartbeatMs);
  heartbeat.unref?.();

  async function loop(): Promise<void> {
    let failures = 0;
    let recovered = !opts.recover;
    while (!stopCtl.signal.aborted) {
      try {
        if (!state.connected) await hello();
        if (!recovered) {
          let held: Awaited<ReturnType<NonNullable<RunnerOptions['recover']>>> = [];
          try {
            held = await opts.recover!();
            recovered = true;
          } catch (err) {
            // Not a bb-core problem: claim on, retry on the next pass
            log.error(`Recovering held jobs failed: ${errMsg(err)}`);
          }
          for (const { job, run } of held) {
            log.info(`Reattached job ${job.id} (${job.type})`);
            launch(job, run);
          }
        }
        if (active.size >= maxJobs) {
          await waitForSlot();
          continue;
        }
        const startedAt = Date.now();
        const job = await claim();
        failures = 0;
        if (job) dispatch(job);
        else if (Date.now() - startedAt < minClaimIntervalMs) await sleep(minClaimIntervalMs - (Date.now() - startedAt));
      } catch (err) {
        if (stopCtl.signal.aborted) break;
        noteError(err);
        failures++;
        await sleep(backoffMs(failures, backoffBase, backoffMax));
      }
    }
  }

  const loopDone = loop();

  return {
    async stop() {
      clearInterval(heartbeat);
      stopCtl.abort();
      await loopDone;
      await Promise.allSettled([...active.values()]);
    },
    state: () => ({ ...state, activeJobs: [...state.activeJobs] }),
  };
}
