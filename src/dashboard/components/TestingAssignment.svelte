<script lang="ts">
  import type { WorkItem } from '../lib/types';
  import { typeClass, extractRepoFromGitHubUrl } from '../lib/utils';
  import {
    getReviewedItems,
    getMyTestingItems,
    getUnassignedItems,
    getOtherAssignedItems,
    getTeamMembers,
    getSelectedTeamMembers,
    getSprintName,
    getReviewedCount,
    toggleTeamMember,
    selectAllTeam,
    deselectAllTeam,
    generateAssignCommand,
  } from '../stores/testing.svelte';
  import { getCurrentUser } from '../stores/currentUser.svelte';

  let reviewedItems = $derived(getReviewedItems());
  let myItems = $derived(getMyTestingItems());
  let unassignedItems = $derived(getUnassignedItems());
  let otherItems = $derived(getOtherAssignedItems());
  let teamMembers = $derived(getTeamMembers());
  let selectedTeamMembers = $derived(getSelectedTeamMembers());
  let sprintName = $derived(getSprintName());
  let reviewedCount = $derived(getReviewedCount());
  let currentUser = $derived(getCurrentUser());

  let showOthers = $state(false);
  let testingItem = $state<number | null>(null);

  function handleCopyCommand() {
    const cmd = generateAssignCommand();
    if (!cmd) {
      if (selectedTeamMembers.size === 0) {
        alert('Select at least one team member');
      } else {
        alert('No reviewed items to assign');
      }
      return;
    }
    navigator.clipboard.writeText(cmd).then(
      () => alert(`Copied to clipboard:\n${cmd}\n\nPaste in Claude Code to run the skill.`),
      () => prompt('Copy this command:', cmd)
    );
  }

  async function handleTest(wi: WorkItem) {
    testingItem = wi.id;
    try {
      const res = await fetch('/api/actions/test-workitem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: wi.id,
          title: wi.title,
          project: wi.project,
          url: wi.url,
          githubPrUrl: wi.githubPrUrl,
          testNotes: wi.testNotes,
          body: wi.body,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        console.log('Testing task created:', data);
      } else {
        alert(`Failed to create testing task: ${data.error}`);
      }
    } catch (err) {
      alert(`Error: ${err}`);
    } finally {
      testingItem = null;
    }
  }
</script>

