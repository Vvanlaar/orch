// Auto-investigate poller — ported from bb-dashboard scripts/hubspot-poller.mjs.
// Scans HubSpot tickets flagged with the investigate property, runs the
// bb-support investigate flow, and posts the synthesis back as a ticket note.
// A dedup store + per-process marker check prevent double-posting.
//
// Activity is surfaced to the dashboard Support → Inbox status hero via
// getInvestigateSummary(); the client polls it (no WebSocket events needed).

import type { Config } from './types.js';
import { loadHubspot, loadHubspotCreds, loadRunSupport } from './support-paths.js';
import { loadInvestigated, schedulePersist } from './hubspot-investigated-store.js';

// ask.mjs + claude run serially inside runSupportQuery; one deadline suffices.
const INVESTIGATE_TIMEOUT_MS = 7 * 60_000;

async function investigate(url: string): Promise<string> {
  const runSupportQuery = await loadRunSupport();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), INVESTIGATE_TIMEOUT_MS);
  let synthesis = '';
  try {
    const result = await runSupportQuery({
      question: `${url} investigate`,
      intent: 'investigate',
      format: 'html',
      signal: ac.signal,
      onChunk: (c) => { synthesis += c; },
    });
    if (result.stage === 'cancelled') throw new Error(`investigate timed out after ${INVESTIGATE_TIMEOUT_MS / 1000}s`);
    if (result.stage !== 'ok') throw new Error(`${result.stage}: ${(result.claudeStderr || result.askStderr).trim() || '(no detail)'}`);
    const out = synthesis.trim();
    if (!out) throw new Error('claude produced no output');
    return out;
  } finally {
    clearTimeout(timer);
  }
}

const investigated = new Set<string>(loadInvestigated());
const INVESTIGATED_LRU_CAP = 10_000;

// Re-entry guard: a new tick is a no-op while a scan runs.
let scanInFlight: Promise<ScanSummary | undefined> | null = null;
// Per-ticket inflight: a long investigate must not be re-queued from the next tick.
const ticketInFlight = new Set<string>();

type ScanSummary = { scanned: number; investigated: number; skipped: number; errors: number };
type LastScan = ScanSummary & { startedAt: number; finishedAt: number | null; error?: string };

// Recent poller activity, capped so the buffer can't grow unbounded.
const INVESTIGATE_LOG_CAP = 50;
type LogEvent = Record<string, unknown> & { type: string };
const investigateLog: Array<LogEvent & { ts: number }> = [];
let lastScan: LastScan | null = null;

type LogFn = ((event: LogEvent) => void) | undefined;
type BroadcastFn = ((event: string, data: unknown) => void) | undefined;

function record(log: LogFn, event: LogEvent): void {
  investigateLog.push({ ...event, ts: Date.now() });
  if (investigateLog.length > INVESTIGATE_LOG_CAP) investigateLog.shift();
  log?.(event);
}

export function getInvestigateSummary() {
  return {
    lastScan: lastScan ? { ...lastScan } : null,
    inProgress: !!(lastScan && lastScan.startedAt && !lastScan.finishedAt),
    recent: investigateLog.slice().reverse(),
  };
}

