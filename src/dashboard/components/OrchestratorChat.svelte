<script lang="ts">
  import { getOrchestratorState, getChatOpen, toggleChat, sendChatMessage } from '../stores/orchestrator.svelte';

  let state = $derived(getOrchestratorState());
  let isOpen = $derived(getChatOpen());
  let chat = $derived(state.chat);

  let inputValue = $state('');
  let messagesEl = $state<HTMLDivElement>(undefined!);

  function handleSend() {
    const q = inputValue.trim();
    if (!q || chat.status === 'thinking') return;
    inputValue = '';
    sendChatMessage(q);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function relativeTime(ts: string): string {
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h`;
  }

  $effect(() => {
    // scroll to bottom when messages change
    if (chat.messages.length && messagesEl) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  });
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="overlay" onclick={toggleChat} onkeydown={() => {}}></div>
  <aside class="chat-sidebar">
    <div class="chat-header">
      <span class="chat-title">Orchestrator Chat</span>
      <button class="close-btn" onclick={toggleChat}>&times;</button>
    </div>

    <div class="chat-messages" bind:this={messagesEl}>
      {#if chat.messages.length === 0}
        <div class="chat-empty">
          Ask about your work: "What PRs are open?", "Why did task #5 fail?", "What should I work on?"
        </div>
      {/if}
      {#each chat.messages as msg}
        <div class="chat-msg" class:user={msg.role === 'user'} class:assistant={msg.role === 'assistant'}>
          <div class="msg-content">{msg.content}</div>
          <div class="msg-time">{relativeTime(msg.timestamp)}</div>
        </div>
      {/each}
      {#if chat.status === 'thinking'}
        <div class="chat-msg assistant">
          <div class="msg-content thinking">
            <span class="spinner"></span>
            Thinking...
          </div>
        </div>
      {/if}
      {#if chat.error}
        <div class="chat-error">Error: {chat.error}</div>
      {/if}
    </div>

    <div class="chat-input-area">
      <textarea
        class="chat-input"
        placeholder="Ask about your work..."
        bind:value={inputValue}
        onkeydown={handleKeydown}
        disabled={chat.status === 'thinking'}
        rows="2"
      ></textarea>
      <button
        class="send-btn"
        onclick={handleSend}
        disabled={!inputValue.trim() || chat.status === 'thinking'}
      >
        Send
      </button>
    </div>
  </aside>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 199;
    background: rgba(0, 0, 0, 0.4);
  }

  .chat-sidebar {
    position: fixed;
    top: 0;
    right: 0;
    width: 420px;
    height: 100vh;
    background: var(--bg-surface);
    border-left: 1px solid var(--border-primary);
    z-index: 200;
    display: flex;
    flex-direction: column;
    box-shadow: var(--shadow-elevated);
  }

  .chat-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 18px;
    border-bottom: 1px solid var(--border-primary);
  }

  .chat-title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #a78bfa;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    transition: color 0.15s;
  }

  .close-btn:hover {
    color: var(--text-primary);
  }

  .chat-messages {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .chat-empty {
    color: var(--text-dim);
    font-size: 12px;
    text-align: center;
    padding: 32px 16px;
    line-height: 1.6;
  }

  .chat-msg {
    max-width: 85%;
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.5;
    word-break: break-word;
  }

  .chat-msg.user {
    align-self: flex-end;
    background: #1a1030;
    color: var(--text-heading);
    border-bottom-right-radius: 4px;
  }

  .chat-msg.assistant {
    align-self: flex-start;
    background: var(--bg-raised);
    color: var(--text-primary);
    border-bottom-left-radius: 4px;
  }

  .msg-content {
    white-space: pre-wrap;
  }

  .msg-content.thinking {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
  }

  .msg-time {
    font-size: 9px;
    color: var(--text-dim);
    margin-top: 4px;
    text-align: right;
  }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid var(--bg-raised);
    border-top-color: #a78bfa;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .chat-error {
    color: var(--danger);
    font-size: 11px;
    padding: 8px;
    background: var(--danger-bg);
    border-radius: 6px;
  }

  .chat-input-area {
    padding: 12px 16px;
    border-top: 1px solid var(--border-primary);
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }

  .chat-input {
    flex: 1;
    background: var(--bg-deep);
    border: 1px solid var(--border-primary);
    border-radius: 8px;
    color: var(--text-primary);
    padding: 8px 12px;
    font-size: 13px;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    resize: none;
    transition: border-color 0.15s;
  }

  .chat-input:focus {
    outline: none;
    border-color: #8b5cf6;
  }

  .chat-input::placeholder {
    color: var(--text-dim);
  }

  .chat-input:disabled {
    opacity: 0.5;
  }

  .send-btn {
    background: #7c3aed;
    border: none;
    color: #fff;
    padding: 8px 16px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: background 0.15s;
    white-space: nowrap;
  }

  .send-btn:hover:not(:disabled) {
    background: #8b5cf6;
  }

  .send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
