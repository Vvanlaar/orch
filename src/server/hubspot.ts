// /api/support/tickets/* — read-only HubSpot ticket endpoints backing the
// Support → Inbox view. Ported (tickets-only) from bb-dashboard
// scripts/server.mjs. Conversation/thread routes are intentionally omitted.
//
// Mounted from mountSupport() so these inherit the same bearer/anonymous auth
// middleware and the /api/support security headers. Creds + the hubspot.mjs
// client are dynamic-imported via ../core/support-paths.js (no static
// dependency on bb-skills at build time).

import type { Express, RequestHandler } from 'express';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asyncHandler } from '../core/error-handler.js';
import { createLogger } from '../core/logger.js';
import { config } from '../core/config.js';
import { loadHubspot, loadHubspotCreds, RESULTS_DIR } from '../core/support-paths.js';
import { getInvestigateSummary } from '../core/hubspot-poller.js';

const log = createLogger('hubspot');

// hsFetch (bb-support/scripts/hubspot.mjs) attaches `err.status` on every
// non-2xx. Single source of truth — fall through to 'error' rather than
// parsing the message string, which would rot if the format changes.
type HsErr = { kind: 'rate-limited' | 'unauthorized' | 'error'; status: number | null; message: string };
function classifyHsErr(err: unknown): HsErr | null {
  if (!err) return null;
  const e = err as { status?: number | null; message?: string };
  const status = e.status ?? null;
  if (status === 429) return { kind: 'rate-limited', status: 429, message: 'HubSpot rate limit hit — retry shortly.' };
  if (status === 401) return { kind: 'unauthorized', status: 401, message: 'HubSpot token rejected (401).' };
  return { kind: 'error', status, message: String(e.message || err).slice(0, 200) };
}

// Upstream HubSpot 4xx → 502 (we proxied a bad request); everything else 500.
function upstreamStatus(err: unknown): number {
  const s = (err as { status?: number }).status;
  return s && s >= 400 ? 502 : 500;
}

export function mountHubspot(app: Express, opts: { auth: RequestHandler }): void {
  const { auth } = opts;

  // Recent tickets for the inbox list. allSettled-free: tickets-only here, so a
  // failure is reported via `ticketsError` (200 with empty list) so the UI can
  // distinguish "no tickets" from "HubSpot down".
  app.get('/api/support/tickets', auth, asyncHandler(async (req, res) => {
    const creds = await loadHubspotCreds();
    if (!creds.token) { res.status(400).json({ error: 'No HubSpot token configured' }); return; }
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit)) || 20, 50));
    const investigateProperty = config.hubspot.investigateProperty;
    const hub = await loadHubspot();
    try {
      const tickets = await hub.listRecentTickets(creds.token, limit, [investigateProperty]);
      const pipelineCounts: Record<string, number> = {};
      for (const t of tickets) {
        const stage = t.properties?.hs_pipeline_stage || '(unstaged)';
        pipelineCounts[stage] = (pipelineCounts[stage] || 0) + 1;
      }
      res.json({ tickets, pipelineCounts, hubId: creds.hubId, investigateProperty, ticketsError: null });
    } catch (err) {
      res.json({ tickets: [], pipelineCounts: {}, hubId: creds.hubId, investigateProperty, ticketsError: classifyHsErr(err) });
    }
  }));

  // Ticket + engagement timeline for the detail pane. Engagement bodies are
  // HTML emails/notes — stripped to text and truncated to 240 chars server-side.
  app.get('/api/support/tickets/:id', auth, asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!/^\d+$/.test(id)) { res.status(400).json({ error: 'id must be digits' }); return; }
    const creds = await loadHubspotCreds();
    if (!creds.token) { res.status(400).json({ error: 'No HubSpot token configured' }); return; }
    const hub = await loadHubspot();
    try {
      const ticket = await hub.getTicket(creds.token, id);
      // Pagination cap is non-fatal: show the ticket body even when its
      // engagement history is too long to enumerate.
      let engagements: Array<{ type: string; timestamp: number | null; ownerId: number | null; bodyPreview: string; isInvestigationNote: boolean }> = [];
      let capped = false;
      try {
        const raw = await hub.getTicketEngagements(creds.token, id);
        engagements = raw
          .map((e) => {
            const body = e.metadata?.body || '';
            return {
              type: e.engagement?.type || 'UNKNOWN',
              timestamp: e.engagement?.timestamp ?? null,
              ownerId: e.engagement?.ownerId ?? null,
              bodyPreview: hub.stripHtml(body).slice(0, 240),
              isInvestigationNote: e.engagement?.type === 'NOTE' && hub.isInvestigationNote(body),
            };
          })
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENGAGEMENT_PAGINATION_CAP') capped = true;
        else throw err;
      }
      res.json({ ticket, engagements, capped, hubId: creds.hubId });
    } catch (err) {
      res.status(upstreamStatus(err)).json({ error: String((err as Error).message || err) });
    }
  }));

  // AI investigation note body (posted by the auto-investigate poller).
  app.get('/api/support/tickets/:id/note', auth, asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    if (!/^\d+$/.test(id)) { res.status(400).json({ error: 'id must be digits' }); return; }
    const creds = await loadHubspotCreds();
    if (!creds.token) { res.status(400).json({ error: 'No HubSpot token configured' }); return; }
    const hub = await loadHubspot();
    try {
      const engagements = await hub.getTicketEngagements(creds.token, id);
      const notes = engagements
        .filter((e) => e.engagement?.type === 'NOTE' && hub.isInvestigationNote(e.metadata?.body))
        .sort((a, b) => (b.engagement?.timestamp || 0) - (a.engagement?.timestamp || 0));
      if (!notes.length) { res.status(404).json({ error: 'No AI investigation note found' }); return; }
      res.json({ body: notes[0].metadata!.body });
    } catch (err) {
      res.status(upstreamStatus(err)).json({ error: String((err as Error).message || err) });
    }
  }));

  // Auto-investigate scan summary + recent activity for the status hero.
  app.get('/api/support/investigate-summary', auth, (_req, res) => {
    res.json(getInvestigateSummary());
  });

  // Persisted manual Investigate/Draft runs for a ticket (result cache), so the
  // inbox can re-show the last run after a reload. Written by support.ts /ask.
  app.get('/api/support/results/:id', auth, (req, res) => {
    const id = String(req.params.id);
    if (!/^\d+$/.test(id)) { res.status(400).json({ error: 'id must be digits' }); return; }
    try { mkdirSync(RESULTS_DIR, { recursive: true }); } catch { /* best effort */ }
    if (!existsSync(RESULTS_DIR)) { res.json({ results: [] }); return; }
    const prefix = `ticket-${id}-`;
    const results: unknown[] = [];
    try {
      for (const name of readdirSync(RESULTS_DIR)) {
        if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
        try { results.push(JSON.parse(readFileSync(join(RESULTS_DIR, name), 'utf8'))); }
        catch { /* drop unreadable entry */ }
      }
    } catch (err) {
      log.warn('results read failed: ' + (err as Error).message);
      res.status(500).json({ error: String((err as Error).message || err) });
      return;
    }
    results.sort((a, b) => String((a as { intent?: string }).intent || '').localeCompare(String((b as { intent?: string }).intent || '')));
    res.json({ results });
  });

  log.info('/api/support/tickets/* mounted');
}
