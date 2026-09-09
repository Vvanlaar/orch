// Shared token + scope auth for orch's HTTP/WS surface.
//
// Tokens live in ~/.claude/bb-support-web/tokens.json (the same file bb-support
// uses, so support tokens keep working). Each entry carries a `scopes` list:
//   - ["support"]        → may use /api/support/* only
//   - ["videoscan"]      → may run and read videoscans and nothing else: the
//                          /api/videoscans/* surface, the videoscan actions, and
//                          the task endpoints that name a videoscan task. Sees
//                          only videoscan tasks over both HTTP and WS.
//   - ["admin"] / ["*"]  → full access (admin satisfies every scope check)
// A legacy entry with no `scopes` defaults to ["support"] (least privilege), so
// pre-existing support tokens don't silently gain admin.
//
// Scopes do NOT nest: a videoscan token grants no support access and vice
// versa. Only admin is a superset. To grant both, list both.
//
// Used by:
//   - index.ts's /api/* auth gate, via requiredScope() below (admin unless the
//     path is in the videoscan slice)
//   - index.ts /ws upgrade gate (admin or videoscan, with per-scope payload filtering)
//   - index.ts GET /api/whoami (reports the caller's scopes to the SPA)
//   - support.ts bearerAuth (support scope, admin allowed)

import type { Request, RequestHandler } from 'express';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = process.env.BB_SUPPORT_DATA_DIR || join(homedir(), '.claude', 'bb-support-web');
export const TOKENS_FILE = join(DATA_DIR, 'tokens.json');

// The scopes a token may be minted with. `*` is a legacy alias for admin —
// honored on read (see isAdminEntry) but never written. The mint-token script
// keeps a hand-copied duplicate of this list (it's a .mjs and can't import TS);
// change one and change the other.
export const SCOPES = ['support', 'videoscan', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

export type TokenEntry = { name?: string; createdAt?: string; scopes: string[] };
// Record (not Map) because tokens.json deserializes as a plain object. Every
// lookup MUST go through Object.hasOwn so prototype keys (constructor,
// __proto__, toString) can't return a truthy entry and bypass auth.
export type TokenMap = Record<string, TokenEntry>;

export function loadTokens(path = TOKENS_FILE): TokenMap {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: TokenMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const entry = v as { name?: unknown; createdAt?: unknown; scopes?: unknown };
        const scopes = Array.isArray(entry.scopes)
          ? entry.scopes.filter((s): s is string => typeof s === 'string')
          : [];
        out[k] = {
          name: typeof entry.name === 'string' ? entry.name : undefined,
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : undefined,
          // Least-privilege default: a token without explicit scopes is support-only.
          scopes: scopes.length > 0 ? scopes : ['support'],
        };
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

// Extract a bearer token from the Authorization header, falling back to the
// `?token=` query param (EventSource/WebSocket can't set custom headers).
export function tokenFromRequest(req: Request): string | null {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/);
  if (m) return m[1];
  const q = req.query?.token;
  if (typeof q === 'string' && q) return q;
  return null;
}

// Extract a token from a raw query string (WS upgrade — no Express Request yet).
export function tokenFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const qi = url.indexOf('?');
  if (qi === -1) return null;
  const t = new URLSearchParams(url.slice(qi + 1)).get('token');
  return t || null;
}

export function lookupToken(tokens: TokenMap, token: string | null): TokenEntry | null {
  if (!token) return null;
  return Object.hasOwn(tokens, token) ? tokens[token] : null;
}

export function isAdminEntry(entry: TokenEntry | null): boolean {
  return !!entry && (entry.scopes.includes('admin') || entry.scopes.includes('*'));
}

// admin/* satisfies any required scope; otherwise the scope must be listed.
export function hasScope(entry: TokenEntry | null, required: Scope): boolean {
  if (!entry) return false;
  if (isAdminEntry(entry)) return true;
  return entry.scopes.includes(required);
}

// --- Route → scope policy ---------------------------------------------------
// The videoscan slice: everything a scan operator needs and nothing more.
// Anything absent stays admin-only, so a route added later is locked down by
// default instead of silently inheriting videoscan access.
const VIDEOSCAN_ACTIONS = new Set<string>([
  '/api/actions/start-videoscan',
  '/api/actions/start-videoscan-urls',
  '/api/actions/resume-videoscan',
  '/api/actions/add-urls-to-scan',
]);

