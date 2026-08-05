// Hand-rolled sliding-window rate limiter, extracted from support.ts so
// support-gather.ts can hold its own buckets without importing support.ts
// (which imports support-gather.ts to mount it — that would be circular).
//
// Each (keyFn, limiter) pair owns an independent bucket map. Endpoints with
// wildly different costs must NOT share one: /ask spawns Claude, /gather only
// spawns ask.mjs, /reveal is a file read. A shared budget would let the cheap
// call starve the expensive one or vice versa.

import type { NextFunction, Request, Response } from 'express';

// Only sweep once the map is big enough to be worth an O(n) pass. Below this a
// LAN's worth of clients fits comfortably and the scan is pure overhead.
const SWEEP_THRESHOLD = 64;

export function rateLimiter(opts: {
  windowMs: number;
  limit: number;
  keyFn?: (req: Request) => string;
}) {
  const buckets = new Map<string, number[]>();
  const { windowMs, limit, keyFn = (req) => req.ip || 'unknown' } = opts;
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = keyFn(req);
    const now = Date.now();
    const cutoff = now - windowMs;
    const hits = (buckets.get(key) || []).filter((t) => t > cutoff);
    if (hits.length >= limit) {
      // Keep the pruned array so the window keeps sliding while the caller is
      // being refused — dropping it here would reset their budget on every 429.
      buckets.set(key, hits);
      res.status(429).json({ error: 'rate limit exceeded — try again later' });
      return;
    }
    hits.push(now);
    buckets.set(key, hits);
    // Sweep other keys that have fully aged out. Without this the map grows one
    // entry per distinct req.ip for the lifetime of the process — expiry is
    // applied to an array's contents on read, never to the key itself, and this
    // is now a long-lived always-on service.
    if (buckets.size > SWEEP_THRESHOLD) {
      for (const [k, v] of buckets) {
        if (k !== key && !v.some((t) => t > cutoff)) buckets.delete(k);
      }
    }
    next();
  };
}
