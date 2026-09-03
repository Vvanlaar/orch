import type { Request, Response, NextFunction } from 'express';
import { createLogger } from './logger.js';

const log = createLogger('error-handler');

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// A body express.json() couldn't parse. It sets status 400 and type
// 'entity.parse.failed' on the error; both are checked because the status is
// the documented contract and the type pins it to the body parser rather than
// any other library that happens to attach a 4xx status.
function isBodyParseError(err: Error): boolean {
  const e = err as Error & { status?: number; statusCode?: number; type?: string };
  return e.type === 'entity.parse.failed' && (e.status ?? e.statusCode) === 400;
}

export function expressErrorMiddleware(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  log.error(err.message, err);
  if (res.headersSent) return;
  // Malformed JSON is the caller's mistake, not ours — reporting 500 sends
  // clients (and anyone reading a probe) hunting for a server fault that
  // doesn't exist.
  if (isBodyParseError(err)) {
    res.status(400).json({ error: 'invalid JSON body' });
    return;
  }
  res.status(500).json({ error: 'Internal server error' });
}

export function installProcessHandlers(): void {
  process.on('uncaughtException', (err) => {
    log.error('Uncaught exception', err);
    setTimeout(() => process.exit(1), 1000);
  });

  process.on('unhandledRejection', (reason) => {
    log.error('Unhandled rejection', reason);
  });
}
