<script lang="ts">
  import { formatTime } from '../lib/utils';
  import {
    getProcesses,
    isLoading,
    fetchProcesses,
    killProcess,
    killOldProcesses,
    killAllProcesses,
  } from '../stores/processes.svelte';
  import { getSearchQuery, matchesSearch } from '../stores/search.svelte';
  import { showToast, showConfirm } from '../stores/toast.svelte';
  import { readPreference, writePreference } from '../lib/preferences';

  let allProcesses = $derived(getProcesses());
  let loading = $derived(isLoading());
  let searchQuery = $derived(getSearchQuery());
  let processes = $derived.by(() => {
    if (!searchQuery) return allProcesses;
    return allProcesses.filter(p => matchesSearch(searchQuery, p.pid, p.taskId, p.taskType, p.repo));
  });

  async function handleKill(pid: number) {
    if (!await showConfirm(`Kill process ${pid}?`)) return;
    try {
      await killProcess(pid);
    } catch (err) {
      showToast('Failed to kill process', 'error');
    }
  }

  async function handleKillOld() {
    if (!await showConfirm('Kill Orch task processes older than 2 hours?')) return;
    try {
      await killOldProcesses();
    } catch (err) {
      showToast('Failed to kill old processes', 'error');
    }
  }

  async function handleKillAll() {
    if (!await showConfirm('Kill all Orch task processes?')) return;
    try {
      await killAllProcesses();
    } catch (err) {
      showToast('Failed to kill processes', 'error');
    }
  }

  const CARD_ID = 'processes';
  const COLLAPSED_KEY = 'orch.dashboard.cards.collapsed';
  function getCollapsedCards(): string[] {
    return readPreference(COLLAPSED_KEY, [] as string[], (v): v is string[] => Array.isArray(v));
  }
  let cardCollapsed = $state(getCollapsedCards().includes(CARD_ID));
  function toggleCard() {
    cardCollapsed = !cardCollapsed;
    const current = getCollapsedCards();
    const next = cardCollapsed ? [...new Set([...current, CARD_ID])] : current.filter(id => id !== CARD_ID);
    writePreference(COLLAPSED_KEY, next);
  }
</script>

<div class="card" class:collapsed={cardCollapsed}>
  <h2 class="process-header" onclick={toggleCard}>
    <span>Processes</span>
    <div class="process-actions" onclick={e => e.stopPropagation()}>
      <button class="action-btn secondary" onclick={fetchProcesses}>Refresh</button>
      <button class="action-btn kill-old" onclick={handleKillOld}>Kill Old (2h+)</button>
      <button class="action-btn kill-all" onclick={handleKillAll}>Kill All</button>
    </div>
  </h2>
  {#if !cardCollapsed}
  <div class="card-body">
  <div class="card-list" style="max-height:300px;">
    {#if loading}
      <div class="empty">Loading...</div>
    {:else if processes.length === 0}
      <div class="empty">Click Refresh to load</div>
    {:else}
      {#each processes as p (p.pid)}
        {@const age = p.startTime ? formatTime(p.startTime) : 'unknown'}
        {@const taskInfo = p.taskId ? `Task #${p.taskId} (${p.taskType})` : 'Unknown task'}
        <div class="item" style="grid-template-columns: 1fr auto;">
          <div class="item-info">
            <div class="item-title">{taskInfo} - PID {p.pid}</div>
            <div class="item-meta">
              {#if p.repo}
                <span>{p.repo}</span>
              {/if}
              <span>Started {age}</span>
            </div>
          </div>
          <div class="item-actions">
            <button class="action-btn kill-btn" onclick={() => handleKill(p.pid)}>Kill</button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
  </div>
  {/if}
</div>

<style>
  .process-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .process-actions {
    display: flex;
    gap: 6px;
  }

  .kill-old {
    background: var(--warning-bg) !important;
    color: var(--warning) !important;
    border: 1px solid #5c3610;
  }

  .kill-old:hover {
    background: #3a1f0c !important;
  }

  .kill-all {
    background: var(--danger-bg) !important;
    color: var(--danger) !important;
    border: 1px solid #5c1010;
  }

  .kill-all:hover {
    background: #3a0f0f !important;
  }

  .kill-btn {
    background: var(--danger-bg) !important;
    color: var(--danger) !important;
    border: 1px solid #5c1010;
  }

  .kill-btn:hover {
    background: #3a0f0f !important;
  }
</style>
