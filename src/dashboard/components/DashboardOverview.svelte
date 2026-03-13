<script lang="ts">
  import { getUsage, formatResetTime } from '../stores/usage.svelte';
  import { getPRs, getWorkItems } from '../stores/workItems.svelte';
  import { getTasks } from '../stores/tasks.svelte';
  import { getScans, fetchScans } from '../stores/videoscan.svelte';
  import { getOrchestratorState } from '../stores/orchestrator.svelte';
  import { navigate } from '../lib/router.svelte';
  import { onMount } from 'svelte';

  let usage = $derived(getUsage());
  let usage5h = $derived(Math.round(usage?.five_hour?.utilization ?? 0));
  let usage7d = $derived(Math.round(usage?.seven_day?.utilization ?? 0));
  let reset5h = $derived(formatResetTime(usage?.five_hour?.resets_at));
  let reset7d = $derived(formatResetTime(usage?.seven_day?.resets_at));

  let workItems = $derived(getWorkItems());
  let prs = $derived(getPRs());
  let tasks = $derived(getTasks());
  let scans = $derived(getScans());
  let orch = $derived(getOrchestratorState());

  // Work item counts by state
  let wiCounts = $derived.by(() => {
    const counts = { new: 0, active: 0, resolved: 0, reviewed: 0, total: 0 };
    for (const wi of workItems) {
      const s = wi.state.toLowerCase();
      if (s === 'completed' || s === 'done' || s === 'closed') continue;
      counts.total++;
      if (s === 'new' || s === 'to do') counts.new++;
      else if (s === 'active' || s === 'in progress') counts.active++;
      else if (s === 'resolved') counts.resolved++;
      else if (s === 'reviewed') counts.reviewed++;
    }
    return counts;
  });

  // PR counts by role
  let prCounts = $derived.by(() => {
    const counts = { author: 0, reviewer: 0, total: 0 };
    for (const pr of prs) {
      counts.total++;
      if (pr.role === 'author') counts.author++;
      else counts.reviewer++;
    }
    return counts;
  });

  // Task counts by status
  let taskCounts = $derived.by(() => {
    const counts = { running: 0, pending: 0, completed: 0, failed: 0, suggestion: 0, total: 0 };
    for (const t of tasks) {
      counts.total++;
      if (t.status === 'running') counts.running++;
      else if (t.status === 'pending' || t.status === 'needs-repo') counts.pending++;
      else if (t.status === 'completed') counts.completed++;
      else if (t.status === 'failed') counts.failed++;
      else if (t.status === 'suggestion') counts.suggestion++;
    }
    return counts;
  });

  let runningTasks = $derived(tasks.filter(t => t.status === 'running'));

  // Videoscan summary
  let scanSummary = $derived.by(() => {
    const totalPages = scans.reduce((sum, s) => sum + s.pagesScanned, 0);
    const totalWithVideo = scans.reduce((sum, s) => sum + s.pagesWithVideo, 0);
    return { count: scans.length, totalPages, totalWithVideo };
  });

  // Orchestrator pending actions
  let pendingActions = $derived(orch.actions.filter(a => !a.accepted && !a.dismissed));

  function usageColor(pct: number): string {
    if (pct >= 90) return 'var(--danger)';
    if (pct >= 70) return 'var(--warning)';
    return 'var(--success)';
  }

  onMount(() => {
    fetchScans();
  });
</script>

