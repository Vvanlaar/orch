// Session / auth store — the single source of truth for the access token and
// the scopes it grants. Drives App.svelte's render gate (token screen vs
// support-only vs full admin dashboard).
//
// A one-time global fetch interceptor injects the token into every /api/*
// request and drops us back to the token screen on 401. Patching fetch here
// (rather than threading a wrapper through ~30 call sites in api.ts + the
// stores) guarantees no request is missed.

const TOKEN_KEY = 'orch/token';
const LEGACY_KEY = 'bb-support-web/token'; // SupportPage's old key — migrate it once

function initialToken(): string {
  if (typeof localStorage === 'undefined') return '';
  const t = localStorage.getItem(TOKEN_KEY);
  if (t) return t;
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy) {
    try { localStorage.setItem(TOKEN_KEY, legacy); } catch { /* quota */ }
    return legacy;
  }
  return '';
}

let token = $state<string>(initialToken());
let scopes = $state<string[]>([]);
let ready = $state<boolean>(false); // whoami has resolved at least once

if (typeof window !== 'undefined' && !(window as { __orchFetchPatched?: boolean }).__orchFetchPatched) {
  (window as { __orchFetchPatched?: boolean }).__orchFetchPatched = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const isApi = url.startsWith('/api/') || url.includes(`//${location.host}/api/`);
    let opts = init;
    // Skip Request objects (none in this app) — their headers are immutable here.
    if (isApi && token && !(input instanceof Request)) {
      const headers = new Headers(init?.headers);
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
      opts = { ...init, headers };
    }
    const res = await orig(input, opts);
    // Only drop to the token gate when OUR auth layer rejects the token
    // (X-Orch-Auth: required). A bare 401 from a downstream handler — e.g. an
    // upstream API returning 401/backoff on /api/claude/usage — must NOT clear
    // the session, or a valid admin would be bounced to the gate in a loop.
    if (isApi && res.status === 401 && res.headers.get('X-Orch-Auth') === 'required' && !url.includes('/api/whoami')) {
      scopes = [];
      ready = true;
    }
    return res;
  };
}

export function getToken(): string { return token; }
export function getScopes(): string[] { return scopes; }
export function isReady(): boolean { return ready; }
export function isAdmin(): boolean { return scopes.includes('admin') || scopes.includes('*'); }
export function canSupport(): boolean { return isAdmin() || scopes.includes('support'); }

export async function loadWhoami(): Promise<void> {
  try {
    const res = await fetch('/api/whoami');
    const data = res.ok ? await res.json() : null;
    scopes = data && Array.isArray(data.scopes) ? data.scopes : [];
  } catch {
    scopes = [];
  } finally {
    ready = true;
  }
}

export function setToken(t: string): void {
  token = t.trim();
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* quota */ }
  loadWhoami();
}
