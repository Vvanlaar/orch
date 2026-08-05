// /api/support/gather + /api/support/note — the "route it through the host"
// half of bb-support.
//
// WHY THIS EXISTS. bb-support's ask.mjs needs three things a teammate's laptop
// usually lacks: a HubSpot legacy private-app token, an ADO_PAT, and a built
// ~/.claude/bb-knowledge/index.json. /api/support/ask solves that for *browser*
// users by also running the `claude -p` synthesis here — but that spends THIS
// host's Claude subscription and gives the caller no way to fold in their own
// repo context.
//
// /gather splits the pipeline instead: the host does the credential-gated
// gather and returns ask.mjs's raw NDJSON sections; the caller's own Claude Code
// does the synthesis on its own quota. `ask.mjs --remote` is the client.
//
// /note is the write-back leg. Posting an investigation note needs the HubSpot
// token *plus* the legacy `timeline` scope, so a remote caller can't do it —
// without this endpoint remote mode could investigate a ticket but never record
// the finding on it.
//
// Both mount from mountSupport() and inherit its `auth` (support scope, or
// anonymous when BB_SUPPORT_ALLOW_ANONYMOUS=1) plus the /api/support security
// headers.

import type { Express, Request, RequestHandler } from 'express';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { asyncHandler } from '../core/error-handler.js';
import { createLogger } from '../core/logger.js';
import { KEYS_DIR, SCRIPTS_DIR } from '../core/support-paths.js';
import { rateLimiter } from './rate-limit.js';

const log = createLogger('support-gather');

// ask.mjs fans out to HubSpot search + ADO WIQL + a KB index read. 60s is
// generous for the slow path (a broad query on a cold HubSpot connection) and
// still well inside any sane client timeout.
const GATHER_TIMEOUT_MS = 60_000;
// note.mjs does at most a list-engagements + a POST/PATCH.
const NOTE_TIMEOUT_MS = 30_000;
// Matches support.ts's SSE chunk cap. A runaway --top would otherwise let one
// request pin unbounded RSS while we buffer stdout to build the JSON response.
const OUTPUT_CAP_BYTES = 2_000_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type GatherRequest = {
  question?: unknown;
  top?: unknown;
  hubspot?: unknown;
  kb?: unknown;
  ado?: unknown;
  scrub?: unknown;
  note?: unknown;
};

// --- pure helpers (unit-tested; see support-gather.test.ts) -----------------

// Build ask.mjs's argv. Deliberately has NO `--code` path: `--code <repo>` greps
// $REPOS_BASE_DIR on whichever machine runs it, and the host's checkouts are not
// the caller's. The client greps its own repo and splices the CODE section in.
export function buildGatherArgs(
  askScript: string,
  body: GatherRequest,
  keyFile: string,
): string[] {
  const args = [askScript, String(body.question)];

  // Clamp rather than reject: `top` is a relevance knob, not a correctness one,
  // and a client sending 500 deserves 20 hits, not a 400.
  if (body.top !== undefined) {
    const n = Number(body.top);
    if (Number.isFinite(n)) args.push('--top', String(Math.max(1, Math.min(Math.floor(n), 20))));
  }

  // Each source defaults ON in ask.mjs, so only an explicit `false` emits a flag.
  if (body.hubspot === false) args.push('--no-hubspot');
  if (body.kb === false) args.push('--no-kb');
  if (body.ado === false) args.push('--no-ado');
  if (body.scrub === false) args.push('--no-scrub');

  // Tri-state, mirroring ask.mjs: absent means "decide from context", so an
  // undefined `note` must emit neither flag.
  if (body.note === true) args.push('--note');
  else if (body.note === false) args.push('--no-note');

  args.push('--key-file', keyFile);
  return args;
}

