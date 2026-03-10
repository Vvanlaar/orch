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
  }

  onMount(() => {
    connect();
    refreshAll();
    // Refresh every 2 minutes (uses cache)
    const interval = setInterval(() => refreshAll(), 120000);
    return () => clearInterval(interval);
  });
</script>

<div class="container">
  <Header {refreshAll} />
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
    background: #0d1117;
    color: #c9d1d9;
    -webkit-font-smoothing: antialiased;
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
    background: #161b22;
    border: 1px solid #2a313b;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
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
    background: #30363d;
    border-radius: 3px;
  }

  :global(.card > h2) {
    cursor: pointer;
    user-select: none;
  }

  :global(.card > h2::before) {
    content: '▼';
    display: inline-block;
    margin-right: 8px;
    font-size: 9px;
    transition: transform 0.15s;
  }

  :global(.card.collapsed > h2::before) {
    transform: rotate(-90deg);
  }

  :global(.card.collapsed > h2) {
    border-bottom: none;
  }

  :global(h2) {
    font-size: 13px;
    font-weight: 600;
    padding: 14px 18px;
    border-bottom: 1px solid #2a313b;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #8b949e;
  }

  :global(.empty) {
    padding: 40px;
    text-align: center;
    color: #6e7681;
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
    background: #2a313b;
    color: #8b949e;
  }

  :global(.badge.state-active),
  :global(.badge.state-open) {
    background: #123620;
    color: #3fb950;
  }

  :global(.badge.state-new) {
    background: #122a4a;
    color: #58a6ff;
  }

  :global(.badge.state-resolved),
  :global(.badge.state-closed) {
    background: #2a313b;
    color: #8b949e;
  }

  :global(.badge.role-author) {
    background: #22163c;
    color: #a371f7;
  }

  :global(.badge.role-reviewer) {
    background: #362210;
    color: #f0883e;
  }

  :global(.badge.type) {
    background: #2a313b;
    color: #8b949e;
  }

  :global(.badge.type-bug) {
    background: #361414;
    color: #f85149;
  }

  :global(.badge.type-feature),
  :global(.badge.type-story) {
    background: #123620;
    color: #3fb950;
  }

  :global(.badge.type-task) {
    background: #122a4a;
    color: #58a6ff;
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
    background: #238636;
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
    background: #2ea043;
  }

  :global(.action-btn:disabled) {
    background: #2a313b;
    color: #6e7681;
    cursor: not-allowed;
  }

  :global(.action-btn.secondary) {
    background: #2a313b;
    color: #8b949e;
  }

  :global(.action-btn.secondary:hover) {
    background: #353d47;
    color: #c9d1d9;
  }

  :global(.refresh-btn) {
    background: #2a313b;
    border: 1px solid #353d47;
    color: #c9d1d9;
    padding: 6px 14px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: background 0.15s;
  }

  :global(.refresh-btn:hover) {
    background: #353d47;
  }

  /* --- Item rows --- */
  :global(.item) {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    padding: 10px 18px;
    border-bottom: 1px solid #21262d;
    align-items: center;
    transition: background 0.1s;
  }

  :global(.item:hover) {
    background: #1c2128;
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
    color: #e6edf3;
  }

  :global(.item-meta) {
    font-size: 11px;
    color: #8b949e;
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
    border-bottom: 1px solid #2a313b;
    flex-wrap: wrap;
  }

  :global(.filter-btn) {
    background: transparent;
    border: 1px solid #353d47;
    color: #8b949e;
    padding: 4px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: all 0.15s;
  }

  :global(.filter-btn:hover) {
    border-color: #58a6ff;
    color: #c9d1d9;
  }

  :global(.filter-btn.active) {
    background: #122a4a;
    border-color: #1f4a85;
    color: #58a6ff;
  }

  :global(.filter-btn.pr-accent.active) {
    background: #22163c;
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
    background: #2a313b;
    border-radius: 3px;
  }

  :global(progress.bright::-webkit-progress-value) {
    background: linear-gradient(90deg, #1a6dff, #58a6ff);
    border-radius: 3px;
  }

  :global(progress.dim::-webkit-progress-value) {
    background: #3d444d;
    border-radius: 3px;
  }
</style>
