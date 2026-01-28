import { Router, type Request, type Response } from 'express';
import { config } from '../../core/config.js';
import { createTask } from '../../core/task-queue.js';
import { triggerUpdate } from '../../core/task-processor.js';
import type { TaskContext, TaskType } from '../../core/types.js';
import path from 'path';

export const adoRouter = Router();

function resolveRepoPath(repoName: string, project: string): string | null {
  // Try full path first: org/project/repo
  const fullKey = `${config.ado.organization}/${project}/${repoName}`;
  if (config.repos.mapping[fullKey]) {
    return path.resolve(config.repos.baseDir, config.repos.mapping[fullKey]);
  }
  // Try project/repo
  const projKey = `${project}/${repoName}`;
  if (config.repos.mapping[projKey]) {
    return path.resolve(config.repos.baseDir, config.repos.mapping[projKey]);
  }
  // Fallback: use repo name directly
  return path.resolve(config.repos.baseDir, repoName);
}

function getWorkItemType(workItemType: string): TaskType {
  const lower = workItemType.toLowerCase();
  if (lower.includes('bug')) return 'issue-fix';
  if (lower.includes('feature') || lower.includes('story')) return 'code-gen';
  return 'issue-fix';
}

function getBranchPrefix(workItemType: string): string {
  const lower = workItemType.toLowerCase();
  if (lower.includes('bug')) return 'bug';
  if (lower.includes('feature') || lower.includes('story')) return 'feat';
  return 'maintenance';
}

adoRouter.post('/', (req: Request, res: Response) => {
  const body = req.body;
  const eventType = body.eventType as string;

  // Handle PR events
  if (eventType === 'git.pullrequest.created' || eventType === 'git.pullrequest.updated') {
    const resource = body.resource;
    const repo = resource.repository;
    const project = repo.project?.name || '';
    const repoPath = resolveRepoPath(repo.name, project);

    if (!repoPath) {
      res.status(400).json({ error: 'Unknown repository' });
      return;
    }

    const context: TaskContext = {
      source: 'ado',
      event: eventType,
      prNumber: resource.pullRequestId,
      branch: resource.sourceRefName?.replace('refs/heads/', ''),
      baseBranch: resource.targetRefName?.replace('refs/heads/', ''),
      title: resource.title,
      body: resource.description,
      url: resource._links?.web?.href,
    };

    const repoFullName = `${project}/${repo.name}`;
    const task = createTask('pr-review', repoFullName, repoPath, context);
    console.log(`Created PR review task #${task.id} for ${repoFullName}!${resource.pullRequestId}`);
    triggerUpdate();

    res.json({ taskId: task.id, message: 'PR review task created' });
    return;
  }

  // Handle work item events
  if (eventType === 'workitem.created' || eventType === 'workitem.updated') {
    const resource = body.resource;
    const fields = resource.fields || {};
    const workItemType = fields['System.WorkItemType'] || 'Task';
    const title = fields['System.Title'] || '';
    const description = fields['System.Description'] || '';
    const workItemId = resource.id;

    // Need a repo context - check if there's a linked repo or use default
    // For now, we'll skip if no repo mapping exists for the project
    const project = body.resourceContainers?.project?.name || '';

    // Try to find any repo for this project
    let repoPath: string | null = null;
    let repoName = '';
    for (const [key, val] of Object.entries(config.repos.mapping)) {
      if (key.includes(project)) {
        repoPath = path.resolve(config.repos.baseDir, val);
        repoName = key;
        break;
      }
    }

    if (!repoPath) {
      res.json({ message: 'Work item received but no repo mapping found for project' });
      return;
    }

    const taskType = getWorkItemType(workItemType);
    const branchPrefix = getBranchPrefix(workItemType);

    const context: TaskContext = {
      source: 'ado',
      event: eventType,
      workItemId,
      title,
      body: description,
      url: resource._links?.html?.href,
      branch: `${branchPrefix}/${workItemId}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`,
    };

    const task = createTask(taskType, repoName, repoPath, context);
    console.log(`Created ${taskType} task #${task.id} for work item #${workItemId}`);
    triggerUpdate();

    res.json({ taskId: task.id, message: `${taskType} task created` });
    return;
  }

  // Handle build events
  if (eventType === 'build.complete') {
    const resource = body.resource;
    const result = resource.result;

    // Only process failed builds
    if (result !== 'failed' && result !== 'partiallySucceeded') {
      res.json({ message: 'Build succeeded, no action needed' });
      return;
    }

    const repo = resource.repository;
    const project = body.resourceContainers?.project?.name || '';
    const repoPath = resolveRepoPath(repo?.name || '', project);

    if (!repoPath) {
      res.json({ message: 'Build failed but no repo mapping found' });
      return;
    }

    const context: TaskContext = {
      source: 'ado',
      event: eventType,
      title: `Build ${resource.buildNumber} failed`,
      body: `Build definition: ${resource.definition?.name}\nResult: ${result}`,
      url: resource._links?.web?.href,
      branch: resource.sourceBranch?.replace('refs/heads/', ''),
    };

    const repoFullName = `${project}/${repo?.name || 'unknown'}`;
    const task = createTask('pipeline-fix', repoFullName, repoPath, context);
    console.log(`Created pipeline-fix task #${task.id} for build ${resource.buildNumber}`);
    triggerUpdate();

    res.json({ taskId: task.id, message: 'Pipeline fix task created' });
    return;
  }

  res.json({ message: 'Event received but not processed', eventType });
});
