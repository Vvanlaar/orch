<script lang="ts">
  import { getToasts, dismissToast, getConfirmState, resolveConfirm } from '../stores/toast.svelte';

  let toasts = $derived(getToasts());
  let confirm = $derived(getConfirmState());

  function typeColor(type: string) {
    if (type === 'success') return '#3fb950';
    if (type === 'error') return '#f85149';
    if (type === 'warning') return '#f0883e';
    return '#58a6ff';
  }

  function typeBg(type: string) {
    if (type === 'success') return '#123620';
    if (type === 'error') return '#361414';
    if (type === 'warning') return '#362210';
    return '#122a4a';
  }
</script>

<!-- Toasts -->
{#if toasts.length > 0}
  <div class="toast-container">
    {#each toasts as toast (toast.id)}
      <div
        class="toast"
        style="background:{typeBg(toast.type)};border-color:{typeColor(toast.type)};"
        role="alert"
      >
        <span class="toast-msg" style="color:{typeColor(toast.type)};">{toast.message}</span>
        <button class="toast-close" onclick={() => dismissToast(toast.id)}>&times;</button>
      </div>
    {/each}
  </div>
{/if}

<!-- Confirm dialog -->
{#if confirm}
  <div class="confirm-overlay" onclick={() => resolveConfirm(false)} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_interactive_supports_focus -->
    <div class="confirm-panel" onclick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" tabindex="-1">
      <div class="confirm-msg">{confirm.message}</div>
      <div class="confirm-actions">
        <button class="confirm-btn cancel" onclick={() => resolveConfirm(false)}>Cancel</button>
        <button class="confirm-btn ok" onclick={() => resolveConfirm(true)}>Confirm</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .toast-container {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 420px;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(8px);
    animation: slide-in 0.2s ease-out;
  }

  @keyframes slide-in {
    from { opacity: 0; transform: translateX(40px); }
    to { opacity: 1; transform: translateX(0); }
  }

  .toast-msg {
    flex: 1;
    font-size: 12px;
    font-weight: 500;
    line-height: 1.4;
  }

  .toast-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 16px;
    cursor: pointer;
    padding: 0 2px;
    line-height: 1;
    flex-shrink: 0;
  }

  .toast-close:hover {
    color: var(--text-primary);
  }

  .confirm-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: fade-in 0.15s ease-out;
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .confirm-panel {
    background: var(--bg-overlay);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    padding: 20px 24px;
    max-width: 400px;
    width: 90%;
    box-shadow: var(--shadow-elevated);
  }

  .confirm-msg {
    font-size: 13px;
    color: var(--text-heading);
    line-height: 1.5;
    margin-bottom: 16px;
  }

  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .confirm-btn {
    padding: 6px 16px;
    border-radius: 6px;
    border: none;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: background 0.15s;
  }

  .confirm-btn.cancel {
    background: var(--bg-raised);
    color: var(--text-muted);
  }

  .confirm-btn.cancel:hover {
    background: var(--bg-overlay);
    color: var(--text-primary);
  }

  .confirm-btn.ok {
    background: var(--success);
    color: #000;
  }

  .confirm-btn.ok:hover {
    background: #22c55e;
  }
</style>
