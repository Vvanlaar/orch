import type { OrchestratorState, OrchestratorAction, ChatMessage } from '../lib/types';
import { setOrchestratorHandler } from './websocket.svelte';

let orchState = $state<OrchestratorState>({
  status: 'idle',
  actions: [],
  chat: { status: 'idle', messages: [] },
});

let chatOpen = $state(false);

// Register WebSocket handler
setOrchestratorHandler((newState: OrchestratorState) => {
  orchState = newState;
});

export async function fetchOrchestratorState() {
  try {
    const res = await fetch('/api/orchestrator/state');
    if (!res.ok) return;
    orchState = await res.json();
  } catch {}
}

export async function triggerOrchestration() {
  try {
    const res = await fetch('/api/orchestrate', { method: 'POST' });
    if (res.status === 409) return; // already running
    if (!res.ok) {
      const data = await res.json();
      console.error('Orchestration failed:', data.error);
    }
  } catch (err) {
    console.error('Orchestration error:', err);
  }
}

export async function acceptAction(id: string) {
  try {
    const res = await fetch(`/api/orchestrator/${id}/accept`, { method: 'POST' });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

export async function dismissAction(id: string, reason?: string) {
  try {
    await fetch(`/api/orchestrator/${id}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
  } catch {}
}

export async function sendChatMessage(question: string) {
  try {
    await fetch('/api/orchestrator/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    // Response comes via WebSocket state update
  } catch (err) {
    console.error('Chat error:', err);
  }
}

export function toggleChat() {
  chatOpen = !chatOpen;
}

export function getOrchestratorState() {
  return orchState;
}

export function getChatOpen() {
  return chatOpen;
}
