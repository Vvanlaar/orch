<script lang="ts">
  // Minimal access screen shown when there's no token or the token is unknown.
  // Submitting stores the token and re-runs /api/whoami; App.svelte then routes
  // to the support-only or full dashboard based on the returned scopes.
  import { setToken, getToken, getScopes, isReady } from '../stores/session.svelte';

  let value = $state<string>(getToken());
  let attempted = $state<boolean>(false);

  function submit(): void {
    attempted = true;
    setToken(value);
  }

  // A token was tried, whoami came back, and it granted nothing → reject it.
  let invalid = $derived(attempted && isReady() && getToken().length > 0 && getScopes().length === 0);
</script>

<div class="gate">
  <div class="card">
    <h1>Orch</h1>
    <p class="sub">Enter your access token to continue.</p>
    <input
      type="password"
      bind:value
      placeholder="Bearer token"
      autocomplete="off"
      onkeydown={(e) => { if (e.key === 'Enter') submit(); }}
    />
    <button onclick={submit} disabled={!value.trim()}>Continue</button>
    {#if invalid}
      <p class="err">That token isn't recognized. Check it and try again.</p>
    {/if}
  </div>
</div>

<style>
  .gate {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-deep, #0d1117);
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 360px;
    background: var(--bg-secondary, #161b22);
    border: 1px solid var(--border, #30363d);
    border-radius: 12px;
    padding: 28px 24px;
    text-align: center;
  }
  h1 {
    margin: 0 0 4px;
    font-size: 22px;
    color: var(--text-primary, #e6edf3);
  }
  .sub {
    margin: 0 0 18px;
    font-size: 13px;
    color: var(--text-muted, #8b949e);
  }
  input {
    width: 100%;
    padding: 10px 12px;
    margin-bottom: 12px;
    background: var(--bg-deep, #0d1117);
    border: 1px solid var(--border, #30363d);
    border-radius: 8px;
    color: var(--text-primary, #e6edf3);
    font-family: 'IBM Plex Mono', monospace;
    font-size: 13px;
  }
  button {
    width: 100%;
    padding: 10px 12px;
    background: #2dd4bf;
    color: #04211d;
    border: none;
    border-radius: 8px;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .err {
    margin: 12px 0 0;
    font-size: 12px;
    color: #f85149;
  }
</style>
