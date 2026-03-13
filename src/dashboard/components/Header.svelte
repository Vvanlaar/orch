<script lang="ts">
  import { getConnectionState } from '../stores/websocket.svelte';
  import { getUsage, formatResetTime, formatUpdatedAt } from '../stores/usage.svelte';
  import { getSettings, fetchTerminalConfig, detectTerminals, selectInteractiveSession, selectTerminal } from '../stores/settings.svelte';
  import { getCredentials, saveCredentials } from '../lib/api';
  import { getAuth, fetchAuthStatus, beginDeviceFlow, cancelDeviceFlow } from '../stores/auth.svelte';
  import { getNotificationState, toggleSidebar } from '../stores/notifications.svelte';
  import { triggerOrchestration, toggleChat } from '../stores/orchestrator.svelte';
  import { getSearchQuery, setSearchQuery } from '../stores/search.svelte';
  import { getRoute, navigate, type Route } from '../lib/router.svelte';
  import type { TerminalId } from '../lib/types';
  import { onMount } from 'svelte';

  interface Props {
    refreshAll: (refresh?: boolean) => void;
  }

  let { refreshAll }: Props = $props();

  let currentRoute = $derived(getRoute());

  let connectionState = $derived(getConnectionState());
  let usage = $derived(getUsage());
  let settings = $derived(getSettings());

  let usage5h = $derived(Math.round(usage?.five_hour?.utilization ?? 0));
  let usage7d = $derived(Math.round(usage?.seven_day?.utilization ?? 0));
  let reset5h = $derived(formatResetTime(usage?.five_hour?.resets_at));
  let reset7d = $derived(formatResetTime(usage?.seven_day?.resets_at));
  let updatedAt = $derived(formatUpdatedAt(usage?.updatedAt));

  let auth = $derived(getAuth());
  let notifState = $derived(getNotificationState());
  let currentSearch = $derived(getSearchQuery());
  let searchInput: HTMLInputElement;
  let settingsOpen = $state(false);
  let creds = $state<Record<string, string>>({});
  let credsSaving = $state(false);
  let credsMessage = $state('');

  function toggleSettings() {
    if (settingsOpen) { closeSettings(); return; }
    settingsOpen = true;
    if (!settings.loaded) fetchTerminalConfig();
    getCredentials().then(c => creds = c).catch(() => {});
    fetchAuthStatus();
  }

  async function handleSaveCredentials() {
    credsSaving = true;
    credsMessage = '';
    try {
      await saveCredentials(creds);
      credsMessage = 'Saved';
      creds = await getCredentials();
      setTimeout(() => credsMessage = '', 2000);
    } catch {
      credsMessage = 'Error';
    } finally {
      credsSaving = false;
    }
  }

  function handleTerminalSelect(terminal: TerminalId) {
    selectTerminal(terminal);
  }

  function handleInteractiveToggle(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    selectInteractiveSession(input.checked);
  }

  function closeSettings() {
    settingsOpen = false;
    if (auth.flowState === 'polling') cancelDeviceFlow();
  }

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.settings-container')) {
      closeSettings();
    }
  }

  function handleSearchKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      searchInput?.focus();
    }
  }

  // Tab accent colors
  function tabAccent(route: string): string {
    if (route === '/') return '#f59e0b';
    if (route === '/tickets') return '#3b82f6';
    if (route === '/videoscan') return '#06b6d4';
    return '#5e7389';
  }

  onMount(() => {
    fetchTerminalConfig();
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('keydown', handleSearchKey);
    return () => {
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('keydown', handleSearchKey);
    };
  });
</script>

