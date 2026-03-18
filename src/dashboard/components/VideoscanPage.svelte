<script lang="ts">
  import { onMount } from 'svelte';
  import { getScans, fetchScans, startScan, startGroupScan, resumeScan, addUrlsToScan, mergeDomainScans, regenerateReport, regeneratePreview, isLoading, importDigiToegankelijk, type ScanSummary, type DigiImportResult, type ReportOptions } from '../stores/videoscan.svelte';
  import { getTasks, getTaskOutput, isExpanded, toggleExpanded } from '../stores/tasks.svelte';
  import { readPreference, writePreference } from '../lib/preferences';

  let url = $state('');
  let maxPages = $state(5000);
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

  async function handleDigiImport(orgId: number) {
    importing = true;
    error = '';
    try {
      const result = await importDigiToegankelijk(orgId);
      importPreview = result;
      selectedUrls = new Set(result.groups.flatMap(g => g.sites.map(s => s.url)));
    } catch (err: any) {
      error = err.message;
    } finally {
      importing = false;
    }
  }

  async function handleStart() {
    if (!url || importPreview) return;
    const digiMatch = url.match(digiPattern);
    if (digiMatch) {
      await handleDigiImport(Number(digiMatch[1]));
      return;
    }
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

  function toggleSiteUrl(siteUrl: string) {
    toggleDomainGroup([siteUrl]);
  }

  function toggleDomainGroup(urls: string[]) {
    const allSelected = urls.every(u => selectedUrls.has(u));
    const next = new Set(selectedUrls);
    for (const u of urls) {
      if (allSelected) next.delete(u);
      else next.add(u);
    }
    selectedUrls = next;
  }

  function dismissImport() {
    importPreview = null;
    selectedUrls = new Set();
    bulkProgress = 0;
  }

  let bulkGroupCount = $derived.by(() => {
    if (!importPreview) return 0;
    return importPreview.groups.filter(g => g.sites.some(s => selectedUrls.has(s.url))).length;
  });

  async function handleBulkStart() {
    if (!importPreview || bulkStarting) return;
    bulkStarting = true;
    bulkProgress = 0;
    error = '';
    const errors: string[] = [];

    const groupScans = importPreview.groups
      .map(g => ({
        domain: g.rootDomain,
        urls: g.sites.map(s => s.url).filter(u => selectedUrls.has(u)),
      }))
      .filter(g => g.urls.length > 0);

    for (const group of groupScans) {
      try {
        await startGroupScan(group.urls, maxPages, concurrency, delay);
      } catch (err: any) {
        errors.push(`${group.domain}: ${err.message}`);
      }
      bulkProgress++;
    }
    if (errors.length > 0) {
      error = `${errors.length} scan(s) failed to start`;
    }
    dismissImport();
    url = '';
    setTimeout(() => fetchScans(), 2000);
    bulkStarting = false;
  }

  async function handleResume(scan: ScanSummary) {
    try {
      await resumeScan(scan.filename, maxPages, concurrency, delay);
      setTimeout(() => fetchScans(), 2000);
    } catch (err: any) {
      error = err.message;
    }
  }

  let addingUrlsTo = $state<string | null>(null);
  let addUrlsText = $state('');
  let addUrlsSubmitting = $state(false);

  async function handleAddUrls(scan: ScanSummary) {
    const urls = addUrlsText.split('\n').map(u => u.trim()).filter(u => u.startsWith('http'));
    if (urls.length === 0) return;
    addUrlsSubmitting = true;
    try {
      await addUrlsToScan(scan.filename, urls, concurrency, delay);
      addingUrlsTo = null;
      addUrlsText = '';
      setTimeout(() => fetchScans(), 2000);
    } catch (err: any) {
      error = err.message;
    } finally {
      addUrlsSubmitting = false;
    }
  }

  let generating = $state<string | null>(null);
  let generatingPreview = $state<string | null>(null);
  let merging = $state(false);
  let showReportOptions = $state<string | null>(null);
  let reportOpts = $state<ReportOptions>({});

  // DigiToegankelijk import state
  let importPreview = $state<DigiImportResult | null>(null);
  let selectedUrls = $state(new Set<string>());
  let importing = $state(false);
  let bulkStarting = $state(false);
  let bulkProgress = $state(0);

  const digiPattern = /^https?:\/\/dashboard\.digitoegankelijk\.nl\/organisaties\/(\d+)/;

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

  async function handleGenerateReport(scan: ScanSummary, opts?: ReportOptions) {
    if (generating) return;
    generating = scan.filename;
    showReportOptions = null;
    writePreference(`report-opts-${scan.filename}`, opts ?? {});
    try {
      await regenerateReport(scan.filename, opts);
    } catch (err: any) {
      error = err.message;
    } finally {
      generating = null;
    }
  }

  async function handleGeneratePreview(scan: ScanSummary) {
    if (generatingPreview) return;
    generatingPreview = scan.filename;
    writePreference(`report-opts-${scan.filename}`, reportOpts);
    try {
      await regeneratePreview(scan.filename, reportOpts);
    } catch (err: any) {
      error = err.message;
    } finally {
      generatingPreview = null;
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
            placeholder="https://example.com or DigiToegankelijk organisation URL"
            bind:value={url}
            onkeydown={(e) => e.key === 'Enter' && handleStart()}
          />
        </div>
        <button class="cmd-go" onclick={handleStart} disabled={starting || importing || !url}>
          {#if starting}
            <span class="spinner"></span> Scanning
          {:else if importing}
            <span class="spinner"></span> Importing
          {:else}
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            Launch
          {/if}
        </button>
      </div>
      <div class="cmd-opts">
        <label class="cmd-opt">
          <span>Pages</span>
          <input type="number" min="1" max="50000" bind:value={maxPages} />
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

  <!-- DigiToegankelijk Import Preview -->
  {#if importPreview}
    {@const selectedCount = selectedUrls.size}
    <div class="digi-preview">
      <div class="digi-header">
        <div class="digi-title">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.66 0 3-4.03 3-9s-1.34-9-3-9m0 18c-1.66 0-3-4.03-3-9s1.34-9 3-9m-9 9a9 9 0 0 1 9-9"/></svg>
          <span>{importPreview.orgName}</span>
        </div>
        <button class="digi-dismiss" onclick={dismissImport} aria-label="Dismiss import">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="digi-summary">
        <span class="digi-chip">{importPreview.totalSites} sites</span>
        {#if importPreview.skippedApps > 0}
          <span class="digi-chip muted">{importPreview.skippedApps} apps skipped</span>
        {/if}
        <span class="digi-chip accent">{selectedCount} selected</span>
      </div>
      <div class="digi-groups">
        {#each importPreview.groups as group (group.rootDomain)}
          {@const groupUrls = group.sites.map(s => s.url)}
          {@const allChecked = groupUrls.every(u => selectedUrls.has(u))}
          <div class="digi-group">
            <button class="digi-group-head" onclick={() => toggleDomainGroup(groupUrls)}>
              <span class="digi-check" class:checked={allChecked}>{allChecked ? '✓' : ''}</span>
              <span class="digi-domain">{group.rootDomain}</span>
              <span class="digi-count">{group.sites.length}</span>
            </button>
            <div class="digi-sites">
              {#each group.sites as site (site.url)}
                <label class="digi-site">
                  <input type="checkbox" checked={selectedUrls.has(site.url)} onchange={() => toggleSiteUrl(site.url)} />
                  <span class="digi-site-name">{site.name || site.url}</span>
                  {#if site.status}
                    <span class="digi-status">{site.status}</span>
                  {/if}
                </label>
              {/each}
            </div>
          </div>
        {/each}
      </div>
      <div class="digi-actions">
        {#if bulkStarting}
          <div class="digi-progress">
            <div class="digi-progress-bar" style="width:{bulkGroupCount > 0 ? Math.round((bulkProgress / bulkGroupCount) * 100) : 0}%"></div>
          </div>
          <span class="digi-progress-text">{bulkProgress} / {bulkGroupCount} domains</span>
        {:else}
          <button class="cmd-go" onclick={handleBulkStart} disabled={selectedCount === 0}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
            Start {bulkGroupCount} domain scan{bulkGroupCount !== 1 ? 's' : ''} ({selectedCount} URLs)
          </button>
          <button class="digi-cancel" onclick={dismissImport}>Cancel</button>
        {/if}
      </div>
    </div>
  {/if}

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
                        {#if scan.hasPreview}
                          <a class="sb prv" href="/api/videoscans/files/{scan.filename.replace('.json', '-preview.html')}" target="_blank">Preview</a>
                        {/if}
                        <a class="sb" href="/api/videoscans/files/{scan.filename}" target="_blank" download>JSON</a>
                        <button class="sb" onclick={() => { showReportOptions = showReportOptions === scan.filename ? null : scan.filename; reportOpts = readPreference(`report-opts-${scan.filename}`, {}); }} disabled={generating === scan.filename}>
                          {generating === scan.filename ? '...' : scan.hasReport ? 'Regen' : 'Gen'}
                        </button>
                        {#if scan.hasReport && !scan.hasPreview}
                          <button class="sb prv" onclick={() => handleGeneratePreview(scan)} disabled={generatingPreview === scan.filename}>
                            {generatingPreview === scan.filename ? '...' : 'Teaser'}
                          </button>
                        {/if}
                        {#if scan.canResume}
                          <button class="sb res" onclick={() => handleResume(scan)}>Resume</button>
                        {/if}
                        <button class="sb" onclick={() => { addingUrlsTo = addingUrlsTo === scan.filename ? null : scan.filename; addUrlsText = ''; }}>+ URLs</button>
                      </div>
                    </div>
                  </div>
                  {#if showReportOptions === scan.filename}
                    <div class="add-urls-panel" style="gap:6px">
                      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
                        <input class="add-urls-ta" style="padding:6px 8px;font-size:12px;grid-column:span 2" placeholder="Organisation name (override)" bind:value={reportOpts.orgName}>
                        <input class="add-urls-ta" style="padding:6px 8px;font-size:12px" placeholder="Cover image URL" bind:value={reportOpts.coverImageUrl}>
                        <input class="add-urls-ta" style="padding:6px 8px;font-size:12px" placeholder="Contact image URL" bind:value={reportOpts.contactImageUrl}>
                        <input class="add-urls-ta" style="padding:6px 8px;font-size:12px" placeholder="Contact name" bind:value={reportOpts.contactName}>
                        <input class="add-urls-ta" style="padding:6px 8px;font-size:12px" placeholder="Contact phone" bind:value={reportOpts.contactPhone}>
                        <input class="add-urls-ta" style="padding:6px 8px;font-size:12px;grid-column:span 2" placeholder="Contact email" bind:value={reportOpts.contactEmail}>
                      </div>
                      <div class="add-urls-btns">
                        <button class="sb res" onclick={() => handleGenerateReport(scan, reportOpts)}>Generate</button>
                        <button class="sb" onclick={() => showReportOptions = null}>Cancel</button>
                      </div>
                    </div>
                  {/if}
                  {#if addingUrlsTo === scan.filename}
                    <div class="add-urls-panel">
                      <textarea
                        class="add-urls-ta"
                        placeholder="One URL per line..."
                        bind:value={addUrlsText}
                        rows="4"
                      ></textarea>
                      <div class="add-urls-btns">
                        <button class="sb res" onclick={() => handleAddUrls(scan)} disabled={addUrlsSubmitting || !addUrlsText.trim()}>
                          {addUrlsSubmitting ? '...' : 'Scan & merge'}
                        </button>
                        <button class="sb" onclick={() => { addingUrlsTo = null; addUrlsText = ''; }}>Cancel</button>
                      </div>
                    </div>
                  {/if}
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

  <!-- Howto + Audit Documents -->
  <div class="info-section">
    <div class="info-card">
      <h3 class="info-h">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
        Quick Start
      </h3>
      <div class="info-body">
        <div class="info-step">
          <span class="info-num">1</span>
          <div>
            <strong>Scan a website</strong>
            <p>Paste any URL in the input above — e.g. <code>https://example.nl</code>. The scanner crawls pages and detects video players.</p>
          </div>
        </div>
        <div class="info-step">
          <span class="info-num">2</span>
          <div>
            <strong>Bulk-scan from DigiToegankelijk</strong>
            <p>Paste a municipality page URL like <code>https://dashboard.digitoegankelijk.nl/organisaties/123</code> to import all their sites at once. Select which to scan and hit Start.</p>
          </div>
        </div>
        <div class="info-step">
          <span class="info-num">3</span>
          <div>
            <strong>Generate reports</strong>
            <p>After a scan completes, click <strong>Gen</strong> for a full HTML/PDF report or <strong>Teaser</strong> for a one-page preview. Merge multiple scans of the same domain with the Merge button.</p>
          </div>
        </div>
      </div>
    </div>

    <div class="info-card">
      <h3 class="info-h">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        Audit Documents
      </h3>
      <div class="info-body">
        <p class="info-desc">WCAG 2.2 video player accessibility audit by Proper Access — comparing Blue Billywig against other players.</p>
        <div class="info-links">
          <a class="sb rpt" href="/api/videoscans/audit/audit-summary.html" target="_blank">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            Audit Summary (HTML)
          </a>
          <a class="sb pdf" href="/api/videoscans/audit/audit-summary.pdf" target="_blank" download>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            Audit Summary (PDF)
          </a>
        </div>
      </div>
    </div>
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
    width: 80px;
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

  .sb.prv {
    border-color: rgba(168, 85, 247, 0.3);
    color: #c084fc;
  }

  .sb.prv:hover {
    background: rgba(168, 85, 247, 0.1);
    border-color: #a855f7;
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

  /* === DigiToegankelijk Import Preview === */
  .digi-preview {
    background: linear-gradient(145deg, var(--surface), var(--surface-deep));
    border: 1px solid var(--accent-dim);
    border-radius: 12px;
    overflow: hidden;
  }

  .digi-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .digi-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    color: var(--accent-bright);
    font-family: 'IBM Plex Mono', monospace;
  }

  .digi-title svg {
    color: var(--accent);
    flex-shrink: 0;
  }

  .digi-dismiss {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px;
    border-radius: 4px;
    transition: color 0.15s, background 0.15s;
  }

  .digi-dismiss:hover {
    color: var(--text);
    background: var(--surface-raised);
  }

  .digi-summary {
    display: flex;
    gap: 8px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--border-subtle);
    flex-wrap: wrap;
  }

  .digi-chip {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-family: 'IBM Plex Mono', monospace;
  }

  .digi-chip.muted {
    color: var(--text-muted);
  }

  .digi-chip.accent {
    background: var(--accent-dim);
    color: var(--accent-bright);
  }

  .digi-groups {
    max-height: 400px;
    overflow-y: auto;
  }

  .digi-groups::-webkit-scrollbar {
    width: 4px;
  }

  .digi-groups::-webkit-scrollbar-track {
    background: transparent;
  }

  .digi-groups::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 2px;
  }

  .digi-group {
    border-bottom: 1px solid var(--border-subtle);
  }

  .digi-group:last-child {
    border-bottom: none;
  }

  .digi-group-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 18px;
    background: none;
    border: none;
    cursor: pointer;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 12px;
    color: var(--text);
    text-align: left;
    transition: background 0.1s;
  }

  .digi-group-head:hover {
    background: var(--surface-raised);
  }

  .digi-check {
    width: 16px;
    height: 16px;
    border: 1.5px solid var(--border);
    border-radius: 3px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: var(--accent-bright);
    flex-shrink: 0;
    transition: border-color 0.15s, background 0.15s;
  }

  .digi-check.checked {
    border-color: var(--accent);
    background: var(--accent-dim);
  }

  .digi-domain {
    font-weight: 600;
    color: var(--accent-bright);
  }

  .digi-count {
    margin-left: auto;
    font-size: 10px;
    color: var(--text-muted);
    background: var(--surface-deep);
    padding: 1px 7px;
    border-radius: 8px;
  }

  .digi-sites {
    padding: 0 18px 6px 42px;
  }

  .digi-site {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 0;
    font-size: 11px;
    color: var(--text-muted);
    cursor: pointer;
  }

  .digi-site:hover {
    color: var(--text);
  }

  .digi-site input[type="checkbox"] {
    accent-color: var(--accent);
    width: 13px;
    height: 13px;
    flex-shrink: 0;
  }

  .digi-site-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .digi-status {
    margin-left: auto;
    font-size: 9px;
    color: var(--text-muted);
    white-space: nowrap;
    flex-shrink: 0;
    padding: 1px 6px;
    background: var(--surface-deep);
    border-radius: 4px;
  }

  .digi-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 18px;
    border-top: 1px solid var(--border-subtle);
  }

  .digi-cancel {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-muted);
    border-radius: 8px;
    padding: 10px 18px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: border-color 0.15s, color 0.15s;
  }

  .digi-cancel:hover {
    border-color: var(--text-muted);
    color: var(--text);
  }

  .digi-progress {
    flex: 1;
    height: 6px;
    background: var(--surface-deep);
    border-radius: 3px;
    overflow: hidden;
  }

  .digi-progress-bar {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-bright));
    border-radius: 3px;
    transition: width 0.3s;
  }

  .digi-progress-text {
    font-size: 11px;
    font-weight: 600;
    color: var(--accent-bright);
    font-family: 'IBM Plex Mono', monospace;
    white-space: nowrap;
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

  /* === Info Section === */
  .info-section {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }

  @media (max-width: 900px) {
    .info-section {
      grid-template-columns: 1fr;
    }
  }

  .info-card {
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: 10px;
    overflow: hidden;
  }

  .info-h {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border-subtle);
    margin: 0;
  }

  .info-h svg {
    flex-shrink: 0;
    color: var(--accent);
  }

  .info-body {
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .info-step {
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }

  .info-num {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--accent-dim);
    color: var(--accent-bright);
    font-size: 11px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    font-family: 'IBM Plex Mono', monospace;
    margin-top: 1px;
  }

  .info-step strong {
    font-size: 13px;
    color: var(--text);
    display: block;
    margin-bottom: 2px;
  }

  .info-step p {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }

  .info-step code {
    font-size: 11px;
    background: var(--surface-deep);
    padding: 1px 5px;
    border-radius: 3px;
    font-family: 'IBM Plex Mono', monospace;
    color: var(--accent-bright);
  }

  .info-desc {
    font-size: 12px;
    color: var(--text-muted);
    line-height: 1.5;
    margin: 0;
  }

  .info-links {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .info-links .sb {
    gap: 5px;
  }

  /* Add URLs panel */
  .add-urls-panel {
    padding: 8px 10px;
    border-top: 1px solid var(--border);
    background: var(--surface-deep);
  }
  .add-urls-ta {
    width: 100%;
    min-height: 60px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font: 11px/1.4 monospace;
    padding: 6px;
    resize: vertical;
  }
  .add-urls-ta::placeholder { color: var(--text-dim); }
  .add-urls-btns {
    display: flex;
    gap: 6px;
    margin-top: 6px;
  }
</style>
