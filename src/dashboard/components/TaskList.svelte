<script lang="ts">
  import TaskItem from './TaskItem.svelte';
  import { getTasks } from '../stores/tasks.svelte';
  import { getSearchQuery, matchesSearch } from '../stores/search.svelte';

  let allTasks = $derived(getTasks());
  let searchQuery = $derived(getSearchQuery());
  let tasks = $derived.by(() => {
    if (!searchQuery) return allTasks;
    return allTasks.filter(t => matchesSearch(searchQuery, t.id, t.type, t.repo, t.context?.title, t.context?.url));
  });
</script>

<div class="card tasks">
  <h2>Orch Tasks</h2>
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

<style>
  .tasks {
    overflow-x: hidden;
  }
</style>
