export function formatTime(iso: string | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

export function stateClass(state: string): string {
  const s = state.toLowerCase();
  if (s === 'open' || s === 'active' || s === 'in progress') return 'state-active';
  if (s === 'new') return 'state-new';
  if (s === 'closed' || s === 'resolved' || s === 'done') return 'state-resolved';
  return '';
}

export function typeClass(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('bug')) return 'type-bug';
  if (t.includes('feature') || t.includes('story')) return 'type-feature';
  if (t.includes('task')) return 'type-task';
  return '';
}

export function extractAdoTicket(title: string): string | null {
  const match = title.match(/(?:AB|ADO)?#(\d{4,6})/i);
  return match ? match[1] : null;
}

export function extractRepoFromGitHubUrl(url?: string): string | null {
  if (!url?.includes('github.com')) return null;
  const match = url.match(/github\.com\/([^/]+\/[^/]+)/);
  return match ? match[1] : null;
}
