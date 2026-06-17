// Shared filesystem locations + dynamic-import helpers for the bb-support /
// HubSpot integration. Single source of truth so support.ts (Q&A endpoints),
// hubspot.ts (ticket-inbox endpoints) and hubspot-poller.ts (auto-investigate)
// agree on where tokens / keys / results / dedup state live, and where to
// import the bb-skills .mjs libraries from.
//
// The bb-skills .mjs are imported dynamically (pathToFileURL keeps Windows /
// MSYS paths un-mangled) so orch's TypeScript build never statically depends
// on bb-skills being present at compile time.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Defaults match the standalone bb-support-web deployment so existing
// tokens.json / audit.jsonl / results keep working across host switches.
export const DATA_DIR = process.env.BB_SUPPORT_DATA_DIR || join(homedir(), '.claude', 'bb-support-web');
export const RESULTS_DIR = join(DATA_DIR, 'results');

// First candidate that exists on disk, else the last (so error messages point
// at the canonical location).
function firstExisting(...candidates: string[]): string {
  for (const c of candidates) { if (existsSync(c)) return c; }
  return candidates[candidates.length - 1];
}

// bb-support/scripts holds run-support.mjs, reveal.mjs, hubspot.mjs.
// Prefer BB_SUPPORT_SCRIPTS_DIR, then a sibling-of-orch checkout (deploy
// layout), then the developer's ~/bb-skills worktree / ~/.claude/skills symlink.
export const SCRIPTS_DIR = process.env.BB_SUPPORT_SCRIPTS_DIR || firstExisting(
  resolvePath(__dirname, '..', '..', '..', 'bb-skills', 'bb-support', 'scripts'),
  join(homedir(), 'bb-skills', 'bb-support', 'scripts'),
  join(homedir(), '.claude', 'skills', 'bb-support', 'scripts'),
);

// hubspot-creds.mjs lives in _shared, a sibling of bb-support. Resolve it the
// same way so it tracks whichever bb-skills root SCRIPTS_DIR landed on.
const SHARED_DIR = firstExisting(
  resolvePath(SCRIPTS_DIR, '..', '..', '_shared'),
  join(homedir(), 'bb-skills', '_shared'),
  join(homedir(), '.claude', 'skills', '_shared'),
);
const HUBSPOT_CREDS_PATH = join(SHARED_DIR, 'hubspot-creds.mjs');

// --- hubspot.mjs surface (only the functions orch uses) --------------------
export interface HubspotTicket {
  id: string;
  properties?: Record<string, string | null | undefined>;
}
export interface HubspotEngagement {
  engagement?: { type?: string; timestamp?: number | null; ownerId?: number | null };
  metadata?: { body?: string };
}
export interface HubspotLib {
  listRecentTickets(token: string, limit?: number, extraProps?: string[]): Promise<HubspotTicket[]>;
  searchTicketsByProperty(token: string, propertyName: string, value: string, limit?: number): Promise<HubspotTicket[]>;
  getTicket(token: string, ticketId: string): Promise<HubspotTicket>;
  getTicketEngagements(token: string, ticketId: string): Promise<HubspotEngagement[]>;
  createTicketNote(token: string, ticketId: string, body: string): Promise<unknown>;
  isInvestigationNote(body: string | undefined): boolean;
  buildInvestigationNoteBody(synthesis: string): string;
  stripHtml(s: string): string;
  ticketUrl(hubId: string, ticketId: string): string | null;
}

export interface HubspotCreds {
  token: string | null;
  hubId: string | null;
  source: string | null;
}

let hubspotLibCache: HubspotLib | null = null;
export async function loadHubspot(): Promise<HubspotLib> {
  if (hubspotLibCache) return hubspotLibCache;
  const url = pathToFileURL(join(SCRIPTS_DIR, 'hubspot.mjs')).href;
  const mod = await import(url);
  if (typeof mod.listRecentTickets !== 'function') {
    throw new Error(`hubspot.mjs missing expected exports at ${url}`);
  }
  hubspotLibCache = mod as HubspotLib;
  return hubspotLibCache;
}

type LoadCredsFn = () => HubspotCreds;
let loadCredsCache: LoadCredsFn | null = null;
export async function loadHubspotCreds(): Promise<HubspotCreds> {
  if (!loadCredsCache) {
    const url = pathToFileURL(HUBSPOT_CREDS_PATH).href;
    const mod = await import(url);
    if (typeof mod.loadHubspotCreds !== 'function') {
      throw new Error(`hubspot-creds.mjs missing loadHubspotCreds export at ${url}`);
    }
    loadCredsCache = mod.loadHubspotCreds as LoadCredsFn;
  }
  return loadCredsCache();
}

// --- run-support.mjs surface (shared by support.ts Q&A + the poller) -------
export type RunStage = 'ok' | 'ask' | 'claude' | 'cancelled' | 'spawn';
export type Intent = 'investigate' | 'draft' | 'reply';
export type Format = 'markdown' | 'html';
export type RunSupportFn = (opts: {
  question: string;
  keyFile?: string;
  intent?: Intent;
  format?: Format;
  onChunk: (text: string) => void;
  signal?: AbortSignal;
}) => Promise<{ stage: RunStage; exitCode: number | null; askStderr: string; claudeStderr: string }>;

let runSupportCache: RunSupportFn | null = null;
export async function loadRunSupport(): Promise<RunSupportFn> {
  if (runSupportCache) return runSupportCache;
  const url = pathToFileURL(join(SCRIPTS_DIR, 'run-support.mjs')).href;
  const mod = await import(url);
  if (typeof mod.runSupportQuery !== 'function') {
    throw new Error(`runSupportQuery export missing from ${url}`);
  }
  runSupportCache = mod.runSupportQuery as RunSupportFn;
  return runSupportCache;
}
