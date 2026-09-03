import { describe, it, expect } from 'vitest';
import type { Request, Response } from 'express';
import {
  createApiAuthGate,
  hasScope,
  hideTaskFrom,
  isAdminEntry,
  requiredScope,
  visibleTasks,
  type TokenEntry,
  type TokenMap,
} from './auth.js';

const SUPPORT: TokenEntry = { name: 'Koert', scopes: ['support'] };
const VIDEOSCAN: TokenEntry = { name: 'Luuk', scopes: ['videoscan'] };
const ADMIN: TokenEntry = { name: 'Vince', scopes: ['admin'] };
const LEGACY_STAR: TokenEntry = { name: 'old', scopes: ['*'] };

describe('hasScope', () => {
  it('grants admin every scope', () => {
    expect(hasScope(ADMIN, 'support')).toBe(true);
    expect(hasScope(ADMIN, 'videoscan')).toBe(true);
    expect(hasScope(LEGACY_STAR, 'videoscan')).toBe(true);
  });

  it('keeps support and videoscan disjoint', () => {
    // The whole point of the videoscan scope: it must not be a back door into
    // the support surface, and a support token must not gain scan control.
    expect(hasScope(SUPPORT, 'videoscan')).toBe(false);
    expect(hasScope(VIDEOSCAN, 'support')).toBe(false);
  });

  it('denies everything for a missing token', () => {
    expect(hasScope(null, 'videoscan')).toBe(false);
    expect(isAdminEntry(null)).toBe(false);
  });

  it('does not treat videoscan as admin', () => {
    expect(isAdminEntry(VIDEOSCAN)).toBe(false);
    expect(hasScope(VIDEOSCAN, 'admin')).toBe(false);
  });
});

describe('requiredScope', () => {
  it('opens the videoscan surface to the videoscan scope', () => {
    expect(requiredScope('/api/videoscans', 'GET')).toBe('videoscan');
    expect(requiredScope('/api/videoscans', 'DELETE')).toBe('videoscan');
    expect(requiredScope('/api/videoscans/merge', 'POST')).toBe('videoscan');
    expect(requiredScope('/api/videoscans/files/scan-2026.json', 'GET')).toBe('videoscan');
    expect(requiredScope('/api/actions/start-videoscan', 'POST')).toBe('videoscan');
    expect(requiredScope('/api/actions/resume-videoscan', 'POST')).toBe('videoscan');
  });

  it('allows stop/pause/resume on a numbered task', () => {
    expect(requiredScope('/api/tasks/42/stop', 'POST')).toBe('videoscan');
    expect(requiredScope('/api/tasks/42/pause', 'POST')).toBe('videoscan');
    expect(requiredScope('/api/tasks/42/resume', 'POST')).toBe('videoscan');
  });

  it('keeps the rest of the task surface admin-only', () => {
    // Retry/complete/terminal/approve would let a scan operator drive arbitrary
    // Claude subprocesses — they are deliberately not in the videoscan slice.
    expect(requiredScope('/api/tasks/42/retry', 'POST')).toBe('admin');
    expect(requiredScope('/api/tasks/42/terminal', 'POST')).toBe('admin');
    expect(requiredScope('/api/tasks/42/approve', 'POST')).toBe('admin');
    expect(requiredScope('/api/tasks/42', 'DELETE')).toBe('admin');
    expect(requiredScope('/api/tasks/42', 'GET')).toBe('admin');
  });

  it('allows only GET on the task list', () => {
    expect(requiredScope('/api/tasks', 'GET')).toBe('videoscan');
    expect(requiredScope('/api/tasks', 'POST')).toBe('admin');
  });

  it('does not let a lookalike path slip through', () => {
    // Substring/prefix confusion is the classic way a route allowlist leaks.
    expect(requiredScope('/api/videoscans-secret', 'GET')).toBe('admin');
    expect(requiredScope('/api/tasks/abc/stop', 'POST')).toBe('admin');
    expect(requiredScope('/api/tasks/42/stop/extra', 'POST')).toBe('admin');
    expect(requiredScope('/api/config/credentials', 'GET')).toBe('admin');
  });

  it('defaults an unknown route to admin', () => {
    expect(requiredScope('/api/some/route/added/later', 'GET')).toBe('admin');
    expect(requiredScope('/api/repos', 'GET')).toBe('admin');
  });

  it('treats a case-varied admin path as admin', () => {
    // Express matches routes case-insensitively, so /API/config/credentials
    // reaches the same handler as the lowercase path. The gate lower-cases
    // before calling this, and these must not become videoscan by accident.
    expect(requiredScope('/API/config/credentials'.toLowerCase(), 'GET')).toBe('admin');
    expect(requiredScope('/API/repos'.toLowerCase(), 'GET')).toBe('admin');
    // ...and the videoscan slice still resolves once normalized.
    expect(requiredScope('/API/Videoscans'.toLowerCase(), 'GET')).toBe('videoscan');
  });

  it('does not match an un-normalized upper-case path', () => {
    // Documents why the gate must lower-case: raw upper-case input falls
    // through to admin here, which is safe, but the gate's own /api/ prefix
    // test would have skipped it entirely. Fail-closed either way.
    expect(requiredScope('/API/videoscans', 'GET')).toBe('admin');
  });
});

