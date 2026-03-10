<script lang="ts">
  import { getOrchestratorState, triggerOrchestration, acceptAction, dismissAction } from '../stores/orchestrator.svelte';
  import { readPreference, writePreference } from '../lib/preferences';

  let state = $derived(getOrchestratorState());
  let expandedId = $state<string | null>(null);
  let dismissingId = $state<string | null>(null);
  let dismissReason = $state('');

  function toggleExpand(id: string) {
    expandedId = expandedId === id ? null : id;
  }

  function priorityClass(p: string): string {
    if (p === 'high') return 'priority-high';
    if (p === 'medium') return 'priority-medium';
    return 'priority-low';
  }

  function sourceLabel(s: string): string {
    const map: Record<string, string> = {
      'ado-workitem': 'ADO',
      'github-pr': 'PR',
      'pr-comments': 'Comments',
      'testing': 'Testing',
      'notification': 'Notif',
    };
    return map[s] || s;
  }

  function startDismiss(id: string) {
    dismissingId = id;
    dismissReason = '';
  }

  function cancelDismiss() {
    dismissingId = null;
    dismissReason = '';
  }

  function confirmDismiss(id: string) {
    dismissAction(id, dismissReason || undefined);
    dismissingId = null;
    dismissReason = '';
  }

  function handleDismissKey(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter') confirmDismiss(id);
    else if (e.key === 'Escape') cancelDismiss();
  }

  let isRunning = $derived(state.status === 'gathering' || state.status === 'analyzing');
  let activeActions = $derived(state.actions.filter(a => !a.dismissed));
  let dismissedActions = $derived(state.actions.filter(a => a.dismissed));

  const CARD_ID = 'orchestrator';
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

