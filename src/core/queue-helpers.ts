// Pure scheduling helpers for task-processor, kept free of side effects so they can be unit tested.

/** Slots left when `running` (DB rows) and `inFlight` (claims made by this process) may overlap or lag each other. */
export function freeSlots(max: number, running: Iterable<number>, inFlight: Iterable<number>): number {
  return max - new Set([...running, ...inFlight]).size;
}

/**
 * Wrap `fn` so at most one run is in flight. A call made during a run doesn't start a
 * second one; it schedules exactly one rerun after the current run, and gets that promise.
 */
export function singleFlight(fn: () => Promise<void>): () => Promise<void> {
  let current: Promise<void> | null = null;
  let rerun = false;
  return () => {
    if (current) {
      rerun = true;
      return current;
    }
    current = (async () => {
      try {
        do {
          rerun = false;
          await fn();
        } while (rerun);
      } finally {
        current = null;
      }
    })();
    return current;
  };
}

/**
 * Tracks how long ids have been continuously seen dead across passes. `update` takes the
 * ids dead right now and returns those dead for at least `staleAfterMs`; an id that is no
 * longer reported dead starts over.
 */
export function createStaleTracker(staleAfterMs: number) {
  const deadSince = new Map<number, number>();
  return {
    update(deadIds: Iterable<number>, now = Date.now()): number[] {
      const current = new Set(deadIds);
      for (const id of deadSince.keys()) if (!current.has(id)) deadSince.delete(id);
      const stale: number[] = [];
      for (const id of current) {
        const since = deadSince.get(id) ?? now;
        deadSince.set(id, since);
        if (now - since >= staleAfterMs) stale.push(id);
      }
      return stale;
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `fn`, retrying after each delay in `delaysMs` while it throws; rethrows the last error. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[],
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delaysMs.length) throw err;
      onRetry?.(err, attempt + 1, delaysMs[attempt]);
      await wait(delaysMs[attempt]);
    }
  }
}

export interface ScanFileInfo {
  name: string;
  mtimeMs: number;
  /** scan.mjs periodic checkpoint (`checkpoint: true`), as opposed to a finished report. */
  checkpoint: boolean;
}

export type DeadScanAction =
  | { action: 'complete'; file: string }
  | { action: 'resume'; file: string }
  | { action: 'fail'; reason: string };

/**
 * What to do with a videoscan row that says running while its scan process is gone.
 * `latest` is the newest scan JSON for the scan's domain (null if none or unreadable).
 * Kind is judged by content, not name: a scan resumed from its INPROGRESS checkpoint
 * writes its finished report back under that same name.
 */
export function decideDeadScan(opts: {
  latest: ScanFileInfo | null;
  startedAtMs: number | null;
  /** scanUrl without explicit urls: the only mode with resumable on-disk state. */
  crawlMode: boolean;
  /** targetFilename: the scan is merged into it server-side, so only that file proves the run finished. */
  mergeTarget?: string;
  /** Basename of the checkpoint this run resumed from, if any. */
  resumeFile?: string;
}): DeadScanAction {
  const { latest } = opts;
  if (!latest) return { action: 'fail', reason: 'no scan file' };
  if (latest.checkpoint) {
    if (!opts.crawlMode) return { action: 'fail', reason: 'explicit-URL scan cannot resume' };
    // Only this run's checkpoint: written during the run, or the one it resumed from.
    // An older one can belong to another row of the domain, e.g. a paused scan.
    const own = latest.name === opts.resumeFile
      || (opts.startedAtMs !== null && latest.mtimeMs >= opts.startedAtMs);
    return own ? { action: 'resume', file: latest.name } : { action: 'fail', reason: 'no checkpoint from this run' };
  }
  // A report older than this run is an earlier scan of the same domain. The negated
  // comparison also rejects a NaN start time (unparseable startedAt).
  if (opts.startedAtMs === null || !(latest.mtimeMs >= opts.startedAtMs)) {
    return { action: 'fail', reason: 'no report from this run' };
  }
  if (opts.mergeTarget && latest.name !== opts.mergeTarget) {
    return { action: 'fail', reason: 'merge into target file did not run' };
  }
  return { action: 'complete', file: latest.name };
}
