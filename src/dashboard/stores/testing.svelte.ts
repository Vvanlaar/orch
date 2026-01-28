import type { WorkItem, TeamMember } from '../lib/types';

// State
let reviewedItems = $state<WorkItem[]>([]);
let teamMembers = $state<TeamMember[]>([]);
let selectedTeamMembers = $state(new Set<string>());
let sprintName = $state('Loading sprint...');

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
}

export function selectAllTeam() {
  teamMembers.forEach((m) => selectedTeamMembers.add(m.email));
  selectedTeamMembers = new Set(selectedTeamMembers);
}

export function deselectAllTeam() {
  selectedTeamMembers.clear();
  selectedTeamMembers = new Set(selectedTeamMembers);
}

export function generateAssignCommand(): string | null {
  if (selectedTeamMembers.size === 0) return null;
  if (reviewedItems.length === 0) return null;
  const users = Array.from(selectedTeamMembers).join(',');
  return `/assign-testing --users "${users}"`;
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
  } catch (err) {
    console.error('Failed to fetch team members:', err);
    teamMembers = [];
  }
}
