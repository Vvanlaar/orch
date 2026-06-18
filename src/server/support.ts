// /api/support/* — ported from bb-support-web/scripts/server.mjs into orch.
// Hosts the bb-support skill's Q&A flow inside orch's Express app: bearer
// auth (with optional anonymous LAN mode), per-request UUID PII keyfiles,
// SSE streaming, audit JSONL, and a 30-min keyfile reaper.
//
// State directory defaults to ~/.claude/bb-support-web/ — i.e. the same
// tokens / audit / keys location the standalone bb-support-web used, so no
// state migration is needed when users switch hosts. Override via env vars
// (see envs below).
//
// Env vars:
//   BB_SUPPORT_SCRIPTS_DIR   — where to dynamic-import run-support.mjs +
//                              reveal.mjs from (default: ../bb-skills/
//                              bb-support/scripts relative to orch root).
//   BB_SUPPORT_DATA_DIR      — tokens/audit/keys dir (default ~/.claude/
//                              bb-support-web).
//   BB_SUPPORT_ALLOW_ANONYMOUS=1 — opt out of bearer auth; the LAN itself
//                              becomes the boundary. Bind must be loopback
//                              or RFC1918 / link-local / fe80::.

import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../core/error-handler.js';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../core/logger.js';
import {
  DATA_DIR, RESULTS_DIR, SCRIPTS_DIR, loadRunSupport,
  type RunSupportFn,
} from '../core/support-paths.js';
import { mountHubspot } from './hubspot.js';
import { hasScope, loadTokens, lookupToken, tokenFromRequest, type TokenMap } from './auth.js';

const log = createLogger('support');

const KEYS_DIR = join(DATA_DIR, '.keys');
const TOKENS_FILE = join(DATA_DIR, 'tokens.json');
const AUDIT_FILE = join(DATA_DIR, 'audit.jsonl');

const ALLOW_ANONYMOUS = process.env.BB_SUPPORT_ALLOW_ANONYMOUS === '1';

// Timings + budgets — match bb-support-web exactly. Tweaking these in isolation
// is dangerous because the interlock between RUN_MAX_MS (cancel runaway runs),
// RUN_COMPLETION_TTL_MS (grace for late SSE attach), and the chunk buffer cap
// is what bounds RSS for an orphaned ask.
const KEY_TTL_MS = 30 * 60_000;
const RUN_MAX_MS = 5 * 60_000;
const RUN_COMPLETION_TTL_MS = 60_000;
const CHUNK_BUFFER_CAP_BYTES = 1_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const PRIVATE_IPV4_RE = /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.)/;

function isLoopback(bind: string): boolean {
  return LOOPBACK.has(String(bind));
}

function isPrivateOrLoopback(bind: string): boolean {
  const s = String(bind);
  return isLoopback(s) || PRIVATE_IPV4_RE.test(s) || /^fe80:/i.test(s);
}

// Token map + loader live in ./auth.ts (shared with the global API/WS gate).
// Entries now carry `scopes`; support endpoints require the `support` scope,
// which `admin`/`*` tokens also satisfy (see hasScope).

// Refuse to expose unauthenticated endpoints. Called once at boot; throws on
// misconfiguration so the operator sees the failure before any request lands.
export function assertBindAuthValid(bind: string, tokens: TokenMap, allowAnonymous: boolean): void {
  if (isLoopback(bind)) return;
  if (allowAnonymous) {
    if (!isPrivateOrLoopback(bind)) {
      throw new Error(
        `bb-support refuses BB_SUPPORT_ALLOW_ANONYMOUS=1 on ${bind} — only loopback ` +
        `or private (RFC1918 / link-local / fe80::) binds may opt out of bearer auth.`,
      );
    }
    return;
  }
  if (!tokens || Object.keys(tokens).length === 0) {
    throw new Error(
      `bb-support refuses to expose /api/support/* on non-loopback bind ${bind} without tokens. ` +
      `Populate ${TOKENS_FILE} with at least one { "<token>": { "name": "..." } } entry, ` +
      `or set BB_SUPPORT_ALLOW_ANONYMOUS=1 to trust the LAN as the boundary.`,
    );
  }
}

