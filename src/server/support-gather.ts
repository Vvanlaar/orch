// /api/support/gather + /api/support/note — the "route it through the host"
// half of bb-support.
//
// WHY THIS EXISTS. bb-support's ask.mjs needs three things a teammate's laptop
// usually lacks: a HubSpot legacy private-app token, an ADO_PAT, and a built
// ~/.claude/bb-knowledge/index.json. /api/support/ask solves that for *browser*
// users by also running the `claude -p` synthesis here — but that spends THIS
// host's Claude subscription and gives the caller no way to fold in their own
// repo context.
//
// /gather splits the pipeline instead: the host does the credential-gated
// gather and returns ask.mjs's raw NDJSON sections; the caller's own Claude Code
// does the synthesis on its own quota. `ask.mjs --remote` is the client.
//
// /note is the write-back leg. Posting an investigation note needs the HubSpot
// token *plus* the legacy `timeline` scope, so a remote caller can't do it —
// without this endpoint remote mode could investigate a ticket but never record
// the finding on it.
//
// Both mount from mountSupport() and share the /api/support security headers,
// but NOT the same auth. /gather takes `auth` (support scope, or anonymous when
// BB_SUPPORT_ALLOW_ANONYMOUS=1); /note takes `writeAuth`, which is bearer auth
// unconditionally — it writes to a live customer's ticket under the host's
// HubSpot token, so it stays attributable even when the LAN is the boundary.

import type { Express, RequestHandler } from 'express';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { asyncHandler } from '../core/error-handler.js';
import { createLogger } from '../core/logger.js';
import { KEYS_DIR, SCRIPTS_DIR } from '../core/support-paths.js';
import { rateLimiter } from './rate-limit.js';
// Type-only, so this erases at compile time and creates no runtime cycle with
// support.ts (which imports mountSupportGather from here). Keep it that way —
// a value import in this direction would be a real cycle.
import type { AuthedRequest, NoteAuditEntry } from './support.js';

const log = createLogger('support-gather');

// ask.mjs fans out to HubSpot search + ADO WIQL + a KB index read. 60s is
// generous for the slow path (a broad query on a cold HubSpot connection) and
// still well inside any sane client timeout.
const GATHER_TIMEOUT_MS = 60_000;
// note.mjs does at most a list-engagements + a POST/PATCH.
const NOTE_TIMEOUT_MS = 30_000;
// A runaway --top would otherwise let one request pin unbounded RSS while we
// buffer stdout to build the JSON response. Deliberately looser than support.ts's
// CHUNK_BUFFER_CAP_BYTES (1 MB): that one bounds an *unattached SSE* backlog,
// this one bounds a single in-flight response body.
const OUTPUT_CAP_BYTES = 2_000_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `scrub` is typed `never`, not merely absent — see buildGatherArgs. A client
// must never be able to switch off the host's PII redaction, and `never`
// keeps that visible in the type (an `if (body.scrub)` becomes a statically
// flagged always-false expression) instead of relying on omission alone,
// which a later edit could silently reintroduce.
export type GatherRequest = {
  question?: unknown;
  top?: unknown;
  hubspot?: unknown;
  kb?: unknown;
  ado?: unknown;
  note?: unknown;
  scrub?: never;
};

// --- pure helpers (unit-tested; see support-gather.test.ts) -----------------

