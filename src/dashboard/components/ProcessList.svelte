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

  let processes = $derived(getProcesses());
  let loading = $derived(isLoading());

  async function handleKill(pid: number) {
    if (!confirm(`Kill process ${pid}?`)) return;
    try {
      await killProcess(pid);
    } catch (err) {
      alert('Failed to kill process');
    }
  }

  async function handleKillOld() {
    if (!confirm('Kill Orch task processes older than 2 hours?')) return;
    try {
      await killOldProcesses();
    } catch (err) {
      alert('Failed to kill old processes');
    }
  }

  async function handleKillAll() {
    if (!confirm('Kill all Orch task processes?')) return;
    try {
      await killAllProcesses();
    } catch (err) {
      alert('Failed to kill processes');
    }
  }
</script>

<div class="card" style="margin-top: 24px;">
  <h2 class="process-header">
    <span>Processes</span>
    <div class="process-actions">
      <button class="action-btn secondary" onclick={fetchProcesses}>Refresh</button>
      <button class="action-btn kill-old" onclick={handleKillOld}>Kill Old (2h+)</button>
      <button class="action-btn kill-all" onclick={handleKillAll}>Kill All</button>
    </div>
  </h2>
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

<style>
  .process-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .process-actions {
    display: flex;
    gap: 8px;
  }

  .kill-old {
    background: #f0883e !important;
  }

  .kill-all {
    background: #f85149 !important;
  }

  .kill-btn {
    background: #f85149 !important;
  }
</style>
