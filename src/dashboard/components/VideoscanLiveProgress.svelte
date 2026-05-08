<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Task } from '../lib/types';
  import { getTaskOutput, setVideoscanControl, pauseVideoscanTask, resumeVideoscanTask } from '../stores/tasks.svelte';
  import { parseScanProgress, formatDuration, formatEta } from '../lib/videoscan-progress';

  let { task }: { task: Task } = $props();

  let now = $state(Date.now());
  const tick = setInterval(() => { now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(tick));

  let output = $derived(getTaskOutput(task.id));
  let progress = $derived(parseScanProgress(output, task.context?.maxPages ?? 0));

  let concInput = $state<number | null>(null);
  let concBusy = $state(false);
  let concError = $state<string | null>(null);

  let displayConc = $derived(progress.baseConcurrency ?? progress.concurrency ?? task.context?.concurrency ?? null);

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

  let pct = $derived.by(() => {
    if (!progress.maxPages) return 0;
    return Math.min(100, (progress.visited / progress.maxPages) * 100);
  });

  let isRunning = $derived(task.status === 'running' || task.status === 'pending');
  let isPaused = $derived(task.status === 'paused');
  // Explicit-URL scans (Digi imports / URL list batches) can't be paused yet —
  // scanExplicitUrls' resume path isn't implemented; we'd silently drop the unvisited URLs.
  let canPause = $derived(!task.context?.urls?.length);

  let pauseBusy = $state(false);
  let pauseError = $state<string | null>(null);

  async function handlePause() {
    pauseBusy = true;
    pauseError = null;
    try {
      await pauseVideoscanTask(task.id);
    } catch (err) {
      pauseError = err instanceof Error ? err.message : String(err);
    } finally {
      pauseBusy = false;
    }
  }

  async function handleResume() {
    pauseBusy = true;
    pauseError = null;
    try {
      await resumeVideoscanTask(task.id);
    } catch (err) {
      pauseError = err instanceof Error ? err.message : String(err);
    } finally {
      pauseBusy = false;
    }
  }
</script>

<div class="vsp-card" class:paused={isPaused}>
  <div class="vsp-head">
    <span class="vsp-dot" class:running={isRunning} class:paused={isPaused}></span>
    <span class="vsp-title">{isPaused ? 'Paused' : 'Live progress'}</span>
    {#if progress.pagesPerMin !== null && !isPaused}
      <span class="vsp-rate">{progress.pagesPerMin.toFixed(1)} pg/min</span>
    {/if}
    {#if isRunning && canPause}
      <button class="vsp-pause-btn" onclick={handlePause} disabled={pauseBusy} title="Pause this scan — state is saved so you can resume later">
        {pauseBusy ? '…' : '⏸ Pause'}
      </button>
    {:else if isPaused}
      <button class="vsp-pause-btn vsp-resume-btn" onclick={handleResume} disabled={pauseBusy} title="Resume this paused scan">
        {pauseBusy ? '…' : '▶ Resume'}
      </button>
    {/if}
  </div>
  {#if pauseError}
    <div class="vsp-pause-err">{pauseError}</div>
  {/if}

  <div class="vsp-bar-wrap">
    <div class="vsp-bar" style="width: {pct}%"></div>
  </div>

  <div class="vsp-grid">
    <div class="vsp-stat">
      <div class="vsp-num">{progress.visited.toLocaleString()}</div>
      <div class="vsp-lbl">Scanned{progress.maxPages ? ` / ${progress.maxPages.toLocaleString()}` : ''}</div>
    </div>
    <div class="vsp-stat">
      <div class="vsp-num">{progress.queue.toLocaleString()}</div>
      <div class="vsp-lbl">In queue</div>
    </div>
    <div class="vsp-stat">
      <div class="vsp-num">{formatDuration(elapsedSec)}</div>
      <div class="vsp-lbl">Elapsed</div>
    </div>
    <div class="vsp-stat">
      <div class="vsp-num eta">{formatEta(progress.etaMin)}</div>
      <div class="vsp-lbl">Est. left</div>
    </div>
  </div>

  {#if isRunning}
    <div class="vsp-conc">
      <div class="vsp-conc-row">
        <span class="vsp-conc-lbl">Concurrency</span>
        <span class="vsp-conc-val">
          {displayConc ?? '?'}
          {#if progress.concurrency !== null && progress.baseConcurrency !== null && progress.concurrency !== progress.baseConcurrency}
            <span class="vsp-conc-cur">(now {progress.concurrency})</span>
          {/if}
        </span>
        <button class="vsp-btn" onclick={() => bumpConc(-1)} disabled={concBusy}>−</button>
        <button class="vsp-btn" onclick={() => bumpConc(+1)} disabled={concBusy}>+</button>
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
          class="vsp-btn vsp-btn-apply"
          onclick={() => concInput && applyConc(concInput)}
          disabled={concBusy || !concInput}
        >Set</button>
      </div>
      {#if concError}
        <div class="vsp-conc-err">{concError}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .vsp-card {
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    padding: 12px 14px;
    margin-bottom: 8px;
  }
  .vsp-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin-bottom: 10px;
  }
  .vsp-title { flex: 1; }
  .vsp-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-muted);
  }
  .vsp-dot.running {
    background: var(--accent, #06b6d4);
    box-shadow: 0 0 0 0 rgba(6, 182, 212, 0.6);
    animation: vsp-pulse 1.6s ease-out infinite;
  }
  .vsp-dot.paused {
    background: #f59e0b;
    animation: none;
  }
  .vsp-card.paused {
    border-left: 3px solid #f59e0b;
  }
  .vsp-pause-btn {
    margin-left: 6px;
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid rgba(245, 158, 11, 0.4);
    color: #f59e0b;
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
  }
  .vsp-pause-btn:hover:not(:disabled) {
    background: rgba(245, 158, 11, 0.18);
    border-color: #f59e0b;
  }
  .vsp-pause-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .vsp-resume-btn {
    background: rgba(34, 211, 238, 0.08);
    border-color: rgba(34, 211, 238, 0.4);
    color: var(--accent-bright, #22d3ee);
  }
  .vsp-resume-btn:hover:not(:disabled) {
    background: rgba(34, 211, 238, 0.18);
    border-color: var(--accent-bright, #22d3ee);
  }
  .vsp-pause-err {
    margin-bottom: 8px;
    font-size: 11px;
    color: #f87171;
  }
  @keyframes vsp-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0.55); }
    70%  { box-shadow: 0 0 0 8px rgba(6, 182, 212, 0); }
    100% { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0); }
  }
  .vsp-rate {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent, #06b6d4);
    letter-spacing: 0.04em;
  }
  .vsp-bar-wrap {
    height: 6px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 12px;
  }
  .vsp-bar {
    height: 100%;
    background: linear-gradient(90deg, var(--accent, #06b6d4), #22d3ee);
    border-radius: 3px;
    transition: width 0.6s ease;
  }
  .vsp-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 14px;
  }
  .vsp-stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .vsp-num {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 18px;
    font-weight: 700;
    color: var(--text, #c9d5e0);
    line-height: 1.1;
  }
  .vsp-num.eta { color: var(--accent, #06b6d4); }
  .vsp-lbl {
    font-size: 9px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted, #5e7389);
  }
  .vsp-conc {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--border-subtle);
  }
  .vsp-conc-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .vsp-conc-lbl {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin-right: 4px;
  }
  .vsp-conc-val {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    font-weight: 700;
    color: var(--text, #c9d5e0);
    min-width: 24px;
  }
  .vsp-conc-cur {
    font-size: 10px;
    font-weight: 500;
    color: var(--text-muted);
    margin-left: 4px;
  }
  .vsp-btn {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--border-subtle);
    color: var(--text, #c9d5e0);
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 12px;
    cursor: pointer;
    line-height: 1.4;
  }
  .vsp-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
  }
  .vsp-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .vsp-btn-apply {
    background: var(--accent, #06b6d4);
    color: #001;
    border-color: transparent;
    font-weight: 700;
  }
  .vsp-input {
    width: 50px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--border-subtle);
    color: var(--text, #c9d5e0);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .vsp-conc-err {
    margin-top: 6px;
    font-size: 11px;
    color: #f87171;
  }
</style>