// Build ask.mjs's argv. Deliberately has NO `--code` path: `--code <repo>` greps
// $REPOS_BASE_DIR on whichever machine runs it, and the host's checkouts are not
// the caller's. The client greps its own repo and splices the CODE section in.
export function buildGatherArgs(
  askScript: string,
  body: GatherRequest,
  keyFile: string,
): string[] {
  const args = [askScript];

  // Clamp rather than reject: `top` is a relevance knob, not a correctness one,
  // and a client sending 500 deserves 20 hits, not a 400.
  //
  // Accept a number or a numeric string, and NOTHING else. A bare
  // `!== undefined` + Number() would take null, '', [], true and false as 0 or 1
  // — so a client that serialises an unset field as null silently asks for one
  // hit per source instead of ask.mjs's default of 5, and its Claude concludes
  // "we have almost no history on this" from a gather that was never run wide.
  const rawTop = body.top;
  const top = typeof rawTop === 'number' ? rawTop
    : typeof rawTop === 'string' && rawTop.trim() !== '' ? Number(rawTop)
    : NaN;
  if (Number.isFinite(top)) {
    args.push('--top', String(Math.max(1, Math.min(Math.floor(top), 20))));
  }

  // Each source defaults ON in ask.mjs, so only an explicit `false` emits a flag.
  if (body.hubspot === false) args.push('--no-hubspot');
  if (body.kb === false) args.push('--no-kb');
  if (body.ado === false) args.push('--no-ado');

  // NOTE deliberately no `scrub` passthrough. `--no-scrub` swaps ask.mjs's
  // redactor for a no-op, so the response would carry raw HubSpot subjects and
  // bodies — customer names, emails, phone numbers — straight back to the caller.
  // That is strictly more than /reveal can ever yield (it only decodes *names*;
  // emails and phones get uniform placeholders with no mapping at all), and in
  // open mode /gather takes unauthenticated LAN requests. --no-scrub stays a local
  // debugging flag; it is not a remote capability.

  // Tri-state, mirroring ask.mjs: absent means "decide from context", so an
  // undefined `note` must emit neither flag.
  if (body.note === true) args.push('--note');
  else if (body.note === false) args.push('--no-note');

  args.push('--key-file', keyFile);

  // NOT pushing `--no-remote`, even though a spawned ask.mjs that resolves
  // remote mode (via ~/.env or ~/.claude/bb-support/remote.json — childEnv can
  // only clear *process.env*) would call /gather right back out. A prior
  // version of this function pushed it unconditionally, on the assumption that
  // ask.mjs recognises the flag — checked three bb-skills refs and got a 2-1
  // split: nightly and ~/.claude/skills's checkout do, but the SCRIPTS_DIR
  // candidate that actually wins on a plain sibling-of-orch checkout (see
  // support-paths.ts's firstExisting()) does not. On that build, `--no-remote`
  // has no case in parseArgs and falls into positional like any unrecognised
  // token — corrupting args.question with a leading "--no-remote " on every
  // single gather, the identical failure mode the `--` sentinel below was
  // reverted for. Re-add this only once SCRIPTS_DIR is guaranteed to resolve to
  // an ask.mjs build with `--no-remote` support (or once ask.mjs itself rejects
  // unknown flags instead of absorbing them) — childEnv's process.env strip is
  // the sole defence against the proxy loop until then.

  // NOT prefixed with a `--` end-of-options sentinel: ask.mjs's parseArgs has no
  // such handling (checked bb-support/scripts/ask.mjs on the local checkout,
  // nightly, and master — every one falls through `else positional.push(a)` for
  // a literal '--' exactly like an unrecognised flag), so a sentinel here would
  // land in args.question as a stray "-- " prefix on every gather, not just the
  // flag-shaped ones. Splitting flags from the question is instead the route's
  // job: the route rejects any question starting with '-' (support-gather.ts,
  // the `startsWith('-')` check) BEFORE calling this function, and spawn uses
  // shell:false with an args array, so `body.question` always reaches ask.mjs as
  // ONE argv token — it can only equal a flag name if the *entire* string does,
  // which the reject already forecloses. This function trusts that guard.
  args.push(String(body.question));
  return args;
}

// The child env for a host-side ask.mjs / note.mjs run.
//
// BB_SUPPORT_REMOTE and BB_SUPPORT_TOKEN MUST be stripped. If this host ever has
// them set (e.g. someone points it at a second orch, or a stray export lands in
// the service environment), the spawned ask.mjs would resolve remote mode and
// call /gather right back — an infinite proxy loop that each hop pays for.
// Deleting the keys is what makes the recursion structurally impossible rather
// than merely unlikely.
export function childEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...parent };
  delete env.BB_SUPPORT_REMOTE;
  delete env.BB_SUPPORT_TOKEN;
  return env;
}

