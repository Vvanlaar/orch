<script lang="ts">
  import type { WorkItem, GitHubRepo } from '../lib/types';
  import { typeClass, extractRepoFromGitHubUrl } from '../lib/utils';
  import { testWorkitem, openTerminalWithCommand } from '../lib/api';
  import { showToast } from '../stores/toast.svelte';
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
  import { readPreference, writePreference } from '../lib/preferences';
  import { getCurrentUser } from '../stores/currentUser.svelte';
  import { getOrgRepos, isLoading, isLoaded, getCloningRepo, loadOrgRepos, cloneRepo } from '../stores/repos.svelte';

  import { getSearchQuery, matchesSearch } from '../stores/search.svelte';

  let searchQuery = $derived(getSearchQuery());
  function filterTesting(items: WorkItem[]): WorkItem[] {
    if (!searchQuery) return items;
    return items.filter(wi => matchesSearch(searchQuery, wi.id, wi.title, wi.type, wi.assignedTo, wi.resolvedBy, wi.reviewedBy));
  }
  let reviewedItems = $derived(getReviewedItems());
  let myItems = $derived(filterTesting(getMyTestingItems()));
  let unassignedItems = $derived(filterTesting(getUnassignedItems()));
  let otherItems = $derived(filterTesting(getOtherAssignedItems()));
  let teamMembers = $derived(getTeamMembers());
  let selectedTeamMembers = $derived(getSelectedTeamMembers());
  let sprintName = $derived(getSprintName());
  let reviewedCount = $derived(getReviewedCount());
  let currentUser = $derived(getCurrentUser());
  let orgRepos = $derived(getOrgRepos());
  let reposLoading = $derived(isLoading());
  let cloningRepo = $derived(getCloningRepo());

  const SHOW_OTHERS_STORAGE_KEY = 'orch.dashboard.testing.show-others';
  let showOthers = $state(
    readPreference(SHOW_OTHERS_STORAGE_KEY, false, (value): value is boolean => typeof value === 'boolean')
  );
  let testingItem = $state<number | null>(null);
  let selectedRepos = $state<Map<number, string>>(new Map());

  function toggleShowOthers() {
    showOthers = !showOthers;
    writePreference(SHOW_OTHERS_STORAGE_KEY, showOthers);
  }

  async function handleOpenTerminal() {
    const cmd = generateAssignCommand();
    if (!cmd) {
      showToast(selectedTeamMembers.size === 0 ? 'Select at least one team member' : 'No reviewed items to assign', 'warning');
      return;
    }
    try {
      await openTerminalWithCommand(cmd, 'Assign Testing');
    } catch (err) {
      showToast(`Failed to open terminal: ${err}`, 'error');
    }
  }

  async function handleTest(wi: WorkItem) {
    testingItem = wi.id;
    try {
      const selectedRepo = selectedRepos.get(wi.id);
      await testWorkitem(wi, selectedRepo);
    } catch (err) {
      showToast(`Failed: ${err}`, 'error');
    } finally {
      testingItem = null;
    }
  }

  function handleRepoSelect(wiId: number, repoName: string) {
    if (repoName) {
      selectedRepos.set(wiId, repoName);
    } else {
      selectedRepos.delete(wiId);
    }
    selectedRepos = new Map(selectedRepos);
  }

  async function handleClone(repo: GitHubRepo) {
    await cloneRepo(repo);
  }

  function getSelectedRepo(wiId: number): GitHubRepo | undefined {
    const name = selectedRepos.get(wiId);
    return name ? orgRepos.find(r => r.name === name) : undefined;
  }

  $effect(() => {
    if (!isLoaded() && !reposLoading) {
      loadOrgRepos();
    }
  });
</script>