export async function runHubspotInvestigateScan(
  config: Config,
  { broadcast, log }: { broadcast?: BroadcastFn; log?: LogFn } = {},
): Promise<ScanSummary | undefined> {
  if (!config.hubspot.autoInvestigate) return;
  if (scanInFlight) {
    record(log, { type: 'hubspot-investigate-scan-skip', reason: 'previous scan still running' });
    return scanInFlight;
  }
  scanInFlight = (async () => {
    try {
      const creds = await loadHubspotCreds();
      if (!creds.token) return;
      const hub = await loadHubspot();
      const propertyName = config.hubspot.investigateProperty;

      lastScan = { startedAt: Date.now(), finishedAt: null, scanned: 0, investigated: 0, skipped: 0, errors: 0 };
      record(log, { type: 'hubspot-investigate-scan-start', property: propertyName });

      let tickets;
      try {
        tickets = await hub.searchTicketsByProperty(creds.token, propertyName, 'true', 50);
      } catch (err) {
        const message = (err as Error).message;
        record(log, { type: 'hubspot-investigate-scan-error', error: message });
        broadcast?.('hubspot-investigate-error', { phase: 'search', property: propertyName, error: message });
        const summary: ScanSummary = { scanned: 0, investigated: 0, skipped: 0, errors: 1 };
        lastScan = { ...lastScan!, ...summary, finishedAt: Date.now() };
        return summary;
      }

      record(log, { type: 'hubspot-investigate-scan-found', count: tickets.length });

      const summary: ScanSummary = { scanned: tickets.length, investigated: 0, skipped: 0, errors: 0 };
      // Mirror into lastScan so the status hero shows live progress.
      const liveUpdate = () => { lastScan = { ...lastScan!, ...summary }; };
      liveUpdate();

      for (const ticket of tickets) {
        const ticketId = ticket.id;
        if (investigated.has(ticketId)) { summary.skipped++; liveUpdate(); continue; }

        let alreadyDone = false;
        try {
          const engagements = await hub.getTicketEngagements(creds.token, ticketId);
          alreadyDone = engagements.some(
            (e) => e.engagement?.type === 'NOTE' && hub.isInvestigationNote(e.metadata?.body),
          );
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          record(log, { type: 'hubspot-investigate-check-error', ticketId, error: (err as Error).message, code });
          summary.errors++;
          // Only the pagination cap is structural — fail closed and mark done.
          // Transient errors (429/5xx/network) must NOT mark done, or the ticket
          // is permanently blacklisted for this process lifetime.
          if (code === 'ENGAGEMENT_PAGINATION_CAP') markInvestigated(ticketId);
          liveUpdate();
          continue;
        }

        if (alreadyDone) { markInvestigated(ticketId); summary.skipped++; liveUpdate(); continue; }

        const url = creds.hubId ? hub.ticketUrl(creds.hubId, ticketId) : null;
        if (!url) {
          record(log, { type: 'hubspot-investigate-skip', ticketId, reason: 'no hubId configured' });
          summary.skipped++;
          liveUpdate();
          continue;
        }

        const subject = ticket.properties?.subject || ticketId;
        record(log, { type: 'hubspot-investigate-running', ticketId, subject });

        if (ticketInFlight.has(ticketId)) { summary.skipped++; liveUpdate(); continue; }
        ticketInFlight.add(ticketId);
        try {
          const synthesis = await investigate(url);
          await hub.createTicketNote(creds.token, ticketId, hub.buildInvestigationNoteBody(synthesis));
          markInvestigated(ticketId);
          summary.investigated++;
          record(log, { type: 'hubspot-investigate-done', ticketId, subject });
          broadcast?.('hubspot-investigated', { ticketId, subject });
        } catch (err) {
          const message = (err as Error).message;
          record(log, { type: 'hubspot-investigate-run-error', ticketId, error: message });
          summary.errors++;
          broadcast?.('hubspot-investigate-error', { phase: 'run', ticketId, subject, error: message });
        } finally {
          ticketInFlight.delete(ticketId);
          liveUpdate();
        }
      }

      lastScan = { ...lastScan!, ...summary, finishedAt: Date.now() };
      return summary;
    } catch (err) {
      // Pre-search import/credential failures: surface instead of leaving the
      // prior cycle's lastScan visible with no error breadcrumb.
      lastScan = {
        startedAt: lastScan?.startedAt || Date.now(),
        finishedAt: Date.now(),
        scanned: 0, investigated: 0, skipped: 0, errors: 1,
        error: (err as Error).message,
      };
      throw err;
    } finally {
      scanInFlight = null;
    }
  })();
  return scanInFlight;
}

function markInvestigated(ticketId: string): void {
  if (investigated.has(ticketId)) {
    investigated.delete(ticketId); // refresh recency
  } else if (investigated.size >= INVESTIGATED_LRU_CAP) {
    const oldest = investigated.values().next().value;
    if (oldest !== undefined) investigated.delete(oldest);
  }
  investigated.add(ticketId);
  schedulePersist(investigated);
}

// Stamp lastScan with a top-of-cycle crash so a broken import doesn't leave the
// previous scan's summary visible forever, masking that auto-investigate stopped.
export function stampCycleCrash(err: unknown): void {
  const now = Date.now();
  lastScan = {
    startedAt: now, finishedAt: now,
    scanned: 0, investigated: 0, skipped: 0, errors: 1,
    error: (err as Error)?.message || String(err),
  };
}
