// Hand-rolled sliding-window rate limiter, extracted from support.ts so
// support-gather.ts can hold its own buckets without importing support.ts
// (which imports support-gather.ts to mount it — that would be circular).
//
// Each (keyFn, limiter) pair owns an independent bucket map. Endpoints with
// wildly different costs must NOT share one: /ask spawns Claude, /gather only
// spawns ask.mjs, /reveal is a file read. A shared budget would let the cheap
// call starve the expensive one or vice versa.

import type { NextFunction, Request, Response } from 'express';

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
      res.status(429).json({ error: 'rate limit exceeded — try again later' });
      return;
    }
    hits.push(now);
    buckets.set(key, hits);
    next();
  };
}
