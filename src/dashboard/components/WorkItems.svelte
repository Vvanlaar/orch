<script lang="ts">
  import { GridOutline, TableRowOutline } from 'flowbite-svelte-icons';
  import { readPreference, writePreference } from '../lib/preferences';
  import type { PR, WorkItem, FilterType, OwnerFilter } from '../lib/types';
  import { formatTime, stateClass, typeClass, extractAdoTicket } from '../lib/utils';
  import { reviewPR, fixPRComments, analyzeWorkItem, reviewResolution, openTerminalForRepo, openTerminalWithCommand } from '../lib/api';
  import { showToast } from '../stores/toast.svelte';
  import {
    getFilteredItems,
    setFilter,
    getFilter,
    getOwnerFilter,
    setOwnerFilter,
    getMode,
    setMode,
    getPRFromCache,
    getWorkItemFromCache,
    getResolvedWithComments,
  } from '../stores/workItems.svelte';
  import { getSearchQuery, matchesSearch } from '../stores/search.svelte';

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
  type KanbanColumnKey = 'todo' | 'inprogress' | 'resolved' | 'pr-comments' | 'reviewed' | 'other';
  type PRKanbanColumnKey = 'draft' | 'needs-review' | 'open' | 'has-comments';

  const viewModes: { key: ViewMode; label: string }[] = [
    { key: 'list', label: 'List' },
    { key: 'kanban', label: 'Kanban' },
  ];

  const kanbanColumns: { key: KanbanColumnKey; label: string }[] = [
    { key: 'todo', label: 'To Do' },
    { key: 'inprogress', label: 'In Progress' },
    { key: 'resolved', label: 'Resolved' },
    { key: 'pr-comments', label: 'PR Comments' },
    { key: 'reviewed', label: 'Reviewed' },
    { key: 'other', label: 'Other' },
  ];

  const prKanbanColumns: { key: PRKanbanColumnKey; label: string }[] = [
    { key: 'draft', label: 'Draft' },
    { key: 'needs-review', label: 'Needs Your Review' },
    { key: 'open', label: 'Open' },
    { key: 'has-comments', label: 'Has Comments' },
  ];

  let rawItems = $derived(getFilteredItems());
  let searchQuery = $derived(getSearchQuery());
  let items = $derived.by(() => {
    if (!searchQuery) return rawItems;
    return {
      prs: rawItems.prs.filter(pr => matchesSearch(searchQuery, pr.number, pr.title, pr.repo, pr.adoTicketId, pr.branch)),
      workItems: rawItems.workItems.filter(wi => matchesSearch(searchQuery, wi.id, wi.title, wi.project, wi.type, wi.assignedTo, wi.resolvedBy, wi.repositories?.join(' '))),
    };
  });
  let currentFilter = $derived(getFilter());
  let currentOwner = $derived(getOwnerFilter());
  let currentMode = $derived(getMode());
  let isPRMode = $derived(currentMode === 'prs');
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
    if (!pr) return showToast('PR not found', 'warning');
    try {
      const result = await reviewPR(pr);
      showToast(`Task #${result.taskId} created: ${result.message}`, 'success');
    } catch (err: any) {
      showToast('Failed to create task: ' + err.message, 'error');
    }
  }

  async function handleFixComments(key: string) {
    const pr = getPRFromCache(key);
    if (!pr) return showToast('PR not found', 'warning');
    try {
      const result = await fixPRComments(pr);
      showToast(`Task #${result.taskId} created: ${result.message}`, 'success');
    } catch (err: any) {
      showToast('Failed to create task: ' + err.message, 'error');
    }
  }

  async function handleAnalyzeWorkItem(id: number) {
    const wi = getWorkItemFromCache(id);
    if (!wi) return showToast('Work item not found', 'warning');
    try {
      const result = await analyzeWorkItem(wi);
      showToast(`Task #${result.taskId} created: ${result.message}`, 'success');
    } catch (err: any) {
      showToast('Failed to create task: ' + err.message, 'error');
    }
  }

  async function handleReviewResolution(id: number) {
    const wi = getWorkItemFromCache(id);
    if (!wi) return showToast('Work item not found', 'warning');
    try {
      const result = await reviewResolution(wi);
      showToast(`Task #${result.taskId} created: ${result.message}`, 'success');
    } catch (err: any) {
      showToast('Failed to create task: ' + err.message, 'error');
    }
  }

  function getPRKey(pr: PR): string {
    return `${pr.repo}#${pr.number}`;
  }

  function isResolvedWithPR(wi: WorkItem): boolean {
    const state = wi.state.toLowerCase();
    const isResolved = state === 'resolved' || state === 'reviewed';
    const hasPr = !!(wi.githubPrUrl || wi.resolution?.includes('github.com'));
    return isResolved && hasPr;
  }

  let prCommentItems = $derived(getResolvedWithComments());
  let prCommentIds = $derived(new Set(prCommentItems.map(wi => wi.id)));

  function getKanbanColumn(state: string): KanbanColumnKey {
    const normalized = state.toLowerCase().trim();
    if (normalized === 'new' || normalized === 'to do' || normalized === 'todo') return 'todo';
    if (normalized === 'active' || normalized === 'in progress') return 'inprogress';
    if (normalized === 'resolved') return 'resolved';
    if (normalized === 'reviewed') return 'reviewed';
    return 'other';
  }

  function getPRKanbanColumn(pr: PR): PRKanbanColumnKey {
    if (pr.draft) return 'draft';
    if (pr.role === 'reviewer') return 'needs-review';
    if (pr.commentCount) return 'has-comments';
    return 'open';
  }

  function getPRsForColumn(column: PRKanbanColumnKey): PR[] {
    return items.prs.filter(pr => getPRKanbanColumn(pr) === column);
  }

  function getKanbanItems(column: KanbanColumnKey): WorkItem[] {
    if (column === 'pr-comments') return prCommentItems;
    return items.workItems.filter((wi) => !prCommentIds.has(wi.id) && getKanbanColumn(wi.state) === column);
  }

  async function handleInvestigate(wi: WorkItem) {
    try {
      await openTerminalWithCommand(`claude "investigate ticket #${wi.id}"`, `Investigate #${wi.id}`);
    } catch (err: any) {
      showToast('Failed: ' + err.message, 'error');
    }
  }

  async function handleOpenTerminal(repoName: string, workItemId?: number) {
    try {
      await openTerminalForRepo(repoName, workItemId);
    } catch (err: any) {
      showToast('Failed: ' + err.message, 'error');
    }
  }

  function setViewMode(mode: ViewMode) {
    viewMode = mode;
    writePreference(VIEW_MODE_STORAGE_KEY, mode);
  }

  // --- Collapsible kanban columns ---
  const COLLAPSED_COLS_KEY = 'orch.kanban.collapsed';
  let collapsedColumns = $state<Set<KanbanColumnKey>>(
    new Set(readPreference(COLLAPSED_COLS_KEY, [] as KanbanColumnKey[], (v): v is KanbanColumnKey[] => Array.isArray(v)))
  );

  function toggleColumnCollapse(key: KanbanColumnKey) {
    if (collapsedColumns.has(key)) {
      collapsedColumns.delete(key);
    } else {
      collapsedColumns.add(key);
    }
    collapsedColumns = new Set(collapsedColumns);
    writePreference(COLLAPSED_COLS_KEY, [...collapsedColumns]);
  }

  function isColumnCollapsed(key: KanbanColumnKey): boolean {
    return collapsedColumns.has(key);
  }

  // --- Collapsible PR kanban columns ---
  const PR_COLLAPSED_COLS_KEY = 'orch.kanban.pr-collapsed';
  let prCollapsedColumns = $state<Set<PRKanbanColumnKey>>(
    new Set(readPreference(PR_COLLAPSED_COLS_KEY, [] as PRKanbanColumnKey[], (v): v is PRKanbanColumnKey[] => Array.isArray(v)))
  );

  function togglePRColumnCollapse(key: PRKanbanColumnKey) {
    if (prCollapsedColumns.has(key)) {
      prCollapsedColumns.delete(key);
    } else {
      prCollapsedColumns.add(key);
    }
    prCollapsedColumns = new Set(prCollapsedColumns);
    writePreference(PR_COLLAPSED_COLS_KEY, [...prCollapsedColumns]);
  }

  function isPRColumnCollapsed(key: PRKanbanColumnKey): boolean {
    return prCollapsedColumns.has(key);
  }

  // --- Local notes per ticket ---
  const NOTES_PREFIX = 'orch.workitem.notes.';
  let expandedNotes = $state(new Set<number>());
  let noteTexts = $state(new Map<number, string>());
  let idsWithNotes = $state(new Set<number>());
  let debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();

  // Scan localStorage for existing notes on init
  if (typeof window !== 'undefined') {
    const initIds = new Set<number>();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(NOTES_PREFIX)) {
        const id = parseInt(key.slice(NOTES_PREFIX.length));
        const val = localStorage.getItem(key);
        if (!isNaN(id) && val) {
          try {
            const text = JSON.parse(val);
            if (text) initIds.add(id);
          } catch {}
        }
      }
    }
    if (initIds.size > 0) idsWithNotes = initIds;
  }

  function toggleNotes(id: number) {
    const expanding = !expandedNotes.has(id);
    if (expanding) {
      expandedNotes.add(id);
      // Lazy-load from localStorage
      if (!noteTexts.has(id)) {
        const text = readPreference(`${NOTES_PREFIX}${id}`, '', (v): v is string => typeof v === 'string');
        noteTexts.set(id, text);
        noteTexts = new Map(noteTexts);
      }
    } else {
      expandedNotes.delete(id);
    }
    expandedNotes = new Set(expandedNotes);
  }

  function updateNote(id: number, text: string) {
    noteTexts.set(id, text);
    noteTexts = new Map(noteTexts);
    if (text) idsWithNotes.add(id);
    else idsWithNotes.delete(id);
    idsWithNotes = new Set(idsWithNotes);
    // Debounced save
    const existing = debounceTimers.get(id);
    if (existing) clearTimeout(existing);
    debounceTimers.set(id, setTimeout(() => {
      writePreference(`${NOTES_PREFIX}${id}`, text);
      debounceTimers.delete(id);
    }, 500));
  }

  function hasNote(id: number): boolean {
    return idsWithNotes.has(id);
  }

  function typeBorderColor(type: string): string {
    const t = type.toLowerCase();
    if (t.includes('bug')) return '#f85149';
    if (t.includes('feature') || t.includes('story')) return '#3fb950';
    if (t.includes('task')) return '#58a6ff';
    return '#8b949e';
  }

  // --- Collapsible card ---
  const CARD_ID = 'work-items';
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

