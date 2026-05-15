<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { Task } from '../lib/types';
  import { getTaskOutput } from '../stores/tasks.svelte';
  import { parseScanProgress, formatDuration, effectivePlanned } from '../lib/videoscan-progress';
  import { readPreference, writePreference } from '../lib/preferences';
  import VideoscanLiveProgress from './VideoscanLiveProgress.svelte';

  let { batchId, label, tasks }: { batchId: string; label: string; tasks: Task[] } = $props();

  const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
  let collapsed = $state(
    untrack(() =>
      readPreference<boolean>(`videoscan.batch.collapsed.${batchId}`, tasks.length > 5, isBool)
    )
  );
  let expandedChildren = $state(new Set<number>());

  function toggleCollapsed() {
    collapsed = !collapsed;
    writePreference(`videoscan.batch.collapsed.${batchId}`, collapsed);
  }

  function toggleChild(taskId: number) {
    const next = new Set(expandedChildren);
    if (next.has(taskId)) next.delete(taskId);
    else next.add(taskId);
    expandedChildren = next;
  }

  let now = $state(Date.now());
  const tick = setInterval(() => { now = Date.now(); }, 1000);
  onDestroy(() => clearInterval(tick));

  let perTask = $derived(tasks.map(t => {
    const output = getTaskOutput(t.id);
    const progress = parseScanProgress(output, t.context?.maxPages ?? 0);
    const planned = effectivePlanned(progress, t.context?.urls?.length ?? 0);
    return { task: t, progress, planned };
  }));

  let runningCount = $derived(tasks.filter(t => t.status === 'running').length);
  let pendingCount = $derived(tasks.filter(t => t.status === 'pending').length);
  let pausedCount = $derived(tasks.filter(t => t.status === 'paused').length);
  let totalCount = $derived(tasks.length);

  let totalVisited = $derived(perTask.reduce((s, p) => s + p.progress.visited, 0));
  let totalPlanned = $derived(perTask.reduce((s, p) => s + p.planned, 0));
  let pct = $derived(totalPlanned > 0 ? Math.min(100, (totalVisited / totalPlanned) * 100) : 0);

  let earliestStart = $derived.by(() => {
    let earliest = Infinity;
    for (const t of tasks) {
      const s = t.startedAt || t.createdAt;
      if (!s) continue;
      const ts = new Date(s).getTime();
      if (ts < earliest) earliest = ts;
    }
    return Number.isFinite(earliest) ? earliest : now;
  });
  let elapsedSec = $derived(Math.max(0, (now - earliestStart) / 1000));

  function rowLabel(task: Task): string {
    const u = task.context?.scanUrl || task.context?.urls?.[0];
    if (u) {
      try { return new URL(u).hostname.replace(/^www\./, ''); } catch { /* fall through */ }
    }
    return task.context?.title || `#${task.id}`;
  }
</script>

