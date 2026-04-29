<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Task } from '../lib/types';
  import { getTaskOutput } from '../stores/tasks.svelte';
  import { parseScanProgress, formatDuration, formatEta } from '../lib/videoscan-progress';

  let { task }: { task: Task } = $props();

  let now = $state(Date.now());
  const tick = setInterval(() => { now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(tick));

  let output = $derived(getTaskOutput(task.id));
  let progress = $derived(parseScanProgress(output, task.context?.maxPages ?? 0));

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
</script>

<div class="vsp-card">
  <div class="vsp-head">
    <span class="vsp-dot" class:running={isRunning}></span>
    <span class="vsp-title">Live progress</span>
    {#if progress.pagesPerMin !== null}
      <span class="vsp-rate">{progress.pagesPerMin.toFixed(1)} pg/min</span>
    {/if}
  </div>

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
</style>
