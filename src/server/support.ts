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

import type { Express, NextFunction, Request, Response } from 'express';
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
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLogger } from '../core/logger.js';

const log = createLogger('support');

// Allow callers to override paths via env. Defaults match the standalone
// bb-support-web deployment so existing tokens.json / audit.jsonl keep working.
const DATA_DIR = process.env.BB_SUPPORT_DATA_DIR || join(homedir(), '.claude', 'bb-support-web');
const KEYS_DIR = join(DATA_DIR, '.keys');
const TOKENS_FILE = join(DATA_DIR, 'tokens.json');
const AUDIT_FILE = join(DATA_DIR, 'audit.jsonl');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = process.env.BB_SUPPORT_SCRIPTS_DIR
  || resolvePath(__dirname, '..', '..', '..', 'bb-skills', 'bb-support', 'scripts');

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

type TokenEntry = { name?: string; createdAt?: string };
type TokenMap = Record<string, TokenEntry>;

function loadTokens(path = TOKENS_FILE): TokenMap {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as TokenMap;
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

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
type AuditEntry = {
  ts: string;
  ip: string | undefined;
  tokenName: string;
  question: string;
  status: string;
  durationMs: number;
  error?: string;
  stage?: string;
};

function appendAudit(entry: AuditEntry, path = AUDIT_FILE): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, 'wx', 0o600));
  }
  appendFileSync(path, JSON.stringify(entry) + '\n');
}

// Hand-rolled sliding-window rate limiter — orch doesn't depend on
// express-rate-limit and adding it just for two buckets isn't worth the dep.
// keyFn defaults to req.ip so each remote client gets its own bucket.
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

// Dynamic-import the bb-support library so orch's TypeScript build doesn't
// statically depend on bb-skills. pathToFileURL keeps Windows / MSYS Git Bash
// paths un-mangled.
type RunSupportFn = (opts: {
  question: string;
  keyFile?: string;
  intent?: 'investigate' | 'draft' | 'reply';
  format?: 'markdown' | 'html';
  onChunk: (text: string) => void;
  signal?: AbortSignal;
}) => Promise<{ stage: string; exitCode: number | null; askStderr: string; claudeStderr: string }>;

type ApplyMappingFn = (text: string, mappings: Record<string, string>) => string;

let runSupportQueryCache: RunSupportFn | null = null;
let applyMappingCache: ApplyMappingFn | null = null;

async function loadRunSupport(): Promise<RunSupportFn> {
  if (runSupportQueryCache) return runSupportQueryCache;
  const url = pathToFileURL(join(SCRIPTS_DIR, 'run-support.mjs')).href;
  const mod = await import(url);
  if (typeof mod.runSupportQuery !== 'function') {
    throw new Error(`runSupportQuery export missing from ${url}`);
  }
  runSupportQueryCache = mod.runSupportQuery as RunSupportFn;
  return runSupportQueryCache;
}

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

// Extend Request with the auth-attached fields. Keeping this local rather than
// in a global declaration so the typing is self-contained to this module.
interface AuthedRequest extends Request {
  bearerToken?: string | null;
  tokenName?: string;
}

type SupportRun = {
  controller: AbortController;
  startedAt: number;
  keyFile: string;
  ownerBearer: string | null;
  chunks: string[];
  bufferedBytes: number;
  bufferTruncated: boolean;
  sseRes: Response | null;
  done: boolean;
  terminal: { stage: string; error?: string } | null;
};