<div class="card" class:collapsed={cardCollapsed} style="margin-bottom: 20px;">
  <h2 onclick={toggleCard}>{isPRMode ? 'Pull Requests' : 'Work Items'}</h2>
  {#if !cardCollapsed}
  <div class="card-body">
  <div class="filters" style="margin-bottom: 4px;">
    <button
      class="filter-btn pr-accent"
      class:active={isPRMode}
      onclick={() => setMode('prs')}
    >
      My PRs
    </button>
    <span class="filter-separator"></span>
    {#each ownerFilters as opt}
      <button
        class="filter-btn"
        class:active={!isPRMode && currentOwner === opt.key}
        onclick={() => { setMode('tickets'); setOwnerFilter(opt.key); }}
      >
        {opt.label}
      </button>
    {/each}
  </div>
  {#if !isPRMode}
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
  {/if}
  <div class="board-controls">
    <div class="view-note"></div>
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
          <div class="list-row" style="border-left-color: #a371f7;">
            <div class="list-row-content">
              <div class="list-row-top">
                <a href={pr.url} target="_blank" class="ticket-link">{pr.repo}#{pr.number}</a>
                <span class="list-row-time">{formatTime(pr.updatedAt)}</span>
              </div>
              <div class="list-row-title">{pr.title}</div>
              <div class="list-row-badges">
                <span class="badge" style="background:#a371f720;color:#a371f7;">PR</span>
                <span class="badge role-{pr.role}">{pr.role}</span>
                <span class="badge state {stateClass(pr.state)}">{pr.draft ? 'draft' : pr.state}</span>
                {#if pr.commentCount}
                  <span class="badge" style="background:#f0883e20;color:#f0883e;">{pr.commentCount} cmts</span>
                {/if}
                {#if pr.adoTicketUrl}
                  <a href={pr.adoTicketUrl} target="_blank" class="badge badge-link" style="background:#58a6ff20;color:#58a6ff;">ADO#{pr.adoTicketId}</a>
                {:else if adoTicket}
                  <span class="badge" style="background:#58a6ff20;color:#58a6ff;">ADO#{adoTicket}</span>
                {/if}
              </div>
            </div>
            <div class="list-row-actions">
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
              <button class="action-btn secondary" title="Open workspace terminal" onclick={() => handleOpenTerminal(pr.repo.split('/')[1])}>
                &lt;/&gt;
              </button>
            </div>
          </div>
        {/each}

        {#each items.workItems as wi (wi.id)}
          {@const hasPr = !!(wi.githubPrUrl || wi.resolution?.includes('github.com'))}
          <div class="list-row" style="border-left-color: {typeBorderColor(wi.type)};">
            <div class="list-row-content">
              <div class="list-row-top">
                <a href={wi.url} target="_blank" class="ticket-link">#{wi.id} · {wi.project}</a>
                <span class="list-row-time">{formatTime(wi.updatedAt)}</span>
              </div>
              <div class="list-row-title">{wi.title}</div>
              <div class="list-row-badges">
                <span class="badge type {typeClass(wi.type)}">{wi.type}</span>
                <span class="badge state {stateClass(wi.state)}">{wi.state}</span>
                {#if wi.commentCount}
                  <span class="badge" style="background:#f0883e20;color:#f0883e;">{wi.commentCount} cmts</span>
                {/if}
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
              </div>
            </div>
            <div class="list-row-actions">
              <button class="action-btn secondary" title="Investigate with Claude" onclick={() => handleInvestigate(wi)}>Inv</button>
              {#if isResolvedWithPR(wi)}
                <button class="action-btn" onclick={() => handleReviewResolution(wi.id)}>Review</button>
              {:else}
                <button class="action-btn" onclick={() => handleAnalyzeWorkItem(wi.id)}>
                  {wi.type.toLowerCase().includes('bug') ? 'Fix' : 'Implement'}
                </button>
              {/if}
              {#if wi.repositories?.length}
                <button class="action-btn secondary" title="Open terminal" onclick={() => handleOpenTerminal(wi.repositories![0], wi.id)}>
                  &lt;/&gt;
                </button>
              {/if}
              <button class="action-btn secondary notes-btn" class:has-note={hasNote(wi.id)} title="Toggle notes" onclick={() => toggleNotes(wi.id)}>
                Notes{#if hasNote(wi.id)}<span class="note-dot"></span>{/if}
              </button>
              {#if wi.githubPrUrl}
                <a href={wi.githubPrUrl} target="_blank" class="action-btn secondary">PR</a>
              {/if}
            </div>
          </div>
          {#if expandedNotes.has(wi.id)}
            <div class="note-area">
              <textarea
                class="note-textarea"
                placeholder="Add notes..."
                value={noteTexts.get(wi.id) || ''}
                oninput={(e) => updateNote(wi.id, (e.target as HTMLTextAreaElement).value)}
              ></textarea>
            </div>
          {/if}
        {/each}
      {/if}
    </div>
  {:else}
    <div class="kanban-board-wrapper">
      {#if isPRMode}
        {#if items.prs.length === 0}
          <div class="empty">No PRs found</div>
        {:else}
          <div class="kanban-board" style="grid-template-columns: {prKanbanColumns.map(c => isPRColumnCollapsed(c.key) ? '36px' : 'minmax(200px, 1fr)').join(' ')};">
            {#each prKanbanColumns as column}
              {@const columnPRs = getPRsForColumn(column.key)}
              {@const collapsed = isPRColumnCollapsed(column.key)}
              {@const count = columnPRs.length}
              <div class="kanban-column" class:collapsed>
                <button class="kanban-column-header" onclick={() => togglePRColumnCollapse(column.key)} title={collapsed ? `Expand ${column.label}` : `Collapse ${column.label}`}>
                  {#if collapsed}
                    <span class="kanban-collapsed-label"><span class="kanban-collapsed-text">{column.label}</span><span class="badge">{count}</span></span>
                  {:else}
                    <span>{column.label}</span>
                    <span class="badge">{count}</span>
                  {/if}
                </button>
                <div class="kanban-column-body" class:hidden={collapsed}>
                  {#if columnPRs.length === 0}
                    <div class="kanban-empty">No items</div>
                  {/if}
                  {#each columnPRs as pr (getPRKey(pr))}
                    {@const key = getPRKey(pr)}
                    <div class="kanban-card" style="border-left-color: #a371f7;">
                      <div class="kanban-card-top">
                        <a href={pr.url} target="_blank" class="ticket-link">{pr.repo}#{pr.number}</a>
                        <span>{formatTime(pr.updatedAt)}</span>
                      </div>
                      <div class="kanban-title">{pr.title}</div>
                      <div class="kanban-badges">
                        <span class="badge" style="background:#a371f720;color:#a371f7;">PR</span>
                        <span class="badge role-{pr.role}">{pr.role}</span>
                        <span class="badge state {stateClass(pr.state)}">{pr.draft ? 'draft' : pr.state}</span>
                        {#if pr.commentCount}
                          <span class="badge" style="background:#f0883e20;color:#f0883e;">{pr.commentCount} cmts</span>
                        {/if}
                        {#if pr.adoTicketUrl}
                          <a href={pr.adoTicketUrl} target="_blank" class="badge badge-link" style="background:#58a6ff20;color:#58a6ff;">ADO#{pr.adoTicketId}</a>
                        {/if}
                      </div>
                      <div class="kanban-actions">
                        <div class="kanban-action-primary">
                          {#if pr.role === 'author'}
                            <button class="action-btn" style="background:#a371f7;" onclick={() => handleFixComments(key)}>Fix Comments</button>
                          {:else}
                            <button class="action-btn" onclick={() => handleReviewPR(key)}>Review</button>
                          {/if}
                        </div>
                        <div class="kanban-action-toolbar">
                          {#if pr.role === 'author'}
                            <button class="action-btn secondary" onclick={() => handleReviewPR(key)}>Review</button>
                          {/if}
                          <button class="action-btn secondary" title="Open terminal" onclick={() => handleOpenTerminal(pr.repo.split('/')[1])}>
                            &lt;/&gt;
                          </button>
                        </div>
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        {#if items.workItems.length === 0}
          <div class="empty">No items match filter</div>
        {:else}
          <div class="kanban-board" style="grid-template-columns: {kanbanColumns.map(c => isColumnCollapsed(c.key) ? '36px' : 'minmax(200px, 1fr)').join(' ')};">
            {#each kanbanColumns as column}
              {@const columnItems = getKanbanItems(column.key)}
              {@const collapsed = isColumnCollapsed(column.key)}
              {@const count = columnItems.length}
              <div class="kanban-column" class:collapsed>
                <button class="kanban-column-header" onclick={() => toggleColumnCollapse(column.key)} title={collapsed ? `Expand ${column.label}` : `Collapse ${column.label}`}>
                  {#if collapsed}
                    <span class="kanban-collapsed-label"><span class="kanban-collapsed-text">{column.label}</span><span class="badge">{count}</span></span>
                  {:else}
                    <span>{column.label}</span>
                    <span class="badge">{count}</span>
                  {/if}
                </button>
                <div class="kanban-column-body" class:hidden={collapsed}>
                  {#if columnItems.length === 0}
                    <div class="kanban-empty">No items</div>
                  {/if}
                  {#each columnItems as wi (wi.id)}
                    {@const hasPr = !!(wi.githubPrUrl || wi.resolution?.includes('github.com'))}
                    <div class="kanban-card" style="border-left-color: {typeBorderColor(wi.type)};">
                      <div class="kanban-card-top">
                        <a href={wi.url} target="_blank" class="ticket-link">#{wi.id} · {wi.project}</a>
                        <span>{formatTime(wi.updatedAt)}</span>
                      </div>
                      <div class="kanban-title">{wi.title}</div>
                      <div class="kanban-badges">
                        <span class="badge type {typeClass(wi.type)}">{wi.type}</span>
                        <span class="badge state {stateClass(wi.state)}">{wi.state}</span>
                        {#if wi.commentCount}
                          <span class="badge" style="background:#f0883e20;color:#f0883e;">{wi.commentCount} cmts</span>
                        {/if}
                        {#if currentOwner !== 'my' && wi.assignedTo}
                          <span class="badge" style="background:#8b949e20;color:#8b949e;">{wi.assignedTo}</span>
                        {/if}
                        {#if hasPr}
                          <span class="badge" style="background:#3fb95020;color:#3fb950;">PR</span>
                        {/if}
                      </div>
                      {#if wi.repositories?.length}
                        <div class="kanban-repos">
                          {#each wi.repositories as repo}
                            <span class="badge" style="background:#da3b0120;color:#da3b01;">{repo}</span>
                          {/each}
                        </div>
                      {/if}
                      <div class="kanban-actions">
                        <div class="kanban-action-primary">
                          {#if isResolvedWithPR(wi)}
                            <button class="action-btn" onclick={() => handleReviewResolution(wi.id)}>Review Resolution</button>
                          {:else}
                            <button class="action-btn" onclick={() => handleAnalyzeWorkItem(wi.id)}>
                              {wi.type.toLowerCase().includes('bug') ? 'Fix Bug' : 'Implement'}
                            </button>
                          {/if}
                        </div>
                        <div class="kanban-action-toolbar">
                          <button class="action-btn secondary" title="Investigate with Claude" onclick={() => handleInvestigate(wi)}>Inv</button>
                          {#if wi.repositories?.length}
                            <button class="action-btn secondary" title="Open terminal" onclick={() => handleOpenTerminal(wi.repositories![0], wi.id)}>
                              &lt;/&gt;
                            </button>
                          {/if}
                          {#if wi.githubPrUrl}
                            <a href={wi.githubPrUrl} target="_blank" class="action-btn secondary">PR</a>
                          {/if}
                          <button class="action-btn secondary notes-btn" class:has-note={hasNote(wi.id)} title="Toggle notes" onclick={() => toggleNotes(wi.id)}>
                            Notes{#if hasNote(wi.id)}<span class="note-dot"></span>{/if}
                          </button>
                        </div>
                      </div>
                      {#if expandedNotes.has(wi.id)}
                        <div class="note-area">
                          <textarea
                            class="note-textarea"
                            placeholder="Add notes..."
                            value={noteTexts.get(wi.id) || ''}
                            oninput={(e) => updateNote(wi.id, (e.target as HTMLTextAreaElement).value)}
                          ></textarea>
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
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
    padding: 8px 18px 10px;
    border-bottom: 1px solid #2a313b;
  }

  .view-note {
    font-size: 11px;
    color: #8b949e;
    min-height: 16px;
  }

  .view-switch {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid #353d47;
    border-radius: 8px;
    background: #0d1117;
  }

  .view-switch-btn {
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #8b949e;
    padding: 5px 10px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: all 0.15s;
  }

  .view-switch-btn:hover {
    color: #c9d1d9;
    background: #2a313b;
  }

  .view-switch-btn.active {
    color: #58a6ff;
    background: #122a4a;
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
    max-height: calc(100vh - 280px);
    overflow: auto;
    border-top: 1px solid #2a313b;
  }

  .kanban-board {
    display: grid;
    gap: 10px;
    padding: 12px 18px;
  }

  .kanban-column {
    background: #0d1117;
    border: 1px solid #2a313b;
    border-radius: 8px;
    display: flex;
    flex-direction: column;
    min-height: 340px;
    transition: min-width 0.2s;
  }

  .kanban-column.collapsed {
    min-height: 0;
    overflow: hidden;
  }

  .kanban-column-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border: none;
    border-bottom: 1px solid #2a313b;
    background: transparent;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #8b949e;
    cursor: pointer;
    width: 100%;
    font-family: inherit;
    transition: color 0.15s;
  }

  .kanban-column-header:hover {
    color: #c9d1d9;
  }

  .collapsed .kanban-column-header {
    border-bottom: none;
    padding: 10px 4px;
    justify-content: center;
  }

  .kanban-collapsed-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .kanban-collapsed-text {
    writing-mode: vertical-lr;
    text-orientation: mixed;
    white-space: nowrap;
  }

  .kanban-column-body.hidden {
    display: none;
  }

  .kanban-column-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px;
    overflow-y: auto;
  }

  .kanban-card {
    background: #161b22;
    border: 1px solid #2a313b;
    border-left: 3px solid #8b949e;
    border-radius: 8px;
    padding: 10px;
    transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
  }

  .kanban-card:hover {
    border-color: #353d47;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .kanban-card-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 10px;
    color: #6e7681;
    margin-bottom: 4px;
  }

  .kanban-card-top .ticket-link {
    color: #6e7681;
    font-size: 10px;
  }

  .kanban-card-top .ticket-link:hover {
    color: #58a6ff;
  }

  .kanban-title {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.35;
    margin-bottom: 6px;
    color: #e6edf3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .kanban-badges,
  .kanban-repos {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    font-size: 10px;
    margin-bottom: 6px;
  }

  .kanban-actions {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-top: 2px;
    padding-top: 8px;
    border-top: 1px solid #21262d;
  }

  .kanban-action-primary {
    display: flex;
  }

  .kanban-action-primary .action-btn {
    flex: 1;
    padding: 5px 8px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-align: center;
  }

  .kanban-action-toolbar {
    display: flex;
    gap: 4px;
  }

  .kanban-action-toolbar .action-btn {
    padding: 3px 8px;
    font-size: 10px;
    flex: 1;
    text-align: center;
  }

  .kanban-empty {
    color: #6e7681;
    font-size: 11px;
    text-align: center;
    padding: 16px 8px;
  }

  .ticket-link {
    color: #8b949e;
    text-decoration: none;
    transition: color 0.15s;
  }

  .ticket-link:hover {
    color: #58a6ff;
  }

  .list-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 16px;
    padding: 10px 18px 10px 16px;
    border-bottom: 1px solid #21262d;
    border-left: 3px solid #8b949e;
    align-items: center;
    transition: background 0.1s;
  }

  .list-row:hover {
    background: #1c2128;
  }

  .list-row-content {
    overflow: hidden;
    min-width: 0;
  }

  .list-row-top {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: #6e7681;
    margin-bottom: 2px;
  }

  .list-row-top .ticket-link {
    color: #6e7681;
    font-size: 11px;
  }

  .list-row-time {
    color: #6e7681;
    white-space: nowrap;
  }

  .list-row-title {
    font-size: 13px;
    font-weight: 600;
    color: #e6edf3;
    line-height: 1.35;
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .list-row-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }

  .list-row-actions {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-shrink: 0;
  }

  .notes-btn {
    position: relative;
  }

  .note-dot {
    display: inline-block;
    width: 5px;
    height: 5px;
    background: #58a6ff;
    border-radius: 50%;
    margin-left: 4px;
    vertical-align: middle;
  }

  .note-area {
    padding: 0 18px 10px;
  }

  .kanban-card .note-area {
    padding: 8px 0 0;
  }

  .note-textarea {
    width: 100%;
    min-height: 60px;
    background: #0d1117;
    border: 1px solid #2a313b;
    border-radius: 6px;
    color: #c9d1d9;
    font-size: 12px;
    font-family: 'IBM Plex Mono', 'Consolas', monospace;
    padding: 8px 10px;
    resize: vertical;
    transition: border-color 0.15s;
  }

  .note-textarea:focus {
    outline: none;
    border-color: #1f4a85;
  }

  .filter-separator {
    display: inline-block;
    width: 1px;
    height: 20px;
    background: #353d47;
    align-self: center;
    margin: 0 2px;
  }
</style>
