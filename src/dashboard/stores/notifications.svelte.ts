import type { Notification } from '../lib/types';
import { setNotificationHandler } from './websocket.svelte';

let notifications = $state<Notification[]>([]);
let filterRepo = $state('');
let searchQuery = $state('');
let sidebarOpen = $state(false);
let unreadCount = $state(0);
let lastSeenTimestamp = $state('');

// Derived computations (stable references within Svelte's reactive graph)
let filteredNotifications = $derived.by(() => {
  let result = notifications;
  if (filterRepo) result = result.filter(n => n.repo === filterRepo);
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    result = result.filter(n =>
      n.sessionName?.toLowerCase().includes(q) ||
      n.lastMessage?.toLowerCase().includes(q) ||
      n.repo?.toLowerCase().includes(q)
    );
  }
  return result;
});

let repoList = $derived.by(() => {
  return [...new Set(notifications.map(n => n.repo).filter(Boolean))].sort();
});

// Restore persisted state
try {
  sidebarOpen = localStorage.getItem('notif-sidebar-open') === 'true';
  lastSeenTimestamp = localStorage.getItem('notif-last-seen') || '';
} catch {}

function persistState() {
  try {
    localStorage.setItem('notif-sidebar-open', String(sidebarOpen));
    localStorage.setItem('notif-last-seen', lastSeenTimestamp);
  } catch {}
}

function computeUnread() {
  if (sidebarOpen) { unreadCount = 0; return; }
  if (!lastSeenTimestamp) { unreadCount = notifications.length; return; }
  unreadCount = notifications.filter(n => n.timestamp > lastSeenTimestamp).length;
}

// Register WebSocket handler
setNotificationHandler((notification: Notification) => {
  if (!notifications.some(n => n.id === notification.id)) {
    notifications = [notification, ...notifications];
  }
  computeUnread();
});

export async function fetchNotifications() {
  try {
    const res = await fetch('/api/notifications');
    if (!res.ok) return;
    const data: Notification[] = await res.json();
    const ids = new Set(data.map(n => n.id));
    const wsOnly = notifications.filter(n => !ids.has(n.id));
    notifications = [...wsOnly, ...data];
    computeUnread();
  } catch {}
}

export function toggleSidebar() {
  sidebarOpen = !sidebarOpen;
  if (sidebarOpen) {
    unreadCount = 0;
    lastSeenTimestamp = new Date().toISOString();
  }
  persistState();
}

export function setFilterRepo(repo: string) {
  filterRepo = repo;
}

export function setSearchQuery(query: string) {
  searchQuery = query;
}

export function getFilteredNotifications() {
  return filteredNotifications;
}

export function getRepos() {
  return repoList;
}

export function getNotificationState() {
  return {
    sidebarOpen,
    unreadCount,
    filterRepo,
    searchQuery,
  };
}
