import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { Express, RequestHandler } from 'express';
import { buildGatherArgs, buildNoteArgs, childEnv, degradedSections, mountSupportGather, noteExitToHttp } from './support-gather.js';

const ASK = '/skills/bb-support/scripts/ask.mjs';
const KEY = '/keys/abc.json';

describe('buildGatherArgs', () => {
  it('puts the script first and the question as one arg (no shell tokenisation)', () => {
    const args = buildGatherArgs(ASK, { question: 'how does live transcoding work' }, KEY);
    expect(args[0]).toBe(ASK);
    // The question is LAST, immediately after the `--` end-of-options sentinel.
    expect(args.at(-2)).toBe('--');
    expect(args.at(-1)).toBe('how does live transcoding work');
    // spawn uses an args array with shell:false, so a multi-word question must
    // stay a single element — splitting it would make ask.mjs treat each word as
    // a positional token (harmless today, but it also swallows anything that
    // looks like a flag).
    expect(args.filter((a) => a === 'how')).toHaveLength(0);
  });

  it('always passes the per-request key file (PII isolation)', () => {
    const args = buildGatherArgs(ASK, { question: 'q' }, KEY);
    expect(args).toContain('--key-file');
    expect(args[args.indexOf('--key-file') + 1]).toBe(KEY);
  });

  it('emits no source flags when every source is defaulted', () => {
    const args = buildGatherArgs(ASK, { question: 'q' }, KEY);
    expect(args).toEqual([ASK, '--key-file', KEY, '--no-remote', '--', 'q']);
  });

  it('emits --no-* only for an explicit false, not for undefined', () => {
    const args = buildGatherArgs(ASK, { question: 'q', hubspot: false, kb: true, ado: undefined }, KEY);
    expect(args).toContain('--no-hubspot');
    expect(args).not.toContain('--no-kb');
    expect(args).not.toContain('--no-ado');
  });

  it('NEVER emits --no-scrub, whatever the client sends', () => {
    // --no-scrub swaps ask.mjs's redactor for a no-op, so the response would carry
    // raw HubSpot subjects/bodies — names, emails, phone numbers — back to the
    // caller. Strictly more than /reveal can yield (that only decodes names), and
    // in open mode /gather answers unauthenticated LAN requests.
    for (const scrub of [false, true, 'false', 0, null]) {
      const args = buildGatherArgs(ASK, { question: 'q', scrub } as never, KEY);
      expect(args).not.toContain('--no-scrub');
      expect(args).not.toContain('--scrub');
    }
  });

  it('forces --no-remote so a spawned ask.mjs cannot call back out', () => {
    // childEnv only clears process.env; resolveRemote also reads ~/.env, which is
    // exactly where the docs tell people to put BB_SUPPORT_REMOTE. This flag is
    // what actually breaks the proxy loop.
    expect(buildGatherArgs(ASK, { question: 'q' }, KEY)).toContain('--no-remote');
  });

  it('puts a flag-shaped question after `--` so it cannot be parsed as a flag', () => {
    // Verified against ask.mjs's parseArgs: {"question":"--code"} used to consume
    // the following `--key-file` path, leaving args.keyFile undefined so
    // resolveKeyFile wiped the HOST OPERATOR's own default key file.
    // {"question":"--remote"} flipped the host's run into remote mode;
    // {"question":"--no-scrub"} disabled the redactor. All unauthenticated in open mode.
    for (const question of ['--code', '--remote', '--no-scrub', '--key-file', '--top', '-x']) {
      const args = buildGatherArgs(ASK, { question }, KEY);
      const sep = args.indexOf('--');
      expect(sep).toBeGreaterThan(-1);
      // The question sits strictly after the sentinel...
      expect(args.slice(sep + 1)).toEqual([question]);
      // ...and the key file is still bound before it, not swallowed as its value.
      expect(args.slice(0, sep)).toContain('--key-file');
      expect(args[args.indexOf('--key-file') + 1]).toBe(KEY);
    }
  });

  it('keeps `note` tri-state: undefined emits neither flag', () => {
    // ask.mjs treats "absent" as "decide from context" and only prints a
    // `# note-intent:` line when a flag was passed. Emitting --no-note for an
    // undefined value would silently forbid the note-offer flow.
    const none = buildGatherArgs(ASK, { question: 'q' }, KEY);
    expect(none).not.toContain('--note');
    expect(none).not.toContain('--no-note');
    expect(buildGatherArgs(ASK, { question: 'q', note: true }, KEY)).toContain('--note');
    expect(buildGatherArgs(ASK, { question: 'q', note: false }, KEY)).toContain('--no-note');
  });

  it('never emits --code — the host\'s repos are not the caller\'s', () => {
    // The client greps its own checkout and splices CODE in. If this ever passed
    // --code through, a remote caller would silently get grep hits from files on
    // a different machine, attributed to their own repo.
    const args = buildGatherArgs(ASK, { question: 'q', code: 'ovp6' } as never, KEY);
    expect(args).not.toContain('--code');
    expect(args).not.toContain('ovp6');
  });

  it('clamps --top into 1..20 rather than rejecting', () => {
    const at = (b: object) => {
      const a = buildGatherArgs(ASK, { question: 'q', ...b }, KEY);
      const i = a.indexOf('--top');
      return i === -1 ? null : a[i + 1];
    };
    expect(at({ top: 10 })).toBe('10');
    expect(at({ top: 500 })).toBe('20');
    expect(at({ top: 0 })).toBe('1');
    expect(at({ top: -5 })).toBe('1');
    expect(at({ top: 7.9 })).toBe('7');
    expect(at({ top: '12' })).toBe('12');
  });

  it('omits --top for a non-numeric value instead of passing NaN', () => {
    // ask.mjs's parseInt fallback would turn NaN into its default anyway, but
    // passing the literal string "NaN" makes the child's argv misleading in logs.
    const args = buildGatherArgs(ASK, { question: 'q', top: 'lots' }, KEY);
    expect(args).not.toContain('--top');
  });
});