<div class="card orch-panel" class:collapsed={cardCollapsed}>
  <h2 onclick={toggleCard}>
    Auto-Orchestrator
    <span class="orch-controls" onclick={e => e.stopPropagation()}>
      {#if state.status !== 'idle'}
        <span class="status-badge" class:gathering={state.status === 'gathering'} class:analyzing={state.status === 'analyzing'} class:ready={state.status === 'ready'} class:error={state.status === 'error'}>
          {state.status}
        </span>
      {/if}
      <button class="action-btn orch-run-btn" onclick={triggerOrchestration} disabled={isRunning}>
        {isRunning ? 'Running...' : 'Run'}
      </button>
    </span>
  </h2>
  <div class="card-body">
  {#if state.dataSummary && (state.status === 'analyzing' || state.status === 'ready')}
    <div class="data-summary">
      {#if state.dataSummary.adoWorkItems}<span>{state.dataSummary.adoWorkItems} ADO items</span>{/if}
      {#if state.dataSummary.githubPRs}<span>{state.dataSummary.githubPRs} PRs</span>{/if}
      {#if state.dataSummary.prComments}<span>{state.dataSummary.prComments} with comments</span>{/if}
      {#if state.dataSummary.testingItems}<span>{state.dataSummary.testingItems} for testing</span>{/if}
      {#if state.dataSummary.notifications}<span>{state.dataSummary.notifications} notifications</span>{/if}
    </div>
  {/if}

  {#if state.status === 'idle'}
    <div class="empty">Click "Run" to scan all work sources and get prioritized recommendations</div>
  {:else if state.status === 'gathering'}
    <div class="orch-loading">
      <span class="spinner"></span>
      Gathering work data...
    </div>
  {:else if state.status === 'analyzing'}
    <div class="orch-loading">
      <span class="spinner"></span>
      Analyzing with Claude...
    </div>
  {:else if state.status === 'error'}
    <div class="orch-error">
      <span>Error: {state.error}</span>
      <button class="action-btn secondary" onclick={triggerOrchestration}>Retry</button>
    </div>
  {:else if state.status === 'ready'}
    {#if activeActions.length === 0}
      <div class="empty">No actions recommended — everything looks good!</div>
    {:else}
      <div class="card-list">
        {#each activeActions as action (action.id)}
          <div class="orch-action" class:accepted={action.accepted}>
            <div class="action-row">
              <div class="action-info">
                <div class="action-badges">
                  <span class="badge {priorityClass(action.priority)}">{action.priority}</span>
                  <span class="badge type">{action.taskType}</span>
                  <span class="badge source">{sourceLabel(action.sourceType)}</span>
                </div>
                <div class="action-title">{action.title}</div>
                <div class="action-meta">
                  <span>{action.repo}</span>
                  {#if action.sourceId}
                    <span>#{action.sourceId}</span>
                  {/if}
                </div>
              </div>
              <div class="action-controls">
                {#if action.accepted}
                  <span class="accepted-label">Task #{action.taskId}</span>
                {:else if dismissingId === action.id}
                  <div class="dismiss-reason-row">
                    <input
                      class="dismiss-reason-input"
                      type="text"
                      placeholder="Why? (optional)"
                      bind:value={dismissReason}
                      onkeydown={(e) => handleDismissKey(e, action.id)}
                    />
                    <button class="action-btn" onclick={() => confirmDismiss(action.id)}>OK</button>
                    <button class="action-btn secondary" onclick={cancelDismiss}>Cancel</button>
                  </div>
                {:else}
                  <button class="action-btn" onclick={() => acceptAction(action.id)}>Accept</button>
                  <button class="action-btn secondary" onclick={() => startDismiss(action.id)}>Dismiss</button>
                {/if}
                <button class="expand-btn" onclick={() => toggleExpand(action.id)}>
                  {expandedId === action.id ? '−' : '+'}
                </button>
              </div>
            </div>
            {#if expandedId === action.id}
              <div class="action-detail">
                <div class="detail-label">Reasoning</div>
                <div class="detail-text">{action.reasoning}</div>
                <div class="detail-label">Prompt</div>
                <div class="detail-text prompt-text">{action.prompt}</div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
    {#if dismissedActions.length > 0}
      <div class="dismissed-section">
        {#each dismissedActions as action (action.id)}
          <div class="dismissed-item">
            <span class="dismissed-title">{action.title}</span>
            {#if action.dismissReason}
              <span class="dismiss-reason">— {action.dismissReason}</span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
  </div>
</div>

<style>
  .orch-panel {
    margin-bottom: 20px;
  }

  .orch-panel h2 {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .orch-controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .orch-run-btn {
    background: #6e40c9 !important;
    font-size: 11px !important;
  }

  .orch-run-btn:hover:not(:disabled) {
    background: #8957e5 !important;
  }

  .status-badge {
    font-size: 10px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .status-badge.gathering,
  .status-badge.analyzing {
    background: #122a4a;
    color: #58a6ff;
  }

  .status-badge.ready {
    background: #123620;
    color: #3fb950;
  }

  .status-badge.error {
    background: #361414;
    color: #f85149;
  }

  .data-summary {
    display: flex;
    gap: 12px;
    padding: 8px 18px;
    font-size: 11px;
    color: #8b949e;
    border-bottom: 1px solid #21262d;
    flex-wrap: wrap;
  }

  .orch-loading {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 24px 18px;
    color: #8b949e;
    font-size: 13px;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid #2a313b;
    border-top-color: #58a6ff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .orch-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 18px;
    color: #f85149;
    font-size: 12px;
  }

  .orch-action {
    border-bottom: 1px solid #21262d;
    transition: background 0.1s;
  }

  .orch-action:hover {
    background: #1c2128;
  }

  .orch-action.accepted {
    opacity: 0.6;
  }

  .action-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 18px;
    gap: 12px;
  }

  .action-info {
    flex: 1;
    min-width: 0;
  }

  .action-badges {
    display: flex;
    gap: 6px;
    margin-bottom: 4px;
  }

  .priority-high {
    background: #361414 !important;
    color: #f85149 !important;
  }

  .priority-medium {
    background: #362210 !important;
    color: #f0883e !important;
  }

  .priority-low {
    background: #2a313b !important;
    color: #8b949e !important;
  }

  .source {
    background: #22163c !important;
    color: #a371f7 !important;
  }

  .action-title {
    font-size: 13px;
    font-weight: 500;
    color: #e6edf3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .action-meta {
    font-size: 11px;
    color: #8b949e;
    margin-top: 2px;
    display: flex;
    gap: 10px;
  }

  .action-controls {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-shrink: 0;
  }

  .accepted-label {
    font-size: 11px;
    color: #3fb950;
    font-weight: 500;
  }

  .expand-btn {
    background: transparent;
    border: 1px solid #353d47;
    color: #8b949e;
    width: 24px;
    height: 24px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .expand-btn:hover {
    background: #2a313b;
    color: #c9d1d9;
  }

  .action-detail {
    padding: 0 18px 12px;
    font-size: 12px;
  }

  .detail-label {
    color: #8b949e;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-top: 8px;
    margin-bottom: 4px;
  }

  .detail-text {
    color: #c9d1d9;
    line-height: 1.5;
  }

  .prompt-text {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    background: #0d1117;
    padding: 8px 10px;
    border-radius: 6px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 150px;
    overflow-y: auto;
  }

  .dismiss-reason-row {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .dismiss-reason-input {
    background: #0d1117;
    border: 1px solid #353d47;
    color: #c9d1d9;
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11px;
    width: 160px;
    outline: none;
  }

  .dismiss-reason-input:focus {
    border-color: #58a6ff;
  }

  .dismissed-section {
    border-top: 1px solid #21262d;
    padding: 8px 18px;
  }

  .dismissed-item {
    font-size: 11px;
    color: #484f58;
    padding: 2px 0;
    text-decoration: line-through;
  }

  .dismiss-reason {
    font-style: italic;
    color: #484f58;
    text-decoration: none;
  }
</style>
