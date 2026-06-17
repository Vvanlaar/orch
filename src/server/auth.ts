// Shared token + scope auth for orch's HTTP/WS surface.
//
// Tokens live in ~/.claude/bb-support-web/tokens.json (the same file bb-support
// uses, so support tokens keep working). Each entry carries a `scopes` list:
//   - ["support"]        → may use /api/support/* only
//   - ["admin"] / ["*"]  → full access (admin satisfies every scope check)
// A legacy entry with no `scopes` defaults to ["support"] (least privilege), so
// pre-existing support tokens don't silently gain admin.
//
// Used by:
//   - index.ts requireScopes middleware (gates every non-support /api/* on admin)
//   - index.ts /ws upgrade gate (admin only)
//   - index.ts GET /api/whoami (reports the caller's scopes to the SPA)
//   - support.ts bearerAuth (support scope, admin allowed)

import type { Request } from 'express';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = process.env.BB_SUPPORT_DATA_DIR || join(homedir(), '.claude', 'bb-support-web');
export const TOKENS_FILE = join(DATA_DIR, 'tokens.json');

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
export function hasScope(entry: TokenEntry | null, required: string): boolean {
  if (!entry) return false;
  if (isAdminEntry(entry)) return true;
  return entry.scopes.includes(required);
}