// Build note.mjs's argv.
//
// --force and --update are DISTINCT and neither is the default: force APPENDS
// another note, update REPLACES the existing one, and passing neither makes
// note.mjs refuse with exit 3 when a note is already there. Defaulting to
// --update here would silently make every direct API caller overwrite rather
// than refuse; collapsing force into update would quietly do something other
// than what the caller asked, on a live customer ticket.
//
// keyId is validated as a UUID by the route before it reaches here, so it cannot
// traverse out of KEYS_DIR.
export function buildNoteArgs(
  noteScript: string,
  ticketId: string,
  bodyFile: string,
  opts: { update?: unknown; force?: unknown; keyId?: string },
  keysDir: string,
): string[] {
  const args = [noteScript, '--ticket', ticketId, '--body-file', bodyFile];
  if (opts.force === true) args.push('--force');
  else if (opts.update === true) args.push('--update');
  if (opts.keyId) {
    // An explicit --key-file bypasses note.mjs's keyFileMatchesTicket guard
    // ("the caller owns that path's lifecycle"). Correct here: this keyfile came
    // from the same /gather run, so its mapping is bound to the very question
    // that produced this body. The guard exists for the shared DEFAULT_KEY_FILE,
    // which every ask.mjs run overwrites.
    args.push('--key-file', join(keysDir, `${opts.keyId}.json`));
  }
  return args;
}

// Find sources that failed outright rather than merely returning nothing.
//
// ask.mjs's emitResult writes `# section: NAME` then, for a hard failure,
// `# note: error: <msg>` and zero hits — and still exits 0. A caller reading
// only the hit count cannot tell "HubSpot is down" from "nothing matched", so
// pull the distinction back out of the stream and report it as structured data.
// `skipped:` is deliberately NOT included: that one means "source disabled",
// which is a legitimate empty, not a failure.
export function degradedSections(stdout: string): { section: string; error: string }[] {
  const out: { section: string; error: string }[] = [];
  let current = '';
  for (const line of stdout.split('\n')) {
    const section = /^# section: (.+)$/.exec(line);
    if (section) { current = section[1].trim(); continue; }
    const err = /^# note: error: (.*)$/.exec(line);
    if (err && current) out.push({ section: current, error: err[1].trim() });
  }
  return out;
}

// note.mjs's documented exit codes → HTTP. 3 (note already exists) is the one
// that isn't really an error: the caller asked to record a finding and a finding
// is on record, so it maps to 409 and the client can retry with update:true.
export function noteExitToHttp(code: number | null): { status: number; error: string } {
  switch (code) {
    case 0: return { status: 200, error: '' };
    case 2: return { status: 400, error: 'note.mjs rejected the input (bad ticket id, or no HubSpot creds on the host)' };
    case 3: return { status: 409, error: 'ticket already has an AI investigation note — retry with update:true to refresh it' };
    case 4: return { status: 409, error: 'could not verify whether a note already exists (engagement pagination cap) — check the ticket by hand' };
    case 5: return { status: 502, error: 'HubSpot rejected the write (a 403 usually means the private app lacks the legacy `timeline` scope)' };
    default: return { status: 500, error: `note.mjs exited ${code ?? 'null'}` };
  }
}

// --- child-process plumbing -------------------------------------------------

// Windows-safe tree kill. Same shape as bb-support/scripts/run-support.mjs:41 —
// proc.kill() on win32 leaves grandchildren (the node wrapper's real process)
// alive, so a timed-out gather would keep hitting HubSpot after we responded.
//
// Returns whether the kill is believed to have landed. spawnSync does NOT throw
// on ENOENT or a non-zero exit — it reports via .error / .status — so a bare
// try/catch silently treats "taskkill isn't on PATH" as success. It isn't:
// the child survives, 'close' never fires, and the caller's promise would hang
// forever. runNode needs the answer to decide whether it can still wait.
export function killTree(pid: number | undefined): boolean {
  if (!pid) return true;
  try {
    if (platform() !== 'win32') {
      process.kill(pid, 'SIGKILL');
      return true;
    }
    const res = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'pipe' });
    if (res.error) {
      log.error(`taskkill could not run (${res.error.message}) — pid ${pid} may still be alive`);
      return false;
    }
    if (res.status !== 0) {
      // 128 = "process not found", i.e. it already exited. Anything else
      // (notably 1, "Access is denied") means it is still running.
      if (res.status === 128) return true;
      log.error(`taskkill exited ${res.status} for pid ${pid}: ${String(res.stderr || '').trim()}`);
      return false;
    }
    return true;
  } catch (err) {
    // ESRCH from process.kill means it's already gone; anything else is a
    // genuine failure to signal.
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
    log.error(`kill failed for pid ${pid}`, err);
    return false;
  }
}

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  orphaned: boolean;
};

