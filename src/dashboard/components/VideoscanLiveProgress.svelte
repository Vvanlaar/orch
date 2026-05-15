<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Task } from '../lib/types';
  import { getTaskOutput, setVideoscanControl, pauseVideoscanTask, resumeVideoscanTask } from '../stores/tasks.svelte';
  import { parseScanProgress, formatDuration, effectivePlanned } from '../lib/videoscan-progress';

  let { task, expanded = false, onToggleExpand }: {
    task: Task;
    expanded?: boolean;
    onToggleExpand?: () => void;
  } = $props();

  let now = $state(Date.now());
  const tick = setInterval(() => { now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(tick));

  let output = $derived(getTaskOutput(task.id));
  let progress = $derived(parseScanProgress(output, task.context?.maxPages ?? 0));

  let displayConc = $derived(progress.baseConcurrency ?? progress.concurrency ?? task.context?.concurrency ?? null);

  let showConc = $state(false);
  let concInput = $state<number | null>(null);
  let concBusy = $state(false);
  let concError = $state<string | null>(null);

  // Close the concurrency popover on Escape — outside-click handled by toggling
  // the chip again; the popover is part of the card so most clicks land on it.
  $effect(() => {
    if (!showConc) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') showConc = false;
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function bumpConc(delta: number) {
    const base = displayConc ?? 6;
    await applyConc(Math.max(1, Math.min(64, base + delta)));
  }

  async function applyConc(value: number) {
    concBusy = true;
    concError = null;
    try {
      await setVideoscanControl(task.id, { concurrency: value });
      concInput = null;
    } catch (err) {
      concError = err instanceof Error ? err.message : String(err);
    } finally {
      concBusy = false;
    }
  }

  let startTs = $derived.by(() => {
    const s = task.startedAt || task.createdAt;
    return s ? new Date(s).getTime() : now;
  });
  let elapsedSec = $derived(Math.max(0, (now - startTs) / 1000));

  let planned = $derived(effectivePlanned(progress, task.context?.urls?.length ?? 0));
  let pct = $derived(planned > 0 ? Math.min(100, (progress.visited / planned) * 100) : 0);

  let isRunning = $derived(task.status === 'running' || task.status === 'pending');
  let isPaused = $derived(task.status === 'paused');
  // Explicit-URL scans (Digi imports / URL list batches) can't be paused yet —
  // scanExplicitUrls' resume path isn't implemented; we'd silently drop the unvisited URLs.
  let canPause = $derived(!task.context?.urls?.length);

  let hostname = $derived.by(() => {
    const u = task.context?.scanUrl || task.context?.urls?.[0];
    if (!u) return task.context?.title || `task-${task.id}`;
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
  });

  let pauseBusy = $state(false);
  let pauseError = $state<string | null>(null);

  async function handlePause() {
    pauseBusy = true;
    pauseError = null;
    try { await pauseVideoscanTask(task.id); }
    catch (err) { pauseError = err instanceof Error ? err.message : String(err); }
    finally { pauseBusy = false; }
  }

  async function handleResume() {
    pauseBusy = true;
    pauseError = null;
    try { await resumeVideoscanTask(task.id); }
    catch (err) { pauseError = err instanceof Error ? err.message : String(err); }
    finally { pauseBusy = false; }
  }

  function fmtEta(min: number | null): string {
    if (min === null || !Number.isFinite(min)) return '—';
    if (min < 1) return '<1m';
    if (min < 60) return `${Math.round(min)}m`;
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
</script>

<div class="vsp" class:paused={isPaused}>
  <div class="vsp-head">
    <span class="vsp-dot" class:running={isRunning} class:paused={isPaused}></span>
    <span class="vsp-host" title={hostname}>{hostname}</span>
    <span class="vsp-id">#{task.id}</span>
    {#if onToggleExpand}
      <button class="vsp-log" class:open={expanded} onclick={onToggleExpand} title={expanded ? 'Hide log' : 'Show log'} aria-label="Toggle log">
        log {expanded ? '▾' : '▸'}
      </button>
    {/if}
    {#if isRunning && displayConc !== null}
      <button
        class="vsp-chip"
        class:open={showConc}
        onclick={() => (showConc = !showConc)}
        title="Concurrency"
      >
        <span class="vsp-chip-ico">⚙</span>
        <span>{displayConc}</span>
        {#if progress.concurrency !== null && progress.baseConcurrency !== null && progress.concurrency !== progress.baseConcurrency}
          <span class="vsp-chip-live">→{progress.concurrency}</span>
        {/if}
      </button>
    {/if}
    {#if isRunning && canPause}
      <button class="vsp-pause" onclick={handlePause} disabled={pauseBusy} title="Pause this scan — state is saved" aria-label="Pause">
        {pauseBusy ? '…' : '⏸'}
      </button>
    {:else if isPaused}
      <button class="vsp-pause resume" onclick={handleResume} disabled={pauseBusy} title="Resume" aria-label="Resume">
        {pauseBusy ? '…' : '▶'}
      </button>
    {/if}
  </div>

  {#if pauseError}<div class="vsp-err">{pauseError}</div>{/if}

  <div class="vsp-row">
    <div class="vsp-meter" class:running={isRunning && !isPaused}>
      <div class="vsp-meter-fill" style="width: {pct}%"></div>
    </div>
    <span class="vsp-pct">{pct.toFixed(1)}%</span>
    <span class="vsp-count">{progress.visited.toLocaleString()}{planned ? ` / ${planned.toLocaleString()}` : ''}</span>
  </div>

  <div class="vsp-stats">
    {#if progress.pagesPerMin !== null && !isPaused}
      <span class="vsp-stat"><strong>{progress.pagesPerMin.toFixed(1)}</strong>&nbsp;pg/min</span>
      <span class="vsp-sep">·</span>
    {/if}
    <span class="vsp-stat"><strong>{progress.queue.toLocaleString()}</strong>&nbsp;queued</span>
    <span class="vsp-sep">·</span>
    <span class="vsp-stat"><strong>{formatDuration(elapsedSec)}</strong>&nbsp;elapsed</span>
    {#if progress.etaMin !== null && !isPaused}
      <span class="vsp-sep">·</span>
      <span class="vsp-stat eta">ETA&nbsp;<strong>{fmtEta(progress.etaMin)}</strong></span>
    {/if}
  </div>

  {#if showConc && isRunning}
    <div class="vsp-conc">
      <span class="vsp-conc-lbl">Concurrency</span>
      <button class="vsp-btn" onclick={() => bumpConc(-1)} disabled={concBusy} aria-label="Decrease concurrency">−</button>
      <span class="vsp-conc-val">{displayConc ?? '?'}</span>
      <button class="vsp-btn" onclick={() => bumpConc(+1)} disabled={concBusy} aria-label="Increase concurrency">+</button>
      <input
        class="vsp-input"
        type="number"
        min="1"
        max="64"
        placeholder="set"
        bind:value={concInput}
        disabled={concBusy}
      />
      <button
        class="vsp-btn apply"
        onclick={() => concInput && applyConc(concInput)}
        disabled={concBusy || !concInput}
      >Set</button>
      {#if concError}<span class="vsp-conc-err">{concError}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .vsp {
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    padding: 10px 12px 11px;
    margin-bottom: 6px;
    transition: border-color 0.2s;
  }
  .vsp.paused { border-left: 3px solid #f59e0b; }

  /* === Title row === */
  .vsp-head {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 8px;
  }
  .vsp-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }
  .vsp-dot.running {
    background: var(--accent, #06b6d4);
    box-shadow: 0 0 0 0 rgba(6, 182, 212, 0.6);
    animation: vsp-pulse 1.6s ease-out infinite;
  }
  .vsp-dot.paused { background: #f59e0b; animation: none; }
  @keyframes vsp-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0.55); }
    70%  { box-shadow: 0 0 0 8px rgba(6, 182, 212, 0); }
    100% { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0); }
  }
  .vsp-host {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--text, #c9d5e0);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    letter-spacing: -0.005em;
  }
  .vsp-id {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }
  .vsp-log {
    background: transparent;
    border: 0;
    color: var(--text-muted);
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    cursor: pointer;
    padding: 3px 5px;
    border-radius: 3px;
    line-height: 1;
  }
  .vsp-log:hover { color: var(--text); background: rgba(255,255,255,0.04); }
  .vsp-log.open { color: var(--accent, #06b6d4); }

  /* === Concurrency chip === */
  .vsp-chip {
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border-subtle);
    color: var(--text);
    border-radius: 4px;
    padding: 2px 7px;
    font-size: 10px;
    font-family: ui-monospace, monospace;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
    display: inline-flex; gap: 4px; align-items: center;
    line-height: 1.4;
  }
  .vsp-chip:hover { background: rgba(255,255,255,0.08); color: var(--text); }
  .vsp-chip.open {
    background: var(--accent-dim, #0c3d4a);
    border-color: var(--accent, #06b6d4);
    color: var(--accent-bright, #22d3ee);
  }
  .vsp-chip-ico { opacity: 0.7; font-size: 9px; }
  .vsp-chip-live { color: var(--accent-bright, #22d3ee); font-weight: 600; }

  /* === Pause button === */
  .vsp-pause {
    width: 22px; height: 22px;
    display: inline-grid; place-items: center;
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid rgba(245, 158, 11, 0.4);
    color: #f59e0b;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    padding: 0;
    transition: background 0.15s, border-color 0.15s;
    line-height: 1;
  }
  .vsp-pause:hover:not(:disabled) {
    background: rgba(245, 158, 11, 0.18);
    border-color: #f59e0b;
  }
  .vsp-pause.resume {
    background: rgba(34, 211, 238, 0.08);
    border-color: rgba(34, 211, 238, 0.4);
    color: var(--accent-bright, #22d3ee);
  }
  .vsp-pause.resume:hover:not(:disabled) {
    background: rgba(34, 211, 238, 0.18);
    border-color: var(--accent-bright, #22d3ee);
  }
  .vsp-pause:disabled { opacity: 0.5; cursor: not-allowed; }

  /* === Meter row === */
  .vsp-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }
  .vsp-meter {
    flex: 1;
    height: 8px;
    background: rgba(255,255,255,0.05);
    border-radius: 4px;
    overflow: hidden;
    min-width: 40px;
    position: relative;
  }
  .vsp-meter-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent, #06b6d4), var(--accent-bright, #22d3ee));
    transition: width 0.6s ease;
    box-shadow: 0 0 8px rgba(6,182,212,0.35);
  }
  /* Subtle moving shimmer on running scans — only on the filled portion */
  .vsp-meter.running .vsp-meter-fill::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      transparent 0%,
      rgba(255,255,255,0.18) 50%,
      transparent 100%
    );
    background-size: 200% 100%;
    animation: vsp-shimmer 2.2s linear infinite;
    pointer-events: none;
  }
  @keyframes vsp-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  .vsp-pct {
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: var(--accent-bright, #22d3ee);
    font-weight: 700;
    min-width: 40px;
    text-align: right;
    letter-spacing: 0.02em;
  }
  .vsp-count {
    font-family: ui-monospace, monospace;
    font-size: 10px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  /* === Stats line === */
  .vsp-stats {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    font-size: 10px;
    color: var(--text-muted);
  }
  .vsp-stat strong {
    font-family: ui-monospace, monospace;
    color: var(--text);
    font-weight: 700;
    font-size: 11px;
  }
  .vsp-stat.eta strong { color: var(--accent-bright, #22d3ee); }
  .vsp-sep { opacity: 0.4; }

  /* === Concurrency popover === */
  .vsp-conc {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 9px;
    padding-top: 9px;
    border-top: 1px dashed var(--border-subtle);
  }
  .vsp-conc-lbl {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }
  .vsp-conc-val {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    font-weight: 700;
    color: var(--text);
    min-width: 18px;
    text-align: center;
  }
  .vsp-btn {
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border-subtle);
    color: var(--text);
    border-radius: 3px;
    padding: 2px 8px;
    font-size: 11px;
    cursor: pointer;
    line-height: 1.4;
  }
  .vsp-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08); }
  .vsp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .vsp-btn.apply {
    background: var(--accent, #06b6d4);
    color: #001;
    border-color: transparent;
    font-weight: 700;
  }
  .vsp-input {
    width: 44px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--border-subtle);
    color: var(--text);
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 11px;
    font-family: ui-monospace, monospace;
  }
  .vsp-conc-err { font-size: 10px; color: #f87171; }
  .vsp-err { font-size: 11px; color: #f87171; margin-bottom: 6px; }
</style>
