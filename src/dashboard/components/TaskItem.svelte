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
    getLocalMachineId,
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
  let isRemote = $derived(!!task.machineId && !!getLocalMachineId() && task.machineId !== getLocalMachineId());

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

<div class="task-wrapper" class:running={isRunning}>
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
      {:else if isRunning && isRemote}
        <span class="remote-badge" title="Running on {task.machineId}">remote</span>
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
    border-bottom: 1px solid var(--border-subtle);
    overflow-x: hidden;
    border-left: 2px solid transparent;
    transition: border-left-color 0.2s;
  }

  .task-wrapper.running {
    border-left-color: var(--success);
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
    background: var(--bg-raised);
  }

  .task-id {
    font-family: 'IBM Plex Mono', monospace;
    color: var(--text-muted);
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
    background: var(--warning-bg);
    color: var(--warning);
  }

  .task-status.running {
    background: var(--info-bg);
    color: var(--info);
  }

  .task-status.completed {
    background: var(--success-bg);
    color: var(--success);
  }

  .task-status.failed {
    background: var(--danger-bg);
    color: var(--danger);
  }

  .task-status.needs-repo {
    background: var(--bg-raised);
    color: var(--text-muted);
  }

  .task-status.suggestion {
    background: #1a1030;
    color: #a371f7;
  }

  .task-status.dismissed {
    background: var(--bg-raised);
    color: var(--text-muted);
  }

  .task-info {
    overflow: hidden;
  }

  .task-type {
    font-size: 10px;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .task-title {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-heading);
  }

  .task-time {
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'IBM Plex Mono', monospace;
  }

  .task-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .done-btn {
    background: var(--success) !important;
    color: #000 !important;
  }

  .stop-btn {
    background: var(--danger) !important;
  }

  .retry-btn {
    background: var(--warning) !important;
    color: #000 !important;
  }

  .approve-btn {
    background: var(--success) !important;
    color: #000 !important;
  }

  .dismiss-btn {
    background: var(--text-muted) !important;
  }

  .remote-badge {
    font-size: 9px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--info-bg);
    color: var(--info);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .retry-btn:hover {
    background: #d97706 !important;
  }

  .task-output {
    font-family: 'IBM Plex Mono', 'Consolas', monospace;
    font-size: 11px;
    background: var(--bg-deep);
    padding: 12px 18px;
    max-height: 400px;
    overflow-y: auto;
    overflow-x: hidden;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-muted);
    border-top: 1px solid var(--border-subtle);
    display: none;
  }

  .task-output.visible {
    display: block;
  }

  .task-output .chunk {
    color: var(--text-primary);
  }

  .task-output .no-output {
    color: var(--text-dim);
  }

  .steer-input {
    display: none;
    padding: 8px 18px;
    gap: 8px;
    border-top: 1px solid var(--border-subtle);
    background: var(--bg-surface);
  }

  .steer-input.visible {
    display: flex;
  }

  .steer-input input {
    flex: 1;
    background: var(--bg-deep);
    border: 1px solid var(--border-primary);
    color: var(--text-primary);
    padding: 6px 10px;
    border-radius: 6px;
    font-family: 'IBM Plex Mono', 'Consolas', monospace;
    font-size: 11px;
    transition: border-color 0.15s;
  }

  .steer-input input:focus {
    outline: none;
    border-color: #10b981;
  }

  .repo-path-input {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 18px;
    border-top: 1px solid var(--border-subtle);
    background: var(--bg-surface);
  }

  .repo-label {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .repo-path-input input {
    flex: 1;
    background: var(--bg-deep);
    border: 1px solid var(--border-primary);
    color: var(--text-primary);
    padding: 6px 10px;
    border-radius: 6px;
    font-family: 'IBM Plex Mono', 'Consolas', monospace;
    font-size: 11px;
    transition: border-color 0.15s;
  }

  .repo-path-input input:focus {
    outline: none;
    border-color: #10b981;
  }
</style>