// Append-only audit log. Mode 0600 on create (POSIX advisory on Windows; the
// 'wx' flag still avoids overwriting an existing file in a TOCTOU race).
type AuditEntry =
  | { ts: string; ip: string | undefined; tokenName: string; question: string; status: 'ok' | 'cancelled'; durationMs: number }
  | { ts: string; ip: string | undefined; tokenName: string; question: string; status: 'ask' | 'claude' | 'spawn'; durationMs: number; error: string };

function appendAudit(entry: AuditEntry, path = AUDIT_FILE): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    // 'wx' fails with EEXIST if a parallel writer raced us between the
    // existsSync check and this open — in that case the file already has 0600
    // (or whatever the racer set) and we can safely append. Ignore EEXIST;
    // re-throw anything else.
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
  }
  appendFileSync(path, JSON.stringify(entry) + '\n');
}

// Hand-rolled sliding-window rate limiter. keyFn defaults to req.ip so each
// remote client gets its own bucket.
function rateLimiter(opts: { windowMs: number; limit: number; keyFn?: (req: Request) => string }) {
  const buckets = new Map<string, number[]>();
  const { windowMs, limit, keyFn = (req) => req.ip || 'unknown' } = opts;
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const now = Date.now();
    const cutoff = now - windowMs;
    const hits = (buckets.get(key) || []).filter((t) => t > cutoff);
    if (hits.length >= limit) {
      res.status(429).json({ error: 'rate limit exceeded — try again later' });
      return;
    }
    hits.push(now);
    buckets.set(key, hits);
    next();
  };
}

// Dynamic-import the bb-support reveal library so orch's TypeScript build
// doesn't statically depend on bb-skills. pathToFileURL keeps Windows / MSYS
// Git Bash paths un-mangled. (run-support + hubspot loaders live in
// ../core/support-paths.js so the poller can share them.)
type ApplyMappingFn = (text: string, mappings: Record<string, string>) => string;

let applyMappingCache: ApplyMappingFn | null = null;

async function loadApplyMapping(): Promise<ApplyMappingFn> {
  if (applyMappingCache) return applyMappingCache;
  const url = pathToFileURL(join(SCRIPTS_DIR, 'reveal.mjs')).href;
  const mod = await import(url);
  if (typeof mod.applyMapping !== 'function') {
    throw new Error(`applyMapping export missing from ${url}`);
  }
  applyMappingCache = mod.applyMapping as ApplyMappingFn;
  return applyMappingCache;
}

// Local extension; not declared globally to avoid leaking these fields onto
// every other Express handler in orch.
interface AuthedRequest extends Request {
  bearerToken?: string | null;
  tokenName?: string;
}

// Discriminated terminal so error-stage runs are guaranteed to carry an
// error string (non-error stages can't). `done` is implicit from `terminal`.
type SupportTerminal =
  | { stage: 'ok' | 'cancelled' }
  | { stage: 'ask' | 'claude' | 'spawn'; error: string };

// Set when /ask is called from the ticket inbox; drives the on-disk result
// cache so reopening a ticket re-shows its last Investigate/Draft after a
// page reload. Absent for plain Q&A asks (no persistence).
type TicketSubject = { type: 'ticket'; id: string };

type SupportRun = {
  controller: AbortController;
  startedAt: number;
  keyFile: string;
  ownerBearer: string | null;
  chunks: string[];
  bufferedBytes: number;
  bufferTruncated: boolean;
  sseRes: Response | null;
  terminal: SupportTerminal | null;
  // Result-cache: full answer accumulated across the run (independent of SSE
  // attach), bounded by the same 1 MB cap. `subject` keys the cache file.
  subject: TicketSubject | null;
  answer: string;
  answerBytes: number;
  answerTruncated: boolean;
};