<header>
  <h1>Orch Dashboard</h1>
  <input
    bind:this={searchInput}
    class="global-search"
    type="text"
    placeholder="Search tickets, PRs, repos... (Ctrl+K)"
    value={currentSearch}
    oninput={(e) => setSearchQuery((e.currentTarget as HTMLInputElement).value)}
  />
  <div class="header-right">
    <nav class="nav-tabs">
      <a class="nav-tab" class:active={currentRoute === '/'} href="/" onclick={(e) => { e.preventDefault(); navigate('/'); }} style={currentRoute === '/' ? `border-bottom-color: ${tabAccent('/')}; color: ${tabAccent('/')}` : ''}>Dashboard</a>
      <a class="nav-tab" class:active={currentRoute === '/tickets'} href="/tickets" onclick={(e) => { e.preventDefault(); navigate('/tickets'); }} style={currentRoute === '/tickets' ? `border-bottom-color: ${tabAccent('/tickets')}; color: ${tabAccent('/tickets')}` : ''}>Tickets</a>
      <a class="nav-tab" class:active={currentRoute === '/videoscan'} href="/videoscan" onclick={(e) => { e.preventDefault(); navigate('/videoscan'); }} style={currentRoute === '/videoscan' ? `border-bottom-color: ${tabAccent('/videoscan')}; color: ${tabAccent('/videoscan')}` : ''}>Videoscan</a>
    </nav>
    <div class="usage-bars" title={updatedAt}>
      <span>5h</span>
      <progress class="bright" value={usage5h} max="100" title={reset5h}></progress>
      <span class="pct">{usage5h}%</span>
      <span class="spacer">7d</span>
      <progress class="dim" value={usage7d} max="100" title={reset7d}></progress>
      <span class="pct">{usage7d}%</span>
      {#if updatedAt}<span class="updated-at">{updatedAt}</span>{/if}
    </div>
    <label class="toggle-wrap" title="When enabled, Fix/Implement tasks open Claude in interactive terminal mode.">
      <input
        type="checkbox"
        checked={settings.interactiveSession}
        onchange={handleInteractiveToggle}
      />
      <span>Interactive Claude</span>
    </label>
    <div class="settings-container">
      <button class="settings-btn" onclick={toggleSettings} title="Settings">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/>
          <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.115l.094-.319z"/>
        </svg>
      </button>
      {#if settingsOpen}
        <div class="settings-dropdown">
          <div class="dropdown-header">
            <span>Terminal</span>
            <button class="analyze-btn" onclick={detectTerminals} disabled={settings.analyzing}>
              {settings.analyzing ? 'Analyzing...' : 'Analyze'}
            </button>
          </div>
          <div class="terminal-list">
            {#each settings.terminals as terminal (terminal.id)}
              <button
                class="terminal-option"
                class:selected={settings.selectedTerminal === terminal.id}
                class:unavailable={terminal.available === false}
                onclick={() => handleTerminalSelect(terminal.id)}
                disabled={terminal.available === false}
              >
                <span class="terminal-name">{terminal.name}</span>
                {#if terminal.available === false}
                  <span class="unavailable-badge">N/A</span>
                {:else if settings.selectedTerminal === terminal.id}
                  <span class="check">&#10003;</span>
                {/if}
              </button>
            {/each}
            {#if settings.terminals.length === 0}
              <div class="no-terminals">Click "Analyze" to detect terminals</div>
            {/if}
          </div>
          <div class="dropdown-header">
            <span>GitHub</span>
            {#if auth.flowState === 'complete' || auth.authenticated}
              <span class="gh-connected">Connected</span>
            {/if}
          </div>
          <div class="gh-auth-section">
            {#if !auth.clientIdConfigured}
              <span class="gh-hint">Set GITHUB_OAUTH_CLIENT_ID in .env</span>
            {:else if auth.authenticated && auth.flowState === 'idle'}
              <span class="gh-status">GitHub authenticated</span>
            {:else if auth.flowState === 'idle'}
              <button class="gh-signin-btn" onclick={beginDeviceFlow}>Sign in with GitHub</button>
            {:else if auth.flowState === 'polling'}
              <div class="gh-code-flow">
                <code class="gh-user-code">{auth.userCode}</code>
                <a href={auth.verificationUri} target="_blank" rel="noopener noreferrer" class="gh-link">
                  Open github.com/login/device
                </a>
                <button class="gh-cancel-btn" onclick={cancelDeviceFlow}>Cancel</button>
              </div>
            {:else if auth.flowState === 'complete'}
              <span class="gh-status">GitHub connected!</span>
            {:else if auth.flowState === 'error'}
              <span class="gh-error">{auth.errorMessage}</span>
              <button class="gh-signin-btn" onclick={beginDeviceFlow}>Retry</button>
            {/if}
          </div>
          <div class="dropdown-header">
            <span>Credentials</span>
            <button class="analyze-btn" onclick={handleSaveCredentials} disabled={credsSaving}>
              {credsSaving ? 'Saving...' : credsMessage || 'Save'}
            </button>
          </div>
          <div class="creds-list">
            {#each ['GITHUB_TOKEN', 'ADO_PAT', 'ADO_ORG', 'ADO_PROJECT', 'ADO_TEAM'] as key}
              <label class="cred-field">
                <span class="cred-label">{key}</span>
                <input
                  type={key.includes('PAT') || key.includes('TOKEN') ? 'password' : 'text'}
                  value={creds[key] ?? ''}
                  oninput={(e) => creds[key] = (e.currentTarget as HTMLInputElement).value}
                  placeholder={key}
                />
              </label>
            {/each}
          </div>
        </div>
      {/if}
    </div>
    <button class="orch-btn" onclick={triggerOrchestration} title="Run Auto-Orchestrator">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0zm4.879-2.773L11 8l-4.621 2.773A.25.25 0 0 1 6 10.523V5.477a.25.25 0 0 1 .379-.25z"/>
      </svg>
    </button>
    <button class="chat-btn" onclick={toggleChat} title="Orchestrator Chat">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.5 2.75a.25.25 0 0 1 .25-.25h12.5a.25.25 0 0 1 .25.25v8.5a.25.25 0 0 1-.25.25h-6.5a.75.75 0 0 0-.53.22L4.5 14.44v-2.19a.75.75 0 0 0-.75-.75H1.75a.25.25 0 0 1-.25-.25v-8.5zM1.75 1A1.75 1.75 0 0 0 0 2.75v8.5C0 12.216.784 13 1.75 13H3v1.543a1.457 1.457 0 0 0 2.487 1.03L8.44 12.5h5.81c.966 0 1.75-.784 1.75-1.75v-8.5A1.75 1.75 0 0 0 14.25 1H1.75z"/>
      </svg>
    </button>
    <button class="notif-btn" onclick={toggleSidebar} title="Notifications">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 16a2 2 0 0 0 2-2H6a2 2 0 0 0 2 2zM8 1.918l-.797.161A4.002 4.002 0 0 0 4 6c0 .628-.134 2.197-.459 3.742-.16.767-.376 1.566-.663 2.258h10.244c-.287-.692-.502-1.49-.663-2.258C12.134 8.197 12 6.628 12 6a4.002 4.002 0 0 0-3.203-3.92L8 1.917zM14.22 12c.223.447.481.801.78 1H1c.299-.199.557-.553.78-1C2.68 10.2 3 6.88 3 6c0-2.42 1.72-4.44 4.005-4.901a1 1 0 1 1 1.99 0A5.002 5.002 0 0 1 13 6c0 .88.32 4.2 1.22 6z"/>
      </svg>
      {#if notifState.unreadCount > 0}
        <span class="notif-badge-count">{notifState.unreadCount > 99 ? '99+' : notifState.unreadCount}</span>
      {/if}
    </button>
    <button class="refresh-btn" onclick={() => refreshAll(true)}>Refresh</button>
    <div class="status">
      <div class="status-dot" class:disconnected={!connectionState.connected}></div>
      <span>{connectionState.connected ? 'Connected' : 'Disconnected'}</span>
    </div>
  </div>
</header>

<style>
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border-primary);
    background: linear-gradient(180deg, var(--bg-raised) 0%, transparent 100%);
    padding: 16px 20px;
    border-radius: 10px;
  }

  h1 {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text-heading);
    flex-shrink: 0;
  }

  .global-search {
    flex: 1;
    max-width: 340px;
    background: var(--bg-deep);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    color: var(--text-primary);
    padding: 6px 10px;
    font-size: 12px;
    font-family: 'IBM Plex Mono', monospace;
    transition: border-color 0.15s, box-shadow 0.15s;
  }

  .global-search:focus {
    outline: none;
    border-color: var(--info);
    box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.15);
  }

  .global-search::placeholder {
    color: var(--text-dim);
  }

  .nav-tabs {
    display: flex;
    gap: 2px;
    background: var(--bg-surface);
    border-radius: 6px;
    padding: 2px;
  }

  .nav-tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    padding: 4px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: all 0.15s;
    text-decoration: none;
  }

  .nav-tab:hover {
    color: var(--text-primary);
  }

  .nav-tab.active {
    background: var(--bg-raised);
    color: var(--text-heading);
  }

  .header-right {
    display: flex;
    gap: 10px;
    align-items: center;
  }

  .usage-bars {
    display: flex;
    gap: 6px;
    align-items: center;
    font-size: 11px;
    color: var(--text-muted);
    font-family: 'IBM Plex Mono', monospace;
  }

  .usage-bars progress {
    width: 52px;
    height: 4px;
  }

  .spacer {
    margin-left: 4px;
  }

  .pct {
    min-width: 28px;
    font-size: 10px;
  }

  .updated-at {
    font-size: 9px;
    color: var(--text-dim);
    margin-left: 4px;
  }

  .toggle-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-muted);
    user-select: none;
  }

  .toggle-wrap input {
    accent-color: var(--success);
    cursor: pointer;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 8px rgba(52, 211, 153, 0.5);
  }

  .status-dot.disconnected {
    background: var(--danger);
    box-shadow: 0 0 8px rgba(248, 81, 73, 0.5);
  }

  .settings-container {
    position: relative;
  }

  .settings-btn {
    background: var(--bg-raised);
    border: 1px solid var(--border-bright);
    border-radius: 6px;
    padding: 6px 8px;
    cursor: pointer;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    transition: all 0.15s;
  }

  .settings-btn:hover {
    background: var(--bg-overlay);
    color: var(--text-primary);
  }

  .settings-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 8px;
    background: var(--bg-overlay);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    min-width: 280px;
    z-index: 100;
    box-shadow: var(--shadow-elevated);
  }

  .dropdown-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-primary);
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .analyze-btn {
    background: #1a7f37;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 10px;
    font-weight: 500;
    cursor: pointer;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: background 0.15s;
  }

  .analyze-btn:hover:not(:disabled) {
    background: #22943e;
  }

  .analyze-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .terminal-list {
    padding: 6px;
  }

  .terminal-option {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    padding: 7px 10px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: background 0.1s;
  }

  .terminal-option:hover:not(:disabled) {
    background: var(--bg-raised);
  }

  .terminal-option.selected {
    background: var(--info-bg);
  }

  .terminal-option.unavailable {
    color: var(--text-dim);
    cursor: not-allowed;
  }

  .unavailable-badge {
    font-size: 9px;
    color: var(--text-muted);
    background: var(--bg-raised);
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 500;
  }

  .check {
    color: var(--success);
  }

  .no-terminals {
    padding: 12px;
    color: var(--text-dim);
    font-size: 11px;
    text-align: center;
  }

  .creds-list {
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .cred-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .cred-label {
    font-size: 9px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }

  .cred-field input {
    background: var(--bg-deep);
    border: 1px solid var(--border-primary);
    border-radius: 4px;
    color: var(--text-primary);
    padding: 5px 8px;
    font-size: 11px;
    font-family: 'IBM Plex Mono', monospace;
    transition: border-color 0.15s;
  }

  .cred-field input:focus {
    outline: none;
    border-color: var(--info);
  }

  .gh-auth-section {
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }

  .gh-hint {
    font-size: 10px;
    color: var(--text-dim);
    font-style: italic;
  }

  .gh-status {
    font-size: 11px;
    color: var(--success);
    font-weight: 500;
  }

  .gh-connected {
    font-size: 10px;
    color: var(--success);
    font-weight: 500;
  }

  .gh-signin-btn {
    background: var(--bg-raised);
    border: 1px solid var(--border-bright);
    border-radius: 6px;
    color: var(--text-primary);
    padding: 4px 10px;
    font-size: 11px;
    cursor: pointer;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: background 0.15s;
  }

  .gh-signin-btn:hover {
    background: var(--bg-overlay);
  }

  .gh-code-flow {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: flex-start;
  }

  .gh-user-code {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 3px;
    color: var(--info);
    background: var(--info-bg);
    padding: 6px 12px;
    border-radius: 6px;
    font-family: 'IBM Plex Mono', monospace;
  }

  .gh-link {
    font-size: 11px;
    color: var(--info);
  }

  .gh-cancel-btn {
    background: transparent;
    border: 1px solid var(--border-bright);
    border-radius: 4px;
    color: var(--text-muted);
    padding: 2px 8px;
    font-size: 10px;
    cursor: pointer;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: color 0.15s;
  }

  .gh-cancel-btn:hover {
    color: var(--text-primary);
  }

  .gh-error {
    font-size: 11px;
    color: var(--danger);
  }

  .orch-btn,
  .chat-btn {
    background: #1a1030;
    border: 1px solid #3b2460;
    border-radius: 6px;
    padding: 6px 8px;
    cursor: pointer;
    color: #a371f7;
    display: flex;
    align-items: center;
    transition: all 0.15s;
  }

  .orch-btn:hover,
  .chat-btn:hover {
    background: #2a1850;
    color: #d2a8ff;
  }

  .notif-btn {
    position: relative;
    background: #2a1508;
    border: 1px solid #5c3610;
    border-radius: 6px;
    padding: 6px 8px;
    cursor: pointer;
    color: #f97316;
    display: flex;
    align-items: center;
    transition: all 0.15s;
  }

  .notif-btn:hover {
    background: #3a1f0c;
    color: #fb923c;
  }

  .notif-badge-count {
    position: absolute;
    top: -5px;
    right: -5px;
    background: var(--danger);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    min-width: 16px;
    height: 16px;
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
    font-family: 'IBM Plex Mono', monospace;
  }
</style>
