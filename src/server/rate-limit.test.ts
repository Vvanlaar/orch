import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { rateLimiter } from './rate-limit.js';

afterEach(() => { vi.useRealTimers(); });

// Minimal req/res doubles — the limiter reads only req.ip and calls res.status().json().
function call(mw: ReturnType<typeof rateLimiter>, ip: string): { passed: boolean; status: number | null } {
  let status: number | null = null;
  let passed = false;
  const res = {
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  mw({ ip } as Request, res, () => { passed = true; });
  return { passed, status };
}

describe('rateLimiter', () => {
  it('allows exactly `limit` requests then refuses with 429', () => {
    const mw = rateLimiter({ windowMs: 60_000, limit: 3 });
    expect(call(mw, 'a').passed).toBe(true);
    expect(call(mw, 'a').passed).toBe(true);
    expect(call(mw, 'a').passed).toBe(true);
    const fourth = call(mw, 'a');
    expect(fourth.passed).toBe(false);
    expect(fourth.status).toBe(429);
  });

  it('keys per caller, so one noisy client cannot starve the LAN', () => {
    const mw = rateLimiter({ windowMs: 60_000, limit: 1 });
    expect(call(mw, 'a').passed).toBe(true);
    expect(call(mw, 'a').passed).toBe(false);
    expect(call(mw, 'b').passed).toBe(true);
  });

  it('slides: budget returns once the window passes', () => {
    vi.useFakeTimers();
    const mw = rateLimiter({ windowMs: 60_000, limit: 2 });
    expect(call(mw, 'a').passed).toBe(true);
    expect(call(mw, 'a').passed).toBe(true);
    expect(call(mw, 'a').passed).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(call(mw, 'a').passed).toBe(true);
  });

  it('does not reset the window by being refused', () => {
    // If a 429 dropped the bucket, a client at the limit could hammer forever:
    // each rejection would clear its own history and the next call would pass.
    vi.useFakeTimers();
    const mw = rateLimiter({ windowMs: 60_000, limit: 1 });
    expect(call(mw, 'a').passed).toBe(true);
    for (let i = 0; i < 5; i++) expect(call(mw, 'a').passed).toBe(false);
    vi.advanceTimersByTime(30_000);
    expect(call(mw, 'a').passed).toBe(false);
    vi.advanceTimersByTime(30_002);
    expect(call(mw, 'a').passed).toBe(true);
  });

  it('honours a custom keyFn', () => {
    const mw = rateLimiter({ windowMs: 60_000, limit: 1, keyFn: () => 'shared' });
    expect(call(mw, 'a').passed).toBe(true);
    expect(call(mw, 'b').passed).toBe(false);
  });

  it('falls back to a placeholder key when req.ip is absent', () => {
    const mw = rateLimiter({ windowMs: 60_000, limit: 1 });
    expect(call(mw, undefined as unknown as string).passed).toBe(true);
    expect(call(mw, undefined as unknown as string).passed).toBe(false);
  });

  it('evicts aged-out keys instead of growing forever', () => {
    // This is a long-lived always-on service: without eviction the map keeps one
    // entry per distinct client IP for the process lifetime, because expiry is
    // applied to an array's contents on read and never to the key itself.
    vi.useFakeTimers();
    const mw = rateLimiter({ windowMs: 1_000, limit: 5 });
    for (let i = 0; i < 100; i++) call(mw, `ip-${i}`);
    vi.advanceTimersByTime(5_000);
    call(mw, 'trigger-sweep');
    // Every pre-sweep key has aged out; a fresh call for one of them must be
    // treated as a new bucket with a full budget.
    for (let i = 0; i < 5; i++) expect(call(mw, 'ip-0').passed).toBe(true);
    expect(call(mw, 'ip-0').passed).toBe(false);
  });

  it('does not evict a key that is still inside its window', () => {
    vi.useFakeTimers();
    const mw = rateLimiter({ windowMs: 60_000, limit: 1 });
    expect(call(mw, 'keep-me').passed).toBe(true);
    // Push the map past the sweep threshold while 'keep-me' is still live.
    for (let i = 0; i < 100; i++) call(mw, `ip-${i}`);
    expect(call(mw, 'keep-me').passed).toBe(false);
  });
});
