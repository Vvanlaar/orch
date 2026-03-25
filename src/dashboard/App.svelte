<script lang="ts">
  import { onMount } from 'svelte';
  import Header from './components/Header.svelte';
  import WorkItems from './components/WorkItems.svelte';
  import TestingAssignment from './components/TestingAssignment.svelte';
  import TaskList from './components/TaskList.svelte';
  import ProcessList from './components/ProcessList.svelte';
  import { connect } from './stores/websocket.svelte';
  import { fetchPRs, fetchWorkItems, fetchResolvedByMe, fetchResolvedWithComments } from './stores/workItems.svelte';
  import { fetchTasks } from './stores/tasks.svelte';
  import { fetchClaudeUsage } from './stores/usage.svelte';
  import { fetchReviewedItems, fetchTeamMembers } from './stores/testing.svelte';
  import { fetchCurrentUser } from './stores/currentUser.svelte';
  import { fetchNotifications } from './stores/notifications.svelte';
  import { fetchOrchestratorState } from './stores/orchestrator.svelte';
  import NotificationSidebar from './components/NotificationSidebar.svelte';
  import OrchestratorPanel from './components/OrchestratorPanel.svelte';
  import OrchestratorChat from './components/OrchestratorChat.svelte';
  import ToastContainer from './components/ToastContainer.svelte';
  import VideoscanPage from './components/VideoscanPage.svelte';
  import DashboardOverview from './components/DashboardOverview.svelte';
  import { getRoute } from './lib/router.svelte';

  let route = $derived(getRoute());
  let lastRefreshedAt = $state<string>('');

  function refreshAll(refresh = false) {
    fetchPRs(refresh);
    fetchWorkItems();
    fetchResolvedByMe();
    fetchResolvedWithComments(refresh);
    fetchTasks();
    fetchClaudeUsage();
    fetchReviewedItems();
    fetchTeamMembers();
    fetchCurrentUser();
    fetchNotifications();
    fetchOrchestratorState();
    lastRefreshedAt = new Date().toISOString();
  }

  onMount(() => {
    connect();
    refreshAll();
    // Refresh every 10 minutes (reduced from 2min to lower Supabase egress)
    const interval = setInterval(() => refreshAll(), 600000);
    return () => clearInterval(interval);
  });
</script>