<div class="card">
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
          {@const detectedRepo = extractRepoFromGitHubUrl(wi.githubPrUrl)}
          {@const selected = getSelectedRepo(wi.id)}
          <div class="item">
            <div class="item-info">
              <div class="item-title">{wi.title}</div>
              <div class="item-meta">
                <a href={wi.url} target="_blank" class="ticket-link">#{wi.id}</a>
                <span class="badge type {typeClass(wi.type)}">{wi.type}</span>
                {#if detectedRepo}
                  <span class="badge repo">{detectedRepo}</span>
                {/if}
              </div>
              <div class="reviewed-meta">
                <span class="badge-person">Resolved: {wi.resolvedBy || 'N/A'}</span>
                <span class="badge-person">Reviewed: {wi.reviewedBy || 'N/A'}</span>
              </div>
              {#if !detectedRepo || orgRepos.length > 0}
                <div class="repo-selector">
                  <select
                    onchange={(e) => handleRepoSelect(wi.id, (e.target as HTMLSelectElement).value)}
                    value={selectedRepos.get(wi.id) || ''}
                  >
                    <option value="">{detectedRepo ? `Auto: ${detectedRepo}` : 'Select repo...'}</option>
                    {#each orgRepos as repo (repo.name)}
                      <option value={repo.name} disabled={!repo.isLocal}>
                        {repo.name} {repo.isLocal ? '✓' : '(not cloned)'}
                      </option>
                    {/each}
                  </select>
                  {#if selected && !selected.isLocal}
                    <button
                      class="action-btn clone-btn"
                      onclick={() => handleClone(selected)}
                      disabled={cloningRepo === selected.name}
                    >
                      {cloningRepo === selected.name ? 'Cloning...' : 'Clone'}
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
            <div class="item-actions">
              <button
                class="action-btn"
                onclick={() => handleTest(wi)}
                disabled={testingItem === wi.id || (selected && !selected.isLocal)}
              >
                {testingItem === wi.id ? 'Starting...' : 'Test'}
              </button>
            </div>
          </div>
        {/each}
      {/if}

      <!-- Unassigned Section -->
      {#if unassignedItems.length > 0}
        <div class="section-header">Unassigned ({unassignedItems.length})</div>
        {#each unassignedItems as wi (wi.id)}
          {@const detectedRepo = extractRepoFromGitHubUrl(wi.githubPrUrl)}
          <div class="item">
            <div class="item-info">
              <div class="item-title">{wi.title}</div>
              <div class="item-meta">
                <a href={wi.url} target="_blank" class="ticket-link">#{wi.id}</a>
                <span class="badge type {typeClass(wi.type)}">{wi.type}</span>
                {#if detectedRepo}
                  <span class="badge repo">{detectedRepo}</span>
                {/if}
                <span class="badge-person unassigned">Unassigned</span>
              </div>
              <div class="reviewed-meta">
                <span class="badge-person">Resolved: {wi.resolvedBy || 'N/A'}</span>
                <span class="badge-person">Reviewed: {wi.reviewedBy || 'N/A'}</span>
              </div>
            </div>
          </div>
        {/each}
      {/if}

      <!-- Others Section (Collapsible) -->
      {#if otherItems.length > 0}
        <div
          class="section-header clickable"
          onclick={toggleShowOthers}
          role="button"
          tabindex="0"
          onkeydown={(e) => e.key === 'Enter' && toggleShowOthers()}
        >
          <span>Assigned to Others ({otherItems.length})</span>
          <span class="toggle-icon">{showOthers ? '▼' : '▶'}</span>
        </div>
        {#if showOthers}
          {#each otherItems as wi (wi.id)}
            {@const detectedRepo = extractRepoFromGitHubUrl(wi.githubPrUrl)}
            <div class="item">
              <div class="item-info">
                <div class="item-title">{wi.title}</div>
                <div class="item-meta">
                  <a href={wi.url} target="_blank" class="ticket-link">#{wi.id}</a>
                  <span class="badge type {typeClass(wi.type)}">{wi.type}</span>
                  {#if detectedRepo}
                    <span class="badge repo">{detectedRepo}</span>
                  {/if}
                  <span class="badge-person assigned">Assigned: {wi.assignedTo}</span>
                </div>
                <div class="reviewed-meta">
                  <span class="badge-person">Resolved: {wi.resolvedBy || 'N/A'}</span>
                  <span class="badge-person">Reviewed: {wi.reviewedBy || 'N/A'}</span>
                </div>
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
      <button class="action-btn" onclick={handleOpenTerminal}>Open Terminal</button>
    </div>
  </div>
</div>

<style>
  .ticket-link {
    color: #8b949e;
    text-decoration: none;
    transition: color 0.15s;
  }

  .ticket-link:hover {
    color: #58a6ff;
  }

  .sprint-header {
    padding: 10px 18px;
    background: #151b23;
    font-size: 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: #8b949e;
  }

  .current-user {
    color: #58a6ff;
    font-weight: 500;
  }

  .section-header {
    padding: 8px 18px;
    background: #151b23;
    font-size: 11px;
    font-weight: 600;
    color: #8b949e;
    border-bottom: 1px solid #21262d;
    display: flex;
    justify-content: space-between;
    align-items: center;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .section-header.clickable {
    cursor: pointer;
    transition: background 0.1s;
  }

  .section-header.clickable:hover {
    background: #161b22;
  }

  .toggle-icon {
    font-size: 10px;
  }

  .assign-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 18px;
    border-top: 1px solid #2a313b;
    gap: 12px;
  }

  .assign-left {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    flex-wrap: wrap;
  }

  .assign-label {
    font-size: 11px;
    color: #8b949e;
    white-space: nowrap;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }

  .team-selection {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .team-member {
    padding: 3px 10px;
    border-radius: 6px;
    background: #2a313b;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    transition: all 0.15s;
  }

  .team-member:hover {
    background: #353d47;
  }

  .team-member.selected {
    background: #123620;
    color: #3fb950;
    border: 1px solid #16381f;
  }

  .assign-controls {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .reviewed-meta {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }

  .badge-person {
    background: #2a313b;
    color: #8b949e;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
  }

  .badge-person.assigned {
    background: #123620;
    color: #3fb950;
  }

  .badge-person.unassigned {
    background: #361414;
    color: #f85149;
  }

  .badge.repo {
    background: #122a4a;
    color: #58a6ff;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    font-family: 'IBM Plex Mono', monospace;
  }

  .repo-selector {
    display: flex;
    gap: 6px;
    margin-top: 6px;
    align-items: center;
  }

  .repo-selector select {
    padding: 4px 8px;
    background: #0d1117;
    border: 1px solid #2a313b;
    border-radius: 6px;
    color: #c9d1d9;
    font-size: 11px;
    min-width: 180px;
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    transition: border-color 0.15s;
  }

  .repo-selector select:focus {
    outline: none;
    border-color: #1f4a85;
  }

  .clone-btn {
    padding: 4px 8px !important;
    font-size: 10px !important;
  }
</style>