// The child env for a host-side ask.mjs / note.mjs run.
//
// BB_SUPPORT_REMOTE and BB_SUPPORT_TOKEN MUST be stripped. If this host ever has
// them set (e.g. someone points it at a second orch, or a stray export lands in
// the service environment), the spawned ask.mjs would resolve remote mode and
// call /gather right back — an infinite proxy loop that each hop pays for.
// Deleting the keys is what makes the recursion structurally impossible rather
// than merely unlikely.
export function childEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent };
  delete env.BB_SUPPORT_REMOTE;
  delete env.BB_SUPPORT_TOKEN;
  return env;
}

// note.mjs's documented exit codes → HTTP. 3 (note already exists) is the one
// that isn't really an error: the caller asked to record a finding and a finding
// is on record, so it maps to 409 and the client can retry with update:true.
export function noteExitToHttp(code: number | null): { status: number; error: string } {
  switch (code) {
    case 0: return { status: 200, error: '' };
    case 2: return { status: 400, error: 'note.mjs rejected the input (bad ticket id, or no HubSpot creds on the host)' };
    case 3: return { status: 409, error: 'ticket already has an AI investigation note — retry with update:true to refresh it' };
    case 4: return { status: 409, error: 'could not verify whether a note already exists (engagement pagination cap) — check the ticket by hand' };
    case 5: return { status: 502, error: 'HubSpot rejected the write (a 403 usually means the private app lacks the legacy `timeline` scope)' };
    default: return { status: 500, error: `note.mjs exited ${code ?? 'null'}` };
  }
}

// --- child-process plumbing -------------------------------------------------

// Windows-safe tree kill. Same shape as bb-support/scripts/run-support.mjs:41 —
// proc.kill() on win32 leaves grandchildren (the node wrapper's real process)
// alive, so a timed-out gather would keep hitting HubSpot after we responded.
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (platform() === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'pipe' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
};

function runNode(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let truncated = false;
    let timedOut = false;

    const child = spawn(process.argv[0], args, { shell: false, env: childEnv() });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (c: Buffer) => {
      // Sticky truncation: a gap mid-stream would hand the reading Claude a
      // section list with a hole in it, which is worse than a clean cut.
      if (truncated) return;
      if (stdoutBytes + c.length > OUTPUT_CAP_BYTES) { truncated = true; return; }
      stdoutBytes += c.length;
      stdout += c.toString();
    });
    // stderr carries ask.mjs's `# note:` / creds-source diagnostics. Capped
    // hard — it's only ever surfaced for debugging.
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 16_384) stderr += c.toString();
    });

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, truncated, timedOut });
    });
  });
}

// --- routes -----------------------------------------------------------------

