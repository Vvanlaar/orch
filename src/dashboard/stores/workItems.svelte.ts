import type { PR, WorkItem, FilterType } from '../lib/types';

// State
let prs = $state<PR[]>([]);
let workItems = $state<WorkItem[]>([]);
let resolvedByMe = $state<WorkItem[]>([]);
let filter = $state<FilterType>('all');

// Caches for action handlers
const prCache = new Map<string, PR>();
const workItemCache = new Map<number, WorkItem>();

// Derived filtered items
export function getFilteredItems() {
  let filteredWorkItems: WorkItem[];

  if (filter === 'resolved-by-me') {
    filteredWorkItems = resolvedByMe;
  } else {
    filteredWorkItems = workItems.filter((wi) => {
      const state = wi.state.toLowerCase();
      if (state === 'completed' || state === 'done' || state === 'closed') return false;
      if (filter === 'all') return true;
      if (filter === 'new') return state === 'new' || state === 'to do';
      if (filter === 'active') return state === 'active' || state === 'in progress';
      if (filter === 'resolved') return state === 'resolved';
      if (filter === 'reviewed') return state === 'reviewed';
      return true;
    });
  }

  // Sort by updated date
  filteredWorkItems = [...filteredWorkItems].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );

  const showPRs = filter !== 'resolved-by-me';
  return {
    prs: showPRs ? prs : [],
    workItems: filteredWorkItems,
    filter,
  };
}

export function setFilter(newFilter: FilterType) {
  filter = newFilter;
}

export function getFilter() {
  return filter;
}

export function getPRFromCache(key: string): PR | undefined {
  return prCache.get(key);
}

export function getWorkItemFromCache(id: number): WorkItem | undefined {
  return workItemCache.get(id);
}

export async function fetchPRs() {
  try {
    const res = await fetch('/api/my/prs');
    prs = await res.json();
    // Update cache
    prs.forEach((pr) => prCache.set(`${pr.repo}#${pr.number}`, pr));
  } catch (err) {
    console.error('Failed to fetch PRs:', err);
    prs = [];
  }
}

export async function fetchWorkItems() {
  try {
    const res = await fetch('/api/my/workitems');
    workItems = await res.json();
    // Update cache
    workItems.forEach((wi) => workItemCache.set(wi.id, wi));
  } catch (err) {
    console.error('Failed to fetch work items:', err);
    workItems = [];
  }
}

export async function fetchResolvedByMe() {
  try {
    const res = await fetch('/api/my/resolved-workitems');
    resolvedByMe = await res.json();
    // Update cache
    resolvedByMe.forEach((wi) => workItemCache.set(wi.id, wi));
  } catch (err) {
    console.error('Failed to fetch resolved-by-me items:', err);
    resolvedByMe = [];
  }
}
