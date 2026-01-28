<script lang="ts">
  import TaskItem from './TaskItem.svelte';
  import { getTasks } from '../stores/tasks.svelte';

  let tasks = $derived(getTasks());
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
    margin-bottom: 24px;
    overflow-x: hidden;
  }
</style>