// Persist a finished ticket Investigate/Draft so the inbox can re-show it on
// reopen. Overwrite-per-(ticket,intent); no TTL (matches bb-dashboard). Best
// effort — a failed write only costs the reopen convenience.
function writeTicketResult(
  subject: TicketSubject,
  intent: string,
  body: string,
  stage: string,
): void {
  if (!body.trim()) return;
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const payload = { type: subject.type, id: subject.id, intent, body, stage, finishedAt: Date.now() };
    writeFileSync(join(RESULTS_DIR, `ticket-${subject.id}-${intent}.json`), JSON.stringify(payload, null, 2));
  } catch (err) {
    log.warn('failed to persist ticket result: ' + (err as Error).message);
  }
}

export function mountSupport(app: Express, opts: { bind?: string } = {}): void {
  // Token file is loaded once at boot; re-issuing tokens requires a server restart.
  const tokens = loadTokens();
  const bind = opts.bind || '127.0.0.1';
  try {
    assertBindAuthValid(bind, tokens, ALLOW_ANONYMOUS);
  } catch (err) {
    log.error((err as Error).message);
    throw err;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(KEYS_DIR, { recursive: true });

  if (ALLOW_ANONYMOUS) {
    log.warn(
      'BB_SUPPORT_ALLOW_ANONYMOUS=1 — /api/support/* accepts unauthenticated requests. ' +
      'The LAN itself is the security boundary; every request is logged as "anonymous".',
    );
  } else {
    log.info(`/api/support/* loaded with ${Object.keys(tokens).length} bearer token(s) from ${TOKENS_FILE}`);
  }

  // Bearer auth — token resolution + prototype-pollution guard live in
  // ./auth.ts. A valid token must carry the `support` scope (admin/* satisfies
  // it); a token that exists but lacks the scope gets 403, not 401.
  const bearerAuth: RequestHandler = (req, res, next) => {
    const r = req as AuthedRequest;
    const tk = tokenFromRequest(r);
    if (!tk) {
      res.setHeader('X-Orch-Auth', 'required');
      res.status(401).json({ error: 'bearer token required' });
      return;
    }
    const entry = lookupToken(tokens, tk);
    if (!entry) {
      res.setHeader('X-Orch-Auth', 'required');
      res.status(401).json({ error: 'invalid token' });
      return;
    }
    if (!hasScope(entry, 'support')) {
      res.setHeader('X-Orch-Auth', 'scope');
      res.status(403).json({ error: 'token lacks support scope' });
      return;
    }
    r.bearerToken = tk;
    r.tokenName = entry.name || 'unnamed';
    next();
  };

  const anonymousAuth: RequestHandler = (req, _res, next) => {
    const r = req as AuthedRequest;
    const tk = tokenFromRequest(r);
    const entry = lookupToken(tokens, tk);
    r.bearerToken = entry ? tk : null;
    r.tokenName = entry ? (entry.name || 'unnamed') : 'anonymous';
    next();
  };

  const auth: RequestHandler = ALLOW_ANONYMOUS ? anonymousAuth : bearerAuth;

  // Two budgets: /ask spawns claude (expensive); /reveal is a pure file read.
  // Sharing a bucket would punish the documented "ask → reveal N matches" flow.
  const askLimiter = rateLimiter({ windowMs: 5 * 60_000, limit: 10 });
  const revealLimiter = rateLimiter({ windowMs: 5 * 60_000, limit: 60 });

  const supportRuns = new Map<string, SupportRun>();

  // Defence-in-depth headers on the /support page + its API. Doesn't affect
  // the rest of the orch dashboard, which has its own posture.
  const securityHeaders = (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
  app.use('/api/support', securityHeaders);

  // Liveness probe (no auth) — UI uses authMode to decide whether to show
  // the token input. Mounted before any auth middleware.
  app.get('/api/support/health', (_req, res) => {
    res.json({ status: 'ok', authMode: ALLOW_ANONYMOUS ? 'anonymous' : 'token' });
  });

  app.post('/api/support/ask', auth, askLimiter, asyncHandler(async (req, res) => {
    const r = req as AuthedRequest;
    const body = (r.body || {}) as { question?: unknown; intent?: unknown; subject?: unknown };
    const question = body.question;
    const intent = body.intent ?? 'investigate';
    if (!question || typeof question !== 'string') {
      res.status(400).json({ error: 'question required' });
      return;
    }
    if (intent !== 'investigate' && intent !== 'draft' && intent !== 'reply' && intent !== 'summarise') {
      res.status(400).json({ error: 'intent must be investigate|draft|reply|summarise' });
      return;
    }
    // Optional ticket subject (from the inbox) — keys the result cache. Q&A
    // asks omit it. Validate strictly so a bad value can't escape the filename.
    let subject: TicketSubject | null = null;
    const rawSubject = body.subject;
    if (rawSubject && typeof rawSubject === 'object') {
      const s = rawSubject as { type?: unknown; id?: unknown };
      if (s.type === 'ticket' && typeof s.id === 'string' && /^\d+$/.test(s.id)) {
        subject = { type: 'ticket', id: s.id };
      } else {
        res.status(400).json({ error: 'subject must be { type:"ticket", id:"<digits>" }' });
        return;
      }
    }

    let runSupportQuery: RunSupportFn;
    try {
      runSupportQuery = await loadRunSupport();
    } catch (err) {
      log.error('failed to load runSupportQuery from ' + SCRIPTS_DIR, err);
      res.status(500).json({ error: 'support library unavailable: ' + (err as Error).message });
      return;
    }

    const runId = randomUUID();
    const keyId = randomUUID();
    const keyFile = join(KEYS_DIR, `${keyId}.json`);

    const controller = new AbortController();
    const run: SupportRun = {
      controller,
      startedAt: Date.now(),
      keyFile,
      ownerBearer: r.bearerToken ?? null,
      chunks: [],
      bufferedBytes: 0,
      bufferTruncated: false,
      sseRes: null,
      terminal: null,
      subject,
      answer: '',
      answerBytes: 0,
      answerTruncated: false,
    };
    supportRuns.set(runId, run);

    res.status(202).json({ runId, keyId });

    const auditBase = {
      ts: new Date().toISOString(),
      ip: r.ip,
      tokenName: r.tokenName ?? 'anonymous',
      question,
    };

    runSupportQuery({
      question,
      keyFile,
      intent,
      format: 'markdown',
      signal: controller.signal,
      onChunk: (chunk: string) => {
        // Accumulate the full answer for the result cache (independent of SSE
        // attach), bounded by the same cap so an orphaned run can't pin RSS.
        if (run.subject && !run.answerTruncated) {
          const sz = Buffer.byteLength(chunk);
          if (run.answerBytes + sz > CHUNK_BUFFER_CAP_BYTES) run.answerTruncated = true;
          else { run.answer += chunk; run.answerBytes += sz; }
        }
        if (run.sseRes) {
          try {
            run.sseRes.write(`event: chunk\ndata: ${JSON.stringify({ chunk })}\n\n`);
            return;
          } catch {
            // TCP teardown between attach and this write — fall through to the
            // buffer path so the run can still complete cleanly.
            run.sseRes = null;
          }
        }
        // Sticky truncation past 1 MB — a mid-stream gap renders an incoherent
        // partial answer worse than a clean cut-off, and an orphaned ask
        // shouldn't pin unbounded RSS.
        if (run.bufferTruncated) return;
        const size = Buffer.byteLength(chunk);
        if (run.bufferedBytes + size > CHUNK_BUFFER_CAP_BYTES) {
          run.bufferTruncated = true;
          return;
        }
        run.bufferedBytes += size;
        run.chunks.push(chunk);
      },
    }).then(({ stage, askStderr, claudeStderr }) => {
      const terminal: SupportTerminal = stage === 'ok' || stage === 'cancelled'
        ? { stage }
        : { stage, error: (stage === 'claude' ? claudeStderr : askStderr).trim() || '(no detail)' };
      run.terminal = terminal;
      if (run.sseRes) {
        try {
          run.sseRes.write(`event: done\ndata: ${JSON.stringify(terminal)}\n\n`);
          run.sseRes.end();
        } catch { /* client disconnected mid-write; sse will be reaped */ }
      }
      // Persist for inbox reopen — partial output from a non-ok stage is still
      // useful to revisit (matches bb-dashboard).
      if (run.subject) writeTicketResult(run.subject, intent, run.answer, terminal.stage);
      try {
        appendAudit(
          'error' in terminal
            ? { ...auditBase, status: terminal.stage, error: terminal.error, durationMs: Date.now() - run.startedAt }
            : { ...auditBase, status: terminal.stage, durationMs: Date.now() - run.startedAt },
        );
      } catch (err) {
        log.error('audit write failed', err);
      }
      scheduleRunDelete(runId);
    }).catch((err: Error) => {
      run.terminal = { stage: 'spawn', error: err.message };
      if (run.sseRes) {
        try {
          run.sseRes.write(`event: done\ndata: ${JSON.stringify(run.terminal)}\n\n`);
          run.sseRes.end();
        } catch { /* client disconnected mid-write */ }
      }
      if (run.subject) writeTicketResult(run.subject, intent, run.answer, 'spawn');
      try {
        appendAudit({
          ...auditBase, status: 'spawn',
          error: err.message, durationMs: Date.now() - run.startedAt,
        });
      } catch (auditErr) {
        log.error('audit write failed', auditErr);
      }
      scheduleRunDelete(runId);
    });
  }));

  // Drop a completed run from the Map after a short grace window so a late
  // EventSource attach (racing the resolve) can still pick up the buffered
  // chunks.
  function scheduleRunDelete(runId: string): void {
    const handle = setTimeout(() => supportRuns.delete(runId), RUN_COMPLETION_TTL_MS);
    handle.unref?.();
  }

  app.get('/api/support/events/:runId', (req, res) => {
    // Reject non-UUID runIds before any auth/lookup to keep the surface small.
    if (!UUID_RE.test(req.params.runId)) {
      res.status(400).json({ error: 'runId must be UUID' });
      return;
    }

    if (!ALLOW_ANONYMOUS) {
      // Auth BEFORE lookup so the response doesn't leak run existence to
      // unauthenticated callers.
      const token = req.query.token;
      if (typeof token !== 'string' || !Object.hasOwn(tokens, token)) {
        res.status(401).json({ error: 'invalid token' });
        return;
      }
      const run = supportRuns.get(req.params.runId);
      if (!run) { res.status(404).json({ error: 'unknown runId' }); return; }
      if (run.ownerBearer !== token) { res.status(403).json({ error: 'not your run' }); return; }
      attachSse(res, req, run);
      return;
    }

    // Anonymous: UUID-as-secret. Anyone who knows the runId can subscribe;
    // acceptable under the LAN-trust threat model that anonymous mode opts into.
    const run = supportRuns.get(req.params.runId);
    if (!run) { res.status(404).json({ error: 'unknown runId' }); return; }
    attachSse(res, req, run);
  });

  function attachSse(res: Response, req: Request, run: SupportRun): void {
    try {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write('\n');

      run.sseRes = res;
      for (const c of run.chunks) {
        res.write(`event: chunk\ndata: ${JSON.stringify({ chunk: c })}\n\n`);
      }
      run.chunks = [];
      if (run.terminal) {
        res.write(`event: done\ndata: ${JSON.stringify(run.terminal)}\n\n`);
        res.end();
      }
    } catch {
      // Client tore down the TCP socket during the replay. Detach so the run's
      // continuing chunks don't write to a dead response.
      if (run.sseRes === res) run.sseRes = null;
      return;
    }

    req.on('close', () => {
      if (run.sseRes === res) run.sseRes = null;
    });
  }

  // Cancel a run mid-stream. Aborts the AbortController so the ask.mjs +
  // claude subprocess tree is killed via the library's taskkill /T.
  app.post('/api/support/cancel/:runId', auth, asyncHandler(async (req, res) => {
    const r = req as AuthedRequest;
    const runId = String(req.params.runId ?? '');
    if (!UUID_RE.test(runId)) {
      res.status(400).json({ error: 'runId must be UUID' });
      return;
    }
    const run = supportRuns.get(runId);
    if (!run) { res.status(404).json({ error: 'unknown runId' }); return; }
    if (!ALLOW_ANONYMOUS && run.ownerBearer !== r.bearerToken) {
      res.status(403).json({ error: 'not your run' });
      return;
    }
    run.controller.abort();
    res.status(202).json({ ok: true });
  }));

  app.post('/api/support/reveal', auth, revealLimiter, asyncHandler(async (req, res) => {
    const body = (req.body || {}) as { keyId?: unknown; text?: unknown };
    const { keyId, text } = body;
    if (!keyId || typeof keyId !== 'string' || !UUID_RE.test(keyId)) {
      res.status(400).json({ error: 'keyId required (UUID format)' });
      return;
    }
    const keyFile = join(KEYS_DIR, `${keyId}.json`);
    if (!existsSync(keyFile)) {
      res.status(404).json({ error: 'unknown or expired keyId' });
      return;
    }
    let payload: { mappings?: Record<string, string> };
    try {
      payload = JSON.parse(readFileSync(keyFile, 'utf8'));
    } catch (err) {
      res.status(500).json({ error: 'key file unreadable: ' + (err as Error).message });
      return;
    }
    const mappings = payload.mappings || {};
    let decoded: string | null = null;
    if (typeof text === 'string') {
      try {
        const applyMapping = await loadApplyMapping();
        decoded = applyMapping(text, mappings);
      } catch (err) {
        log.error('failed to load applyMapping', err);
        res.status(500).json({ error: 'reveal library unavailable: ' + (err as Error).message });
        return;
      }
    }
    res.json({ mappings, decoded });
  }));

  // Reapers: kill runaway runs at 5 min, unlink stale key files past 30 min.
  // User-initiated cancel routes through POST /api/support/cancel/:runId
  // (above) which aborts the controller; this reaper is the fallback for runs
  // that nobody cancelled.
  const runReaper = setInterval(() => {
    const now = Date.now();
    for (const [runId, run] of supportRuns) {
      if (now - run.startedAt > RUN_MAX_MS) {
        run.controller.abort();
        if (run.sseRes) {
          try {
            run.sseRes.write(`event: done\ndata: ${JSON.stringify({ stage: 'cancelled' })}\n\n`);
            run.sseRes.end();
          } catch { /* sse already closed */ }
        }
        supportRuns.delete(runId);
      }
    }
  }, 30_000);
  runReaper.unref?.();

  const keyReaper = setInterval(() => {
    let files: string[];
    try {
      if (!existsSync(KEYS_DIR)) return;
      files = readdirSync(KEYS_DIR);
    } catch (err) {
      log.warn('keyReaper scan failed: ' + ((err as NodeJS.ErrnoException).code || (err as Error).message));
      return;
    }
    const cutoff = Date.now() - KEY_TTL_MS;
    for (const f of files) {
      const p = join(KEYS_DIR, f);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') log.warn(`keyReaper unlink failed: ${f} ${code || (err as Error).message}`);
      }
    }
  }, 60_000);
  keyReaper.unref?.();

  // HubSpot ticket-inbox endpoints — share this module's auth + the
  // /api/support securityHeaders already applied above.
  mountHubspot(app, { auth });
}
