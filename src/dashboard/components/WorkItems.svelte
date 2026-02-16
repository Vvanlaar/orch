<script lang="ts">
  import type { PR, WorkItem, FilterType, OwnerFilter } from '../lib/types';
  import { formatTime, stateClass, typeClass, extractAdoTicket } from '../lib/utils';
  import { reviewPR, fixPRComments, analyzeWorkItem, reviewResolution } from '../lib/api';
  import {
    getFilteredItems,
    setFilter,
    getFilter,
    getOwnerFilter,
    setOwnerFilter,
    getPRFromCache,
    getWorkItemFromCache,
  } from '../stores/workItems.svelte';

  const ownerFilters: { key: OwnerFilter; label: string }[] = [
    { key: 'my', label: 'My Tickets' },
    { key: 'unassigned', label: 'Unassigned' },
    { key: 'all', label: 'All' },
  ];

  const filters: { key: FilterType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'new', label: 'To Do' },
    { key: 'active', label: 'In Progress' },
    { key: 'resolved', label: 'Resolved' },
    { key: 'reviewed', label: 'Reviewed' },
    { key: 'resolved-by-me', label: 'Resolved by me' },
  ];

  let items = $derived(getFilteredItems());
  let currentFilter = $derived(getFilter());
  let currentOwner = $derived(getOwnerFilter());

  async function handleReviewPR(key: string) {
    const pr = getPRFromCache(key);
    if (!pr) return alert('PR not found');
    try {
      const result = await reviewPR(pr);
      alert(`Task #${result.taskId} created: ${result.message}`);
    } catch (err: any) {
      alert('Failed to create task: ' + err.message);
    }
  }

  async function handleFixComments(key: string) {
    const pr = getPRFromCache(key);
    if (!pr) return alert('PR not found');
    try {
      const result = await fixPRComments(pr);
      alert(`Task #${result.taskId} created: ${result.message}`);
    } catch (err: any) {
      alert('Failed to create task: ' + err.message);
    }
  }

  async function handleAnalyzeWorkItem(id: number) {
    const wi = getWorkItemFromCache(id);
    if (!wi) return alert('Work item not found');
    try {
      const result = await analyzeWorkItem(wi);
      alert(`Task #${result.taskId} created: ${result.message}`);
    } catch (err: any) {
      alert('Failed to create task: ' + err.message);
    }
  }

  async function handleReviewResolution(id: number) {
    const wi = getWorkItemFromCache(id);
    if (!wi) return alert('Work item not found');
    try {
      const result = await reviewResolution(wi);
      alert(`Task #${result.taskId} created: ${result.message}`);
    } catch (err: any) {
      alert('Failed to create task: ' + err.message);
    }
  }

  function getPRKey(pr: PR): string {
    return `${pr.repo}#${pr.number}`;
  }

  function isResolvedWithPR(wi: WorkItem): boolean {
    const isResolved = wi.state.toLowerCase() === 'resolved' || wi.state.toLowerCase() === 'reviewed';
    const hasPr = !!(wi.githubPrUrl || (wi.resolution && wi.resolution.includes('github.com')));
    return isResolved && hasPr;
  }
</script>

<div class="card" style="margin-bottom: 24px;">
  <h2>Work Items</h2>
  <div class="filters" style="margin-bottom: 4px;">
    {#each ownerFilters as opt}
      <button
        class="filter-btn"
        class:active={currentOwner === opt.key}
        onclick={() => setOwnerFilter(opt.key)}
      >
        {opt.label}
      </button>
    {/each}
  </div>
  <div class="filters">
    {#each filters as f}
      <button
        class="filter-btn"
        class:active={currentFilter === f.key}
        onclick={() => setFilter(f.key)}
      >
        {f.label}
      </button>
    {/each}
  </div>
  <div class="card-list">
    {#if items.prs.length === 0 && items.workItems.length === 0}
      <div class="empty">No items match filter</div>
    {:else}
      {#each items.prs as pr (getPRKey(pr))}
        {@const key = getPRKey(pr)}
        {@const adoTicket = extractAdoTicket(pr.title)}
        <div class="item">
          <div class="item-info">
            <div class="item-title">{pr.title}</div>
            <div class="item-meta">
              <span class="badge" style="background:#a371f720;color:#a371f7;">PR</span>
              <span>{pr.repo}#{pr.number}</span>
              <span class="badge role-{pr.role}">{pr.role}</span>
              <span class="badge state {stateClass(pr.state)}">{pr.draft ? 'draft' : pr.state}</span>
              {#if adoTicket}
                <span class="badge" style="background:#58a6ff20;color:#58a6ff;">ADO#{adoTicket}</span>
              {/if}
              <span>{formatTime(pr.updatedAt)}</span>
            </div>
          </div>
          <div class="item-actions">
            {#if pr.role === 'author'}
              <button
                class="action-btn"
                style="background:#a371f7;"
                onclick={() => handleFixComments(key)}
              >
                Fix Comments
              </button>
            {/if}
            <button class="action-btn" onclick={() => handleReviewPR(key)}>Review</button>
            <a href={pr.url} target="_blank" class="action-btn secondary">View →</a>
          </div>
        </div>
      {/each}

      {#each items.workItems as wi (wi.id)}
        {@const hasPr = !!(wi.githubPrUrl || (wi.resolution && wi.resolution.includes('github.com')))}
        <div class="item">
          <div class="item-info">
            <div class="item-title">{wi.title}</div>
            <div class="item-meta">
              <span>{wi.project} #{wi.id}</span>
              <span class="badge type {typeClass(wi.type)}">{wi.type}</span>
              <span class="badge state {stateClass(wi.state)}">{wi.state}</span>
              {#if currentOwner !== 'my' && wi.assignedTo}
                <span class="badge" style="background:#8b949e20;color:#8b949e;">{wi.assignedTo}</span>
              {/if}
              {#if wi.repositories?.length}
                {#each wi.repositories as repo}
                  <span class="badge" style="background:#da3b0120;color:#da3b01;">{repo}</span>
                {/each}
              {/if}
              {#if hasPr}
                <span class="badge" style="background:#3fb95020;color:#3fb950;">PR</span>
              {/if}
              <span>{formatTime(wi.updatedAt)}</span>
            </div>
          </div>
          <div class="item-actions">
            {#if isResolvedWithPR(wi)}
              <button class="action-btn" onclick={() => handleReviewResolution(wi.id)}>Review</button>
            {:else}
              <button class="action-btn" onclick={() => handleAnalyzeWorkItem(wi.id)}>
                {wi.type.toLowerCase().includes('bug') ? 'Fix' : 'Implement'}
              </button>
            {/if}
            {#if wi.githubPrUrl}
              <a href={wi.githubPrUrl} target="_blank" class="action-btn secondary">PR</a>
            {/if}
            <a href={wi.url} target="_blank" class="action-btn secondary">View →</a>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>
