import type { Request, Response, NextFunction } from 'express';
import { createLogger } from './logger.js';

const log = createLogger('error-handler');

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export function expressErrorMiddleware(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  log.error(err.message, err);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error' });
  }
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
