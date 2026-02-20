import type { WorkItem, TeamMember } from '../lib/types';
import { getCurrentUser } from './currentUser.svelte';
import { readPreference, writePreference } from '../lib/preferences';

// State
let reviewedItems = $state<WorkItem[]>([]);
let teamMembers = $state<TeamMember[]>([]);
const SELECTED_TEAM_STORAGE_KEY = 'orch.dashboard.testing.selected-team-members';
const savedTeamMembers = readPreference(
  SELECTED_TEAM_STORAGE_KEY,
  [] as string[],
  (value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')
);
let selectedTeamMembers = $state(new Set<string>(savedTeamMembers));
let sprintName = $state('Loading sprint...');

function persistSelectedTeamMembers() {
  writePreference(SELECTED_TEAM_STORAGE_KEY, Array.from(selectedTeamMembers));
}

export function getReviewedItems() {
  // Sort by assignedTo (unassigned first, then alphabetically)
  return [...reviewedItems].sort((a, b) => {
    const aAssigned = a.assignedTo || '';
    const bAssigned = b.assignedTo || '';
    if (!aAssigned && bAssigned) return -1;
    if (aAssigned && !bAssigned) return 1;
    return aAssigned.localeCompare(bAssigned);
  });
}

export function getMyTestingItems() {
  const user = getCurrentUser();
  if (!user) return [];
  return reviewedItems.filter(wi => wi.assignedTo === user.displayName);
}

export function getUnassignedItems() {
  return reviewedItems.filter(wi => !wi.assignedTo);
}

export function getOtherAssignedItems() {
  const user = getCurrentUser();
  return reviewedItems.filter(wi => {
    if (!wi.assignedTo) return false;
    if (!user) return true;
    return wi.assignedTo !== user.displayName;
  });
}

export function getTeamMembers() {
  return teamMembers;
}

export function getSelectedTeamMembers() {
  return selectedTeamMembers;
}

export function getSprintName() {
  return sprintName;
}

export function getReviewedCount() {
  return reviewedItems.length;
}

export function toggleTeamMember(email: string) {
  if (selectedTeamMembers.has(email)) {
    selectedTeamMembers.delete(email);
  } else {
    selectedTeamMembers.add(email);
  }
  selectedTeamMembers = new Set(selectedTeamMembers);
  persistSelectedTeamMembers();
}

export function selectAllTeam() {
  teamMembers.forEach((m) => selectedTeamMembers.add(m.email));
  selectedTeamMembers = new Set(selectedTeamMembers);
  persistSelectedTeamMembers();
}

export function deselectAllTeam() {
  selectedTeamMembers.clear();
  selectedTeamMembers = new Set(selectedTeamMembers);
  persistSelectedTeamMembers();
}

export function generateAssignCommand(): string | null {
  if (selectedTeamMembers.size === 0) return null;
  if (reviewedItems.length === 0) return null;
  const users = Array.from(selectedTeamMembers).join(',');
  return `/ado-assign-testing --users "${users}"`;
}

export async function fetchReviewedItems() {
  try {
    const res = await fetch('/api/sprint/reviewed-items');
    const data = await res.json();
    reviewedItems = data.items || [];
    sprintName = data.sprintName || 'No sprint';
  } catch (err) {
    console.error('Failed to fetch reviewed items:', err);
    reviewedItems = [];
  }
}

export async function fetchTeamMembers() {
  try {
    const res = await fetch('/api/team/members');
    teamMembers = await res.json();
    const validEmails = new Set(teamMembers.map((member) => member.email));
    const prunedSelection = new Set(
      Array.from(selectedTeamMembers).filter((email) => validEmails.has(email))
    );
    if (prunedSelection.size !== selectedTeamMembers.size) {
      selectedTeamMembers = prunedSelection;
      persistSelectedTeamMembers();
    }
  } catch (err) {
    console.error('Failed to fetch team members:', err);
    teamMembers = [];
  }
}