describe('childEnv', () => {
  it('strips BB_SUPPORT_REMOTE and BB_SUPPORT_TOKEN', () => {
    // This is the loop-breaker. If the host's environment names a remote,
    // the ask.mjs we spawn would resolve remote mode and POST to /gather —
    // possibly right back here — and every hop bills someone.
    const env = childEnv({
      PATH: '/usr/bin',
      BB_SUPPORT_REMOTE: 'http://vindell:3011',
      BB_SUPPORT_TOKEN: 'secret',
    });
    expect(env.BB_SUPPORT_REMOTE).toBeUndefined();
    expect(env.BB_SUPPORT_TOKEN).toBeUndefined();
    expect('BB_SUPPORT_REMOTE' in env).toBe(false);
    expect(env.PATH).toBe('/usr/bin');
  });

  it('does not mutate the env it was handed', () => {
    const parent = { BB_SUPPORT_REMOTE: 'http://vindell:3011' };
    childEnv(parent);
    expect(parent.BB_SUPPORT_REMOTE).toBe('http://vindell:3011');
  });

  it('keeps the rest of the environment (claude/git resolution depends on PATH)', () => {
    const env = childEnv({ PATH: '/a:/b', HOME: '/home/x', ADO_PAT: 'pat' });
    expect(env).toEqual({ PATH: '/a:/b', HOME: '/home/x', ADO_PAT: 'pat' });
  });
});

describe('noteExitToHttp', () => {
  it('maps 0 to 200', () => {
    expect(noteExitToHttp(0)).toEqual({ status: 200, error: '' });
  });

  it('maps "note already exists" (3) to 409, not 500', () => {
    // The caller asked for a finding to be on record and one is. 409 + the
    // update hint lets the client recover; a 500 would read as "broken".
    const r = noteExitToHttp(3);
    expect(r.status).toBe(409);
    expect(r.error).toMatch(/update:true/);
  });

  it('maps the inconclusive dedup check (4) to 409', () => {
    expect(noteExitToHttp(4).status).toBe(409);
  });

  it('maps bad input (2) to 400 and a HubSpot rejection (5) to 502', () => {
    expect(noteExitToHttp(2).status).toBe(400);
    expect(noteExitToHttp(5).status).toBe(502);
    // The 403-means-missing-timeline-scope hint is the single most common cause
    // and is otherwise invisible to a remote caller.
    expect(noteExitToHttp(5).error).toMatch(/timeline/);
  });

  it('maps an unknown code and a null (killed) exit to 500', () => {
    expect(noteExitToHttp(99).status).toBe(500);
    expect(noteExitToHttp(null).status).toBe(500);
    expect(noteExitToHttp(null).error).toMatch(/null/);
  });

  it('never reports success for a non-zero code', () => {
    for (const code of [1, 2, 3, 4, 5, 6, 99, null]) {
      expect(noteExitToHttp(code).status).not.toBe(200);
    }
  });
});

