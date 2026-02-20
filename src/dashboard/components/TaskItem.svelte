<script lang="ts">
  import type { Task } from '../lib/types';
  import { formatTime, extractRepoFromGitHubUrl } from '../lib/utils';
  import { send } from '../stores/websocket.svelte';
  import {
    isExpanded,
    toggleExpanded,
    getTaskOutput,
    appendSteerInput,
    stopTask,
    deleteTask,
    retryTask,
    completeTask,
    openTerminal,
    setRepoPath,
  } from '../stores/tasks.svelte';

  interface Props {
    task: Task;
  }

  let { task }: Props = $props();

  let expanded = $derived(isExpanded(task.id));
  let output = $derived(getTaskOutput(task.id) || task.streamingOutput || task.result || task.error || '');

  let steerInput = $state('');
  let repoPathInput = $state('');

  let isRunning = $derived(task.status === 'running');
  let isFailed = $derived(task.status === 'failed');
  let needsRepo = $derived(task.status === 'needs-repo');
  let canDelete = $derived(task.status !== 'running');
  let hasOutput = $derived(!!output);
  let retryInfo = $derived(task.context?.retryCount ? ` (retry #${task.context.retryCount})` : '');

  // Extract repo from GitHub PR URL only
  let repos = $derived(extractRepoFromGitHubUrl(task.context?.url) || '');

  async function handleSetRepoPath(e: Event) {
    e.stopPropagation();
    if (!repoPathInput.trim()) return;
    try {
      await setRepoPath(task.id, repoPathInput.trim());
      repoPathInput = '';
    } catch (err: any) {
      alert('Failed: ' + err.message);
    }
  }

  function handleToggle() {
    toggleExpanded(task.id);
  }

  async function handleStop(e: Event) {
    e.stopPropagation();
    if (!confirm(`Stop task #${task.id}?`)) return;
    try {
      await stopTask(task.id);
    } catch (err: any) {
      alert('Failed to stop task: ' + err.message);
    }
  }

  async function handleDelete(e: Event) {
    e.stopPropagation();
    if (!confirm(`Delete task #${task.id}?`)) return;
    try {
      await deleteTask(task.id);
    } catch (err: any) {
      alert('Failed to delete task: ' + err.message);
    }
  }

  async function handleRetry(e: Event) {
    e.stopPropagation();
    try {
      await retryTask(task.id);
    } catch (err: any) {
      alert('Failed to retry task: ' + err.message);
    }
  }

  async function handleComplete(e: Event) {
    e.stopPropagation();
    try {
      await completeTask(task.id);
    } catch (err: any) {
      alert('Failed to complete task: ' + err.message);
    }
  }

  async function handleTerminal(e: Event) {
    e.stopPropagation();
    try {
      await openTerminal(task.id);
    } catch (err: any) {
      alert('Failed to open terminal: ' + err.message);
    }
  }

  function handleSteerKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendSteer();
    }
  }

  function sendSteer() {
    if (!steerInput.trim()) return;
    send({ type: 'steer', taskId: task.id, input: steerInput });
    appendSteerInput(task.id, steerInput);
    steerInput = '';
  }

  function handleViewClick(e: Event) {
    e.stopPropagation();
  }
</script>

