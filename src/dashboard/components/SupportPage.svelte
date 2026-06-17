<script lang="ts">
  // /support page — Svelte 5 port of bb-support-web/assets/app.js.
  //
  // Bearer token persists in localStorage under `bb-support-web/token` so a
  // user who already pasted one into the standalone bb-support-web instance
  // doesn't have to do it again. Recents history is local to this UI under
  // `orch-support-history`.
  //
  // Render path: marked.parse → sanitizeMarkdown (locked DOMPurify config) →
  // replaceChildren on a bound DOM node. requestAnimationFrame-throttled so
  // streaming chunks don't pin the main thread.
  import { onMount } from 'svelte';
  import { sanitizeMarkdown } from '../lib/sanitize';
  import { getToken, setToken } from '../stores/session.svelte';

  // Minimal interface for the vendored marked bundle (no .d.ts ships). Two
  // methods used; keeping the surface narrow catches drift if we ever swap the
  // vendor for an npm dep.
  interface MarkedApi {
    parse(src: string): string;
    setOptions(opts: { breaks?: boolean }): void;
  }
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error — vendored ESM, no .d.ts shipped
  import { marked as markedRaw } from '../vendor/marked.esm.js';
  const marked = markedRaw as MarkedApi;
  marked.setOptions({ breaks: true });

  // Mirrors the union in src/server/support.ts (orch's server/dashboard live
  // in separate tsconfigs so a shared import would mean a deeper restructure).
  type Intent = 'investigate' | 'draft' | 'reply';
  type RunStage = 'ok' | 'ask' | 'claude' | 'cancelled' | 'spawn';

  // --- state -----------------------------------------------------------------
  // Token is owned by the session store (localStorage 'orch/token') so it stays
  // in sync with the app-wide auth used for /api/whoami and the SSE ?token=.
  const HISTORY_KEY = 'orch-support-history';
  const HISTORY_CAP = 50;

  type HistoryEntry = {
    id: string;
    ts: number;
    question: string;
    answer: string;
    intent: Intent;
    keyId: string | null;
  };

  let token = $state<string>(getToken());
  let authMode = $state<'token' | 'anonymous'>('token');
  let question = $state<string>('');
  let intent = $state<Intent>('investigate');
  let rawAnswer = $state<string>('');
  let streaming = $state<boolean>(false);
  let connState = $state<'' | 'streaming' | 'ok' | 'error' | 'recent'>('');
  let connLabel = $state<string>('idle');
  let currentKeyId = $state<string | null>(null);
  let currentRunId = $state<string | null>(null);
  let terminal = $state<{ text: string; isError: boolean } | null>(null);
  let toastMsg = $state<string | null>(null);

  let history = $state<HistoryEntry[]>([]);
  let activeEntryId = $state<string | null>(null);
  let drawerOpen = $state<boolean>(false);

  let revealVisible = $state<boolean>(false);
  let revealStatus = $state<string>('');
  let revealMappings = $state<Array<[string, string]>>([]);
  let revealDecoded = $state<string>('');

  let activeStream: EventSource | null = null;
  let answerEl: HTMLDivElement | null = $state(null);
  let questionEl: HTMLTextAreaElement | null = $state(null);
  let tokenEl: HTMLInputElement | null = $state(null);

  // --- localStorage helpers --------------------------------------------------
  function saveToken(): void {
    // Persist via the session store so scopes (and the gate) stay consistent.
    setToken(token);
  }

  function loadHistory(): HistoryEntry[] {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        console.warn('orch-support-history: expected array, got', typeof parsed);
        return [];
      }
      return parsed as HistoryEntry[];
    } catch (err) {
      // Corrupt JSON wipes recents — tell the user so they don't think the
      // list just emptied itself. Without this, the next persistHistory()
      // overwrites the salvageable blob with [].
      console.warn('orch-support-history: failed to load —', err);
      toastDeferred('Recents reset (saved data was unreadable).');
      return [];
    }
  }

  // toast() depends on Svelte state that may not be reactive-bound yet during
  // onMount → loadHistory; defer to a microtask.
  function toastDeferred(msg: string): void {
    queueMicrotask(() => toast(msg));
  }

  function persistHistory(): void {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); }
    catch (err) {
      // Quota: drop oldest half and retry once. If still failing, surface to user.
      const isErr = err instanceof Error;
      const sig = isErr ? (err.name || err.message || '') : String(err);
      if (/quota/i.test(sig)) {
        history = history.slice(0, Math.floor(history.length / 2));
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); return; } catch { /* still failing */ }
      }
      toast('Could not save to recents: ' + (isErr ? err.message : 'unknown'));
    }
  }

  function pushHistoryEntry(entry: Omit<HistoryEntry, 'id' | 'ts'>): void {
    if (!entry.answer || !entry.answer.trim()) return;
    const e: HistoryEntry = {
      id: (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      ...entry,
    };
    history = [e, ...history];
    if (history.length > HISTORY_CAP) history = history.slice(0, HISTORY_CAP);
    persistHistory();
  }

  function deleteEntry(id: string): void {
    history = history.filter(e => e.id !== id);
    persistHistory();
    if (activeEntryId === id) exitHistoryMode();
  }

  function clearAllHistory(): void {
    if (!confirm("Clear all saved recents? This can't be undone.")) return;
    history = [];
    persistHistory();
    if (activeEntryId) exitHistoryMode();
  }

  function relTime(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    const days = Math.floor(s / 86400);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function loadEntry(id: string): void {
    const entry = history.find(e => e.id === id);
    if (!entry) return;
    activeEntryId = id;
    rawAnswer = entry.answer;
    currentKeyId = entry.keyId;
    question = entry.question;
    intent = entry.intent === 'draft' || entry.intent === 'reply' ? entry.intent : 'investigate';
    terminal = null;
    revealVisible = /\[customer:\d+\]/.test(rawAnswer);
    revealMappings = [];
    revealDecoded = '';
    revealStatus = '';
    connState = 'recent';
    connLabel = 'recent';
    drawerOpen = false;
    scheduleRender();
  }

  function exitHistoryMode(): void {
    activeEntryId = null;
    rawAnswer = '';
    currentKeyId = null;
    question = '';
    terminal = null;
    revealVisible = false;
    revealMappings = [];
    revealDecoded = '';
    revealStatus = '';
    connState = '';
    connLabel = 'idle';
    if (answerEl) {
      answerEl.replaceChildren();
      answerEl.classList.add('placeholder');
      answerEl.textContent = 'Submit a question to see the streamed answer here.';
    }
  }

  // --- render ----------------------------------------------------------------
  let renderPending = false;
  function scheduleRender(): void {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(async () => {
      renderPending = false;
      if (!answerEl) return;
      if (!rawAnswer) {
        answerEl.replaceChildren();
        answerEl.classList.add('placeholder');
        answerEl.textContent = streaming ? 'Streaming…' : 'Submit a question to see the streamed answer here.';
        return;
      }
      answerEl.classList.remove('placeholder');
      const html = marked.parse(rawAnswer) as string;
      const fragment = sanitizeMarkdown(html);
      answerEl.replaceChildren(fragment);
    });
  }

  // --- toast -----------------------------------------------------------------
  function toast(msg: string, ms = 4000): void {
    toastMsg = msg;
    setTimeout(() => { if (toastMsg === msg) toastMsg = null; }, ms);
  }

  // --- ask flow --------------------------------------------------------------
  async function ask(): Promise<void> {
    const t = token.trim();
    if (authMode === 'token' && !t) {
      toast('Paste a bearer token in the header first.');
      tokenEl?.focus();
      return;
    }
    const q = question.trim();
    if (!q) { questionEl?.focus(); return; }

    resetAnswer();
    streaming = true;
    connState = 'streaming';
    connLabel = 'asking…';

    let body: { runId?: string; keyId?: string; error?: string };
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (t) headers['Authorization'] = `Bearer ${t}`;
      const res = await fetch('/api/support/ask', {
        method: 'POST',
        headers,
        body: JSON.stringify({ question: q, intent }),
      });
      body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    } catch (err) {
      connState = 'error';
      connLabel = 'error';
      showTerminal(`error: ${(err as Error).message}`, true);
      finish();
      return;
    }

    currentKeyId = body.keyId ?? null;
    currentRunId = body.runId ?? null;
    let url = `/api/support/events/${encodeURIComponent(body.runId!)}`;
    if (t) url += `?token=${encodeURIComponent(t)}`;
    activeStream = new EventSource(url);

    activeStream.addEventListener('chunk', (e) => {
      const { chunk } = JSON.parse((e as MessageEvent).data);
      rawAnswer += chunk;
      connState = 'streaming';
      connLabel = 'streaming';
      scheduleRender();
    });

    activeStream.addEventListener('done', (e) => {
      const term = JSON.parse((e as MessageEvent).data) as { stage: RunStage; error?: string };
      connState = term.stage === 'ok' ? 'ok' : (term.stage === 'cancelled' ? '' : 'error');
      connLabel = term.stage;
      showTerminal(term.error ? `${term.stage}: ${term.error}` : term.stage, term.stage !== 'ok' && term.stage !== 'cancelled');
      scheduleRender();
      if (/\[customer:\d+\]/.test(rawAnswer)) revealVisible = true;
      if (term.stage === 'ok' && rawAnswer.trim()) {
        pushHistoryEntry({ question: q, answer: rawAnswer, intent, keyId: currentKeyId });
      }
      finish();
    });

    activeStream.onerror = () => {
      // EventSource also fires `error` on the benign close that follows `done`.
      // The `streaming` guard suppresses that case so a successful run doesn't
      // get retro-overwritten to "stream error".
      if (!streaming) return;
      const rs = activeStream?.readyState;
      connState = 'error';
      connLabel = 'stream error';
      showTerminal(`stream error (readyState=${rs}) — the connection dropped or the server is unreachable`, true);
      finish();
    };
  }

  function cancel(): void {
    // Tell the server to abort the subprocess tree. Without this, closing the
    // EventSource only detaches the client — claude keeps running until the
    // 5-min server-side reaper.
    if (currentRunId) {
      const t = token.trim();
      const headers: Record<string, string> = {};
      if (t) headers['Authorization'] = `Bearer ${t}`;
      fetch(`/api/support/cancel/${encodeURIComponent(currentRunId)}`, { method: 'POST', headers })
        .catch(() => { /* best-effort; the reaper backstops it */ });
    }
    if (activeStream) activeStream.close();
    connState = '';
    connLabel = 'cancelled';
    finish();
  }

  function finish(): void {
    if (activeStream) { activeStream.close(); activeStream = null; }
    streaming = false;
  }

  function resetAnswer(): void {
    rawAnswer = '';
    terminal = null;
    revealVisible = false;
    revealMappings = [];
    revealDecoded = '';
    revealStatus = '';
    currentKeyId = null;
    currentRunId = null;
    scheduleRender();
  }

  function showTerminal(text: string, isError: boolean): void {
    terminal = { text, isError };
  }

  // --- reveal flow -----------------------------------------------------------
  async function reveal(): Promise<void> {
    if (!currentKeyId) return;
    const t = token.trim();
    revealStatus = 'decoding…';
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (t) headers['Authorization'] = `Bearer ${t}`;
      const res = await fetch('/api/support/reveal', {
        method: 'POST',
        headers,
        body: JSON.stringify({ keyId: currentKeyId, text: rawAnswer }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      revealMappings = Object.entries(body.mappings || {}) as Array<[string, string]>;
      revealDecoded = body.decoded || '';
      revealStatus = revealMappings.length
        ? `${revealMappings.length} placeholder(s) resolved`
        : 'no name placeholders in this answer';
    } catch (err) {
      revealStatus = `error: ${(err as Error).message}`;
    }
  }

  // --- lifecycle -------------------------------------------------------------
  onMount(() => {
    history = loadHistory();
    fetch('/api/support/health')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(h => { authMode = h.authMode || 'token'; })
      .catch((err) => {
        // Surface server-unreachable in the conn pill so the user doesn't
        // burn a turn typing a question against a down server.
        console.warn('support health probe failed:', err);
        connState = 'error';
        connLabel = 'server unreachable';
      });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (drawerOpen) { drawerOpen = false; return; }
        if (activeEntryId) { exitHistoryMode(); return; }
        if (streaming) { cancel(); return; }
      }
    };
    document.addEventListener('keydown', onKey);

    scheduleRender();

    return () => {
      document.removeEventListener('keydown', onKey);
      finish();
    };
  });

  function onQuestionKey(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); ask(); }
  }