describe('buildNoteArgs', () => {
  const NOTE = '/skills/bb-support/scripts/note.mjs';
  const KEYS = '/keys';
  const build = (opts: Parameters<typeof buildNoteArgs>[3]) =>
    buildNoteArgs(NOTE, '123', '/tmp/body.html', opts, KEYS);

  it('passes the ticket id and body file', () => {
    expect(build({})).toEqual([NOTE, '--ticket', '123', '--body-file', '/tmp/body.html']);
  });

  it('defaults to NEITHER --update nor --force (note.mjs refuses with exit 3)', () => {
    // Defaulting to --update would silently make every direct API caller
    // overwrite an existing investigation note instead of refusing — a
    // behaviour change invisible from the request.
    const args = build({});
    expect(args).not.toContain('--update');
    expect(args).not.toContain('--force');
  });

  it('keeps --force and --update distinct', () => {
    // force APPENDS another note, update REPLACES the existing one. Collapsing
    // one into the other does something other than what was asked, on a live
    // customer ticket.
    expect(build({ update: true })).toContain('--update');
    expect(build({ update: true })).not.toContain('--force');
    expect(build({ force: true })).toContain('--force');
    expect(build({ force: true })).not.toContain('--update');
  });

  it('lets --force win when both are set (matches note.mjs, where force skips the lookup)', () => {
    const args = build({ update: true, force: true });
    expect(args).toContain('--force');
    expect(args).not.toContain('--update');
  });

  it('ignores non-true values rather than treating them as truthy', () => {
    for (const v of ['true', 1, {}, [], 'yes']) {
      const args = build({ update: v, force: v });
      expect(args).not.toContain('--update');
      expect(args).not.toContain('--force');
    }
  });

  it('resolves keyId under the keys dir with a .json suffix', () => {
    const args = build({ keyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    expect(args).toContain('--key-file');
    expect(args[args.indexOf('--key-file') + 1])
      .toBe(join(KEYS, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json'));
  });

  it('omits --key-file entirely when no keyId was supplied', () => {
    // A query that redacted nothing has no mapping; passing a bogus path would
    // make note.mjs warn about an unreadable key file on every such post.
    expect(build({})).not.toContain('--key-file');
    expect(build({ keyId: undefined })).not.toContain('--key-file');
  });
});

describe('mountSupportGather route wiring', () => {
  // The auth split is the whole security property of anonymous LAN mode: /gather
  // may go anonymous, /note must not. Nothing else asserts which handler landed
  // on which path, and swapping them would leave every other test passing.
  function mount() {
    const routes = new Map<string, RequestHandler[]>();
    const app = {
      post: (path: string, ...handlers: RequestHandler[]) => { routes.set(path, handlers); },
    } as unknown as Express;

    const auth: RequestHandler = (_q, _s, next) => next();
    const writeAuth: RequestHandler = (_q, _s, next) => next();
    mountSupportGather(app, { auth, writeAuth, audit: () => {} });
    return { routes, auth, writeAuth };
  }

  it('gates /gather with the shared auth handler', () => {
    const { routes, auth } = mount();
    expect(routes.get('/api/support/gather')?.[0]).toBe(auth);
  });

  it('gates /note with writeAuth, not the shared auth handler', () => {
    const { routes, auth, writeAuth } = mount();
    expect(routes.get('/api/support/note')?.[0]).toBe(writeAuth);
    expect(routes.get('/api/support/note')?.[0]).not.toBe(auth);
  });
});

describe('buildGatherArgs --top narrowing', () => {
  // Number(null) === 0 clamps to 1, so a `!== undefined` guard would turn the
  // natural JSON encoding of "unset" into a one-hit-per-source gather and the
  // client's Claude would answer "we have almost no history on this".
  it('ignores non-numeric values that Number() would otherwise make finite', () => {
    // Each of these is finite after Number() — null/''/[] → 0 → clamped to 1,
    // true → 1 — so a `!== undefined` guard would turn "unset" into "--top 1".
    for (const v of [null, '', '   ', [], true, false]) {
      expect(buildGatherArgs(ASK, { question: 'q', top: v as never }, KEY)).not.toContain('--top');
    }
  });

  it('still accepts numeric strings, so existing clients are unaffected', () => {
    const args = buildGatherArgs(ASK, { question: 'q', top: '12' }, KEY);
    expect(args[args.indexOf('--top') + 1]).toBe('12');
  });
});

describe('degradedSections', () => {
  // ask.mjs exits 0 for a hard source failure, so the only signal is in-band.
  it('reports a section whose source failed outright', () => {
    const out = [
      '# section: HUBSPOT_TICKETS',
      '# note: error: HTTP 401 from HubSpot',
      '',
      '# section: KB',
      '{"title":"x"}',
      '',
    ].join('\n');
    expect(degradedSections(out)).toEqual([{ section: 'HUBSPOT_TICKETS', error: 'HTTP 401 from HubSpot' }]);
  });

  it('does not treat a disabled source as degraded', () => {
    // `skipped:` means the caller turned the source off — a legitimate empty.
    const out = '# section: ADO_WORKITEMS\n# note: skipped: --no-ado\n\n';
    expect(degradedSections(out)).toEqual([]);
  });

  it('returns nothing for a clean gather', () => {
    expect(degradedSections('# section: KB\n{"title":"x"}\n\n')).toEqual([]);
  });
});