<div class="task-wrapper">
  <div class="task task-row" onclick={handleToggle} role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && handleToggle()}>
    <div class="task-id">#{task.id}</div>
    <div class="task-status {task.status}">{task.status}</div>
    <div class="task-info">
      <div class="task-type">{task.type}{retryInfo}{#if repos} · {repos}{/if}</div>
      <div class="task-title">{task.context?.title || task.repo}</div>
    </div>
    <div class="task-time">{formatTime(task.createdAt)}</div>
    <div class="task-actions">
      <button class="action-btn secondary" onclick={handleTerminal} title="Open terminal">&lt;/&gt;</button>
      {#if isRunning}
        <button class="action-btn done-btn" onclick={handleComplete}>Done</button>
        <button class="action-btn stop-btn" onclick={handleStop}>Stop</button>
      {:else if isFailed}
        <button class="action-btn retry-btn" onclick={handleRetry}>Retry</button>
        <button class="action-btn secondary" onclick={handleDelete}>Delete</button>
      {:else if canDelete}
        <button class="action-btn secondary" onclick={handleDelete}>Delete</button>
      {/if}
      {#if task.context?.url}
        <a href={task.context.url} target="_blank" class="action-btn secondary" onclick={handleViewClick}>View</a>
      {/if}
    </div>
  </div>

  <div class="task-output" class:visible={expanded}>
    {#if hasOutput}
      <span class="chunk">{output}</span>
    {:else}
      <span class="no-output">No output yet...</span>
    {/if}
  </div>

  {#if needsRepo}
    <div class="repo-path-input">
      <span class="repo-label">Repo path not found. Enter local path:</span>
      <input
        type="text"
        placeholder="/path/to/repo"
        bind:value={repoPathInput}
        onkeydown={(e) => e.key === 'Enter' && handleSetRepoPath(e)}
      />
      <button class="action-btn" onclick={handleSetRepoPath}>Set Path</button>
    </div>
  {/if}

  {#if isRunning}
    <div class="steer-input" class:visible={expanded}>
      <input
        type="text"
        placeholder="Send input to Claude..."
        bind:value={steerInput}
        onkeydown={handleSteerKey}
      />
      <button class="action-btn" onclick={sendSteer}>Send</button>
    </div>
  {/if}
</div>

<style>
  .task-wrapper {
    border-bottom: 1px solid #21262d;
    overflow-x: hidden;
  }

  .task-wrapper:last-child {
    border-bottom: none;
  }

  .task {
    display: grid;
    grid-template-columns: 60px 90px minmax(0, 1fr) 80px auto;
    gap: 12px;
    padding: 12px 16px;
    align-items: center;
    overflow: hidden;
    cursor: pointer;
  }

  .task:hover {
    background: #1c2128;
  }

  .task-id {
    font-family: monospace;
    color: #8b949e;
    font-size: 13px;
  }

  .task-status {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 12px;
    text-align: center;
  }

  .task-status.pending {
    background: #f0883e20;
    color: #f0883e;
  }

  .task-status.running {
    background: #58a6ff20;
    color: #58a6ff;
  }

  .task-status.completed {
    background: #3fb95020;
    color: #3fb950;
  }

  .task-status.failed {
    background: #f8514920;
    color: #f85149;
  }

  .task-status.needs-repo {
    background: #8b949e20;
    color: #8b949e;
  }

  .task-info {
    overflow: hidden;
  }

  .task-type {
    font-size: 11px;
    color: #8b949e;
  }

  .task-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 13px;
  }

  .task-time {
    font-size: 12px;
    color: #8b949e;
  }

  .task-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .done-btn {
    background: #3fb950 !important;
  }

  .stop-btn {
    background: #f85149 !important;
  }

  .retry-btn {
    background: #f0883e !important;
  }

  .retry-btn:hover {
    background: #d97706 !important;
  }

  .task-output {
    font-family: 'Monaco', 'Consolas', monospace;
    font-size: 12px;
    background: #0d1117;
    padding: 12px;
    max-height: 400px;
    overflow-y: auto;
    overflow-x: hidden;
    white-space: pre-wrap;
    word-break: break-word;
    color: #8b949e;
    border-top: 1px solid #21262d;
    display: none;
  }

  .task-output.visible {
    display: block;
  }

  .task-output .chunk {
    color: #c9d1d9;
  }

  .task-output .no-output {
    color: #8b949e;
  }

  .steer-input {
    display: none;
    padding: 8px 12px;
    gap: 8px;
    border-top: 1px solid #21262d;
    background: #161b22;
  }

  .steer-input.visible {
    display: flex;
  }

  .steer-input input {
    flex: 1;
    background: #0d1117;
    border: 1px solid #30363d;
    color: #c9d1d9;
    padding: 6px 10px;
    border-radius: 4px;
    font-family: 'Monaco', 'Consolas', monospace;
    font-size: 12px;
  }

  .steer-input input:focus {
    outline: none;
    border-color: #58a6ff;
  }

  .repo-path-input {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid #21262d;
    background: #161b22;
  }

  .repo-label {
    font-size: 12px;
    color: #8b949e;
    white-space: nowrap;
  }

  .repo-path-input input {
    flex: 1;
    background: #0d1117;
    border: 1px solid #30363d;
    color: #c9d1d9;
    padding: 6px 10px;
    border-radius: 4px;
    font-family: 'Monaco', 'Consolas', monospace;
    font-size: 12px;
  }

  .repo-path-input input:focus {
    outline: none;
    border-color: #58a6ff;
  }
</style>