export function mountSupport(app: Express, opts: { bind?: string } = {}): void {
  // Token file is loaded once at boot. Re-issuing tokens requires a server
  // restart — same posture as bb-support-web (the standalone server didn't
  // hot-reload tokens either; both are LAN-scoped admin tools where editing
  // tokens.json is already a deploy step).
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

  // Bearer auth — Object.hasOwn check is critical: `tokens[m[1]]` alone would
  // return Object.prototype members (constructor, __proto__, toString) as
  // truthy, bypassing auth. Same posture for anonymous mode below.
  function bearerAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(.+)$/);
    if (!m) {
      res.status(401).json({ error: 'bearer token required' });
      return;
    }
    const entry = Object.hasOwn(tokens, m[1]) ? tokens[m[1]] : null;
    if (!entry) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }
    req.bearerToken = m[1];
    req.tokenName = entry.name || 'unnamed';
    next();
  }

  function anonymousAuth(req: AuthedRequest, _res: Response, next: NextFunction): void {
    const header = req.headers.authorization || '';
    const m = header.match(/^Bearer\s+(.+)$/);
    const token = m ? m[1] : null;
    const entry = token && Object.hasOwn(tokens, token) ? tokens[token] : null;
    req.bearerToken = entry ? token : null;
    req.tokenName = entry ? (entry.name || 'unnamed') : 'anonymous';
    next();
  }

  const auth = ALLOW_ANONYMOUS ? anonymousAuth : bearerAuth;

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

  app.post('/api/support/ask', auth as never, askLimiter, async (req: AuthedRequest, res) => {
    const body = (req.body || {}) as { question?: unknown; intent?: unknown };
    const question = body.question;
    const intent = body.intent ?? 'investigate';
    if (!question || typeof question !== 'string') {
      res.status(400).json({ error: 'question required' });
      return;
    }
    if (intent !== 'investigate' && intent !== 'draft' && intent !== 'reply') {
      res.status(400).json({ error: 'intent must be investigate|draft|reply' });
      return;
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
      ownerBearer: req.bearerToken ?? null,
      chunks: [],
      bufferedBytes: 0,
      bufferTruncated: false,
      sseRes: null,
      done: false,
      terminal: null,
    };
    supportRuns.set(runId, run);

    res.status(202).json({ runId, keyId });

    const auditBase = {
      ts: new Date().toISOString(),
      ip: req.ip,
      tokenName: req.tokenName ?? 'anonymous',
      question,
    };

    runSupportQuery({
      question,
      keyFile,
      intent: intent as 'investigate' | 'draft' | 'reply',
      format: 'markdown',
      signal: controller.signal,
      onChunk: (chunk: string) => {
        if (run.sseRes) {
          run.sseRes.write(`event: chunk\ndata: ${JSON.stringify({ chunk })}\n\n`);
          return;
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
      run.done = true;
      run.terminal = stage === 'ok' || stage === 'cancelled'
        ? { stage }
        : { stage, error: (stage === 'claude' ? claudeStderr : askStderr).trim() || '(no detail)' };
      if (run.sseRes) {
        run.sseRes.write(`event: done\ndata: ${JSON.stringify(run.terminal)}\n\n`);
        run.sseRes.end();
      }
      try {
        appendAudit({ ...auditBase, status: stage, durationMs: Date.now() - run.startedAt });
      } catch (err) {
        log.error('audit write failed', err);
      }
      scheduleRunDelete(runId);
    }).catch((err: Error) => {
      run.done = true;
      run.terminal = { stage: 'spawn', error: err.message };
      if (run.sseRes) {
        run.sseRes.write(`event: done\ndata: ${JSON.stringify(run.terminal)}\n\n`);
        run.sseRes.end();
      }
      try {
        appendAudit({
          ...auditBase, status: 'spawn', stage: 'spawn',
          error: err.message, durationMs: Date.now() - run.startedAt,
        });
      } catch (auditErr) {
        log.error('audit write failed', auditErr);
      }
      scheduleRunDelete(runId);
    });
  });

  // Drop a completed run from the Map after a short grace window so a late
  // EventSource attach (racing the resolve) can still pick up the buffered
  // chunks. The 5-min reaper only checks startedAt, not doneAt.
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
    if (run.done && run.terminal) {
      res.write(`event: done\ndata: ${JSON.stringify(run.terminal)}\n\n`);
      res.end();
    }

    req.on('close', () => {
      if (run.sseRes === res) run.sseRes = null;
    });
  }

  app.post('/api/support/reveal', auth as never, revealLimiter, async (req: AuthedRequest, res) => {
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
  });

  // Reapers: kill runaway runs at 5 min, unlink stale key files past 30 min.
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
}
