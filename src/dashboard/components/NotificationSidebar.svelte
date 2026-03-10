<script lang="ts">
  import {
    getNotificationState,
    getFilteredNotifications,
    getRepos,
    toggleSidebar,
    setFilterRepo,
    setSearchQuery,
  } from '../stores/notifications.svelte';

  let state = $derived(getNotificationState());
  let filtered = $derived(getFilteredNotifications());
  let repos = $derived(getRepos());

  let copyFeedback = $state<string | null>(null);

  function relativeTime(ts: string): string {
    const diff = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  function truncate(text: string, max: number): string {
    if (!text) return '';
    return text.length > max ? text.slice(0, max) + '...' : text;
  }

  async function copyResume(cwd: string, sessionId: string, notifId: string) {
    const cmd = `cd ${cwd.replace(/\\/g, '/')} && clauded --resume ${sessionId}`;
    try {
      await navigator.clipboard.writeText(cmd);
      copyFeedback = notifId;
      setTimeout(() => copyFeedback = null, 1500);
    } catch {}
  }
</script>

{#if state.sidebarOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="overlay" onclick={toggleSidebar} onkeydown={() => {}}></div>
  <aside class="sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">Notifications</span>
      <button class="close-btn" onclick={toggleSidebar}>&times;</button>
    </div>
    <div class="sidebar-filters">
      <input
        type="text"
        class="search-input"
        placeholder="Search..."
        value={state.searchQuery}
        oninput={(e) => setSearchQuery((e.currentTarget as HTMLInputElement).value)}
      />
      <select
        class="repo-select"
        value={state.filterRepo}
        onchange={(e) => setFilterRepo((e.currentTarget as HTMLSelectElement).value)}
      >
        <option value="">All repos</option>
        {#each repos as repo}
          <option value={repo}>{repo}</option>
        {/each}
      </select>
    </div>
    <div class="sidebar-list">
      {#each filtered as notif (notif.id)}
        <div class="notif-item">
          <div class="notif-top">
            <span class="notif-badge" class:plan-ready={notif.type === 'plan-ready'}>
              {notif.type === 'plan-ready' ? 'Plan Ready' : 'Stopped'}
            </span>
            <span class="notif-time">{relativeTime(notif.timestamp)}</span>
          </div>
          <div class="notif-name">{notif.sessionName || 'Untitled session'}</div>
          {#if notif.lastMessage}
            <div class="notif-msg">{truncate(notif.lastMessage, 200)}</div>
          {/if}
          <div class="notif-meta">
            <span>{notif.repo}</span>
            <span>{notif.machine}</span>
          </div>
          {#if notif.sessionId && notif.cwd}
            <button
              class="copy-btn"
              onclick={() => copyResume(notif.cwd, notif.sessionId, notif.id)}
            >
              {copyFeedback === notif.id ? 'Copied!' : 'Copy resume cmd'}
            </button>
          {/if}
        </div>
      {:else}
        <div class="empty-state">No notifications</div>
      {/each}
    </div>
  </aside>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 199;
    background: rgba(0, 0, 0, 0.3);
  }

  .sidebar {
    position: fixed;
    top: 0;
    right: 0;
    width: 380px;
    height: 100vh;
    background: #161b22;
    border-left: 1px solid #2a313b;
    z-index: 200;
    display: flex;
    flex-direction: column;
    box-shadow: -8px 0 32px rgba(0, 0, 0, 0.5);
  }

  .sidebar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 18px;
    border-bottom: 1px solid #2a313b;
  }

  .sidebar-title {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #8b949e;
  }

  .close-btn {
    background: none;
    border: none;
    color: #8b949e;
    font-size: 18px;
    cursor: pointer;
    padding: 0 4px;
    transition: color 0.15s;
  }

  .close-btn:hover {
    color: #c9d1d9;
  }

  .sidebar-filters {
    display: flex;
    gap: 6px;
    padding: 10px 18px;
    border-bottom: 1px solid #2a313b;
  }

  .search-input {
    flex: 1;
    background: #0d1117;
    border: 1px solid #2a313b;
    border-radius: 6px;
    color: #c9d1d9;
    padding: 6px 10px;
    font-size: 11px;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: border-color 0.15s;
  }

  .search-input:focus {
    outline: none;
    border-color: #1f4a85;
  }

  .repo-select {
    background: #0d1117;
    border: 1px solid #2a313b;
    border-radius: 6px;
    color: #c9d1d9;
    padding: 6px 8px;
    font-size: 11px;
    max-width: 140px;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
  }

  .sidebar-list {
    flex: 1;
    overflow-y: auto;
  }

  .notif-item {
    padding: 12px 18px;
    border-bottom: 1px solid #21262d;
    transition: background 0.1s;
  }

  .notif-item:hover {
    background: #1c2128;
  }

  .notif-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .notif-badge {
    font-size: 9px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 4px;
    background: #361414;
    color: #f85149;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .notif-badge.plan-ready {
    background: #122a4a;
    color: #58a6ff;
  }

  .notif-time {
    font-size: 10px;
    color: #8b949e;
    font-family: 'IBM Plex Mono', monospace;
  }

  .notif-name {
    font-size: 13px;
    font-weight: 600;
    color: #e6edf3;
    margin-bottom: 4px;
  }

  .notif-msg {
    font-size: 11px;
    color: #8b949e;
    line-height: 1.5;
    margin-bottom: 6px;
    word-break: break-word;
  }

  .notif-meta {
    display: flex;
    gap: 10px;
    font-size: 10px;
    color: #6e7681;
    margin-bottom: 6px;
    font-family: 'IBM Plex Mono', monospace;
  }

  .copy-btn {
    background: #2a313b;
    border: 1px solid #353d47;
    border-radius: 4px;
    color: #8b949e;
    padding: 3px 8px;
    font-size: 10px;
    cursor: pointer;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: all 0.15s;
  }

  .copy-btn:hover {
    background: #353d47;
    color: #c9d1d9;
  }

  .empty-state {
    padding: 48px 18px;
    text-align: center;
    color: #6e7681;
    font-size: 12px;
  }
</style>
