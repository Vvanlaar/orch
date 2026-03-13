<script lang="ts">
  import { onMount } from 'svelte';
  import { getScans, fetchScans, startScan, resumeScan, mergeDomainScans, regenerateReport, isLoading, type ScanSummary } from '../stores/videoscan.svelte';
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
  let historyTasks = $derived(videoscanTasks.filter(t => t.status !== 'running' && t.status !== 'pending'));
  let resumableScans = $derived(scans.filter(s => s.canResume));

  let groupedScans = $derived.by(() => {
    const groups = new Map<string, ScanSummary[]>();
    for (const scan of scans) {
      if (!groups.has(scan.domain)) groups.set(scan.domain, []);
      groups.get(scan.domain)!.push(scan);
    }
    return groups;
  });
  let collapsedDomains = $state(new Set<string>());

  let totalPages = $derived(scans.reduce((s, scan) => s + scan.pagesScanned, 0));
  let totalWithVideo = $derived(scans.reduce((s, scan) => s + scan.pagesWithVideo, 0));
  let totalPlayers = $derived(scans.reduce((s, scan) => s + scan.uniquePlayers, 0));
  let domainCount = $derived(groupedScans.size);
  let isScanning = $derived(starting || activeTasks.length > 0);
  let hasActivity = $derived(activeTasks.length > 0 || resumableScans.length > 0 || historyTasks.length > 0);

  function toggleDomain(domain: string) {
    const next = new Set(collapsedDomains);
    if (next.has(domain)) next.delete(domain);
    else next.add(domain);
    collapsedDomains = next;
  }

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

  let generating = $state<string | null>(null);
  let merging = $state(false);

  async function handleMerge(domainScans: ScanSummary[]) {
    if (merging) return;
    merging = true;
    try {
      await mergeDomainScans(domainScans.map(s => s.filename));
    } catch (err: any) {
      error = err.message;
    } finally {
      merging = false;
    }
  }

  async function handleGenerateReport(scan: ScanSummary) {
    if (generating) return;
    generating = scan.filename;
    try {
      await regenerateReport(scan.filename);
    } catch (err: any) {
      error = err.message;
    } finally {
      generating = null;
    }
  }

  function formatDate(iso: string): string {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function coverage(scan: ScanSummary): number {
    if (scan.pagesScanned === 0) return 0;
    return Math.round((scan.pagesWithVideo / scan.pagesScanned) * 100);
  }
</script>

<div class="vs">
  <!-- Command Bar -->
  <div class="cmd" class:scanning={isScanning}>
    <div class="cmd-body">
      <div class="cmd-row">
        <div class="cmd-input-wrap">
          <svg class="cmd-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            type="url"
            class="cmd-input"
            placeholder="https://example.com — scan for video players"
            bind:value={url}
            onkeydown={(e) => e.key === 'Enter' && handleStart()}
          />
        </div>
        <button class="cmd-go" onclick={handleStart} disabled={starting || !url}>
          {#if starting}
            <span class="spinner"></span> Scanning
          {:else}
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            Launch
          {/if}
        </button>
      </div>
      <div class="cmd-opts">
        <label class="cmd-opt">
          <span>Pages</span>
          <input type="number" min="1" max="1000" bind:value={maxPages} />
        </label>
        <label class="cmd-opt">
          <span>Threads</span>
          <input type="number" min="1" max="20" bind:value={concurrency} />
        </label>
        <label class="cmd-opt">
          <span>Delay</span>
          <input type="number" min="0" max="30000" step="100" bind:value={delay} />
          <span class="opt-unit">ms</span>
        </label>
      </div>
      {#if error}
        <div class="cmd-err">{error}</div>
      {/if}
    </div>
    <div class="scan-line"></div>
  </div>

  <!-- Stats Strip -->
  {#if scans.length > 0}
    <div class="stats">
      <button class="stat-chip" onclick={() => fetchScans()}>
        <span class="sn">{scans.length}</span>
        <span class="sl">scans</span>
      </button>
      <span class="sdot"></span>
      <div class="stat-chip">
        <span class="sn">{domainCount}</span>
        <span class="sl">domains</span>
      </div>
      <span class="sdot"></span>
      <div class="stat-chip">
        <span class="sn">{totalPages.toLocaleString()}</span>
        <span class="sl">pages</span>
      </div>
      <span class="sdot"></span>
      <div class="stat-chip accent">
        <span class="sn">{totalWithVideo.toLocaleString()}</span>
        <span class="sl">video</span>
      </div>
      <span class="sdot"></span>
      <div class="stat-chip">
        <span class="sn">{totalPlayers}</span>
        <span class="sl">players</span>
      </div>
    </div>
  {/if}

  <!-- Main Layout -->
  <div class="vs-main" class:two-col={hasActivity}>
    <!-- Results -->
    <div class="vs-results">
      {#if loading}
        <div class="vs-empty">
          <span class="spinner lg"></span>
          <span>Loading scans...</span>
        </div>
      {:else if scans.length === 0}
        <div class="vs-empty">
          <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.25">
            <path d="M15.75 10.5l4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25z"/>
          </svg>
          <span>No scans yet — enter a URL above to start</span>
        </div>
      {:else}
        {#each [...groupedScans.entries()] as [domain, domainScans] (domain)}
          {@const complete = domainScans.filter(s => !s.canResume && s.pagesScanned > 0)}
          {@const collapsed = collapsedDomains.has(domain)}
          <div class="dom" class:collapsed>
            <div class="dom-head">
              <button class="dom-toggle" onclick={() => toggleDomain(domain)}>
                <span class="dom-chev">&#9662;</span>
                <span class="dom-name">{domain}</span>
                <span class="dom-pill">{domainScans.length}</span>
              </button>
              {#if complete.length >= 2}
                <button class="merge-btn" onclick={() => handleMerge(complete)} disabled={merging}>
                  {merging ? 'Merging...' : `Merge ${complete.length}`}
                </button>
              {/if}
            </div>
            {#if !collapsed}
              <div class="dom-scans">
                {#each domainScans as scan (scan.filename)}
                  {@const cov = coverage(scan)}
                  <div class="sc">
                    <div class="sc-left">
                      <span class="sc-date">{formatDate(scan.scanDate)}</span>
                      <div class="sc-nums">
                        <span class="sc-n"><strong>{scan.pagesScanned}</strong> pg</span>
                        <span class="sc-n hi"><strong>{scan.pagesWithVideo}</strong> vid</span>
                        <span class="sc-n"><strong>{scan.uniquePlayers}</strong> pl</span>
                      </div>
                      <div class="cov-wrap">
                        <div class="cov-track">
                          <div class="cov-fill" style="width:{cov}%"></div>
                        </div>
                        <span class="cov-pct">{cov}%</span>
                      </div>
                    </div>
                    <div class="sc-right">
                      {#if !scan.canResume && scan.pagesScanned > 0}
                        <span class="sc-done">Done</span>
                      {/if}
                      <div class="sc-btns">
                        {#if scan.hasPdf}
                          <a class="sb pdf" href="/api/videoscans/files/{scan.filename.replace('.json', '.pdf')}" target="_blank" download>PDF</a>
                        {/if}
                        {#if scan.hasReport}
                          <a class="sb rpt" href="/api/videoscans/files/{scan.filename.replace('.json', '.html')}" target="_blank">Report</a>
                        {/if}
                        <a class="sb" href="/api/videoscans/files/{scan.filename}" target="_blank" download>JSON</a>
                        {#if !scan.hasReport}
                          <button class="sb" onclick={() => handleGenerateReport(scan)} disabled={generating === scan.filename}>
                            {generating === scan.filename ? '...' : 'Gen'}
                          </button>
                        {/if}
                        {#if scan.canResume}
                          <button class="sb res" onclick={() => handleResume(scan)}>Resume</button>
                        {/if}
                      </div>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    <!-- Activity Sidebar -->
    {#if hasActivity}
      <div class="vs-side">
        {#if activeTasks.length > 0}
          <div class="side-sec">
            <h3 class="side-h">
              <span class="live-dot"></span>
              Live
              <span class="live-n">{activeTasks.length}</span>
            </h3>
            {#each activeTasks as task (task.id)}
              {@const output = getTaskOutput(task.id)}
              {@const exp = isExpanded(task.id)}
              <div class="side-item">
                <button class="side-row" onclick={() => toggleExpanded(task.id)}>
                  <span class="side-title">#{task.id} {task.context?.title || 'Videoscan'}</span>
                  <span class="side-badge run">{task.status}</span>
                </button>
                {#if exp && output}
                  <pre class="side-out">{output}</pre>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        {#if resumableScans.length > 0}
          <div class="side-sec">
            <h3 class="side-h">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M3 12a9 9 0 1 1 9 9"/><polyline points="3 21 3 12 12 12"/></svg>
              Resumable
            </h3>
            {#each resumableScans as scan (scan.filename)}
              <div class="side-item">
                <div class="side-resume">
                  <div>
                    <span class="side-domain">{scan.domain}</span>
                    <span class="side-meta">{scan.pagesScanned} pg · {scan.pagesWithVideo} vid</span>
                  </div>
                  <button class="sb res" onclick={() => handleResume(scan)}>Resume</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}

        {#if historyTasks.length > 0}
          <div class="side-sec">
            <h3 class="side-h">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              History
            </h3>
            {#each historyTasks as task (task.id)}
              {@const output = getTaskOutput(task.id)}
              {@const exp = isExpanded(task.id)}
              <div class="side-item">
                <button class="side-row" onclick={() => toggleExpanded(task.id)}>
                  <span class="side-icon" class:ok={task.status === 'completed'} class:fail={task.status === 'failed'}>
                    {task.status === 'completed' ? '✓' : '✗'}
                  </span>
                  <span class="side-title">#{task.id} {task.context?.title || 'Videoscan'}</span>
                </button>
                {#if exp && (output || task.result)}
                  <pre class="side-out">{output || task.result}</pre>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  /* === Page === */
  .vs {
    --accent: #06b6d4;
    --accent-bright: #22d3ee;
    --accent-dim: #0c3d4a;
    --accent-glow: rgba(6, 182, 212, 0.12);
    --surface-deep: #0a1019;
    --surface: #111a27;
    --surface-raised: #182234;
    --border: #1c2e40;
    --border-subtle: #162030;
    --text: #c9d5e0;
    --text-muted: #5e7389;
    --success: #10b981;
    --warning: #f59e0b;

    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* === Command Bar === */
  .cmd {
    background: linear-gradient(145deg, var(--surface), var(--surface-deep));
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    position: relative;
    transition: border-color 0.3s;
  }

  .cmd.scanning {
    border-color: var(--accent-dim);
    box-shadow: 0 0 30px var(--accent-glow), inset 0 0 30px var(--accent-glow);
  }

  .cmd-body {
    padding: 18px 22px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .cmd-row {
    display: flex;
    gap: 10px;
    align-items: center;
  }

  .cmd-input-wrap {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
  }

  .cmd-icon {
    position: absolute;
    left: 12px;
    color: var(--text-muted);
    pointer-events: none;
    transition: color 0.2s;
  }

  .cmd-input {
    width: 100%;
    background: var(--surface-deep);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: 10px 14px 10px 40px;
    font-size: 14px;
    font-family: 'IBM Plex Mono', monospace;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .cmd-input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  .cmd-input-wrap:focus-within .cmd-icon {
    color: var(--accent);
  }

  .cmd-input::placeholder {
    color: var(--text-muted);
    font-size: 13px;
  }

  .cmd-go {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: var(--accent);
    color: #021a1f;
    border: none;
    border-radius: 8px;
    padding: 10px 20px;
    font-size: 13px;
    font-weight: 600;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s, transform 0.1s;
    letter-spacing: 0.02em;
  }

  .cmd-go:hover:not(:disabled) {
    background: var(--accent-bright);
    transform: translateY(-1px);
  }

  .cmd-go:active:not(:disabled) {
    transform: translateY(0);
  }

  .cmd-go:disabled {
    background: var(--border);
    color: var(--text-muted);
    cursor: not-allowed;
  }

  .cmd-opts {
    display: flex;
    gap: 18px;
    padding-left: 2px;
  }

  .cmd-opt {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .cmd-opt input {
    width: 60px;
    background: var(--surface-deep);
    border: 1px solid var(--border-subtle);
    border-radius: 5px;
    color: var(--text);
    padding: 4px 7px;
    font-size: 12px;
    font-family: 'IBM Plex Mono', monospace;
    transition: border-color 0.15s;
  }

  .cmd-opt input:focus {
    outline: none;
    border-color: var(--accent-dim);
  }

  .opt-unit {
    color: var(--text-muted);
    font-size: 10px;
    margin-left: -3px;
  }

  .cmd-err {
    color: #ef4444;
    font-size: 12px;
    padding: 4px 0 0;
  }

  /* Scan line animation */
  .scan-line {
    height: 2px;
    background: transparent;
    position: relative;
    overflow: hidden;
  }

  .cmd.scanning .scan-line {
    background: var(--border-subtle);
  }

  .cmd.scanning .scan-line::after {
    content: '';
    position: absolute;
    top: 0;
    left: -40%;
    width: 40%;
    height: 100%;
    background: linear-gradient(90deg, transparent, var(--accent), var(--accent-bright), transparent);
    animation: sweep 1.8s ease-in-out infinite;
  }

  @keyframes sweep {
    0% { left: -40%; }
    100% { left: 100%; }
  }

  /* === Stats Strip === */
  .stats {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 20px;
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    flex-wrap: wrap;
  }

  .stat-chip {
    display: flex;
    align-items: baseline;
    gap: 6px;
    background: none;
    border: none;
    cursor: default;
    font-family: inherit;
    padding: 0;
  }

  button.stat-chip {
    cursor: pointer;
    transition: opacity 0.15s;
  }

  button.stat-chip:hover {
    opacity: 0.7;
  }

  .sn {
    font-size: 22px;
    font-weight: 700;
    font-family: 'IBM Plex Mono', monospace;
    color: #e6edf3;
    line-height: 1;
    letter-spacing: -0.02em;
  }

  .sl {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .stat-chip.accent .sn {
    color: var(--accent-bright);
  }

  .sdot {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--border);
    flex-shrink: 0;
  }

  /* === Main Layout === */
  .vs-main {
    display: grid;
    gap: 14px;
    align-items: start;
  }

  .vs-main.two-col {
    grid-template-columns: 1fr 300px;
  }

  /* === Results === */
  .vs-results {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  .vs-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 60px 20px;
    color: var(--text-muted);
    font-size: 13px;
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
  }

  /* === Domain Sections === */
  .dom {
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-left: 3px solid var(--accent-dim);
    border-radius: 0 10px 10px 0;
    overflow: hidden;
    transition: border-color 0.2s;
  }

  .dom:hover {
    border-left-color: var(--accent);
  }

  .dom-head {
    display: flex;
    align-items: center;
    background: var(--surface);
  }

  .dom-toggle {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: none;
    border: none;
    color: var(--text);
    cursor: pointer;
    font-size: 13px;
    font-family: 'IBM Plex Mono', monospace;
    text-align: left;
    transition: background 0.1s;
  }

  .dom-toggle:hover {
    background: var(--surface-raised);
  }

  .dom-chev {
    font-size: 10px;
    color: var(--text-muted);
    transition: transform 0.2s;
    display: inline-block;
  }

  .dom.collapsed .dom-chev {
    transform: rotate(-90deg);
  }

  .dom-name {
    font-weight: 600;
    color: var(--accent-bright);
  }

  .dom-pill {
    margin-left: auto;
    font-size: 10px;
    font-weight: 600;
    background: var(--accent-dim);
    color: var(--accent-bright);
    padding: 2px 8px;
    border-radius: 10px;
    letter-spacing: 0.02em;
  }

  .merge-btn {
    margin-right: 12px;
    font-size: 10px;
    font-weight: 600;
    background: var(--surface-raised);
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .merge-btn:hover:not(:disabled) {
    border-color: var(--accent-dim);
    color: var(--accent-bright);
  }

  .merge-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* === Scan Rows === */
  .dom-scans {
    border-top: 1px solid var(--border-subtle);
  }

  .sc {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 10px 16px 10px 34px;
    border-bottom: 1px solid var(--border-subtle);
    transition: background 0.1s;
  }

  .sc:last-child {
    border-bottom: none;
  }

  .sc:hover {
    background: var(--surface-raised);
  }

  .sc-left {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .sc-date {
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'IBM Plex Mono', monospace;
  }

  .sc-nums {
    display: flex;
    gap: 14px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .sc-n strong {
    color: var(--text);
    font-weight: 600;
    font-family: 'IBM Plex Mono', monospace;
  }

  .sc-n.hi strong {
    color: var(--accent-bright);
  }

  /* Coverage bar */
  .cov-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
  }

  .cov-track {
    width: 80px;
    height: 3px;
    background: var(--border-subtle);
    border-radius: 2px;
    overflow: hidden;
  }

  .cov-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent-dim), var(--accent));
    border-radius: 2px;
    transition: width 0.3s;
  }

  .cov-pct {
    font-size: 9px;
    color: var(--text-muted);
    font-family: 'IBM Plex Mono', monospace;
    min-width: 24px;
  }

  /* Scan right side */
  .sc-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .sc-done {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--success);
    background: rgba(16, 185, 129, 0.1);
    padding: 2px 7px;
    border-radius: 4px;
  }

  .sc-btns {
    display: flex;
    gap: 4px;
  }

  /* === Small Buttons === */
  .sb {
    display: inline-flex;
    align-items: center;
    padding: 3px 9px;
    border-radius: 5px;
    font-size: 10px;
    font-weight: 600;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.12s;
    text-decoration: none;
    border: 1px solid var(--border);
    background: var(--surface-deep);
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .sb:hover {
    border-color: var(--border);
    background: var(--surface-raised);
    color: var(--text);
  }

  .sb.pdf {
    border-color: #7f1d1d;
    color: #fca5a5;
  }

  .sb.pdf:hover {
    background: rgba(239, 68, 68, 0.1);
    border-color: #dc2626;
    color: #fca5a5;
  }

  .sb.rpt {
    border-color: var(--accent-dim);
    color: var(--accent-bright);
  }

  .sb.rpt:hover {
    background: var(--accent-glow);
    border-color: var(--accent);
  }

  .sb.res {
    border-color: rgba(245, 158, 11, 0.3);
    color: var(--warning);
  }

  .sb.res:hover {
    background: rgba(245, 158, 11, 0.1);
    border-color: var(--warning);
  }

  .sb:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  a.sb {
    display: inline-flex;
    align-items: center;
  }

  /* === Activity Sidebar === */
  .vs-side {
    position: sticky;
    top: 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .side-sec {
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    overflow: hidden;
  }

  .side-h {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 10px 14px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border-subtle);
    margin: 0;
  }

  .side-h svg {
    flex-shrink: 0;
  }

  .live-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-glow);
    animation: pulse 2s infinite;
    flex-shrink: 0;
  }

  .live-n {
    margin-left: auto;
    background: var(--accent-dim);
    color: var(--accent-bright);
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 8px;
    font-weight: 700;
    letter-spacing: 0;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .side-item {
    border-bottom: 1px solid var(--border-subtle);
  }

  .side-item:last-child {
    border-bottom: none;
  }

  .side-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 14px;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    font-family: inherit;
    transition: background 0.1s;
    color: var(--text);
  }

  .side-row:hover {
    background: var(--surface-raised);
  }

  .side-title {
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  .side-badge {
    font-size: 9px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 4px;
    flex-shrink: 0;
    margin-left: auto;
  }

  .side-badge.run {
    background: var(--accent-dim);
    color: var(--accent-bright);
  }

  .side-icon {
    font-size: 12px;
    font-weight: 700;
    flex-shrink: 0;
    width: 16px;
    text-align: center;
  }

  .side-icon.ok { color: var(--success); }
  .side-icon.fail { color: #ef4444; }

  .side-out {
    background: var(--surface-deep);
    color: var(--text-muted);
    padding: 10px 14px;
    font-size: 10px;
    font-family: 'IBM Plex Mono', monospace;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
    border-top: 1px solid var(--border-subtle);
    margin: 0;
    line-height: 1.5;
  }

  .side-resume {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 8px 14px;
  }

  .side-domain {
    font-size: 12px;
    font-weight: 600;
    color: var(--text);
    display: block;
  }

  .side-meta {
    font-size: 10px;
    color: var(--text-muted);
    margin-top: 1px;
    display: block;
  }

  /* === Spinner === */
  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  .spinner.lg {
    width: 24px;
    height: 24px;
    border-width: 2px;
    color: var(--accent);
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* === Scrollbar === */
  .side-out::-webkit-scrollbar {
    width: 4px;
  }

  .side-out::-webkit-scrollbar-track {
    background: transparent;
  }

  .side-out::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 2px;
  }

  /* === Responsive === */
  @media (max-width: 900px) {
    .vs-main.two-col {
      grid-template-columns: 1fr;
    }

    .vs-side {
      position: static;
    }

    .sc {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }

    .sc-right {
      width: 100%;
      justify-content: flex-end;
    }
  }

  @media (max-width: 600px) {
    .cmd-row {
      flex-direction: column;
    }

    .cmd-go {
      width: 100%;
      justify-content: center;
    }

    .cmd-opts {
      flex-direction: column;
      gap: 8px;
    }

    .stats {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }

    .sdot {
      display: none;
    }
  }
</style>