<div class="card" style="margin-bottom: 24px;">
  <h2>Testing Assignment</h2>
  <div class="sprint-header">
    <span>{sprintName}</span>
    <span>
      {#if currentUser}
        <span class="current-user">{currentUser.displayName}</span> •
      {/if}
      {reviewedCount} items
    </span>
  </div>
  <div class="card-list" style="max-height: 400px;">
    {#if reviewedItems.length === 0}
      <div class="empty">No reviewed items in current sprint</div>
    {:else}
      <!-- My Testing Section -->
      {#if myItems.length > 0}
        <div class="section-header">My Testing ({myItems.length})</div>
        {#each myItems as wi (wi.id)}
          <div class="item">
            <div class="item-info">
              <div class="item-title">{wi.title}</div>
              <div class="item-meta">
                <span>#{wi.id}</span>
                <span class="badge type {typeClass(wi.type)}">{wi.type}</span>
                {#if extractRepoFromGitHubUrl(wi.githubPrUrl)}
                  <span class="badge repo">{extractRepoFromGitHubUrl(wi.githubPrUrl)}</span>
                {/if}
              </div>
              <div class="reviewed-meta">
                <span class="badge-person">Resolved: {wi.resolvedBy || 'N/A'}</span>
                <span class="badge-person">Reviewed: {wi.reviewedBy || 'N/A'}</span>
              </div>
            </div>
            <div class="item-actions">
              <button
                class="action-btn"
                onclick={() => handleTest(wi)}
                disabled={testingItem === wi.id}
              >
                {testingItem === wi.id ? 'Starting...' : 'Test'}
              </button>
              <a href={wi.url} target="_blank" class="action-btn secondary">View →</a>
            </div>
          </div>
        {/each}
      {/if}

      <!-- Unassigned Section -->
      {#if unassignedItems.length > 0}
        <div class="section-header">Unassigned ({unassignedItems.length})</div>
        {#each unassignedItems as wi (wi.id)}
          <div class="item">
            <div class="item-info">
              <div class="item-title">{wi.title}</div>
              <div class="item-meta">
                <span>#{wi.id}</span>
                <span class="badge type {typeClass(wi.type)}">{wi.type}</span>
                {#if extractRepoFromGitHubUrl(wi.githubPrUrl)}
                  <span class="badge repo">{extractRepoFromGitHubUrl(wi.githubPrUrl)}</span>
                {/if}
                <span class="badge-person unassigned">Unassigned</span>
              </div>
              <div class="reviewed-meta">
                <span class="badge-person">Resolved: {wi.resolvedBy || 'N/A'}</span>
                <span class="badge-person">Reviewed: {wi.reviewedBy || 'N/A'}</span>
              </div>
            </div>
            <div class="item-actions">
              <a href={wi.url} target="_blank" class="action-btn secondary">View →</a>
            </div>
          </div>
        {/each}
      {/if}

      <!-- Others Section (Collapsible) -->
      {#if otherItems.length > 0}
        <div
          class="section-header clickable"
          onclick={() => (showOthers = !showOthers)}
          role="button"
          tabindex="0"
          onkeydown={(e) => e.key === 'Enter' && (showOthers = !showOthers)}
        >
          <span>Assigned to Others ({otherItems.length})</span>
          <span class="toggle-icon">{showOthers ? '▼' : '▶'}</span>
        </div>
        {#if showOthers}
          {#each otherItems as wi (wi.id)}
            <div class="item">
              <div class="item-info">
                <div class="item-title">{wi.title}</div>
                <div class="item-meta">
                  <span>#{wi.id}</span>
                  <span class="badge type {typeClass(wi.type)}">{wi.type}</span>
                  {#if extractRepoFromGitHubUrl(wi.githubPrUrl)}
                    <span class="badge repo">{extractRepoFromGitHubUrl(wi.githubPrUrl)}</span>
                  {/if}
                  <span class="badge-person assigned">Assigned: {wi.assignedTo}</span>
                </div>
                <div class="reviewed-meta">
                  <span class="badge-person">Resolved: {wi.resolvedBy || 'N/A'}</span>
                  <span class="badge-person">Reviewed: {wi.reviewedBy || 'N/A'}</span>
                </div>
              </div>
              <div class="item-actions">
                <a href={wi.url} target="_blank" class="action-btn secondary">View →</a>
              </div>
            </div>
          {/each}
        {/if}
      {/if}
    {/if}
  </div>
  <div class="assign-row">
    <div class="assign-left">
      <span class="assign-label">Assign to:</span>
      <div class="team-selection">
        {#if teamMembers.length === 0}
          <div class="empty" style="padding:0;width:100%;">
            No team members found. Set ADO_PROJECT and ADO_TEAM env vars.
          </div>
        {:else}
          {#each teamMembers as m (m.email)}
            <span
              class="team-member"
              class:selected={selectedTeamMembers.has(m.email)}
              onclick={() => toggleTeamMember(m.email)}
              role="button"
              tabindex="0"
              onkeydown={(e) => e.key === 'Enter' && toggleTeamMember(m.email)}
            >
              {m.displayName}
            </span>
          {/each}
        {/if}
      </div>
    </div>
    <div class="assign-controls">
      <button class="action-btn secondary" onclick={selectAllTeam}>All</button>
      <button class="action-btn secondary" onclick={deselectAllTeam}>None</button>
      <button class="action-btn" onclick={handleCopyCommand}>Copy Command</button>
    </div>
  </div>
</div>

<style>
  .sprint-header {
    padding: 12px 16px;
    background: #21262d;
    font-size: 13px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .current-user {
    color: #58a6ff;
    font-weight: 500;
  }

  .section-header {
    padding: 8px 16px;
    background: #1c2128;
    font-size: 12px;
    font-weight: 600;
    color: #8b949e;
    border-bottom: 1px solid #21262d;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .section-header.clickable {
    cursor: pointer;
  }

  .section-header.clickable:hover {
    background: #21262d;
  }

  .toggle-icon {
    font-size: 10px;
  }

  .assign-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-top: 1px solid #30363d;
    gap: 16px;
  }

  .assign-left {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    flex-wrap: wrap;
  }

  .assign-label {
    font-size: 12px;
    color: #8b949e;
    white-space: nowrap;
  }

  .team-selection {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .team-member {
    padding: 3px 8px;
    border-radius: 12px;
    background: #21262d;
    cursor: pointer;
    font-size: 11px;
  }

  .team-member:hover {
    background: #30363d;
  }

  .team-member.selected {
    background: #238636;
    color: #fff;
  }

  .assign-controls {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .reviewed-meta {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  .badge-person {
    background: #30363d;
    color: #c9d1d9;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
  }

  .badge-person.assigned {
    background: #2d5016;
    color: #90ee90;
  }

  .badge-person.unassigned {
    background: #501616;
    color: #ee9090;
  }

  .badge.repo {
    background: #1f3b5c;
    color: #58a6ff;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-family: monospace;
  }
</style>
