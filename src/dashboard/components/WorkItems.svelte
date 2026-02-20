<script lang="ts">
  import { GridOutline, TableRowOutline } from 'flowbite-svelte-icons';
  import { readPreference, writePreference } from '../lib/preferences';
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

  type ViewMode = 'list' | 'kanban';
  type KanbanColumnKey = 'todo' | 'inprogress' | 'resolved' | 'reviewed' | 'other';

  const viewModes: { key: ViewMode; label: string }[] = [
    { key: 'list', label: 'List' },
    { key: 'kanban', label: 'Kanban' },
  ];

  const kanbanColumns: { key: KanbanColumnKey; label: string }[] = [
    { key: 'todo', label: 'To Do' },
    { key: 'inprogress', label: 'In Progress' },
    { key: 'resolved', label: 'Resolved' },
    { key: 'reviewed', label: 'Reviewed' },
    { key: 'other', label: 'Other' },
  ];

  let items = $derived(getFilteredItems());
  let currentFilter = $derived(getFilter());
  let currentOwner = $derived(getOwnerFilter());
  const VIEW_MODE_STORAGE_KEY = 'orch.dashboard.workitems.view-mode';
  let viewMode = $state<ViewMode>(
    readPreference(
      VIEW_MODE_STORAGE_KEY,
      'list',
      (value): value is ViewMode => value === 'list' || value === 'kanban'
    )
  );

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

  function getKanbanColumn(state: string): KanbanColumnKey {
    const normalized = state.toLowerCase().trim();
    if (normalized === 'new' || normalized === 'to do' || normalized === 'todo') return 'todo';
    if (normalized === 'active' || normalized === 'in progress') return 'inprogress';
    if (normalized === 'resolved') return 'resolved';
    if (normalized === 'reviewed') return 'reviewed';
    return 'other';
  }

  function getKanbanItems(column: KanbanColumnKey): WorkItem[] {
    return items.workItems.filter((wi) => getKanbanColumn(wi.state) === column);
  }

  function setViewMode(mode: ViewMode) {
    viewMode = mode;
    writePreference(VIEW_MODE_STORAGE_KEY, mode);
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
  <div class="board-controls">
    {#if viewMode === 'kanban' && items.prs.length > 0}
      <div class="view-note">{items.prs.length} PRs shown in list view</div>
    {:else}
      <div class="view-note"></div>
    {/if}
    <div class="view-switch" role="tablist" aria-label="Work item views">
      {#each viewModes as mode}
        <button
          class="view-switch-btn"
          class:active={viewMode === mode.key}
          aria-pressed={viewMode === mode.key}
          onclick={() => setViewMode(mode.key)}
        >
          {#if mode.key === 'list'}
            <TableRowOutline size="sm" class="view-icon" />
          {:else}
            <GridOutline size="sm" class="view-icon" />
          {/if}
          <span>{mode.label}</span>
        </button>
      {/each}
    </div>
  </div>
  {#if viewMode === 'list'}
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
  {:else}
    <div class="kanban-board-wrapper">
      {#if items.workItems.length === 0}
        <div class="empty">No ADO tickets match filter</div>
      {:else}
        <div class="kanban-board">
          {#each kanbanColumns as column}
            {@const columnItems = getKanbanItems(column.key)}
            <div class="kanban-column">
              <div class="kanban-column-header">
                <span>{column.label}</span>
                <span class="badge">{columnItems.length}</span>
              </div>
              <div class="kanban-column-body">
                {#if columnItems.length === 0}
                  <div class="kanban-empty">No tickets</div>
                {:else}
                  {#each columnItems as wi (wi.id)}
                    {@const hasPr = !!(wi.githubPrUrl || (wi.resolution && wi.resolution.includes('github.com')))}
                    <div class="kanban-card">
                      <div class="kanban-title">{wi.title}</div>
                      <div class="kanban-meta">
                        <span>{wi.project} #{wi.id}</span>
                        <span class="badge type {typeClass(wi.type)}">{wi.type}</span>
                        <span class="badge state {stateClass(wi.state)}">{wi.state}</span>
                        {#if currentOwner !== 'my' && wi.assignedTo}
                          <span class="badge" style="background:#8b949e20;color:#8b949e;">{wi.assignedTo}</span>
                        {/if}
                        {#if hasPr}
                          <span class="badge" style="background:#3fb95020;color:#3fb950;">PR</span>
                        {/if}
                        <span>{formatTime(wi.updatedAt)}</span>
                      </div>
                      {#if wi.repositories?.length}
                        <div class="kanban-meta">
                          {#each wi.repositories as repo}
                            <span class="badge" style="background:#da3b0120;color:#da3b01;">{repo}</span>
                          {/each}
                        </div>
                      {/if}
                      <div class="kanban-actions">
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
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .board-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 8px 16px 10px;
    border-bottom: 1px solid #30363d;
  }

  .view-note {
    font-size: 12px;
    color: #8b949e;
    min-height: 16px;
  }

  .view-switch {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid #30363d;
    border-radius: 10px;
    background: #161b22;
  }

  .view-switch-btn {
    background: transparent;
    border: none;
    border-radius: 8px;
    color: #8b949e;
    padding: 5px 10px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }

  .view-switch-btn:hover {
    color: #c9d1d9;
    background: #21262d;
  }

  .view-switch-btn.active {
    color: #58a6ff;
    background: #58a6ff20;
  }

  .view-icon {
    flex: none;
  }

  @media (max-width: 900px) {
    .board-controls {
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
    }

    .view-note {
      align-self: flex-start;
    }
  }

  .kanban-board-wrapper {
    max-height: 520px;
    overflow: auto;
    border-top: 1px solid #30363d;
  }

  .kanban-board {
    display: grid;
    grid-template-columns: repeat(5, minmax(220px, 1fr));
    gap: 12px;
    padding: 12px 16px;
    min-width: 1120px;
  }

  .kanban-column {
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    min-height: 340px;
    max-height: 480px;
  }

  .kanban-column-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid #30363d;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: #8b949e;
  }

  .kanban-column-body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
    overflow-y: auto;
  }

  .kanban-card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 10px;
  }

  .kanban-title {
    font-size: 13px;
    line-height: 1.4;
    margin-bottom: 8px;
  }

  .kanban-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 11px;
    color: #8b949e;
    margin-bottom: 8px;
  }

  .kanban-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .kanban-actions .action-btn {
    padding: 3px 8px;
    font-size: 11px;
  }

  .kanban-empty {
    color: #6e7681;
    font-size: 12px;
    text-align: center;
    padding: 16px 8px;
  }
</style>