</script>

<svelte:head>
  <!--
    CSP scoped to this page. Belt-to-the-brace alongside DOMPurify (sanitize.ts):
    form-action 'none' stops injected forms; script-src 'self' kills inline
    scripts; connect-src 'self' confines XHR/SSE to our origin.
    The fonts.googleapis.com / fonts.gstatic.com allowlist is for orch's global
    App.svelte stylesheet — without it the IBM Plex font load breaks on /support.
  -->
  <meta http-equiv="content-security-policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'self'">
</svelte:head>

<div class="support-wrap">
  <section class="support-hero">
    <div class="hero-row">
      <div class="hero-title">
        <span class="hero-mark">bb</span>
        <h2>Support</h2>
        <span class="conn-pill">
          <span class="dot dot-{connState}"></span>
          <span>{connLabel}</span>
        </span>
      </div>
      <div class="hero-actions">
        <button class="ghost-btn" type="button" onclick={() => drawerOpen = !drawerOpen}>
          ⌖ recents
          {#if history.length > 0}<span class="badge-count">{history.length}</span>{/if}
        </button>
        {#if authMode === 'token'}
          <input
            bind:this={tokenEl}
            class="token-input"
            type="password"
            placeholder="Bearer token (saved locally)"
            autocomplete="off"
            spellcheck="false"
            bind:value={token}
            oninput={saveToken}
            onchange={saveToken}
            onblur={saveToken}
          />
        {/if}
      </div>
    </div>
  </section>

  <section class="panel ask-panel">
    <div class="panel-title"><span>Ask</span></div>
    <textarea
      bind:this={questionEl}
      bind:value={question}
      onkeydown={onQuestionKey}
      placeholder="Paste a HubSpot URL, ADO ticket URL, or a plain question. e.g. 'how does live transcoding work'"
    ></textarea>
    <div class="controls">
      <label for="intent-select">intent</label>
      <select id="intent-select" bind:value={intent}>
        <option value="investigate">investigate</option>
        <option value="draft">draft reply</option>
        <option value="reply">reply</option>
      </select>
      <button class="primary-btn" disabled={streaming} onclick={ask}>Ask →</button>
      {#if streaming}
        <button class="ghost-btn" type="button" onclick={cancel}>Cancel</button>
      {/if}
    </div>
  </section>

  <section class="panel answer-panel">
    <div class="panel-title">
      <span>Answer</span>
      {#if activeEntryId}
        <span class="history-banner">
          <span class="banner-glyph">↻</span>
          <span>viewing recent</span>
          <button class="banner-exit" type="button" onclick={exitHistoryMode}>back to live</button>
        </span>
      {/if}
    </div>
    <div class="panel-body">
      <div bind:this={answerEl} class="answer placeholder">Submit a question to see the streamed answer here.</div>
      {#if terminal}
        <div class="terminal" class:error={terminal.isError}>{terminal.text}</div>
      {/if}
    </div>
  </section>

  {#if revealVisible}
    <section class="panel">
      <div class="panel-title"><span>Reveal [customer:N] placeholders</span></div>
      <div class="reveal-row">
        <button class="primary-btn" onclick={reveal}>Decode this answer</button>
        <span class="reveal-status">{revealStatus}</span>
      </div>
      {#if revealMappings.length > 0}
        <table class="mappings-table">
          <thead><tr><th>Placeholder</th><th>Real name</th></tr></thead>
          <tbody>
            {#each revealMappings as [ph, real]}
              <tr><td><code>{ph}</code></td><td>{real}</td></tr>
            {/each}
          </tbody>
        </table>
      {/if}
      {#if revealDecoded}
        <div class="decoded">{revealDecoded}</div>
      {/if}
    </section>
  {/if}
</div>

{#if toastMsg}<div class="toast">{toastMsg}</div>{/if}

{#if drawerOpen}
  <!-- Trap focus only when open. Backdrop click closes; Escape closes via onKey. -->
  <button class="drawer-backdrop" aria-label="Close recents" onclick={() => drawerOpen = false}></button>
{/if}
<aside class="drawer" class:is-open={drawerOpen} aria-label="Recents" aria-hidden={!drawerOpen}>
  <header class="drawer-head">
    <div class="drawer-title">
      <span class="drawer-mark">·</span>
      <span>recents</span>
      <span class="drawer-count">{history.length}</span>
    </div>
    <button class="drawer-close" type="button" aria-label="Close" onclick={() => drawerOpen = false}>✕</button>
  </header>
  <div class="drawer-body">
    {#if history.length === 0}
      <div class="drawer-empty">
        <div class="drawer-empty-mark">⌖</div>
        <div class="drawer-empty-text">no recents yet</div>
        <div class="drawer-empty-hint">answers you receive will collect here</div>
      </div>
    {:else}
      <ul class="drawer-list">
        {#each history as entry (entry.id)}
          <li class="drawer-item" class:active={entry.id === activeEntryId}>
            <button type="button" class="drawer-item-main" onclick={() => loadEntry(entry.id)}>
              <span class="drawer-item-q">{entry.question || '(no question)'}</span>
              <span class="drawer-item-meta">
                <span class="drawer-item-time">{relTime(entry.ts)}</span>
                <span class="intent-badge intent-{entry.intent}">
                  {entry.intent === 'draft' || entry.intent === 'reply' ? 'draft' : 'invest.'}
                </span>
                {#if /\[customer:\d+\]/.test(entry.answer)}
                  <span class="pii-dot" title="contains [customer:N] placeholders"></span>
                {/if}
              </span>
            </button>
            <button type="button" class="drawer-item-delete" title="Delete" onclick={() => deleteEntry(entry.id)}>✕</button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  {#if history.length > 0}
    <footer class="drawer-foot">
      <button class="drawer-clear" type="button" onclick={clearAllHistory}>clear all</button>
    </footer>
  {/if}
</aside>

<style>
  :global(:root) {
    --support-accent: #2dd4bf;
    --support-accent-soft: rgba(45, 212, 191, 0.12);
    --support-accent-dim: rgba(45, 212, 191, 0.45);
  }

  .support-wrap {
    display: grid;
    gap: 16px;
    max-width: 1100px;
    margin: 0 auto;
  }

  .support-hero {
    background: var(--bg-surface);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    padding: 14px 18px;
    position: relative;
    overflow: hidden;
  }
  .support-hero::before {
    content: '';
    position: absolute; left: 0; right: 0; bottom: 0;
    height: 2px; background: var(--support-accent); opacity: 0.4;
  }

  .hero-row {
    display: flex; justify-content: space-between; align-items: center;
    gap: 14px; flex-wrap: wrap;
  }
  .hero-title { display: inline-flex; align-items: center; gap: 12px; }
  .hero-title h2 {
    font-size: 15px; font-weight: 600; color: var(--text-heading);
    text-transform: none; padding: 0; border: 0; letter-spacing: 0;
  }
  .hero-mark {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px;
    background: var(--support-accent); color: var(--bg-deep);
    border-radius: 50%; font-size: 10px; font-weight: 700;
    font-family: 'IBM Plex Mono', monospace;
  }
  .hero-actions { display: flex; align-items: center; gap: 10px; }

  .conn-pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px;
    border: 1px solid var(--border-primary); border-radius: 999px;
    font-family: 'IBM Plex Mono', monospace; font-size: 11px;
    color: var(--text-muted);
  }
  .conn-pill .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--text-muted);
  }
  .conn-pill .dot-ok { background: var(--success); }
  .conn-pill .dot-streaming {
    background: var(--support-accent);
    box-shadow: 0 0 6px var(--support-accent-dim);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .conn-pill .dot-error { background: var(--danger); }
  .conn-pill .dot-recent { background: var(--info); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .token-input {
    background: var(--bg-deep);
    border: 1px solid var(--border-primary);
    color: var(--text-primary);
    padding: 5px 10px; border-radius: 6px;
    font-family: 'IBM Plex Mono', monospace; font-size: 11px;
    min-width: 260px;
  }
  .token-input:focus {
    outline: none;
    border-color: var(--support-accent);
    box-shadow: 0 0 0 2px var(--support-accent-soft);
  }

  .badge-count {
    background: var(--support-accent); color: var(--bg-deep);
    border-radius: 999px;
    padding: 0 6px; min-width: 16px;
    font-size: 10px; font-weight: 700; text-align: center;
  }

  .panel {
    background: var(--bg-surface);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    padding: 14px 18px;
  }
  .panel-title {
    display: flex; justify-content: space-between; align-items: center; gap: 8px;
    font-family: 'IBM Plex Mono', monospace; font-size: 11px;
    text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-muted);
    margin-bottom: 10px;
  }

  textarea {
    width: 100%;
    min-height: 80px; max-height: 240px; resize: vertical;
    background: var(--bg-deep); border: 1px solid var(--border-primary);
    color: var(--text-primary);
    padding: 10px 12px; border-radius: 6px;
    font-family: 'IBM Plex Sans', system-ui, sans-serif; font-size: 14px; line-height: 1.5;
  }
  textarea:focus { outline: none; border-color: var(--support-accent); }

  .controls {
    margin-top: 10px;
    display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  }
  .controls label {
    font-family: 'IBM Plex Mono', monospace; font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  select {
    background: var(--bg-deep); border: 1px solid var(--border-primary);
    color: var(--text-primary);
    padding: 5px 8px; border-radius: 6px;
    font-family: 'IBM Plex Mono', monospace; font-size: 12px;
  }

  .primary-btn {
    background: var(--support-accent); color: var(--bg-deep);
    border: 0; padding: 7px 16px; border-radius: 6px;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 13px; font-weight: 600;
    cursor: pointer; transition: opacity 150ms ease;
  }
  .primary-btn:hover { opacity: 0.85; }
  .primary-btn:disabled {
    background: var(--bg-raised); color: var(--text-muted);
    cursor: not-allowed; opacity: 1;
  }
  .ghost-btn {
    background: transparent; color: var(--support-accent);
    border: 1px solid var(--support-accent-dim);
    border-radius: 6px; padding: 4px 12px;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 12px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
    transition: all 150ms ease;
  }
  .ghost-btn:hover { background: var(--support-accent-soft); }

  .answer-panel { display: flex; flex-direction: column; min-height: 280px; }
  .panel-body { padding-right: 4px; overflow-y: auto; max-height: 600px; }
  .answer {
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 14px; line-height: 1.65;
    color: var(--text-primary);
  }
  /* :global so the sanitized fragment (injected via replaceChildren) inherits
     styles even though it's outside Svelte's compiled scope. */
  :global(.answer h1),
  :global(.answer h2),
  :global(.answer h3) { color: var(--text-heading); margin: 16px 0 8px; line-height: 1.3; }
  :global(.answer h1) { font-size: 20px; }
  :global(.answer h2) { font-size: 17px; }
  :global(.answer h3) { font-size: 15px; }
  :global(.answer p) { margin: 8px 0; }
  :global(.answer a) { color: var(--support-accent); text-decoration: none; }
  :global(.answer a:hover) { text-decoration: underline; }
  :global(.answer code) {
    font-family: 'IBM Plex Mono', monospace; font-size: 12px;
    background: var(--bg-deep); padding: 2px 6px; border-radius: 3px;
  }
  :global(.answer pre) {
    background: var(--bg-deep); padding: 12px; border-radius: 6px;
    overflow-x: auto; margin: 10px 0;
  }
  :global(.answer pre code) { background: transparent; padding: 0; }
  :global(.answer ul),
  :global(.answer ol) { margin: 8px 0 8px 24px; }
  :global(.answer li) { margin: 4px 0; }
  :global(.answer blockquote) {
    border-left: 3px solid var(--support-accent);
    padding-left: 12px;
    color: var(--text-muted);
    margin: 10px 0;
  }
  :global(.answer hr) { border: 0; border-top: 1px solid var(--border-primary); margin: 16px 0; }

  .placeholder { color: var(--text-muted); font-style: italic; }

  .terminal {
    margin-top: 12px; padding: 8px 12px;
    font-family: 'IBM Plex Mono', monospace; font-size: 11px;
    background: var(--bg-deep);
    border-left: 3px solid var(--support-accent);
    color: var(--text-muted);
    border-radius: 6px;
  }
  .terminal.error { border-left-color: var(--danger); color: var(--danger); }

  .reveal-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .reveal-status {
    font-family: 'IBM Plex Mono', monospace; font-size: 11px;
    color: var(--text-muted);
  }
  .mappings-table {
    margin-top: 10px; width: 100%; border-collapse: collapse;
    font-family: 'IBM Plex Mono', monospace; font-size: 12px;
  }
  .mappings-table th, .mappings-table td {
    padding: 6px 10px; text-align: left;
    border-bottom: 1px solid var(--border-primary);
  }
  .mappings-table th {
    color: var(--text-muted); font-weight: 500;
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
  }
  .mappings-table tr:last-child td { border-bottom: 0; }
  .mappings-table code { color: var(--support-accent); }

  .decoded {
    margin-top: 10px; padding: 10px 12px;
    background: var(--bg-deep); border-radius: 6px;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: 13px; line-height: 1.6;
    color: var(--text-primary);
    white-space: pre-wrap;
    max-height: 240px; overflow-y: auto;
  }

  .toast {
    position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
    background: var(--bg-surface); border: 1px solid var(--danger);
    color: var(--danger);
    padding: 8px 16px; border-radius: 6px; font-size: 12px;
    z-index: 200;
  }

  .history-banner {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--support-accent-soft);
    border: 1px solid var(--support-accent-dim);
    color: var(--support-accent);
    padding: 2px 8px; border-radius: 999px;
    font-family: 'IBM Plex Mono', monospace; font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .banner-glyph { font-size: 11px; }
  .banner-exit {
    background: transparent; border: 0;
    color: var(--support-accent);
    padding: 0 0 0 6px; border-left: 1px solid var(--support-accent-dim);
    font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
    cursor: pointer;
  }
  .banner-exit:hover { color: var(--text-heading); }

  /* --- drawer --- */
  .drawer-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 80;
    border: 0;
    cursor: pointer;
  }
  .drawer {
    position: fixed; top: 0; right: 0; bottom: 0;
    width: min(380px, 92vw);
    background: var(--bg-surface);
    border-left: 1px solid var(--border-primary);
    box-shadow: -12px 0 32px rgba(0, 0, 0, 0.4);
    z-index: 90;
    display: flex; flex-direction: column;
    transform: translateX(100%);
    transition: transform 240ms cubic-bezier(0.2, 0.7, 0.2, 1);
    visibility: hidden;
  }
  .drawer.is-open { transform: translateX(0); visibility: visible; }
  .drawer::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: var(--support-accent); opacity: 0.5;
  }

  .drawer-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 16px 12px;
    border-bottom: 1px solid var(--border-primary);
  }
  .drawer-title {
    display: inline-flex; align-items: center; gap: 8px;
    font-family: 'IBM Plex Mono', monospace; font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.1em;
    color: var(--text-heading);
  }
  .drawer-mark { color: var(--support-accent); font-size: 18px; line-height: 0.6; }
  .drawer-count {
    background: var(--support-accent-soft); color: var(--support-accent);
    border: 1px solid var(--support-accent-dim);
    border-radius: 999px;
    padding: 1px 8px;
    font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 600;
    letter-spacing: 0;
  }
  .drawer-close {
    background: transparent; border: 0;
    color: var(--text-muted); font-size: 14px; line-height: 1;
    padding: 4px 8px; border-radius: 6px;
    cursor: pointer;
  }
  .drawer-close:hover { color: var(--text-heading); background: var(--bg-raised); }

  .drawer-body { flex: 1; overflow-y: auto; }

  .drawer-empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; padding: 48px 24px;
    color: var(--text-muted);
  }
  .drawer-empty-mark { font-size: 32px; color: var(--support-accent-dim); margin-bottom: 12px; }
  .drawer-empty-text {
    font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-heading);
  }
  .drawer-empty-hint {
    margin-top: 6px; font-size: 12px; color: var(--text-muted); max-width: 220px;
  }

  .drawer-list { list-style: none; margin: 0; padding: 4px 0; }
  .drawer-item {
    position: relative;
    border-bottom: 1px solid var(--border-primary);
  }
  .drawer-item-main {
    all: unset;
    display: block;
    padding: 12px 36px 12px 18px;
    width: 100%;
    cursor: pointer;
    transition: background 120ms ease;
  }
  .drawer-item-main:hover { background: var(--bg-raised); }
  .drawer-item.active .drawer-item-main { background: var(--support-accent-soft); }
  .drawer-item.active::before {
    content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
    background: var(--support-accent);
  }
  .drawer-item-q {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
    font-size: 13px; line-height: 1.4;
    color: var(--text-heading);
  }
  .drawer-item-meta {
    margin-top: 6px;
    display: flex; align-items: center; gap: 8px;
    font-family: 'IBM Plex Mono', monospace; font-size: 10px;
    color: var(--text-muted);
  }
  .intent-badge {
    text-transform: uppercase; letter-spacing: 0.08em;
    padding: 1px 6px; border-radius: 3px;
    border: 1px solid var(--support-accent-dim);
    color: var(--support-accent);
    font-size: 9px; font-weight: 700;
  }
  .intent-badge.intent-draft, .intent-badge.intent-reply {
    color: var(--warning); border-color: var(--warning);
  }
  .pii-dot {
    width: 5px; height: 5px; border-radius: 50%;
    background: var(--support-accent);
    box-shadow: 0 0 4px var(--support-accent-dim);
  }
  .drawer-item-delete {
    position: absolute; top: 10px; right: 10px;
    background: transparent; border: 0;
    color: var(--text-muted); font-size: 12px; line-height: 1;
    padding: 2px 6px; border-radius: 3px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
  }
  .drawer-item:hover .drawer-item-delete { opacity: 1; }
  .drawer-item-delete:hover { color: var(--danger); background: var(--bg-surface); }

  .drawer-foot {
    padding: 10px 16px; border-top: 1px solid var(--border-primary);
    display: flex; justify-content: flex-end;
  }
  .drawer-clear {
    background: transparent; color: var(--text-muted);
    border: 1px solid var(--border-primary); border-radius: 6px;
    padding: 4px 10px;
    font-family: 'IBM Plex Mono', monospace; font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.08em;
    cursor: pointer;
  }
  .drawer-clear:hover { color: var(--danger); border-color: var(--danger); }
</style>