// Task control the scan UI needs. Matching the path proves the caller may act
// on *a* task; the handlers still re-check that the task is a videoscan.
const VIDEOSCAN_TASK_ROUTE = /^\/api\/tasks\/\d+\/(?:stop|pause|resume)$/;

// Which scope an /api/* path demands. Callers must already have excluded the
// public allowlist and the separately-gated /api/support/* tree.
export function requiredScope(path: string, method: string): Scope {
  if (path === '/api/videoscans' || path.startsWith('/api/videoscans/')) return 'videoscan';
  if (VIDEOSCAN_ACTIONS.has(path)) return 'videoscan';
  if (VIDEOSCAN_TASK_ROUTE.test(path)) return 'videoscan';
  // The task list drives the scan UI's live progress; the handler filters the
  // rows down to videoscan tasks for a non-admin caller.
  if (path === '/api/tasks' && method === 'GET') return 'videoscan';
  // Just the host's id, used to label a task as running elsewhere.
  if (path === '/api/config/machine-id' && method === 'GET') return 'videoscan';
  return 'admin';
}

// What a caller at this privilege level may see. A videoscan token is scoped to
// videoscans, so it must not learn that a PR review or an issue fix exists —
// filter the rows out rather than merely hiding them in the UI. Applied
// identically to the HTTP task list and the WS broadcast so the two can't
// disagree.
export function visibleTasks<T extends { type: string }>(tasks: T[], admin: boolean): T[] {
  return admin ? tasks : tasks.filter((t) => t.type === 'videoscan');
}

// Routes that answer without a token at all.
const PUBLIC_API = new Set<string>([
  '/api/whoami',                 // reports caller scopes to the SPA (drives the token gate)
  '/api/notifications/incoming', // webhook-like ingestion from external notifiers (no token to present)
]);

// The /api/* auth gate. Lives here rather than inline in index.ts so it can be
// tested directly — it is the single boundary keeping a LAN visitor out of
// tasks, repos, terminals, config/credentials and the orchestrator.
export function createApiAuthGate(tokens: TokenMap): RequestHandler {
  return (req, res, next) => {
    // Decide on a case-normalized path. Express matches routes
    // case-insensitively by default, so /API/config/credentials reaches the
    // same handler as the lowercase path; testing the raw path here would let
    // any casing variant skip the gate and still be served. Every route stem is
    // lowercase, and only this decision sees the normalized value — the handler
    // still gets req.path untouched.
    const path = req.path.toLowerCase();
    if (!path.startsWith('/api/')) return next();
    if (PUBLIC_API.has(path)) return next();
    // /api/support/* is gated inside mountSupport, which also honors
    // BB_SUPPORT_ALLOW_ANONYMOUS.
    if (path === '/api/support' || path.startsWith('/api/support/')) return next();

    const entry = lookupToken(tokens, tokenFromRequest(req));
    if (!entry) {
      // Mark this as an auth-layer rejection (vs. a downstream handler's own
      // 401, e.g. an upstream API) so the SPA only drops to the token gate on a
      // real token failure, not on a transient downstream 401.
      res.setHeader('X-Orch-Auth', 'required');
      res.status(401).json({ error: 'bearer token required' });
      return;
    }
    const scope = requiredScope(path, req.method);
    if (!hasScope(entry, scope)) {
      res.setHeader('X-Orch-Auth', 'scope');
      res.status(403).json({ error: `${scope} scope required` });
      return;
    }
    // Handlers that return or act on tasks narrow their behaviour by privilege.
    (req as AuthedApiRequest).isAdmin = isAdminEntry(entry);
    next();
  };
}

// Set by the gate above so handlers can tell a full admin from a narrower scope
// without re-reading the token.
export type AuthedApiRequest = Request & { isAdmin?: boolean };
export const isAdminReq = (req: Request): boolean => (req as AuthedApiRequest).isAdmin === true;

// True when this caller must not learn the task exists. Answer 404 rather than
// 403 on these: a distinguishable refusal lets a videoscan token enumerate
// which admin task ids are present and what state they're in.
export const hideTaskFrom = (req: Request, task: { type: string }): boolean =>
  !isAdminReq(req) && task.type !== 'videoscan';
