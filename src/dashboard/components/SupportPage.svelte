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
  import { SvelteSet } from 'svelte/reactivity';
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
  type Intent = 'investigate' | 'draft' | 'reply' | 'summarise';
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

  // --- inbox (HubSpot tickets) sub-view --------------------------------------
  type Mode = 'ask' | 'inbox';
  let mode = $state<Mode>('ask');

  type Ticket = { id: string; properties?: Record<string, string | null | undefined> };
  type Engagement = { type: string; timestamp: number | null; ownerId: number | null; bodyPreview: string; body: string; isInvestigationNote: boolean };
  type CachedResult = { intent: string; body: string; stage: string; finishedAt: number };
  type Summary = {
    lastScan: null | { startedAt: number; finishedAt: number | null; scanned: number; investigated: number; skipped: number; errors: number; error?: string };
    inProgress: boolean;
    recent: Array<{ type: string; ts: number; [k: string]: unknown }>;
  };

  let tickets = $state<Ticket[]>([]);
  let ticketsError = $state<string | null>(null);
  let hubId = $state<string>('');
  let investigateProperty = $state<string>('');
  let inboxLoading = $state<boolean>(false);
  let ticketLimit = $state<number>(20);
  let inboxFilter = $state<'all' | 'flagged'>('all');
  let inboxSearch = $state<string>('');
  let selectedId = $state<string | null>(null);
  let selectedTicket = $state<Ticket | null>(null);
  let selectedEngagements = $state<Engagement[]>([]);
  // Timeline rows the user has clicked open (indices into selectedEngagements).
  let expandedTl = $state(new SvelteSet<number>());
  let selectedCapped = $state<boolean>(false);
  let detailLoading = $state<boolean>(false);
  let noteBody = $state<string | null>(null);
  let summary = $state<Summary | null>(null);
  let cachedLabel = $state<string>('');
  let summaryTimer: ReturnType<typeof setInterval> | null = null;

  const filteredTickets = $derived(
    tickets.filter((t) => {
      if (inboxFilter === 'flagged' && !(investigateProperty && t.properties?.[investigateProperty] === 'true')) return false;
      const s = inboxSearch.trim().toLowerCase();
      if (!s) return true;
      const subj = String(t.properties?.subject || '').toLowerCase();
      const content = String(t.properties?.content || '').toLowerCase();
      return subj.includes(s) || content.includes(s);
    }),
  );

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
        // While streaming but before the first chunk, the run is in ask.mjs's
        // context-gather phase (no output yet). Say so explicitly — a bare
        // "Streaming…" with nothing happening reads as broken.
        answerEl.textContent = streaming
          ? 'Gathering ticket context… this can take up to a minute before the answer streams.'
          : 'Submit a question to see the streamed answer here.';
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
  // Shared by the Ask box (no args → uses the bound question/intent) and the
  // inbox Investigate/Draft buttons (pass q/intent/subject; recordHistory off).
  async function ask(opts: { q?: string; intent?: Intent; subject?: { type: 'ticket'; id: string }; recordHistory?: boolean } = {}): Promise<void> {
    const t = token.trim();
    if (authMode === 'token' && !t) {
      toast('Paste a bearer token in the header first.');
      tokenEl?.focus();
      return;
    }
    const q = (opts.q ?? question).trim();
    const useIntent: Intent = opts.intent ?? intent;
    const recordHistory = opts.recordHistory ?? true;
    if (!q) { questionEl?.focus(); return; }

    resetAnswer();
    streaming = true;
    connState = 'streaming';
    connLabel = 'asking…';
    scheduleRender(); // paint the gather-phase message now, not on first chunk

    let body: { runId?: string; keyId?: string; error?: string };
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (t) headers['Authorization'] = `Bearer ${t}`;
      const res = await fetch('/api/support/ask', {
        method: 'POST',
        headers,
        body: JSON.stringify({ question: q, intent: useIntent, ...(opts.subject ? { subject: opts.subject } : {}) }),
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
      if (term.stage === 'ok' && rawAnswer.trim() && recordHistory) {
        pushHistoryEntry({ question: q, answer: rawAnswer, intent: useIntent, keyId: currentKeyId });
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

  // --- inbox flow ------------------------------------------------------------
  async function apiGet(path: string): Promise<Record<string, unknown>> {
    const t = token.trim();
    const headers: Record<string, string> = {};
    if (t) headers['Authorization'] = `Bearer ${t}`;
    const res = await fetch(path, { headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
    return body as Record<string, unknown>;
  }

  function setMode(m: Mode): void {
    if (mode === m) return;
    // Tear down any in-flight stream before swapping answer surfaces, else the
    // EventSource keeps mutating the shared rawAnswer and bleeds into the other
    // view (the two answer panels share one answerEl binding).
    if (streaming) cancel();
    mode = m;
    if (m === 'inbox') {
      if (!tickets.length) loadTickets();
      startSummaryPolling();
    } else {
      stopSummaryPolling();
    }
  }

  async function loadTickets(): Promise<void> {
    inboxLoading = true;
    try {
      const data = await apiGet(`/api/support/tickets?limit=${ticketLimit}`);
      tickets = (data.tickets as Ticket[]) || [];
      hubId = (data.hubId as string) || '';
      investigateProperty = (data.investigateProperty as string) || '';
      const te = data.ticketsError as { message?: string } | null;
      ticketsError = te ? (te.message || 'HubSpot error') : null;
    } catch (err) {
      ticketsError = (err as Error).message;
      tickets = [];
    } finally {
      inboxLoading = false;
    }
  }

  function ticketUrlFor(id: string): string {
    return hubId ? `https://app.hubspot.com/contacts/${hubId}/ticket/${id}` : `ticket:${id}`;
  }

  async function selectTicket(id: string): Promise<void> {
    // Switching ticket mid-stream would leave the previous run writing into the
    // shared rawAnswer under the new ticket's detail — cancel it first.
    if (streaming) cancel();
    selectedId = id;
    selectedTicket = null;
    selectedEngagements = [];
    expandedTl.clear();
    selectedCapped = false;
    noteBody = null;
    cachedLabel = '';
    detailLoading = true;
    resetAnswer();
    try {
      const data = await apiGet(`/api/support/tickets/${id}`);
      if (selectedId !== id) return; // superseded by a newer selection
      selectedTicket = data.ticket as Ticket;
      selectedEngagements = (data.engagements as Engagement[]) || [];
      selectedCapped = !!data.capped;
      if (data.hubId) hubId = data.hubId as string;
    } catch (err) {
      toast(`Failed to load ticket: ${(err as Error).message}`);
      detailLoading = false;
      return;
    }
    detailLoading = false;
    // Re-show the most recent cached Investigate/Draft for this ticket (no keyId
    // is stored, so reveal isn't offered on cached output).
    try {
      const r = await apiGet(`/api/support/results/${id}`);
      // Bail if the user re-selected another ticket or kicked off a live run
      // during the awaits — don't clobber the current answer with stale cache.
      if (selectedId !== id || streaming) return;
      const results = (r.results as CachedResult[]) || [];
      if (results.length) {
        const latest = results.slice().sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0];
        rawAnswer = latest.body;
        cachedLabel = `cached ${latest.intent}`;
        scheduleRender();
      }
    } catch { /* no cache yet */ }
  }

  async function runTicketAction(actionIntent: Intent): Promise<void> {
    if (!selectedId) return;
    cachedLabel = '';
    await ask({ q: `${ticketUrlFor(selectedId)} ${actionIntent}`, intent: actionIntent, subject: { type: 'ticket', id: selectedId }, recordHistory: false });
  }

  function toggleTl(i: number): void {
    if (expandedTl.has(i)) expandedTl.delete(i);
    else expandedTl.add(i);
  }

  // HubSpot redacts email bodies unless the app has the sales-email-read scope;
  // it returns this sentinel as the "body". Detect it so the timeline shows a
  // short hint instead of repeating the full redaction sentence per row.
  const REDACTED_RE = /content of this email has been redacted/i;
  function isRedacted(e: Engagement): boolean { return REDACTED_RE.test(e.bodyPreview); }

  // Humanise HubSpot engagement type codes for the timeline.
  function engagementLabel(type: string): string {
    switch (type) {
      case 'INCOMING_EMAIL': return 'Email in';
      case 'EMAIL': return 'Email out';
      case 'NOTE': return 'Note';
      case 'CALL': return 'Call';
      case 'MEETING': return 'Meeting';
      case 'TASK': return 'Task';
      case 'CONVERSATION_SESSION': return 'Conversation';
      default: return type.charAt(0).toUpperCase() + type.slice(1).toLowerCase().replace(/_/g, ' ');
    }
  }

  function tlPreview(e: Engagement): string {
    if (isRedacted(e)) return '🔒 Email body hidden — HubSpot app needs the sales-email-read scope';
    return e.bodyPreview || '(no text content)';
  }

  async function viewNote(): Promise<void> {
    if (!selectedId) return;
    try {
      const data = await apiGet(`/api/support/tickets/${selectedId}/note`);
      noteBody = (data.body as string) || '';
    } catch (err) {
      toast(`No AI note: ${(err as Error).message}`);
    }
  }

  async function loadSummary(): Promise<void> {
    try { summary = (await apiGet('/api/support/investigate-summary')) as unknown as Summary; }
    catch { /* poller may be disabled; hero just hides */ }
  }
  function startSummaryPolling(): void {
    loadSummary();
    if (!summaryTimer) summaryTimer = setInterval(loadSummary, 10_000);
  }
  function stopSummaryPolling(): void {
    if (summaryTimer) { clearInterval(summaryTimer); summaryTimer = null; }
  }

  function ticketSubject(t: Ticket): string {
    return String(t.properties?.subject || '(no subject)');
  }
  // HubSpot returns datetime props as either epoch-ms strings or ISO strings;
  // handle both. Returns '' for missing/unparseable so the row hides the chip.
  function ticketAge(t: Ticket): string {
    const v = t.properties?.hs_lastmodifieddate;
    if (!v) return '';
    const ms = /^\d+$/.test(String(v)) ? Number(v) : Date.parse(String(v));
    return Number.isFinite(ms) && ms > 0 ? relTime(ms) : '';
  }
  function isFlagged(t: Ticket): boolean {
    return !!(investigateProperty && t.properties?.[investigateProperty] === 'true');
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
      stopSummaryPolling();
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
        <div class="mode-toggle" role="group" aria-label="Support view">
          <button class="mode-btn" class:active={mode === 'ask'} aria-pressed={mode === 'ask'} type="button" onclick={() => setMode('ask')}>Ask</button>
          <button class="mode-btn" class:active={mode === 'inbox'} aria-pressed={mode === 'inbox'} type="button" onclick={() => setMode('inbox')}>Inbox</button>
        </div>
        {#if mode === 'ask'}
          <button class="ghost-btn" type="button" onclick={() => drawerOpen = !drawerOpen}>
            ⌖ recents
            {#if history.length > 0}<span class="badge-count">{history.length}</span>{/if}
          </button>
        {/if}
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

  {#if mode === 'ask'}
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
      <button class="primary-btn" disabled={streaming} onclick={() => ask()}>Ask →</button>
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
  {/if}

  {#if mode === 'inbox'}
    {@render inbox()}
  {/if}

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

{#snippet inbox()}
  <section class="panel inbox-status">
    <div class="panel-title">
      <span>HubSpot tickets</span>
      <button class="ghost-btn sm" type="button" disabled={inboxLoading} onclick={loadTickets}>
        {inboxLoading ? 'loading…' : '↻ refresh'}
      </button>
    </div>
    <div class="status-row">
      {#if summary?.lastScan}
        <span class="stat"><b>{summary.lastScan.scanned}</b> scanned</span>
        <span class="stat"><b>{summary.lastScan.investigated}</b> investigated</span>
        <span class="stat"><b>{summary.lastScan.skipped}</b> skipped</span>
        <span class="stat" class:err={summary.lastScan.errors > 0}><b>{summary.lastScan.errors}</b> errors</span>
        <span class="stat muted">
          {summary.inProgress ? 'scanning…' : (summary.lastScan.finishedAt ? `last scan ${relTime(summary.lastScan.finishedAt)}` : '')}
        </span>
        {#if summary.lastScan.error}<span class="stat err" title={summary.lastScan.error}>scan error</span>{/if}
      {:else}
        <span class="stat muted">auto-investigate idle (set HUBSPOT_AUTO_INVESTIGATE=true to enable)</span>
      {/if}
    </div>
  </section>

  <div class="inbox-grid">
    <section class="panel inbox-list">
      <div class="filter-bar">
        <div class="seg">
          <button class="seg-btn" class:active={inboxFilter === 'all'} type="button" onclick={() => inboxFilter = 'all'}>All</button>
          <button class="seg-btn" class:active={inboxFilter === 'flagged'} type="button" onclick={() => inboxFilter = 'flagged'}>AI-flagged</button>
        </div>
        <input class="search-input" type="search" placeholder="search subject / content" bind:value={inboxSearch} />
      </div>
      {#if ticketsError}
        <div class="terminal error">{ticketsError}</div>
      {/if}
      {#if inboxLoading && tickets.length === 0}
        <div class="list-empty">loading tickets…</div>
      {:else if filteredTickets.length === 0}
        <div class="list-empty">no tickets{inboxSearch || inboxFilter === 'flagged' ? ' match the filter' : ''}</div>
      {:else}
        <ul class="ticket-list">
          {#each filteredTickets as t (t.id)}
            <li>
              <button type="button" class="ticket-row" class:active={t.id === selectedId} onclick={() => selectTicket(t.id)}>
                <span class="ticket-ico">TKT</span>
                <span class="ticket-main">
                  <span class="ticket-subj">{ticketSubject(t)}</span>
                  <span class="ticket-meta">
                    {#if t.properties?.hs_pipeline_stage}<span class="chip">{t.properties.hs_pipeline_stage}</span>{/if}
                    {#if isFlagged(t)}<span class="chip ai">AI</span>{/if}
                    {#if ticketAge(t)}<span class="ticket-time">{ticketAge(t)}</span>{/if}
                  </span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="panel inbox-detail">
      {#if !selectedId}
        <div class="list-empty">select a ticket to view its detail and run Investigate / Draft</div>
      {:else if detailLoading}
        <div class="list-empty">loading ticket…</div>
      {:else if selectedTicket}
        <div class="detail-head">
          <div class="detail-title">{ticketSubject(selectedTicket)}</div>
          <a class="ghost-btn sm" href={ticketUrlFor(selectedTicket.id)} target="_blank" rel="noreferrer noopener">open in HubSpot ↗</a>
        </div>
        <div class="detail-actions">
          <button class="primary-btn" disabled={streaming} onclick={() => runTicketAction('investigate')}>Investigate</button>
          <button class="ghost-btn" disabled={streaming} onclick={() => runTicketAction('summarise')}>Summarise</button>
          <button class="ghost-btn" disabled={streaming} onclick={() => runTicketAction('draft')}>Draft reply</button>
          <button class="ghost-btn" type="button" onclick={viewNote}>View AI note</button>
          {#if streaming}<button class="ghost-btn" type="button" onclick={cancel}>Cancel</button>{/if}
          {#if cachedLabel}<span class="chip cached">{cachedLabel}</span>{/if}
        </div>

        {#if selectedTicket.properties?.content}
          <div class="detail-body">{selectedTicket.properties.content}</div>
        {/if}

        <div class="panel-body">
          <div bind:this={answerEl} class="answer placeholder">Run Investigate or Draft to see the streamed answer here.</div>
          {#if terminal}<div class="terminal" class:error={terminal.isError}>{terminal.text}</div>{/if}
        </div>

        {#if noteBody}
          <div class="note-box">
            <div class="note-head">AI investigation note</div>
            <div class="note-body">{noteBody}</div>
          </div>
        {/if}

        <div class="timeline">
          <div class="timeline-head">Timeline {selectedCapped ? '(truncated — too many engagements)' : `(${selectedEngagements.length})`}</div>
          {#each selectedEngagements as e, i (i)}
            {@const expandable = !isRedacted(e) && e.body.length > e.bodyPreview.length}
            {@const open = expandedTl.has(i)}
            <div class="tl-item" class:open>
              <button
                type="button"
                class="tl-row"
                disabled={!expandable}
                aria-expanded={expandable ? open : undefined}
                onclick={() => toggleTl(i)}
              >
                <span class="tl-head">
                  <span class="tl-type" class:ai={e.isInvestigationNote}>{engagementLabel(e.type)}</span>
                  {#if e.isInvestigationNote}<span class="tl-ai">AI</span>{/if}
                  <span class="tl-spacer"></span>
                  {#if e.timestamp}<span class="tl-time">{relTime(e.timestamp)}</span>{/if}
                  {#if expandable}<span class="tl-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>{/if}
                </span>
                {#if !open}<span class="tl-preview" class:muted={isRedacted(e)}>{tlPreview(e)}</span>{/if}
              </button>
              {#if open}<div class="tl-body">{e.body}</div>{/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>
  </div>
{/snippet}

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
    overflow-wrap: anywhere;
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

  /* --- inbox sub-view ------------------------------------------------------ */
  .mode-toggle { display: inline-flex; border: 1px solid var(--border-primary); border-radius: 6px; overflow: hidden; }
  .mode-btn {
    background: transparent; color: var(--text-muted); border: 0;
    padding: 5px 12px; font-size: 11px; cursor: pointer;
    font-family: 'IBM Plex Mono', monospace;
  }
  .mode-btn.active { background: var(--support-accent); color: var(--bg-deep); font-weight: 600; }

  .ghost-btn.sm { padding: 3px 8px; font-size: 10px; }

  .status-row { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; padding: 4px 2px; }
  .stat { font-size: 12px; color: var(--text-primary); }
  .stat b { color: var(--text-heading); }
  .stat.muted { color: var(--text-muted); }
  .stat.err b, .stat.err { color: var(--danger); }

  .inbox-grid { display: grid; grid-template-columns: minmax(280px, 360px) 1fr; gap: 16px; align-items: start; }
  /* min-width:0 lets each grid track shrink below its content's intrinsic width;
     without it a long unbreakable string (URL, email body) forces the column
     wider than the page and spawns a horizontal scrollbar. */
  .inbox-list, .inbox-detail { min-width: 0; }
  @media (max-width: 820px) { .inbox-grid { grid-template-columns: 1fr; } }

  .filter-bar { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .seg { display: inline-flex; border: 1px solid var(--border-primary); border-radius: 6px; overflow: hidden; }
  .seg-btn { background: transparent; color: var(--text-muted); border: 0; padding: 4px 10px; font-size: 11px; cursor: pointer; }
  .seg-btn.active { background: var(--support-accent-soft); color: var(--support-accent); }
  .search-input {
    flex: 1; min-width: 140px; background: var(--bg-deep);
    border: 1px solid var(--border-primary); color: var(--text-primary);
    padding: 5px 10px; border-radius: 6px; font-size: 12px;
  }
  .search-input:focus { outline: none; border-color: var(--support-accent); }

  .list-empty { color: var(--text-muted); font-size: 12px; padding: 16px 4px; }

  .ticket-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; max-height: 60vh; overflow-y: auto; }
  .ticket-row {
    display: flex; gap: 10px; align-items: flex-start; width: 100%; text-align: left;
    background: var(--bg-deep); border: 1px solid var(--border-primary); border-radius: 8px;
    padding: 8px 10px; cursor: pointer; color: var(--text-primary);
  }
  .ticket-row:hover { border-color: var(--support-accent-dim); }
  .ticket-row.active { border-color: var(--support-accent); background: var(--support-accent-soft); }
  .ticket-ico {
    font-family: 'IBM Plex Mono', monospace; font-size: 9px; font-weight: 700;
    color: var(--support-accent); border: 1px solid var(--support-accent-dim);
    border-radius: 4px; padding: 2px 4px; margin-top: 1px;
  }
  .ticket-main { display: grid; gap: 4px; min-width: 0; flex: 1; }
  .ticket-subj { font-size: 12px; color: var(--text-heading); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ticket-meta { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .ticket-time { font-size: 10px; color: var(--text-muted); }
  .chip {
    font-size: 10px; padding: 1px 6px; border-radius: 999px;
    border: 1px solid var(--border-primary); color: var(--text-muted);
  }
  .chip.ai { color: var(--support-accent); border-color: var(--support-accent-dim); }
  .chip.cached { color: var(--info); border-color: var(--info); }

  .detail-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 10px; }
  .detail-title { font-size: 14px; font-weight: 600; color: var(--text-heading); }
  .detail-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
  .detail-body {
    background: var(--bg-deep); border: 1px solid var(--border-primary); border-radius: 8px;
    padding: 10px 12px; font-size: 12px; color: var(--text-primary);
    white-space: pre-wrap; overflow-wrap: anywhere;
    max-height: 220px; overflow-y: auto; margin-bottom: 12px;
  }

  .note-box { border: 1px solid var(--support-accent-dim); border-radius: 8px; margin: 12px 0; }
  .note-head { background: var(--support-accent-soft); color: var(--support-accent); font-size: 11px; padding: 5px 10px; }
  .note-body { padding: 10px 12px; font-size: 12px; white-space: pre-wrap; color: var(--text-primary); max-height: 260px; overflow-y: auto; }

  .timeline { margin-top: 14px; border-top: 1px solid var(--border-primary); padding-top: 12px; display: flex; flex-direction: column; gap: 3px; }
  .timeline-head { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
  .tl-item { border: 1px solid transparent; border-radius: 6px; }
  .tl-item.open { border-color: var(--border-primary); background: var(--bg-deep); }
  .tl-row { display: flex; flex-direction: column; gap: 4px; width: 100%; padding: 7px 9px; text-align: left; background: none; border: none; color: inherit; font: inherit; border-radius: 6px; }
  .tl-row:not(:disabled) { cursor: pointer; }
  .tl-row:not(:disabled):hover { background: var(--bg-deep); }
  .tl-head { display: flex; align-items: center; gap: 8px; }
  .tl-type { font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-muted); }
  .tl-type.ai { color: var(--support-accent); }
  .tl-ai { font-size: 9px; font-weight: 700; color: var(--support-accent); border: 1px solid var(--support-accent-dim); border-radius: 999px; padding: 0 5px; line-height: 1.5; }
  .tl-spacer { flex: 1 1 auto; }
  .tl-time { flex: none; font-size: 10px; color: var(--text-muted); }
  .tl-chevron { flex: none; font-size: 10px; color: var(--text-muted); }
  .tl-preview { font-size: 12px; line-height: 1.4; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tl-preview.muted { color: var(--text-muted); font-style: italic; }
  .tl-body { color: var(--text-primary); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 1.55; padding: 2px 9px 10px; }
</style>