function runNode(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Decode across chunk boundaries. A plain per-chunk c.toString() turns any
    // multi-byte character split across a 64KB pipe read into U+FFFD — routine
    // for Dutch ticket subjects and customer names.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let orphaned = false;
    let settled = false;

    const child = spawn(process.argv[0], args, { shell: false, env: childEnv() });

    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout + outDecoder.end(), stderr: stderr + errDecoder.end(), truncated, timedOut, orphaned });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (!killTree(child.pid)) {
        // We could not guarantee the child died, so 'close' may never arrive.
        // Settle now rather than holding the HTTP connection open forever —
        // the documented timeout has to be a real bound, not an advisory one.
        orphaned = true;
        log.error(`gather/note child ${child.pid} outlived its ${timeoutMs}ms budget and could not be killed`);
        settle(null);
      }
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (c: Buffer) => {
      // Sticky truncation: a gap mid-stream would hand the reading Claude a
      // section list with a hole in it, which is worse than a clean cut.
      if (truncated) return;
      const text = outDecoder.write(c);
      if (stdout.length + text.length > OUTPUT_CAP_BYTES) {
        truncated = true;
        // Cut back to the last complete NDJSON record. Dropping the chunk whole
        // (or slicing at the cap) leaves a half-written JSON object as the final
        // line, which the reading client cannot parse.
        const room = OUTPUT_CAP_BYTES - stdout.length;
        const head = text.slice(0, Math.max(0, room));
        const lastNewline = head.lastIndexOf('\n');
        stdout += lastNewline >= 0 ? head.slice(0, lastNewline + 1) : '';
        return;
      }
      stdout += text;
    });
    // stderr carries ask.mjs's `# note:` / creds-source diagnostics, which the
    // remote client relays. Capped hard.
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 16_384) stderr += errDecoder.write(c);
    });

    child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    child.on('close', (code) => settle(code));
  });
}

// --- routes -----------------------------------------------------------------