export function mountSupportGather(app: Express, opts: { auth: RequestHandler }): void {
  const { auth } = opts;

  // Its own bucket, deliberately not shared with /ask's 10-per-5-min. /ask
  // spawns Claude (expensive, rate-limited to protect the subscription);
  // /gather only spawns ask.mjs, so it can be looser — but still bounded,
  // because each call fans out to the HubSpot and ADO APIs under the host's PATs.
  const gatherLimiter = rateLimiter({ windowMs: 5 * 60_000, limit: 30 });
  // Writes to live customer tickets. Tighter than /gather on purpose.
  const noteLimiter = rateLimiter({ windowMs: 5 * 60_000, limit: 10 });

  app.post('/api/support/gather', auth, gatherLimiter, asyncHandler(async (req, res) => {
    const body = (req.body || {}) as GatherRequest;
    if (!body.question || typeof body.question !== 'string') {
      res.status(400).json({ error: 'question required' });
      return;
    }

    const keyId = randomUUID();
    const keyFile = join(KEYS_DIR, `${keyId}.json`);
    try { mkdirSync(KEYS_DIR, { recursive: true }); } catch { /* best effort; ask.mjs also mkdirs */ }

    const args = buildGatherArgs(join(SCRIPTS_DIR, 'ask.mjs'), body, keyFile);

    let result: RunResult;
    try {
      result = await runNode(args, GATHER_TIMEOUT_MS);
    } catch (err) {
      log.error('failed to spawn ask.mjs from ' + SCRIPTS_DIR, err);
      res.status(500).json({ error: 'support library unavailable: ' + (err as Error).message });
      return;
    }

    if (result.timedOut) {
      res.status(504).json({ error: `gather timed out after ${GATHER_TIMEOUT_MS / 1000}s`, stderr: result.stderr });
      return;
    }
    if (result.code !== 0) {
      // ask.mjs is documented never to throw on a missing source — it degrades to
      // a `# note: skipped:` line. A non-zero exit therefore means something
      // structural (bad args, missing module), so surface stderr rather than
      // handing back a half-empty section list that looks like "no hits".
      res.status(500).json({ error: `ask.mjs exited ${result.code}`, stderr: result.stderr });
      return;
    }

    const tokenName = (req as Request & { tokenName?: string }).tokenName ?? 'anonymous';
    log.info(`gather ok for ${tokenName} (${result.stdout.length} bytes${result.truncated ? ', TRUNCATED' : ''})`);

    // The 30-min keyReaper in support.ts owns keyFile cleanup — same directory,
    // so no extra reaper needed here.
    res.json({
      sections: result.stdout,
      keyId,
      stderr: result.stderr,
      truncated: result.truncated,
    });
  }));

  app.post('/api/support/note', auth, noteLimiter, asyncHandler(async (req, res) => {
    const body = (req.body || {}) as { ticketId?: unknown; bodyHtml?: unknown; keyId?: unknown; update?: unknown };
    const ticketId = String(body.ticketId ?? '');
    if (!/^\d+$/.test(ticketId)) {
      res.status(400).json({ error: 'ticketId must be digits' });
      return;
    }
    if (!body.bodyHtml || typeof body.bodyHtml !== 'string') {
      res.status(400).json({ error: 'bodyHtml required' });
      return;
    }
    // keyId is optional — a caller may post a note that never needed redaction.
    // When present it must be a UUID, so it can't escape KEYS_DIR via traversal.
    if (body.keyId !== undefined && (typeof body.keyId !== 'string' || !UUID_RE.test(body.keyId))) {
      res.status(400).json({ error: 'keyId must be a UUID' });
      return;
    }

    const tmpFile = join(tmpdir(), `orch-note-${randomUUID()}.html`);
    try {
      writeFileSync(tmpFile, body.bodyHtml, 'utf8');

      const args = [join(SCRIPTS_DIR, 'note.mjs'), '--ticket', ticketId, '--body-file', tmpFile];
      if (body.update !== false) args.push('--update');
      if (body.keyId) {
        // An explicit --key-file bypasses note.mjs's keyFileMatchesTicket guard
        // ("the caller owns that path's lifecycle"). Correct here: this keyfile
        // came from the same /gather run, so its mapping is bound to the very
        // question that produced this body. The guard exists for the shared
        // DEFAULT_KEY_FILE, which every ask.mjs run overwrites.
        args.push('--key-file', join(KEYS_DIR, String(body.keyId)) + '.json');
      }

      let result: RunResult;
      try {
        result = await runNode(args, NOTE_TIMEOUT_MS);
      } catch (err) {
        log.error('failed to spawn note.mjs from ' + SCRIPTS_DIR, err);
        res.status(500).json({ error: 'support library unavailable: ' + (err as Error).message });
        return;
      }

      if (result.timedOut) {
        res.status(504).json({ error: `note timed out after ${NOTE_TIMEOUT_MS / 1000}s`, stderr: result.stderr });
        return;
      }

      const mapped = noteExitToHttp(result.code);
      if (mapped.status !== 200) {
        res.status(mapped.status).json({ error: mapped.error, stderr: result.stderr });
        return;
      }
      // note.mjs prints "→ posted note <id> to ticket <n>" / "→ view: <url>".
      res.json({ ok: true, output: result.stdout.trim(), stderr: result.stderr });
    } finally {
      try { rmSync(tmpFile, { force: true }); } catch { /* best effort */ }
    }
  }));

  log.info('/api/support/gather + /api/support/note mounted');
}
