import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backoffMs, startRunner, type Recipe, type RunnerHandle, type RunnerOptions } from './bbcore-runner.js';

vi.mock('./logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

interface Req { method: string; path: string; auth?: string; body: Buffer; json?: any; contentType?: string }

/** A bb-core stand-in: records every request; `handle` decides the reply (default 200 {}). */
function fakeCore(handle: (req: Req) => { status: number; json?: unknown } | undefined) {
  const requests: Req[] = [];
  const server: Server = createServer(async (r: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of r) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const req: Req = { method: r.method!, path: r.url!, auth: r.headers.authorization, body, contentType: r.headers['content-type'] };
    if (req.contentType === 'application/json') req.json = JSON.parse(body.toString());
    requests.push(req);
    const out = handle(req) ?? { status: 200, json: {} };
    res.writeHead(out.status, out.json !== undefined ? { 'content-type': 'application/json' } : {});
    res.end(out.json !== undefined ? JSON.stringify(out.json) : undefined);
  });
  return new Promise<{ url: string; requests: Req[]; close: () => Promise<void> }>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise(r => { server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

const FAST: Partial<RunnerOptions> = {
  heartbeatMs: 60_000,
  claimWaitSec: 0,
  minClaimIntervalMs: 10,
  backoffBaseMs: 10,
  backoffMaxMs: 40,
  minProgressIntervalMs: 0,
  keepaliveMs: 0,
};

function recipe(id: string, run: Recipe['run']): Recipe {
  return { id, description: `${id} recipe`, mode: 'job', input: { type: 'object' }, timeoutMs: 1000, package: 'commercieel', run };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

let runner: RunnerHandle | null = null;
let core: Awaited<ReturnType<typeof fakeCore>> | null = null;
afterEach(async () => {
  await runner?.stop();
  await core?.close();
  runner = null;
  core = null;
});

describe('bb-core runner client', () => {
  it('says hello with its recipes, claims a job, runs it and completes it', async () => {
    let claims = 0;
    core = await fakeCore(req => {
      if (req.path.startsWith('/v1/runner/claim')) {
        return ++claims === 1
          ? { status: 200, json: { job: { id: 'j1', type: 'videoscan', input: { url: 'https://example.nl' }, createdAt: 'x' } } }
          : { status: 204 };
      }
    });
    const settled: string[] = [];
    runner = startRunner({
      ...FAST,
      url: `${core.url}/`,
      key: 'bbr_test',
      version: 'orch/1',
      recipes: [recipe('videoscan', async (input, ctx) => {
        await ctx.progress({ visited: 1 });
        await ctx.artifact('report.html', 'text/html', Buffer.from('<h1>r</h1>'));
        return { scanned: input.url };
      })],
      onJobSettled: id => { settled.push(id); },
    });
    await until(() => settled.length === 1);

    const reqs = core.requests;
    expect(reqs.every(r => r.auth === 'Bearer bbr_test')).toBe(true);
    const hello = reqs.find(r => r.path === '/v1/runner/hello')!;
    expect(hello.json.version).toBe('orch/1');
    expect(hello.json.recipes).toEqual([{ id: 'videoscan', description: 'videoscan recipe', mode: 'job', input: { type: 'object' }, timeoutMs: 1000, package: 'commercieel' }]);
    expect(reqs.find(r => r.path.startsWith('/v1/runner/claim'))!.path).toBe('/v1/runner/claim?wait=0');
    expect(reqs.find(r => r.path === '/v1/runner/jobs/j1/progress')!.json).toEqual({ progress: { visited: 1 } });
    const art = reqs.find(r => r.path.startsWith('/v1/runner/jobs/j1/artifact'))!;
    expect(art.method).toBe('PUT');
    expect(art.path).toBe('/v1/runner/jobs/j1/artifact?name=report.html');
    expect(art.contentType).toBe('text/html');
    expect(art.body.toString()).toBe('<h1>r</h1>');
    expect(reqs.find(r => r.path === '/v1/runner/jobs/j1/complete')!.json).toEqual({ result: { scanned: 'https://example.nl' } });
    expect(settled).toEqual(['j1']);
    expect(runner.state()).toMatchObject({ connected: true, activeJobs: [] });
  });

  it('reports a failing recipe, and an unknown job type, as an error', async () => {
    const queue = [
      { id: 'j1', type: 'videoscan', input: {} },
      { id: 'j2', type: 'nope', input: {} },
    ];
    core = await fakeCore(req => {
      if (req.path.startsWith('/v1/runner/claim')) {
        const job = queue.shift();
        return job ? { status: 200, json: { job } } : { status: 204 };
      }
    });
    runner = startRunner({ ...FAST, url: core.url, key: 'k', version: 'v', recipes: [recipe('videoscan', async () => { throw new Error('boom'); })] });
    await until(() => core!.requests.filter(r => r.path.endsWith('/complete')).length === 2);
    const completes = Object.fromEntries(core.requests.filter(r => r.path.endsWith('/complete')).map(r => [r.path, r.json]));
    expect(completes['/v1/runner/jobs/j1/complete']).toEqual({ error: 'boom' });
    expect(completes['/v1/runner/jobs/j2/complete']).toEqual({ error: 'This runner has no recipe "nope"' });
  });

  it('aborts the job with cancelRequested when progress answers cancel', async () => {
    let claimed = false;
    core = await fakeCore(req => {
      if (req.path.startsWith('/v1/runner/claim')) {
        if (claimed) return { status: 204 };
        claimed = true;
        return { status: 200, json: { job: { id: 'j1', type: 'videoscan', input: {} } } };
      }
      if (req.path.endsWith('/progress')) return { status: 200, json: { cancel: true } };
    });
    let sawCancel: boolean | undefined;
    runner = startRunner({
      ...FAST, url: core.url, key: 'k', version: 'v',
      recipes: [recipe('videoscan', async (_input, ctx) => {
        const cancel = await ctx.progress({ n: 1 });
        sawCancel = cancel && ctx.signal.aborted && ctx.cancelRequested;
        throw new Error('Cancelled');
      })],
    });
    await until(() => core!.requests.some(r => r.path.endsWith('/complete')));
    expect(sawCancel).toBe(true);
    expect(core.requests.find(r => r.path.endsWith('/complete'))!.json).toEqual({ error: 'Cancelled' });
  });

  it('stops reporting a job bb-core no longer holds, without asking to cancel the work', async () => {
    let claimed = false;
    core = await fakeCore(req => {
      if (req.path.startsWith('/v1/runner/claim')) {
        if (claimed) return { status: 204 };
        claimed = true;
        return { status: 200, json: { job: { id: 'j1', type: 'videoscan', input: {} } } };
      }
      if (req.path.endsWith('/progress')) return { status: 409, json: { error: 'not running' } };
    });
    const settled: string[] = [];
    let state: { aborted: boolean; cancel: boolean } | undefined;
    runner = startRunner({
      ...FAST, url: core.url, key: 'k', version: 'v',
      recipes: [recipe('videoscan', async (_input, ctx) => {
        await ctx.progress({ n: 1 });
        state = { aborted: ctx.signal.aborted, cancel: ctx.cancelRequested };
        throw new Error('stopped reporting');
      })],
      onJobSettled: id => { settled.push(id); },
    });
    await until(() => settled.length === 1);
    expect(state).toEqual({ aborted: true, cancel: false });
    expect(core.requests.some(r => r.path.endsWith('/complete'))).toBe(false);
  });

  it('throttles progress: an unchanged value within the keepalive is not posted', async () => {
    let claimed = false;
    core = await fakeCore(req => {
      if (req.path.startsWith('/v1/runner/claim')) {
        if (claimed) return { status: 204 };
        claimed = true;
        return { status: 200, json: { job: { id: 'j1', type: 'videoscan', input: {} } } };
      }
    });
    runner = startRunner({
      ...FAST, minProgressIntervalMs: 0, keepaliveMs: 60_000, url: core.url, key: 'k', version: 'v',
      recipes: [recipe('videoscan', async (_input, ctx) => {
        await ctx.progress({ n: 1 });
        await ctx.progress({ n: 1 });
        await ctx.progress({ n: 2 });
        return {};
      })],
    });
    await until(() => core!.requests.some(r => r.path.endsWith('/complete')));
    expect(core.requests.filter(r => r.path.endsWith('/progress')).map(r => r.json.progress)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('backs off while bb-core is unreachable or refuses the key, then connects', async () => {
    let hellos = 0;
    core = await fakeCore(req => {
      if (req.path === '/v1/runner/hello') return ++hellos <= 3 ? { status: 503, json: { error: 'down' } } : undefined;
      if (req.path.startsWith('/v1/runner/claim')) return { status: 204 };
    });
    runner = startRunner({ ...FAST, url: core.url, key: 'k', version: 'v', recipes: [] });
    await until(() => runner!.state().connected);
    expect(hellos).toBe(4);
    // No claim before a hello went through
    await until(() => core!.requests.some(r => r.path.startsWith('/v1/runner/claim')));
    const firstClaim = core.requests.findIndex(r => r.path.startsWith('/v1/runner/claim'));
    expect(core.requests.slice(0, firstClaim).filter(r => r.path === '/v1/runner/hello')).toHaveLength(4);
  });

  it('re-hellos after a failing claim', async () => {
    let claims = 0;
    core = await fakeCore(req => {
      if (req.path.startsWith('/v1/runner/claim')) return ++claims === 1 ? { status: 500 } : { status: 204 };
    });
    runner = startRunner({ ...FAST, url: core.url, key: 'k', version: 'v', recipes: [] });
    await until(() => claims >= 2 && runner!.state().connected);
    expect(core.requests.filter(r => r.path === '/v1/runner/hello')).toHaveLength(2);
  });

  it('reattaches recovered jobs once connected', async () => {
    core = await fakeCore(req => (req.path.startsWith('/v1/runner/claim') ? { status: 204 } : undefined));
    runner = startRunner({
      ...FAST, url: core.url, key: 'k', version: 'v', recipes: [],
      recover: async () => [{ job: { id: 'old', type: 'videoscan', input: {} }, run: async () => ({ resumed: true }) }],
    });
    await until(() => core!.requests.some(r => r.path === '/v1/runner/jobs/old/complete'));
    expect(core.requests.find(r => r.path === '/v1/runner/jobs/old/complete')!.json).toEqual({ result: { resumed: true } });
  });

  it('holds back claims while maxJobs jobs run', async () => {
    let n = 0;
    core = await fakeCore(req => {
      if (req.path.startsWith('/v1/runner/claim')) return { status: 200, json: { job: { id: `j${++n}`, type: 'videoscan', input: {} } } };
    });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    runner = startRunner({ ...FAST, maxJobs: 1, url: core.url, key: 'k', version: 'v', recipes: [recipe('videoscan', async () => { await gate; return {}; })] });
    await until(() => n === 1);
    await new Promise(r => setTimeout(r, 50));
    expect(n).toBe(1);
    release();
    await until(() => n >= 2);
  });

  it('keeps saying hello while every slot is busy, also after a failed hello', async () => {
    let hellos = 0;
    let claimed = false;
    core = await fakeCore(req => {
      if (req.path === '/v1/runner/hello') return ++hellos === 2 ? { status: 502 } : undefined;
      if (req.path.startsWith('/v1/runner/claim')) {
        if (claimed) return { status: 204 };
        claimed = true;
        return { status: 200, json: { job: { id: 'j1', type: 'videoscan', input: {} } } };
      }
    });
    runner = startRunner({
      ...FAST, heartbeatMs: 20, maxJobs: 1, url: core.url, key: 'k', version: 'v',
      recipes: [recipe('videoscan', async (_input, ctx) => { await new Promise(r => ctx.signal.addEventListener('abort', r)); return {}; })],
    });
    await until(() => hellos >= 5);
    expect(runner.state().connected).toBe(true);
  });

  it('replaces a result bb-core refuses with an error', async () => {
    let claimed = false;
    core = await fakeCore(req => {
      if (req.path.startsWith('/v1/runner/claim')) {
        if (claimed) return { status: 204 };
        claimed = true;
        return { status: 200, json: { job: { id: 'j1', type: 'videoscan', input: {} } } };
      }
      if (req.path.endsWith('/complete') && 'result' in req.json) return { status: 413, json: { error: 'too large' } };
    });
    const settled: string[] = [];
    runner = startRunner({ ...FAST, url: core.url, key: 'k', version: 'v', recipes: [recipe('videoscan', async () => ({ big: true }))], onJobSettled: id => { settled.push(id); } });
    await until(() => settled.length === 1);
    expect(core.requests.filter(r => r.path.endsWith('/complete')).map(r => r.json)).toEqual([
      { result: { big: true } },
      { error: "bb-core refused the runner's result (HTTP 413)" },
    ]);
  });

  it('gives up delivering an outcome after its retries, leaving the job unsettled', async () => {
    let claimed = false;
    core = await fakeCore(req => {
      if (req.path.startsWith('/v1/runner/claim')) {
        if (claimed) return { status: 204 };
        claimed = true;
        return { status: 200, json: { job: { id: 'j1', type: 'videoscan', input: {} } } };
      }
      if (req.path.endsWith('/complete')) return { status: 503 };
    });
    const settled: string[] = [];
    runner = startRunner({ ...FAST, backoffBaseMs: 1, backoffMaxMs: 2, url: core.url, key: 'k', version: 'v', recipes: [recipe('videoscan', async () => ({}))], onJobSettled: id => { settled.push(id); } });
    await until(() => runner!.state().activeJobs.length === 0 && core!.requests.some(r => r.path.endsWith('/complete')));
    expect(core.requests.filter(r => r.path.endsWith('/complete'))).toHaveLength(14);
    expect(settled).toEqual([]);
  });

  it('keeps a running job unreported when the runner stops', async () => {
    let claimed = false;
    core = await fakeCore(req => {
      if (req.path.startsWith('/v1/runner/claim')) {
        if (claimed) return { status: 204 };
        claimed = true;
        return { status: 200, json: { job: { id: 'j1', type: 'videoscan', input: {} } } };
      }
    });
    let started = false;
    runner = startRunner({
      ...FAST, url: core.url, key: 'k', version: 'v',
      recipes: [recipe('videoscan', async (_input, ctx) => {
        started = true;
        await new Promise(r => ctx.signal.addEventListener('abort', r));
        throw new Error('stopped');
      })],
    });
    await until(() => started);
    await runner.stop();
    runner = null;
    expect(core.requests.some(r => r.path.endsWith('/complete'))).toBe(false);
  });
});

describe('backoffMs', () => {
  it('doubles up to the cap', () => {
    expect([1, 2, 3, 4, 5, 10].map(n => backoffMs(n, 1000, 8000))).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });
});
