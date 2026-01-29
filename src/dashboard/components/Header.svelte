<script lang="ts">
  import { getConnectionState } from '../stores/websocket.svelte';
  import { getUsage, formatResetTime } from '../stores/usage.svelte';
  import { getSettings, fetchTerminalConfig, detectTerminals, selectTerminal } from '../stores/settings.svelte';
  import type { TerminalId } from '../lib/types';
  import { onMount } from 'svelte';

  interface Props {
    refreshAll: () => void;
  }

  let { refreshAll }: Props = $props();

  let connectionState = $derived(getConnectionState());
  let usage = $derived(getUsage());
  let settings = $derived(getSettings());

  let usage5h = $derived(Math.round(usage?.five_hour?.utilization ?? 0));
  let usage7d = $derived(Math.round(usage?.seven_day?.utilization ?? 0));
  let reset5h = $derived(formatResetTime(usage?.five_hour?.resets_at));
  let reset7d = $derived(formatResetTime(usage?.seven_day?.resets_at));

  let settingsOpen = $state(false);

  function toggleSettings() {
    settingsOpen = !settingsOpen;
    if (settingsOpen && !settings.loaded) {
      fetchTerminalConfig();
    }
  }

  function handleTerminalSelect(terminal: TerminalId) {
    selectTerminal(terminal);
  }

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (!target.closest('.settings-container')) {
      settingsOpen = false;
    }
  }

  onMount(() => {
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  });
</script>

<header>
  <h1>Orch Dashboard</h1>
  <div class="header-right">
    <div class="usage-bars">
      <span>5h</span>
      <progress class="bright" value={usage5h} max="100" title={reset5h}></progress>
      <span class="pct">{usage5h}%</span>
      <span class="spacer">7d</span>
      <progress class="dim" value={usage7d} max="100" title={reset7d}></progress>
      <span class="pct">{usage7d}%</span>
    </div>
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
        </div>
      {/if}
    </div>
    <button class="refresh-btn" onclick={refreshAll}>Refresh</button>
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
    margin-bottom: 24px;
  }

  h1 {
    font-size: 24px;
    font-weight: 600;
  }

  .header-right {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .usage-bars {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 12px;
    color: #8b949e;
  }

  .usage-bars progress {
    width: 60px;
    height: 8px;
  }

  .spacer {
    margin-left: 4px;
  }

  .pct {
    min-width: 32px;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #3fb950;
  }

  .status-dot.disconnected {
    background: #f85149;
  }

  .settings-container {
    position: relative;
  }

  .settings-btn {
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 6px 8px;
    cursor: pointer;
    color: #8b949e;
    display: flex;
    align-items: center;
  }

  .settings-btn:hover {
    background: #30363d;
    color: #c9d1d9;
  }

  .settings-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 8px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    min-width: 220px;
    z-index: 100;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }

  .dropdown-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    border-bottom: 1px solid #30363d;
    font-size: 12px;
    font-weight: 600;
    color: #8b949e;
  }

  .analyze-btn {
    background: #238636;
    color: white;
    border: none;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 11px;
    cursor: pointer;
  }

  .analyze-btn:hover:not(:disabled) {
    background: #2ea043;
  }

  .analyze-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .terminal-list {
    padding: 8px;
  }

  .terminal-option {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: #c9d1d9;
    font-size: 13px;
    cursor: pointer;
    text-align: left;
  }

  .terminal-option:hover:not(:disabled) {
    background: #21262d;
  }

  .terminal-option.selected {
    background: #388bfd26;
  }

  .terminal-option.unavailable {
    color: #484f58;
    cursor: not-allowed;
  }

  .unavailable-badge {
    font-size: 10px;
    color: #8b949e;
    background: #30363d;
    padding: 2px 6px;
    border-radius: 3px;
  }

  .check {
    color: #3fb950;
  }

  .no-terminals {
    padding: 12px;
    color: #8b949e;
    font-size: 12px;
    text-align: center;
  }
</style>
