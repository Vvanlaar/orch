import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { expressErrorMiddleware } from './error-handler.js';

// The middleware logs every error; silence it so a passing run stays readable.
vi.mock('./logger.js', () => ({
  createLogger: () => ({ error: () => {}, info: () => {}, warn: () => {}, debug: () => {} }),
}));

function capture(err: Error, headersSent = false) {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    headersSent,
    status: (c: number) => { out.status = c; return res; },
    json: (b: unknown) => { out.body = b; return res; },
  } as unknown as Response;
  expressErrorMiddleware(err, {} as Request, res, () => {});
  return out;
}

// What express.json() actually throws on a bad body — a SyntaxError carrying
// status 400 and type 'entity.parse.failed'.
function bodyParseError(): Error {
  return Object.assign(new SyntaxError('Unexpected token } in JSON at position 4'), {
    status: 400,
    statusCode: 400,
    type: 'entity.parse.failed',
    expose: true,
  });
}

describe('expressErrorMiddleware', () => {
  it('reports a malformed JSON body as 400, not 500', () => {
    // A 500 here sends the caller hunting for a server fault that doesn't
    // exist — the body was their mistake.
    expect(capture(bodyParseError())).toEqual({ status: 400, body: { error: 'invalid JSON body' } });
  });

  it('still reports a genuine server fault as 500', () => {
    expect(capture(new Error('database exploded'))).toEqual({
      status: 500,
      body: { error: 'Internal server error' },
    });
  });

  it('does not treat any old 400 as a parse failure', () => {
    // Some libraries attach a 4xx status to their errors. Only the body
    // parser's own type should downgrade the response.
    const validation = Object.assign(new Error('bad input'), { status: 400 });
    expect(capture(validation).status).toBe(500);
  });

  it('does not treat a parse-typed error with another status as a parse failure', () => {
    const odd = Object.assign(new Error('too large'), { status: 413, type: 'entity.parse.failed' });
    expect(capture(odd).status).toBe(500);
  });

  it('writes nothing once the response has started', () => {
    expect(capture(new Error('late'), true)).toEqual({});
    expect(capture(bodyParseError(), true)).toEqual({});
  });
});
