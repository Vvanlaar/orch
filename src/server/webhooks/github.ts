import { createHmac, timingSafeEqual } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../../core/config.js';
import { createTask } from '../../core/task-queue.js';
import { triggerUpdate } from '../../core/task-processor.js';
import type { TaskContext } from '../../core/types.js';
import path from 'path';

export const githubRouter = Router();

function verifySignature(payload: string, signature: string | undefined): boolean {
  if (!config.github.webhookSecret || !signature) return false;

  const expected = 'sha256=' + createHmac('sha256', config.github.webhookSecret)
    .update(payload)
    .digest('hex');

  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

function resolveRepoPath(fullName: string): string | null {
  const mapped = config.repos.mapping[fullName];
  if (mapped) {
    return path.resolve(config.repos.baseDir, mapped);
  }
  // Fallback: use repo name directly
  const repoName = fullName.split('/')[1];
  return path.resolve(config.repos.baseDir, repoName);
}

githubRouter.post('/', (req: Request, res: Response) => {
  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const event = req.headers['x-github-event'] as string;
  const payload = JSON.stringify(req.body);

  // Verify signature if secret is configured
  if (config.github.webhookSecret && !verifySignature(payload, signature)) {
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  const body = req.body;

  // Handle PR events
  if (event === 'pull_request') {
    const action = body.action;
    if (action === 'opened' || action === 'synchronize') {
      const pr = body.pull_request;
      const repo = body.repository.full_name;
      const repoPath = resolveRepoPath(repo);

      if (!repoPath) {
        res.status(400).json({ error: 'Unknown repository' });
        return;
      }

      const context: TaskContext = {
        source: 'github',
        event: `pull_request.${action}`,
        prNumber: pr.number,
        branch: pr.head.ref,
        baseBranch: pr.base.ref,
        title: pr.title,
        body: pr.body,
        url: pr.html_url,
      };

      const task = createTask('pr-review', repo, repoPath, context);
      console.log(`Created PR review task #${task.id} for ${repo}#${pr.number}`);
      triggerUpdate();

      res.json({ taskId: task.id, message: 'PR review task created' });
      return;
    }
  }

  // Handle issue events
  if (event === 'issues') {
    const action = body.action;
    if (action === 'opened') {
      const issue = body.issue;
      const repo = body.repository.full_name;
      const repoPath = resolveRepoPath(repo);

      if (!repoPath) {
        res.status(400).json({ error: 'Unknown repository' });
        return;
      }

      const context: TaskContext = {
        source: 'github',
        event: 'issues.opened',
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body,
        url: issue.html_url,
      };

      const task = createTask('issue-fix', repo, repoPath, context);
      console.log(`Created issue-fix task #${task.id} for ${repo}#${issue.number}`);
      triggerUpdate();

      res.json({ taskId: task.id, message: 'Issue fix task created' });
      return;
    }
  }

  res.json({ message: 'Event received but not processed' });
});
