<script lang="ts">
  import { onMount } from 'svelte';
  import { getScans, fetchScans, startScan, resumeScan, isLoading, type ScanSummary } from '../stores/videoscan.svelte';
  import { getTasks, getTaskOutput, isExpanded, toggleExpanded } from '../stores/tasks.svelte';

  let url = $state('');
  let maxPages = $state(50);
  let concurrency = $state(6);
  let delay = $state(200);
  let starting = $state(false);
  let error = $state('');

  let scans = $derived(getScans());
  let loading = $derived(isLoading());
  let allTasks = $derived(getTasks());
  let videoscanTasks = $derived(allTasks.filter(t => t.type === 'videoscan'));
  let activeTasks = $derived(videoscanTasks.filter(t => t.status === 'running' || t.status === 'pending'));
  let resumableScans = $derived(scans.filter(s => s.canResume));

  onMount(() => { fetchScans(); });

  async function handleStart() {
    if (!url) return;
    starting = true;
    error = '';
    try {
      await startScan(url, maxPages, concurrency, delay);
      url = '';
      setTimeout(() => fetchScans(), 2000);
    } catch (err: any) {
      error = err.message;
    } finally {
      starting = false;
    }
  }

  async function handleResume(scan: ScanSummary) {
    try {
      await resumeScan(scan.filename, maxPages, concurrency, delay);
      setTimeout(() => fetchScans(), 2000);
    } catch (err: any) {
      error = err.message;
    }
  }

  function formatDate(iso: string): string {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
</script>

<div class="videoscan-page">
  <!-- Start scan form -->
  <div class="card">
    <h2>Start Videoscan</h2>
    <div class="form">
      <div class="form-row">
        <input
          type="url"
          class="url-input"
          placeholder="https://www.example.com"
          bind:value={url}
          onkeydown={(e) => e.key === 'Enter' && handleStart()}
        />
        <button class="action-btn" onclick={handleStart} disabled={starting || !url}>
          {starting ? 'Starting...' : 'Start Scan'}
        </button>
      </div>
      <div class="form-row options">
        <label>
          <span>Max pages</span>
          <input type="number" min="1" max="1000" bind:value={maxPages} />
        </label>
        <label>
          <span>Concurrency</span>
          <input type="number" min="1" max="20" bind:value={concurrency} />
        </label>
        <label>
          <span>Delay (ms)</span>
          <input type="number" min="0" max="30000" step="100" bind:value={delay} />
        </label>
      </div>
      {#if error}
        <div class="error-msg">{error}</div>
      {/if}
    </div>
  </div>

  <!-- Active tasks -->
  {#if activeTasks.length > 0}
    <div class="card">
      <h2>Active Scans ({activeTasks.length})</h2>
      <div class="card-list">
        {#each activeTasks as task (task.id)}
          {@const output = getTaskOutput(task.id)}
          {@const expanded = isExpanded(task.id)}
          <div class="item" style="display:block">
            <div class="item-header" onclick={() => toggleExpanded(task.id)}>
              <div class="item-info">
                <span class="item-title">#{task.id} {task.context?.title || 'Videoscan'}</span>
                <span class="badge" class:state-active={task.status === 'running'}
                  class:state-new={task.status === 'pending'}>
                  {task.status}
                </span>
              </div>
            </div>
            {#if expanded && output}
              <pre class="output">{output}</pre>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Resumable scans -->
  {#if resumableScans.length > 0}
    <div class="card">
      <h2>Resume Scan ({resumableScans.length})</h2>
      <div class="card-list">
        {#each resumableScans as scan (scan.filename)}
          <div class="item">
            <div class="item-info">
              <span class="item-title">{scan.domain}</span>
              <span class="item-meta">
                {scan.pagesScanned} pages scanned, {scan.pagesWithVideo} with video
              </span>
            </div>
            <div class="item-actions">
              <button class="action-btn secondary" onclick={() => handleResume(scan)}>Resume</button>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Results -->
  <div class="card">
    <h2 onclick={() => fetchScans()}>
      Scan Results ({scans.length})
    </h2>
    {#if loading}
      <div class="empty">Loading...</div>
    {:else if scans.length === 0}
      <div class="empty">No scans yet. Start one above.</div>
    {:else}
      <div class="card-list" style="max-height:600px">
        {#each scans as scan (scan.filename)}
          <div class="item">
            <div class="item-info">
              <span class="item-title">{scan.domain}</span>
              <span class="item-meta">
                <span>{formatDate(scan.scanDate)}</span>
                <span>{scan.pagesScanned} pages</span>
                <span>{scan.pagesWithVideo} with video</span>
                <span>{scan.uniquePlayers} players</span>
              </span>
            </div>
            <div class="item-actions">
              {#if scan.hasReport}
                <a class="action-btn" href="/api/videoscans/files/{scan.filename.replace('.json', '.html')}" target="_blank">
                  Report
                </a>
              {/if}
              <a class="action-btn secondary" href="/api/videoscans/files/{scan.filename}" target="_blank" download>
                JSON
              </a>
              {#if scan.canResume}
                <button class="action-btn secondary" onclick={() => handleResume(scan)}>Resume</button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Recent videoscan tasks (completed/failed) -->
  {#if videoscanTasks.filter(t => t.status !== 'running' && t.status !== 'pending').length > 0}
    <div class="card">
      <h2>Task History</h2>
      <div class="card-list">
        {#each videoscanTasks.filter(t => t.status !== 'running' && t.status !== 'pending') as task (task.id)}
          {@const output = getTaskOutput(task.id)}
          {@const expanded = isExpanded(task.id)}
          <div class="item" style="display:block">
            <div class="item-header" onclick={() => toggleExpanded(task.id)}>
              <div class="item-info">
                <span class="item-title">#{task.id} {task.context?.title || 'Videoscan'}</span>
                <span class="badge" class:state-active={task.status === 'completed'}
                  class:state-resolved={task.status === 'failed'}>
                  {task.status}
                </span>
              </div>
              <div class="item-meta">
                {task.result || task.error || ''}
              </div>
            </div>
            {#if expanded && (output || task.result)}
              <pre class="output">{output || task.result}</pre>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .videoscan-page {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .form {
    padding: 16px 18px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .form-row {
    display: flex;
    gap: 10px;
    align-items: center;
  }

  .form-row.options {
    gap: 20px;
  }

  .form-row.options label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #8b949e;
  }

  .form-row.options input {
    width: 70px;
    background: #0d1117;
    border: 1px solid #2a313b;
    border-radius: 4px;
    color: #c9d1d9;
    padding: 4px 8px;
    font-size: 12px;
    font-family: 'IBM Plex Mono', monospace;
  }

  .url-input {
    flex: 1;
    background: #0d1117;
    border: 1px solid #2a313b;
    border-radius: 6px;
    color: #c9d1d9;
    padding: 8px 12px;
    font-size: 13px;
    font-family: 'IBM Plex Mono', monospace;
  }

  .url-input:focus {
    outline: none;
    border-color: #1f4a85;
  }

  .url-input::placeholder {
    color: #6e7681;
  }

  .error-msg {
    color: #f85149;
    font-size: 12px;
  }

  .item-header {
    cursor: pointer;
    padding: 10px 18px;
  }

  .item-header:hover {
    background: #1c2128;
  }

  .output {
    background: #0d1117;
    color: #8b949e;
    padding: 12px 18px;
    font-size: 11px;
    font-family: 'IBM Plex Mono', monospace;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 300px;
    overflow-y: auto;
    border-top: 1px solid #21262d;
    margin: 0;
  }

  a.action-btn {
    text-decoration: none;
    display: inline-flex;
    align-items: center;
  }
</style>