export function mountSupportGather(
  app: Express,
  opts: { auth: RequestHandler; writeAuth: RequestHandler; audit: (entry: NoteAuditEntry) => void },
): void {
  const { auth, writeAuth, audit } = opts;

  // Its own bucket, deliberately not shared with /ask's 10-per-5-min. /ask
  // spawns Claude (expensive, rate-limited to protect the subscription);
  // /gather only spawns ask.mjs, so it can be looser — but still bounded,
  // because each call fans out to the HubSpot and ADO APIs under the host's PATs.
  const gatherLimiter = rateLimiter({ windowMs: 5 * 60_000, limit: 30 });
  // Writes to live customer tickets. Tighter than /gather on purpose — and
  // token-gated via writeAuth even when /gather is anonymous.
  const noteLimiter = rateLimiter({ windowMs: 5 * 60_000, limit: 10 });

  app.post('/api/support/gather', auth, gatherLimiter, asyncHandler(async (req, res) => {
    const body = (req.body || {}) as GatherRequest;
    if (!body.question || typeof body.question !== 'string') {
      res.status(400).json({ error: 'question required' });
      return;
    }
    // ask.mjs's parseArgs matches flags by exact token at ANY position and has
    // no `--` end-of-options handling, so a flag-shaped question is parsed as a
    // flag and swallows the `--key-file <path>` pair that follows it. The
    // damage is not hypothetical: "--code" leaves keyFile unset, so ask.mjs
    // falls back to the operator's shared ~/.claude/bb-support/.last-ask-key.json
    // — deleting it and rewriting it with THIS request's customer mappings —
    // while "--key-file" makes it a relative path, dropping cleartext PII into
    // the server's cwd where the keyReaper never looks. Prefixing with `--`
    // would not help; parseArgs would fold that into the question. Reject
    // instead, and fix it properly upstream by teaching parseArgs about `--`.
    if (body.question.startsWith('-')) {
      res.status(400).json({ error: 'question must not start with "-"' });
      return;
    }

    const keyId = randomUUID();
    const keyFile = join(KEYS_DIR, `${keyId}.json`);
    try { mkdirSync(KEYS_DIR, { recursive: true }); } catch { /* best effort; ask.mjs also mkdirs */ }

    const args = buildGatherArgs(join(SCRIPTS_DIR, 'ask.mjs'), body, keyFile);

    let result: RunResult;
    try {
      result = await runNode(args, GATHER_TIMEOUT_MS);
    } catch (err) {
      log.error('failed to spawn ask.mjs from ' + SCRIPTS_DIR, err);
      res.status(500).json({ error: 'support library unavailable: ' + (err as Error).message });
      return;
    }

    if (result.timedOut) {
      res.status(504).json({
        error: `gather timed out after ${GATHER_TIMEOUT_MS / 1000}s`,
        ...(result.orphaned ? { orphaned: true } : {}),
        stderr: result.stderr,
      });
      return;
    }
    if (result.code !== 0) {
      // ask.mjs is documented never to throw on a missing source — it degrades to
      // a `# note: skipped:` line. A non-zero exit therefore means something
      // structural (bad args, missing module), so surface stderr rather than
      // handing back a half-empty section list that looks like "no hits".
      res.status(500).json({ error: `ask.mjs exited ${result.code}`, stderr: result.stderr });
      return;
    }

    const tokenName = (req as AuthedRequest).tokenName ?? 'anonymous';
    // A source that failed hard is NOT the same as a source with no hits, but
    // ask.mjs expresses both on stdout and exits 0 either way (emitResult turns
    // {__error} into an empty section plus a `# note: error:` line). Without
    // this, an expired HubSpot token makes every gather return "we have no
    // record of this" forever, logged as success.
    const degraded = degradedSections(result.stdout);
    if (degraded.length > 0) {
      log.warn(`gather degraded for ${tokenName} — ${degraded.map((d) => `${d.section} (${d.error})`).join('; ')}`);
    }
    log.info(`gather ok for ${tokenName} (${result.stdout.length} bytes${result.truncated ? ', TRUNCATED' : ''}${degraded.length ? `, ${degraded.length} DEGRADED` : ''})`);

    // The 30-min keyReaper in support.ts owns keyFile cleanup — same directory,
    // so no extra reaper needed here.
    //
    // keyId only when a key file actually exists: ask.mjs writes one only if the
    // redactor redacted something. Handing back an id for a file that was never
    // written makes /reveal 404 indistinguishably from an expired mapping, and
    // makes /note publish literal [customer:N] placeholders on a live ticket.
    // stderr is deliberately omitted on success. All gather DATA goes to stdout;
    // stderr carries only host-side diagnostics — absolute paths, the
    // `# hubspot creds source:` line, stray node warnings — which under
    // anonymous LAN mode would reach unauthenticated callers. `degraded` above
    // covers the one thing a client genuinely needed stderr for (a source that
    // failed rather than returned nothing), as structured data instead of prose.
    // Error paths still return it: there it is the point. The client guards with
    // `if (stderr && stderr.trim())`, so an absent field is a clean no-op.
    res.json({
      sections: result.stdout,
      keyId: existsSync(keyFile) ? keyId : null,
      truncated: result.truncated,
      degraded,
    });
  }));

  app.post('/api/support/note', writeAuth, noteLimiter, asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    const body = (req.body || {}) as {
      ticketId?: unknown; bodyHtml?: unknown; keyId?: unknown; update?: unknown; force?: unknown;
    };
    const ticketId = String(body.ticketId ?? '');
    if (!/^\d+$/.test(ticketId)) {
      res.status(400).json({ error: 'ticketId must be digits' });
      return;
    }
    if (!body.bodyHtml || typeof body.bodyHtml !== 'string') {
      res.status(400).json({ error: 'bodyHtml required' });
      return;
    }
    // keyId is optional — a caller may post a note that never needed redaction.
    // When present it must be a UUID, so it can't escape KEYS_DIR via traversal.
    if (body.keyId !== undefined && (typeof body.keyId !== 'string' || !UUID_RE.test(body.keyId))) {
      res.status(400).json({ error: 'keyId must be a UUID' });
      return;
    }

    // writeAuth is bearerAuth, so tokenName is always a real name here; the
    // fallback exists only to keep the type honest.
    const tokenName = (req as AuthedRequest).tokenName ?? 'unknown';

    const tmpFile = join(tmpdir(), `orch-note-${randomUUID()}.html`);
    try {
      // 0600: the body is un-redacted customer ticket content, and on Linux
      // /tmp is shared — a default umask would leave it world-readable for the
      // life of the spawn. The name is a fresh UUID so this is always a create,
      // which is the only point `mode` applies. Ignored on Windows, where
      // tmpdir() is already per-user.
      writeFileSync(tmpFile, body.bodyHtml, { encoding: 'utf8', mode: 0o600 });

      const args = buildNoteArgs(
        join(SCRIPTS_DIR, 'note.mjs'),
        ticketId,
        tmpFile,
        { update: body.update, force: body.force, keyId: body.keyId as string | undefined },
        KEYS_DIR,
      );

      // Read the mode off the argv rather than re-deriving it from the body:
      // buildNoteArgs owns the force-beats-update precedence and is tested for
      // it, so a second copy here could drift and make the audit log attest a
      // write mode that never happened — on a live customer ticket.
      const mode = args.includes('--force') ? 'append' : args.includes('--update') ? 'replace' : 'refuse-if-exists';
      const record = (ok: boolean): void => {
        try {
          audit({
            ts: new Date().toISOString(),
            ip: req.ip,
            tokenName,
            status: 'note',
            ticketId,
            mode,
            ok,
            durationMs: Date.now() - startedAt,
          });
        } catch (err) {
          // Never let a failed audit write turn a completed HubSpot post into a
          // 500 — the caller would retry and hit note.mjs's dedup 409. Matches
          // how /ask guards appendAudit.
          log.error('note audit write failed', err);
        }
      };

      let result: RunResult;
      try {
        result = await runNode(args, NOTE_TIMEOUT_MS);
      } catch (err) {
        log.error('failed to spawn note.mjs from ' + SCRIPTS_DIR, err);
        res.status(500).json({ error: 'support library unavailable: ' + (err as Error).message });
        return;
      }

      if (result.timedOut) {
        // The kill can land after note.mjs already POSTed to HubSpot, so the
        // write may have applied. Say so rather than reporting a clean failure —
        // a blind retry would otherwise read note.mjs's dedup 409 as someone
        // else having posted. Audited as not-ok, but the entry pins the ticket.
        record(false);
        res.status(504).json({
          error: `note timed out after ${NOTE_TIMEOUT_MS / 1000}s — the note may still have been posted to ticket ${ticketId}; check before retrying`,
          ticketId,
          ...(result.orphaned ? { orphaned: true } : {}),
          stderr: result.stderr,
        });
        return;
      }

      const mapped = noteExitToHttp(result.code);
      if (mapped.status !== 200) {
        record(false);
        res.status(mapped.status).json({ error: mapped.error, stderr: result.stderr });
        return;
      }
      record(true);
      // note.mjs prints "→ posted note <id> to ticket <n>" / "→ view: <url>".
      // stderr is deliberately omitted on success: it carries host paths and the
      // creds-source diagnostic, the remote client reads only `output`, and under
      // anonymous LAN mode this response reaches unauthenticated callers. Error
      // paths still include it — there it is the point.
      res.json({ ok: true, output: result.stdout.trim() });
    } finally {
      try { rmSync(tmpFile, { force: true }); } catch { /* best effort */ }
    }
  }));

  log.info('/api/support/gather + /api/support/note mounted');
}
