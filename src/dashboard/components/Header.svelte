<script lang="ts">
  import { getConnectionState } from '../stores/websocket.svelte';
  import { getUsage, formatResetTime } from '../stores/usage.svelte';

  interface Props {
    refreshAll: () => void;
  }

  let { refreshAll }: Props = $props();

  let connectionState = $derived(getConnectionState());
  let usage = $derived(getUsage());

  let usage5h = $derived(Math.round(usage?.five_hour?.utilization ?? 0));
  let usage7d = $derived(Math.round(usage?.seven_day?.utilization ?? 0));
  let reset5h = $derived(formatResetTime(usage?.five_hour?.resets_at));
  let reset7d = $derived(formatResetTime(usage?.seven_day?.resets_at));
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
</style>
