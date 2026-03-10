<script lang="ts">
  import type { Task } from '../lib/types';
  import { formatTime, extractRepoFromGitHubUrl } from '../lib/utils';
  import { send } from '../stores/websocket.svelte';
  import { showToast, showConfirm } from '../stores/toast.svelte';
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
    approveTask,
    dismissTask,
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
  let isSuggestion = $derived(task.status === 'suggestion');
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
      showToast('Failed: ' + err.message, 'error');
    }
  }

  function handleToggle() {
    toggleExpanded(task.id);
  }

  async function handleStop(e: Event) {
    e.stopPropagation();
    if (!await showConfirm(`Stop task #${task.id}?`)) return;
    try {
      await stopTask(task.id);
    } catch (err: any) {
      showToast('Failed to stop task: ' + err.message, 'error');
    }
  }

  async function handleDelete(e: Event) {
    e.stopPropagation();
    if (!await showConfirm(`Delete task #${task.id}?`)) return;
    try {
      await deleteTask(task.id);
    } catch (err: any) {
      showToast('Failed to delete task: ' + err.message, 'error');
    }
  }

  async function handleRetry(e: Event) {
    e.stopPropagation();
    try {
      await retryTask(task.id);
    } catch (err: any) {
      showToast('Failed to retry task: ' + err.message, 'error');
    }
  }

  async function handleComplete(e: Event) {
    e.stopPropagation();
    try {
      await completeTask(task.id);
    } catch (err: any) {
      showToast('Failed to complete task: ' + err.message, 'error');
    }
  }

  async function handleTerminal(e: Event) {
    e.stopPropagation();
    try {
      await openTerminal(task.id);
    } catch (err: any) {
      showToast('Failed to open terminal: ' + err.message, 'error');
    }
  }

  async function handleApprove(e: Event) {
    e.stopPropagation();
    try {
      await approveTask(task.id);
    } catch (err: any) {
      showToast('Failed to approve: ' + err.message, 'error');
    }
  }

  async function handleDismiss(e: Event) {
    e.stopPropagation();
    try {
      await dismissTask(task.id);
    } catch (err: any) {
      showToast('Failed to dismiss: ' + err.message, 'error');
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
      {#if isSuggestion}
        <button class="action-btn approve-btn" onclick={handleApprove}>Approve</button>
        <button class="action-btn dismiss-btn" onclick={handleDismiss}>Skip</button>
      {:else if isRunning}
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
    grid-template-columns: 48px 80px minmax(0, 1fr) 72px auto;
    gap: 10px;
    padding: 10px 18px;
    align-items: center;
    overflow: hidden;
    cursor: pointer;
    transition: background 0.1s;
  }

  .task:hover {
    background: #1c2128;
  }

  .task-id {
    font-family: 'IBM Plex Mono', monospace;
    color: #8b949e;
    font-size: 12px;
  }

  .task-status {
    font-size: 10px;
    font-weight: 500;
    padding: 3px 8px;
    border-radius: 4px;
    text-align: center;
    letter-spacing: 0.02em;
  }

  .task-status.pending {
    background: #362210;
    color: #f0883e;
  }

  .task-status.running {
    background: #122a4a;
    color: #58a6ff;
  }

  .task-status.completed {
    background: #123620;
    color: #3fb950;
  }

  .task-status.failed {
    background: #361414;
    color: #f85149;
  }

  .task-status.needs-repo {
    background: #2a313b;
    color: #8b949e;
  }

  .task-status.suggestion {
    background: #22163c;
    color: #a371f7;
  }

  .task-status.dismissed {
    background: #2a313b;
    color: #8b949e;
  }

  .task-info {
    overflow: hidden;
  }

  .task-type {
    font-size: 10px;
    color: #8b949e;
    letter-spacing: 0.02em;
  }

  .task-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    font-weight: 500;
    color: #e6edf3;
  }

  .task-time {
    font-size: 11px;
    color: #8b949e;
    font-family: 'IBM Plex Mono', monospace;
  }

  .task-actions {
    display: flex;
    gap: 6px;
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

  .approve-btn {
    background: #3fb950 !important;
  }

  .dismiss-btn {
    background: #8b949e !important;
  }

  .retry-btn:hover {
    background: #d97706 !important;
  }

  .task-output {
    font-family: 'IBM Plex Mono', 'Consolas', monospace;
    font-size: 11px;
    background: #0d1117;
    padding: 12px 18px;
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
    color: #6e7681;
  }

  .steer-input {
    display: none;
    padding: 8px 18px;
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
    border: 1px solid #2a313b;
    color: #c9d1d9;
    padding: 6px 10px;
    border-radius: 6px;
    font-family: 'IBM Plex Mono', 'Consolas', monospace;
    font-size: 11px;
    transition: border-color 0.15s;
  }

  .steer-input input:focus {
    outline: none;
    border-color: #1f4a85;
  }

  .repo-path-input {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 18px;
    border-top: 1px solid #21262d;
    background: #161b22;
  }

  .repo-label {
    font-size: 11px;
    color: #8b949e;
    white-space: nowrap;
  }

  .repo-path-input input {
    flex: 1;
    background: #0d1117;
    border: 1px solid #2a313b;
    color: #c9d1d9;
    padding: 6px 10px;
    border-radius: 6px;
    font-family: 'IBM Plex Mono', 'Consolas', monospace;
    font-size: 11px;
    transition: border-color 0.15s;
  }

  .repo-path-input input:focus {
    outline: none;
    border-color: #1f4a85;
  }
</style>
