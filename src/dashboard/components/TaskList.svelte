<script lang="ts">
  import TaskItem from './TaskItem.svelte';
  import { getTasks } from '../stores/tasks.svelte';
  import { getSearchQuery, matchesSearch } from '../stores/search.svelte';
  import { readPreference, writePreference } from '../lib/preferences';

  let allTasks = $derived(getTasks());
  let searchQuery = $derived(getSearchQuery());
  let tasks = $derived.by(() => {
    if (!searchQuery) return allTasks;
    return allTasks.filter(t => matchesSearch(searchQuery, t.id, t.type, t.repo, t.context?.title, t.context?.url));
  });

  const CARD_ID = 'tasks';
  const COLLAPSED_KEY = 'orch.dashboard.cards.collapsed';
  function getCollapsedCards(): string[] {
    return readPreference(COLLAPSED_KEY, [] as string[], (v): v is string[] => Array.isArray(v));
  }
  let cardCollapsed = $state(getCollapsedCards().includes(CARD_ID));
  function toggleCard() {
    cardCollapsed = !cardCollapsed;
    const current = getCollapsedCards();
    const next = cardCollapsed ? [...new Set([...current, CARD_ID])] : current.filter(id => id !== CARD_ID);
    writePreference(COLLAPSED_KEY, next);
  }
</script>

<div class="card tasks" class:collapsed={cardCollapsed}>
  <h2><button type="button" class="card-toggle" onclick={toggleCard}>Orch Tasks</button></h2>
  {#if !cardCollapsed}
    <div class="card-body">
      <div class="card-list">
        {#if tasks.length === 0}
          <div class="empty">No tasks yet</div>
        {:else}
          {#each tasks as task (task.id)}
            <TaskItem {task} />
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .tasks {
    overflow-x: hidden;
  }
</style>
