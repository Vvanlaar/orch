<script lang="ts">
  import { onMount } from 'svelte';
  import Header from './components/Header.svelte';
  import WorkItems from './components/WorkItems.svelte';
  import TestingAssignment from './components/TestingAssignment.svelte';
  import TaskList from './components/TaskList.svelte';
  import ProcessList from './components/ProcessList.svelte';
  import { connect } from './stores/websocket.svelte';
  import { fetchPRs, fetchWorkItems, fetchResolvedByMe } from './stores/workItems.svelte';
  import { fetchTasks } from './stores/tasks.svelte';
  import { fetchClaudeUsage } from './stores/usage.svelte';
  import { fetchReviewedItems, fetchTeamMembers } from './stores/testing.svelte';
  import { fetchCurrentUser } from './stores/currentUser.svelte';

  function refreshAll() {
    fetchPRs();
    fetchWorkItems();
    fetchResolvedByMe();
    fetchTasks();
    fetchClaudeUsage();
    fetchReviewedItems();
    fetchTeamMembers();
    fetchCurrentUser();
  }

  onMount(() => {
    connect();
    refreshAll();
    // Refresh every 2 minutes
    const interval = setInterval(refreshAll, 120000);
    return () => clearInterval(interval);
  });
</script>

<div class="container">
  <Header {refreshAll} />
  <WorkItems />
  <TestingAssignment />
  <TaskList />
  <ProcessList />
</div>

<style>
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(body) {
    font-family: system-ui, -apple-system, sans-serif;
    background: #0d1117;
    color: #c9d1d9;
  }

  .container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 20px;
  }

  :global(.card) {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    overflow: hidden;
  }

  :global(.card-list) {
    max-height: 400px;
    overflow-y: auto;
  }

  :global(h2) {
    font-size: 16px;
    font-weight: 600;
    padding: 16px;
    border-bottom: 1px solid #30363d;
  }

  :global(.empty) {
    padding: 48px;
    text-align: center;
    color: #8b949e;
  }

  :global(.badge) {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 12px;
  }

  :global(.badge.state) {
    background: #30363d;
    color: #8b949e;
  }

  :global(.badge.state-active),
  :global(.badge.state-open) {
    background: #3fb95020;
    color: #3fb950;
  }

  :global(.badge.state-new) {
    background: #58a6ff20;
    color: #58a6ff;
  }

  :global(.badge.state-resolved),
  :global(.badge.state-closed) {
    background: #8b949e20;
    color: #8b949e;
  }

  :global(.badge.role-author) {
    background: #a371f720;
    color: #a371f7;
  }

  :global(.badge.role-reviewer) {
    background: #f0883e20;
    color: #f0883e;
  }

  :global(.badge.type) {
    background: #21262d;
    color: #8b949e;
  }

  :global(.badge.type-bug) {
    background: #f8514920;
    color: #f85149;
  }

  :global(.badge.type-feature),
  :global(.badge.type-story) {
    background: #3fb95020;
    color: #3fb950;
  }

  :global(.badge.type-task) {
    background: #58a6ff20;
    color: #58a6ff;
  }

  :global(.action-btn) {
    background: #238636;
    border: none;
    color: #fff;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
  }

  :global(.action-btn:hover) {
    background: #2ea043;
  }

  :global(.action-btn:disabled) {
    background: #21262d;
    color: #8b949e;
    cursor: not-allowed;
  }

  :global(.action-btn.secondary) {
    background: #30363d;
  }

  :global(.action-btn.secondary:hover) {
    background: #3d444d;
  }

  :global(.refresh-btn) {
    background: #21262d;
    border: 1px solid #30363d;
    color: #c9d1d9;
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
  }

  :global(.refresh-btn:hover) {
    background: #30363d;
  }

  :global(.item) {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid #21262d;
    align-items: center;
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
    font-size: 14px;
  }

  :global(.item-meta) {
    font-size: 12px;
    color: #8b949e;
    margin-top: 4px;
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }

  :global(.item-actions) {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  :global(.filters) {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid #30363d;
    flex-wrap: wrap;
  }

  :global(.filter-btn) {
    background: transparent;
    border: 1px solid #30363d;
    color: #8b949e;
    padding: 4px 12px;
    border-radius: 16px;
    cursor: pointer;
    font-size: 12px;
  }

  :global(.filter-btn:hover) {
    border-color: #58a6ff;
    color: #c9d1d9;
  }

  :global(.filter-btn.active) {
    background: #58a6ff20;
    border-color: #58a6ff;
    color: #58a6ff;
  }

  :global(progress) {
    appearance: none;
    border-radius: 4px;
    overflow: hidden;
  }

  :global(progress::-webkit-progress-bar) {
    background: #21262d;
    border-radius: 4px;
  }

  :global(progress.bright::-webkit-progress-value) {
    background: #58a6ff;
  }

  :global(progress.dim::-webkit-progress-value) {
    background: #484f58;
  }
</style>
