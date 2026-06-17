// Persistence for the auto-investigate dedup Set. Without this, a process
// restart between `createTicketNote` succeeding and the next scan reading
// engagements can re-investigate the same ticket: HubSpot's /engagements/v1
// listing is not strictly read-your-writes, so the just-posted marker note
// may not be visible yet. Disk persistence closes that window.
//
// Format: <DATA_DIR>/hubspot-investigated.json
//   { "ticketIds": ["111", "222", ...], "updatedAt": 1700000000000 }
// Mode 0o600 (the ticket ids aren't secret, but the file lives next to
// tokens.json which is — uniform posture keeps the surface small).

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './support-paths.js';

const STORE_FILE = join(DATA_DIR, 'hubspot-investigated.json');

export function loadInvestigated(): string[] {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, 'utf8'));
    const ids = Array.isArray(parsed?.ticketIds) ? parsed.ticketIds : [];
    return ids.filter((id: unknown): id is string => typeof id === 'string');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // A corrupt file is non-fatal: re-investigating at most once beats crashing
    // the poll cycle. The engagement-marker check still prevents duplicate notes
    // within a single process lifetime.
    console.warn('[hubspot-investigated-store] load failed:', (err as NodeJS.ErrnoException).code || (err as Error).message);
    return [];
  }
}

export function persistInvestigated(ticketIds: Iterable<string>): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const body = JSON.stringify({ ticketIds: Array.from(ticketIds), updatedAt: Date.now() });
    writeFileSync(STORE_FILE, body, { encoding: 'utf8', mode: 0o600 });
    // writeFileSync's mode is only honored on creation; chmod makes 0o600
    // idempotent across overwrites (no-op on Windows).
    try { chmodSync(STORE_FILE, 0o600); } catch { /* windows / unsupported */ }
  } catch (err) {
    console.warn('[hubspot-investigated-store] persist failed:', (err as NodeJS.ErrnoException).code || (err as Error).message);
  }
}

// Debounce so a 50-ticket scan doesn't trigger 50 fs writes — dedup is
// session-stable in memory; persistence only matters across restarts.
let debounceTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_MS = 1000;
export function schedulePersist(ticketIds: Iterable<string>): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    persistInvestigated(ticketIds);
  }, DEBOUNCE_MS);
  debounceTimer.unref?.();
}