describe('visibleTasks', () => {
  const tasks = [
    { id: 1, type: 'videoscan' },
    { id: 2, type: 'pr-review' },
    { id: 3, type: 'videoscan' },
    { id: 4, type: 'issue-fix' },
  ];

  it('hands an admin everything, unfiltered', () => {
    expect(visibleTasks(tasks, true)).toBe(tasks);
  });

  it('reduces a non-admin to videoscan rows only', () => {
    // Not just a UI concern: PR/issue task rows carry repo names and titles.
    expect(visibleTasks(tasks, false).map((t) => t.id)).toEqual([1, 3]);
  });

  it('returns an empty list rather than throwing when nothing matches', () => {
    expect(visibleTasks([{ id: 9, type: 'pr-review' }], false)).toEqual([]);
  });
});

describe('createApiAuthGate', () => {
  const TOKENS: TokenMap = {
    'tok-admin': { name: 'Vince', scopes: ['admin'] },
    'tok-scan': { name: 'Luuk', scopes: ['videoscan'] },
    'tok-support': { name: 'Koert', scopes: ['support'] },
  };
  const gate = createApiAuthGate(TOKENS);

  // Minimal Express doubles — the gate reads path/method/headers/query and
  // replies via status().json() or calls next().
  function run(path: string, { token, method = 'GET' }: { token?: string; method?: string } = {}) {
    const req = {
      path,
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      query: {},
    } as unknown as Request;
    const out: { status?: number; body?: unknown; headers: Record<string, string>; nexted: boolean } = {
      headers: {},
      nexted: false,
    };
    const res = {
      setHeader: (k: string, v: string) => { out.headers[k] = v; },
      status: (c: number) => { out.status = c; return res; },
      json: (b: unknown) => { out.body = b; return res; },
    } as unknown as Response;
    gate(req, res, () => { out.nexted = true; });
    return { ...out, isAdmin: (req as Request & { isAdmin?: boolean }).isAdmin };
  }

  it('lets non-API and public routes straight through', () => {
    expect(run('/health').nexted).toBe(true);
    expect(run('/api/whoami').nexted).toBe(true);
    expect(run('/api/notifications/incoming', { method: 'POST' }).nexted).toBe(true);
  });

  it('defers /api/support/* to mountSupport rather than gating it here', () => {
    expect(run('/api/support').nexted).toBe(true);
    expect(run('/api/support/ask', { method: 'POST' }).nexted).toBe(true);
  });

  it('401s an absent or unknown token, and flags it as an auth-layer rejection', () => {
    const anon = run('/api/repos');
    expect(anon.status).toBe(401);
    expect(anon.headers['X-Orch-Auth']).toBe('required');
    expect(run('/api/repos', { token: 'nope' }).status).toBe(401);
  });

  it('403s a token that authenticates but lacks the scope', () => {
    const scan = run('/api/repos', { token: 'tok-scan' });
    expect(scan.status).toBe(403);
    expect(scan.headers['X-Orch-Auth']).toBe('scope');
    expect(run('/api/config/credentials', { token: 'tok-support' }).status).toBe(403);
  });

  it('admits a videoscan token to its slice and marks it non-admin', () => {
    const r = run('/api/videoscans', { token: 'tok-scan' });
    expect(r.nexted).toBe(true);
    expect(r.isAdmin).toBe(false);
  });

  it('admits admin everywhere and marks it admin', () => {
    const r = run('/api/config/credentials', { token: 'tok-admin' });
    expect(r.nexted).toBe(true);
    expect(r.isAdmin).toBe(true);
  });

  it('does not let a case-varied path skip the gate', () => {
    // Regression: Express routes case-insensitively, so /API/config/credentials
    // hits the same handler. Testing req.path raw meant the gate saw no /api/
    // prefix and next()'d — unauthenticated access to the whole admin API from
    // any LAN client. Verified live against a running server before the fix.
    for (const p of ['/API/config/credentials', '/Api/Config/Credentials', '/API/repos']) {
      const r = run(p);
      expect(r.nexted, `${p} must not bypass the gate`).toBe(false);
      expect(r.status).toBe(401);
    }
    // A scoped token is still judged on the normalized path.
    expect(run('/API/repos', { token: 'tok-scan' }).status).toBe(403);
    expect(run('/API/videoscans', { token: 'tok-scan' }).nexted).toBe(true);
  });

  it('does not let case games widen the public allowlist either', () => {
    // /API/whoami should still be public (normalized), not a bypass of anything.
    expect(run('/API/whoami').nexted).toBe(true);
  });
});

describe('hideTaskFrom', () => {
  const admin = { isAdmin: true } as unknown as Request;
  const scan = { isAdmin: false } as unknown as Request;

  it('hides a non-videoscan task from a non-admin caller', () => {
    expect(hideTaskFrom(scan, { type: 'pr-review' })).toBe(true);
  });

  it('shows videoscan tasks to a videoscan caller', () => {
    expect(hideTaskFrom(scan, { type: 'videoscan' })).toBe(false);
  });

  it('hides nothing from an admin', () => {
    expect(hideTaskFrom(admin, { type: 'pr-review' })).toBe(false);
  });

  it('treats a request the gate never touched as non-admin', () => {
    // Fail closed: an unmarked request means the gate didn't run.
    expect(hideTaskFrom({} as Request, { type: 'pr-review' })).toBe(true);
  });
});