<div class="dash overview">
  <!-- Claude Usage -->
  <div class="card summary-card">
    <h2>Claude Usage</h2>
    <div class="card-body usage-card">
      <div class="usage-row">
        <span class="usage-label">5-hour</span>
        <div class="usage-bar-wrap">
          <div class="usage-bar" style="width: {usage5h}%; background: {usageColor(usage5h)}"></div>
        </div>
        <span class="usage-pct" style="color: {usageColor(usage5h)}">{usage5h}%</span>
      </div>
      <span class="usage-reset">{reset5h}</span>
      <div class="usage-row">
        <span class="usage-label">7-day</span>
        <div class="usage-bar-wrap">
          <div class="usage-bar" style="width: {usage7d}%; background: {usageColor(usage7d)}"></div>
        </div>
        <span class="usage-pct" style="color: {usageColor(usage7d)}">{usage7d}%</span>
      </div>
      <span class="usage-reset">{reset7d}</span>
    </div>
  </div>

  <!-- Tickets -->
  <button class="card summary-card clickable" onclick={() => navigate('/tickets')}>
    <h2>Tickets</h2>
    <div class="card-body">
      <div class="stat-grid">
        <div class="stat">
          <span class="stat-value">{wiCounts.total}</span>
          <span class="stat-label">total</span>
        </div>
        <div class="stat">
          <span class="stat-value state-new">{wiCounts.new}</span>
          <span class="stat-label">new</span>
        </div>
        <div class="stat">
          <span class="stat-value state-active">{wiCounts.active}</span>
          <span class="stat-label">active</span>
        </div>
        <div class="stat">
          <span class="stat-value state-resolved">{wiCounts.resolved}</span>
          <span class="stat-label">resolved</span>
        </div>
        <div class="stat">
          <span class="stat-value state-reviewed">{wiCounts.reviewed}</span>
          <span class="stat-label">reviewed</span>
        </div>
      </div>
    </div>
  </button>

  <!-- Pull Requests -->
  <button class="card summary-card clickable" onclick={() => navigate('/tickets')}>
    <h2>Pull Requests</h2>
    <div class="card-body">
      <div class="stat-grid">
        <div class="stat">
          <span class="stat-value">{prCounts.total}</span>
          <span class="stat-label">open</span>
        </div>
        <div class="stat">
          <span class="stat-value" style="color: #a371f7">{prCounts.author}</span>
          <span class="stat-label">author</span>
        </div>
        <div class="stat">
          <span class="stat-value" style="color: var(--warning)">{prCounts.reviewer}</span>
          <span class="stat-label">reviewer</span>
        </div>
      </div>
    </div>
  </button>

  <!-- Tasks -->
  <button class="card summary-card clickable" onclick={() => navigate('/tickets')}>
    <h2>Tasks</h2>
    <div class="card-body">
      <div class="stat-grid">
        <div class="stat">
          <span class="stat-value" style="color: var(--success)">{taskCounts.running}</span>
          <span class="stat-label">running</span>
        </div>
        <div class="stat">
          <span class="stat-value" style="color: var(--info)">{taskCounts.pending}</span>
          <span class="stat-label">pending</span>
        </div>
        <div class="stat">
          <span class="stat-value">{taskCounts.completed}</span>
          <span class="stat-label">completed</span>
        </div>
        {#if taskCounts.failed > 0}
          <div class="stat">
            <span class="stat-value" style="color: var(--danger)">{taskCounts.failed}</span>
            <span class="stat-label">failed</span>
          </div>
        {/if}
        {#if taskCounts.suggestion > 0}
          <div class="stat">
            <span class="stat-value" style="color: #a371f7">{taskCounts.suggestion}</span>
            <span class="stat-label">suggestions</span>
          </div>
        {/if}
      </div>
      {#if runningTasks.length > 0}
        <div class="running-list">
          {#each runningTasks as task (task.id)}
            <div class="running-task">
              <span class="running-dot"></span>
              <span class="running-name">{task.context?.title || task.type}</span>
              <span class="running-repo">{task.repo}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </button>

  <!-- Videoscans -->
  <button class="card summary-card clickable" onclick={() => navigate('/videoscan')}>
    <h2>Videoscans</h2>
    <div class="card-body">
      <div class="stat-grid">
        <div class="stat">
          <span class="stat-value">{scanSummary.count}</span>
          <span class="stat-label">scans</span>
        </div>
        <div class="stat">
          <span class="stat-value">{scanSummary.totalPages}</span>
          <span class="stat-label">pages</span>
        </div>
        <div class="stat">
          <span class="stat-value" style="color: var(--success)">{scanSummary.totalWithVideo}</span>
          <span class="stat-label">with video</span>
        </div>
      </div>
    </div>
  </button>

  <!-- Orchestrator -->
  <div class="card summary-card">
    <h2>Orchestrator</h2>
    <div class="card-body">
      <div class="orch-status">
        <span class="orch-dot" class:running={orch.status !== 'idle'}></span>
        <span class="orch-label">{orch.status}</span>
        {#if pendingActions.length > 0}
          <span class="orch-pending">{pendingActions.length} pending</span>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .dash {
    --accent: #f59e0b;
    --accent-bright: #fbbf24;
    --accent-dim: #92400e;
    --accent-glow: rgba(245, 158, 11, 0.15);
  }

  .overview {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }

  .summary-card {
    border: none;
    text-align: left;
    font: inherit;
    cursor: default;
    border-left: 3px solid var(--accent-dim);
    transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s;
  }

  .summary-card.clickable {
    cursor: pointer;
  }

  .summary-card.clickable:hover {
    transform: translateY(-1px);
    border-left-color: var(--accent);
    box-shadow: 0 0 20px var(--accent-glow);
  }

  .card-body {
    padding: 14px 18px;
  }

  /* Usage */
  .usage-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .usage-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .usage-label {
    font-size: 11px;
    color: var(--text-muted);
    min-width: 42px;
    font-family: 'IBM Plex Mono', monospace;
  }

  .usage-bar-wrap {
    flex: 1;
    height: 10px;
    background: var(--bg-raised);
    border-radius: 5px;
    overflow: hidden;
  }

  .usage-bar {
    height: 100%;
    border-radius: 5px;
    transition: width 0.3s;
  }

  .usage-pct {
    font-size: 13px;
    font-weight: 600;
    min-width: 36px;
    text-align: right;
    font-family: 'IBM Plex Mono', monospace;
  }

  .usage-reset {
    font-size: 10px;
    color: var(--text-dim);
    margin-left: 52px;
  }

  /* Stats */
  .stat-grid {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 40px;
  }

  .stat-value {
    font-size: 24px;
    font-weight: 700;
    color: var(--text-heading);
    font-family: 'IBM Plex Mono', monospace;
    line-height: 1;
  }

  .stat-label {
    font-size: 10px;
    color: var(--text-dim);
    margin-top: 4px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .state-new { color: var(--info); }
  .state-active { color: var(--success); }
  .state-resolved { color: var(--text-muted); }
  .state-reviewed { color: #a371f7; }

  /* Running tasks */
  .running-list {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-top: 1px solid var(--border-subtle);
    padding-top: 10px;
  }

  .running-task {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    border-left: 2px solid var(--success);
    padding-left: 8px;
  }

  .running-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--success);
    flex-shrink: 0;
    animation: pulse 2s infinite;
  }

  .running-name {
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .running-repo {
    color: var(--text-dim);
    margin-left: auto;
    flex-shrink: 0;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* Orchestrator */
  .orch-status {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .orch-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-dim);
  }

  .orch-dot.running {
    background: var(--success);
    animation: pulse 2s infinite;
  }

  .orch-label {
    font-size: 13px;
    color: var(--text-primary);
    text-transform: capitalize;
  }

  .orch-pending {
    font-size: 11px;
    background: var(--warning-bg);
    color: var(--warning);
    padding: 2px 8px;
    border-radius: 4px;
    font-weight: 500;
  }
</style>