<div class="container">
  <Header {refreshAll} {lastRefreshedAt} />
  {#if route === '/videoscan'}
    <VideoscanPage />
  {:else if route === '/tickets'}
    <WorkItems />
    <OrchestratorPanel />
    <div class="bottom-grid">
      <div class="bottom-left">
        <TaskList />
        <ProcessList />
      </div>
      <div class="bottom-right">
        <TestingAssignment />
      </div>
    </div>
  {:else}
    <DashboardOverview />
  {/if}
</div>
<NotificationSidebar />
<OrchestratorChat />
<ToastContainer />

<style>
  @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(body) {
    font-family: 'IBM Plex Sans', system-ui, -apple-system, sans-serif;
    background: var(--bg-deep);
    color: var(--text-primary);
    -webkit-font-smoothing: antialiased;

    /* === Mission Control Design Tokens === */
    --bg-deep: #080d14;
    --bg-surface: #0e1521;
    --bg-raised: #152033;
    --bg-overlay: #1a2740;
    --border-primary: #1c2e42;
    --border-subtle: #142234;
    --border-bright: #264060;
    --text-primary: #d0dae6;
    --text-heading: #e8eff6;
    --text-muted: #5e7389;
    --text-dim: #3d5570;

    /* Semantic colors */
    --success: #34d399;
    --success-bg: #0d2818;
    --danger: #f85149;
    --danger-bg: #2a0f0f;
    --warning: #f0883e;
    --warning-bg: #2a1a0a;
    --info: #58a6ff;
    --info-bg: #0d1f3c;

    /* Shadows */
    --shadow-card: 0 2px 12px rgba(0, 0, 0, 0.3), 0 0 1px rgba(0, 0, 0, 0.2);
    --shadow-elevated: 0 12px 40px rgba(0, 0, 0, 0.5), 0 0 1px rgba(0, 0, 0, 0.3);

    /* Section accents — overridden per wrapper */
    --accent: #10b981;
    --accent-bright: #34d399;
    --accent-dim: #065f46;
    --accent-glow: rgba(16, 185, 129, 0.15);
  }

  .container {
    max-width: 1600px;
    margin: 0 auto;
    padding: 20px 24px;
  }

  .bottom-grid {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: 20px;
    align-items: start;
  }

  .bottom-left {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  @media (max-width: 1100px) {
    .bottom-grid {
      grid-template-columns: 1fr;
    }
  }

  /* --- Card system --- */
  :global(.card) {
    background: var(--bg-surface);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    overflow: hidden;
    box-shadow: var(--shadow-card);
    border-left: 3px solid var(--border-subtle);
  }

  :global(.card-list) {
    max-height: 400px;
    overflow-y: auto;
  }

  :global(.card-list::-webkit-scrollbar) {
    width: 6px;
  }

  :global(.card-list::-webkit-scrollbar-track) {
    background: transparent;
  }

  :global(.card-list::-webkit-scrollbar-thumb) {
    background: var(--border-primary);
    border-radius: 3px;
  }

  :global(.card > h2) {
    user-select: none;
  }

  :global(.card-toggle) {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 0;
  }

  :global(.card-toggle::before) {
    content: '\25BC';
    display: inline-block;
    margin-right: 8px;
    font-size: 9px;
    transition: transform 0.15s;
    flex-shrink: 0;
  }

  :global(.card.collapsed .card-toggle::before) {
    transform: rotate(-90deg);
  }

  :global(.card.collapsed > h2) {
    border-bottom: none;
  }

  :global(h2) {
    font-size: 13px;
    font-weight: 600;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border-primary);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  :global(.empty) {
    padding: 40px;
    text-align: center;
    color: var(--text-dim);
    font-size: 13px;
  }

  /* --- Badges --- */
  :global(.badge) {
    font-size: 10px;
    font-weight: 500;
    padding: 2px 8px;
    border-radius: 4px;
    letter-spacing: 0.02em;
  }

  :global(.badge.state) {
    background: var(--bg-raised);
    color: var(--text-muted);
  }

  :global(.badge.state-active),
  :global(.badge.state-open) {
    background: var(--success-bg);
    color: var(--success);
  }

  :global(.badge.state-new) {
    background: var(--info-bg);
    color: var(--info);
  }

  :global(.badge.state-resolved),
  :global(.badge.state-closed) {
    background: var(--bg-raised);
    color: var(--text-muted);
  }

  :global(.badge.role-author) {
    background: #1a1030;
    color: #a371f7;
  }

  :global(.badge.role-reviewer) {
    background: var(--warning-bg);
    color: var(--warning);
  }

  :global(.badge.type) {
    background: var(--bg-raised);
    color: var(--text-muted);
  }

  :global(.badge.type-bug) {
    background: var(--danger-bg);
    color: var(--danger);
  }

  :global(.badge.type-feature),
  :global(.badge.type-story) {
    background: var(--success-bg);
    color: var(--success);
  }

  :global(.badge.type-task) {
    background: var(--info-bg);
    color: var(--info);
  }

  :global(.badge-link) {
    text-decoration: none;
    cursor: pointer;
    transition: filter 0.15s;
  }

  :global(.badge-link:hover) {
    filter: brightness(1.3);
  }

  /* --- Buttons --- */
  :global(.action-btn) {
    background: #1a7f37;
    border: none;
    color: #fff;
    padding: 5px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: background 0.15s, opacity 0.15s;
  }

  :global(.action-btn:hover) {
    background: #22943e;
  }

  :global(.action-btn:disabled) {
    background: var(--bg-raised);
    color: var(--text-dim);
    cursor: not-allowed;
  }

  :global(.action-btn.secondary) {
    background: var(--bg-raised);
    color: var(--text-muted);
  }

  :global(.action-btn.secondary:hover) {
    background: var(--bg-overlay);
    color: var(--text-primary);
  }

  :global(.refresh-btn) {
    background: var(--bg-raised);
    border: 1px solid var(--border-bright);
    color: var(--text-primary);
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: background 0.15s;
  }

  :global(.refresh-btn:hover) {
    background: var(--bg-overlay);
  }

  /* --- Item rows --- */
  :global(.item) {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--border-subtle);
    align-items: center;
    transition: background 0.1s;
  }

  :global(.item:hover) {
    background: var(--bg-raised);
  }

  :global(.item-info) {
    overflow: hidden;
  }

  :global(.item-title) {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-heading);
  }

  :global(.item-meta) {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
  }

  :global(.item-actions) {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  /* --- Filters --- */
  :global(.filters) {
    display: flex;
    gap: 6px;
    padding: 10px 18px;
    border-bottom: 1px solid var(--border-primary);
    flex-wrap: wrap;
  }

  :global(.filter-btn) {
    background: transparent;
    border: 1px solid var(--border-bright);
    color: var(--text-muted);
    padding: 4px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: all 0.15s;
  }

  :global(.filter-btn:hover) {
    border-color: var(--info);
    color: var(--text-primary);
  }

  :global(.filter-btn.active) {
    background: var(--info-bg);
    border-color: #1f4a85;
    color: var(--info);
  }

  :global(.filter-btn.pr-accent.active) {
    background: #1a1030;
    border-color: #553d87;
    color: #a371f7;
  }

  :global(.filter-btn.pr-accent:hover) {
    border-color: #a371f7;
  }

  /* --- Progress --- */
  :global(progress) {
    appearance: none;
    border-radius: 3px;
    overflow: hidden;
  }

  :global(progress::-webkit-progress-bar) {
    background: var(--bg-raised);
    border-radius: 3px;
  }

  :global(progress.bright::-webkit-progress-value) {
    background: linear-gradient(90deg, #1a6dff, #58a6ff);
    border-radius: 3px;
  }

  :global(progress.dim::-webkit-progress-value) {
    background: var(--text-dim);
    border-radius: 3px;
  }
</style>