<div class="vsb-card">
  <button class="vsb-head" onclick={toggleCollapsed} aria-expanded={!collapsed}>
    <span class="vsb-caret" class:open={!collapsed}>▸</span>
    <span class="vsb-dot running"></span>
    <span class="vsb-label">{label}</span>
    <span class="vsb-counts">
      {#if runningCount > 0}<span class="vsb-c run">{runningCount} running</span>{/if}
      {#if pendingCount > 0}<span class="vsb-c pend">{pendingCount} pending</span>{/if}
      {#if pausedCount > 0}<span class="vsb-c paused">{pausedCount} paused</span>{/if}
      <span class="vsb-c tot">{totalCount} total</span>
    </span>
  </button>

  <div class="vsb-bar-wrap">
    <div class="vsb-bar" style="width: {pct}%"></div>
  </div>

  <div class="vsb-meta">
    <span><strong>{totalVisited.toLocaleString()}</strong> pages scanned{totalPlanned > 0 ? ` / ${totalPlanned.toLocaleString()}` : ''}</span>
    <span class="vsb-meta-sep">·</span>
    <span>{formatDuration(elapsedSec)} elapsed</span>
  </div>

  {#if !collapsed}
    <div class="vsb-children">
      {#each perTask as { task, progress, planned } (task.id)}
        {@const exp = expandedChildren.has(task.id)}
        <button class="vsb-row" onclick={() => toggleChild(task.id)}>
          <span class="vsb-row-caret" class:open={exp}>▸</span>
          <span class="vsb-row-status" class:run={task.status === 'running'} class:pend={task.status === 'pending'} class:paused={task.status === 'paused'}></span>
          <span class="vsb-row-label">{rowLabel(task)}</span>
          <span class="vsb-row-pages">
            {progress.visited.toLocaleString()}{planned > 0 ? `/${planned.toLocaleString()}` : ''} pg
          </span>
          <span class="vsb-row-state">{task.status}</span>
        </button>
        {#if exp}
          <div class="vsb-row-detail">
            <VideoscanLiveProgress {task} />
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .vsb-card {
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    padding: 10px 12px 12px;
    margin-bottom: 8px;
  }
  .vsb-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: transparent;
    border: 0;
    padding: 0;
    margin-bottom: 8px;
    cursor: pointer;
    color: inherit;
    text-align: left;
  }
  .vsb-caret {
    font-size: 10px;
    color: var(--text-muted);
    transition: transform 0.15s ease;
    display: inline-block;
    width: 10px;
  }
  .vsb-caret.open { transform: rotate(90deg); }
  .vsb-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text-muted);
    flex-shrink: 0;
  }
  .vsb-dot.running {
    background: var(--accent, #06b6d4);
    box-shadow: 0 0 0 0 rgba(6, 182, 212, 0.6);
    animation: vsb-pulse 1.6s ease-out infinite;
  }
  @keyframes vsb-pulse {
    0%   { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0.55); }
    70%  { box-shadow: 0 0 0 8px rgba(6, 182, 212, 0); }
    100% { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0); }
  }
  .vsb-label {
    flex: 1;
    font-size: 12px;
    font-weight: 700;
    color: var(--text, #c9d5e0);
    letter-spacing: 0.02em;
  }
  .vsb-counts {
    display: flex;
    gap: 6px;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .vsb-c { padding: 2px 6px; border-radius: 4px; }
  .vsb-c.run  { background: rgba(6, 182, 212, 0.15); color: var(--accent, #06b6d4); }
  .vsb-c.pend { background: rgba(255, 255, 255, 0.06); color: var(--text-muted); }
  .vsb-c.paused { background: rgba(245, 158, 11, 0.15); color: #f59e0b; }
  .vsb-c.tot  { background: rgba(255, 255, 255, 0.04); color: var(--text-muted); }
  .vsb-bar-wrap {
    height: 6px;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 8px;
  }
  .vsb-bar {
    height: 100%;
    background: linear-gradient(90deg, var(--accent, #06b6d4), #22d3ee);
    border-radius: 3px;
    transition: width 0.6s ease;
  }
  .vsb-meta {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 10px;
    color: var(--text-muted);
    margin-bottom: 8px;
  }
  .vsb-meta strong {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text, #c9d5e0);
    font-size: 12px;
  }
  .vsb-meta-sep { opacity: 0.4; }
  .vsb-children {
    display: flex;
    flex-direction: column;
    gap: 2px;
    border-top: 1px solid var(--border-subtle);
    padding-top: 8px;
  }
  .vsb-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: transparent;
    border: 0;
    padding: 6px 4px;
    cursor: pointer;
    color: inherit;
    text-align: left;
    border-radius: 4px;
  }
  .vsb-row:hover { background: rgba(255, 255, 255, 0.03); }
  .vsb-row-caret {
    font-size: 9px;
    color: var(--text-muted);
    transition: transform 0.15s ease;
    width: 8px;
  }
  .vsb-row-caret.open { transform: rotate(90deg); }
  .vsb-row-status {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.15);
    flex-shrink: 0;
  }
  .vsb-row-status.run {
    background: var(--accent, #06b6d4);
    box-shadow: 0 0 4px rgba(6, 182, 212, 0.6);
  }
  .vsb-row-status.pend { background: rgba(255, 255, 255, 0.3); }
  .vsb-row-status.paused { background: #f59e0b; }
  .vsb-row-label {
    flex: 1;
    font-size: 11px;
    color: var(--text, #c9d5e0);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vsb-row-pages {
    font-size: 10px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text-muted);
  }
  .vsb-row-state {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-muted);
    letter-spacing: 0.06em;
    min-width: 60px;
    text-align: right;
  }
  .vsb-row-detail {
    padding: 4px 0 8px 16px;
  }
</style>
