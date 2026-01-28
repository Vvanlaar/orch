import { execSync } from 'child_process';
import express from 'express';
import { existsSync, readFileSync } from 'fs';
import { createServer } from 'http';
import { homedir } from 'os';
import path, { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';

import { killTask } from '../core/claude-runner.js';
import { config } from '../core/config.js';
import { startPoller } from '../core/poller.js';
import { getEffectiveRepoMapping, getScannedRepos } from '../core/repo-scanner.js';
import { completeTask, createTask, deleteTask, failTask, getAllTasks, getAllTasksWithOutput, getTask, getTasksWithPids, retryTask } from '../core/task-queue.js';
import { setOutputCallback, setTaskUpdateCallback, startProcessor, steerTask, triggerUpdate } from '../core/task-processor.js';
import { getMyAdoWorkItems, getMyGitHubPRs, getMyResolvedWorkItems, getReviewedItemsInSprint, getTeamMembers } from '../core/user-items.js';
import { adoRouter } from './webhooks/ado.js';
import { githubRouter } from './webhooks/github.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  // Send current tasks with streaming output on connect
  ws.send(JSON.stringify({ type: 'tasks', tasks: getAllTasksWithOutput(100) }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'steer' && typeof msg.taskId === 'number' && typeof msg.input === 'string') {
        const success = steerTask(msg.taskId, msg.input);
        ws.send(JSON.stringify({ type: 'steerResult', taskId: msg.taskId, success }));
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => clients.delete(ws));
});

export function broadcastTasks(): void {
  const tasks = getAllTasksWithOutput(100);
  const message = JSON.stringify({ type: 'tasks', tasks });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function broadcastOutput(taskId: number, chunk: string): void {
  const message = JSON.stringify({
    type: 'output',
    taskId,
    chunk,
    timestamp: new Date().toISOString(),
  });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

app.use(express.json());

// Dashboard - serve built Svelte app or fallback to old HTML
const distDashboard = join(__dirname, '../../dist/dashboard');
const oldDashboard = join(__dirname, '../dashboard/index.old.html');

if (existsSync(join(distDashboard, 'index.html'))) {
  // Serve built Svelte dashboard
  app.use(express.static(distDashboard));
  app.get('/', (_req, res) => {
    res.sendFile(join(distDashboard, 'index.html'));
  });
} else if (existsSync(oldDashboard)) {
  // Fallback to old vanilla JS dashboard
  app.get('/', (_req, res) => {
    const html = readFileSync(oldDashboard, 'utf-8');
    res.type('html').send(html);
  });
} else {
  // Dev mode - Vite handles the dashboard
  app.get('/', (_req, res) => {
    res.send('Dashboard not built. Run npm run build:dashboard or use Vite dev server.');
  });
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Webhooks
app.use('/webhooks/github', githubRouter);
app.use('/webhooks/ado', adoRouter);

// API for dashboard
app.get('/api/tasks', (_req, res) => {
  const tasks = getAllTasks(100);
  res.json(tasks);
});

app.get('/api/tasks/:id', (req, res) => {
  const task = getTask(parseInt(req.params.id));
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(task);
});

// Stop running task
app.post('/api/tasks/:id/stop', async (req, res) => {
  const id = parseInt(req.params.id);
  const task = getTask(id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'running') {
    res.status(400).json({ error: 'Task not running' });
    return;
  }
  killTask(id);
  failTask(id, 'Stopped by user');
  broadcastTasks();
  res.json({ success: true });
});

// Delete task
app.delete('/api/tasks/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const success = deleteTask(id);
  if (!success) {
    res.status(400).json({ error: 'Cannot delete task (not found or running)' });
    return;
  }
  broadcastTasks();
  res.json({ success: true });
});

// Retry failed task
app.post('/api/tasks/:id/retry', (req, res) => {
  const id = parseInt(req.params.id);
  const task = getTask(id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'failed') {
    res.status(400).json({ error: 'Can only retry failed tasks' });
    return;
  }
  const newTask = retryTask(id);
  if (!newTask) {
    res.status(500).json({ error: 'Failed to create retry task' });
    return;
  }
  triggerUpdate();
  broadcastTasks();
  res.json({ taskId: newTask.id, message: `Retry task #${newTask.id} created (attempt ${newTask.context.retryCount})` });
});

// Complete task manually (for terminal mode)
app.post('/api/tasks/:id/complete', (req, res) => {
  const id = parseInt(req.params.id);
  const task = getTask(id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'running') {
    res.status(400).json({ error: 'Task not running' });
    return;
  }
  completeTask(id, req.body.result || 'Completed manually');
  broadcastTasks();
  res.json({ success: true });
});

// Open terminal in task's repo directory
app.post('/api/tasks/:id/terminal', async (req, res) => {
  const id = parseInt(req.params.id);
  const task = getTask(id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const { exec } = await import('child_process');
  const repoPath = task.repoPath.replace(/\\/g, '/');
  const title = `Task #${id}: ${task.repo}`;
  // Open Windows Terminal in the repo directory
  exec(`wt -w 0 nt --title "${title}" -d "${repoPath}"`, (err) => {
    if (err) {
      // Fallback to cmd
      exec(`start "${title}" cmd /k "cd /d ${task.repoPath}"`, (cmdErr) => {
        if (cmdErr) {
          res.status(500).json({ error: 'Failed to open terminal' });
        } else {
          res.json({ success: true });
        }
      });
    } else {
      res.json({ success: true });
    }
  });
});

function resolveRepoPath(repo: string): { repoPath: string; localFolder: string } | null {
  const repoMapping = getEffectiveRepoMapping();
  let localFolder = repoMapping[repo];

  if (!localFolder) {
    const repoNameOnly = repo.split('/').pop();
    if (repoNameOnly) localFolder = repoMapping[repoNameOnly];
  }

  if (!localFolder) return null;
  return { repoPath: path.resolve(config.repos.baseDir, localFolder), localFolder };
}

function killProcessByPid(pid: number, silent = false): boolean {
  try {
    const silentFlag = silent ? ' -ErrorAction SilentlyContinue' : '';
    execSync(`powershell -Command "Stop-Process -Id ${pid} -Force${silentFlag}"`, { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

function parseCimDate(cimDate: string): string | null {
  if (!cimDate) return null;
  const match = cimDate.match(/\/Date\((\d+)\)\//);
  return match ? new Date(parseInt(match[1])).toISOString() : null;
}

// Process management - only shows processes spawned by Orch tasks
app.get('/api/processes', (_req, res) => {
  try {
    const tasksWithPids = getTasksWithPids();
    if (tasksWithPids.length === 0) {
      res.json([]);
      return;
    }

    const pidList = tasksWithPids.map(t => t.pid).join(',');
    const result = execSync(
      `powershell -Command "Get-CimInstance Win32_Process -Filter \\"ProcessId IN (${pidList})\\" | Select-Object ProcessId, Name, CreationDate, CommandLine | ConvertTo-Json"`,
      { encoding: 'utf-8' }
    );

    if (!result.trim()) {
      res.json([]);
      return;
    }

    const data = JSON.parse(result);
    const arr = Array.isArray(data) ? data : [data];
    const pidToTask = new Map(tasksWithPids.map(t => [t.pid, t]));

    const processes = arr.map((p: { ProcessId: number; Name: string; CreationDate: string; CommandLine: string }) => {
      const task = pidToTask.get(p.ProcessId);
      return {
        pid: p.ProcessId,
        taskId: task?.id,
        taskType: task?.type,
        repo: task?.repo,
        name: p.Name?.replace('.exe', '') || 'unknown',
        startTime: parseCimDate(p.CreationDate),
      };
    });

    res.json(processes);
  } catch (err) {
    console.error('[processes] Error:', err);
    res.json([]);
  }
});

app.post('/api/processes/:pid/kill', (req, res) => {
  const pid = parseInt(req.params.pid);
  if (killProcessByPid(pid)) {
    res.json({ success: true });
  } else {
    res.status(400).json({ error: `Failed to kill process ${pid}` });
  }
});

app.post('/api/processes/kill-old', (_req, res) => {
  const tasksWithPids = getTasksWithPids();
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

  let killed = 0;
  for (const task of tasksWithPids) {
    const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : Date.now();
    if (startedAt < twoHoursAgo && task.pid && killProcessByPid(task.pid, true)) {
      killed++;
    }
  }
  res.json({ success: true, message: `Killed ${killed} Orch process(es) older than 2 hours` });
});

app.post('/api/processes/kill-all', (_req, res) => {
  const tasksWithPids = getTasksWithPids();
  let killed = 0;
  for (const task of tasksWithPids) {
    if (task.pid && killProcessByPid(task.pid, true)) {
      killed++;
    }
  }
  res.json({ success: true, message: `Killed ${killed} Orch process(es)` });
});

app.get('/api/repos', (_req, res) => {
  const repos = getScannedRepos();
  const mapping = getEffectiveRepoMapping();
  res.json({ repos, mapping });
});

app.get('/api/my/prs', async (_req, res) => {
  const prs = await getMyGitHubPRs();
  res.json(prs);
});

app.get('/api/my/workitems', async (_req, res) => {
  const items = await getMyAdoWorkItems();
  res.json(items);
});

app.get('/api/my/resolved-workitems', async (_req, res) => {
  const items = await getMyResolvedWorkItems();
  res.json(items);
});

app.get('/api/sprint/reviewed-items', async (_req, res) => {
  const result = await getReviewedItemsInSprint();
  res.json(result);
});

app.get('/api/team/members', async (_req, res) => {
  const members = await getTeamMembers();
  res.json(members);
});

app.get('/api/claude/usage', async (_req, res) => {
  try {
    const credsPath = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(credsPath)) {
      res.status(404).json({ error: 'Claude credentials not found' });
      return;
    }
    const creds = JSON.parse(readFileSync(credsPath, 'utf-8'));
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token) {
      res.status(401).json({ error: 'No access token in credentials' });
      return;
    }
    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.22',
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!resp.ok) {
      res.status(resp.status).json({ error: `API error: ${resp.status}` });
      return;
    }
    const usage = await resp.json();
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Trigger actions from dashboard
app.post('/api/actions/review-pr', (req, res) => {
  const { repo, prNumber, source, title, url, branch, baseBranch } = req.body;
  const resolved = resolveRepoPath(repo);

  if (!resolved) {
    res.status(400).json({ error: `No local mapping for repo: ${repo}` });
    return;
  }

  const task = createTask('pr-review', repo, resolved.repoPath, {
    source: source || 'github',
    event: 'manual.pr-review',
    prNumber,
    title,
    url,
    branch,
    baseBranch,
  });
  triggerUpdate();
  broadcastTasks();
  res.json({ taskId: task.id, message: 'PR review task created' });
});

app.post('/api/actions/analyze-workitem', (req, res) => {
  const { id, title, project, url, type } = req.body;
  const repoMapping = getEffectiveRepoMapping();

  // Find a repo for this project
  let repoPath: string | null = null;
  let repoName = '';
  for (const [remote, local] of Object.entries(repoMapping)) {
    if (remote.includes(project)) {
      repoPath = path.resolve(config.repos.baseDir, local);
      repoName = remote;
      break;
    }
  }

  if (!repoPath) {
    // Use first available repo as fallback
    const firstRepo = Object.entries(repoMapping)[0];
    if (firstRepo) {
      repoPath = path.resolve(config.repos.baseDir, firstRepo[1]);
      repoName = firstRepo[0];
    }
  }

  if (!repoPath) {
    res.status(400).json({ error: 'No repos available' });
    return;
  }

  const taskType = type?.toLowerCase().includes('bug') ? 'issue-fix' : 'code-gen';
  const task = createTask(taskType, repoName, repoPath, {
    source: 'ado',
    event: 'manual.workitem',
    workItemId: id,
    title,
    url,
  });
  triggerUpdate();
  broadcastTasks();
  res.json({ taskId: task.id, message: `${taskType} task created` });
});

app.post('/api/actions/fix-pr-comments', async (req, res) => {
  const { repo, prNumber, source, title, url, branch, baseBranch } = req.body;
  const resolved = resolveRepoPath(repo);

  if (!resolved) {
    res.status(400).json({ error: `No local mapping for repo: ${repo}` });
    return;
  }

  const { Octokit } = await import('octokit');
  const octokit = new Octokit({ auth: config.github.token });
  const [owner, repoName] = repo.split('/');

  let headBranch = branch;
  let baseBranchRef = baseBranch;

  if (!headBranch) {
    try {
      const { data: prData } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber });
      headBranch = prData.head.ref;
      baseBranchRef = prData.base.ref;
      console.log(`[fix-pr-comments] Fetched branch info: ${headBranch} -> ${baseBranchRef}`);
    } catch (err) {
      console.error('[fix-pr-comments] Failed to fetch PR branch info:', err);
      res.status(400).json({ error: 'Failed to fetch PR branch info' });
      return;
    }
  }

  try {
    const { data: user } = await octokit.rest.users.getAuthenticated();
    const { data: comments } = await octokit.rest.pulls.listReviewComments({
      owner,
      repo: repoName,
      pull_number: prNumber,
    });

    const unresolvedComments = comments.filter(c =>
      c.user?.login !== user.login && !c.in_reply_to_id
    );

    if (unresolvedComments.length === 0) {
      res.status(400).json({ error: 'No unresolved review comments found' });
      return;
    }

    const reviewComments = unresolvedComments.map(c => ({
      id: c.id,
      path: c.path,
      line: c.line || c.original_line || 0,
      body: c.body,
      diffHunk: c.diff_hunk,
    }));

    const task = createTask('pr-comment-fix', repo, resolved.repoPath, {
      source: source || 'github',
      event: 'manual.fix-pr-comments',
      prNumber,
      title,
      url,
      branch: headBranch,
      baseBranch: baseBranchRef,
      reviewComments,
    });

    triggerUpdate();
    broadcastTasks();
    res.json({ taskId: task.id, message: `PR comment fix task created (${unresolvedComments.length} comments)` });
  } catch (err) {
    console.error('[fix-pr-comments] Error:', err);
    res.status(500).json({ error: 'Failed to fetch review comments' });
  }
});

app.post('/api/actions/review-resolution', (req, res) => {
  const { id, title, project, url, resolution, githubPrUrl, testNotes, body } = req.body;
  const repoMapping = getEffectiveRepoMapping();

  console.log(`[review-resolution] Project: ${project}, PR URL: ${githubPrUrl}`);

  let repoPath: string | null = null;
  let repoName = '';

  // Try to find repo from GitHub PR URL
  if (githubPrUrl) {
    const prMatch = githubPrUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull/);
    if (prMatch) {
      const ghRepo = prMatch[1];
      const resolved = resolveRepoPath(ghRepo);
      if (resolved) {
        repoPath = resolved.repoPath;
        repoName = ghRepo;
        console.log(`[review-resolution] Found mapping for ${ghRepo}`);
      }
    }
  }

  // Fallback to project-based lookup
  if (!repoPath && project) {
    for (const [remote, local] of Object.entries(repoMapping)) {
      if (remote.toLowerCase().includes(project.toLowerCase())) {
        repoPath = path.resolve(config.repos.baseDir, local);
        repoName = remote;
        console.log(`[review-resolution] Found by project: ${remote} -> ${local}`);
        break;
      }
    }
  }

  if (!repoPath) {
    const hint = githubPrUrl ? 'for GitHub repo from PR URL' : `for project "${project}"`;
    res.status(400).json({ error: `No local repo mapping found ${hint}. Clone the repo or add manual mapping.` });
    return;
  }

  const task = createTask('resolution-review', repoName, repoPath, {
    source: 'ado',
    event: 'manual.resolution-review',
    workItemId: id,
    title,
    url,
    body,
    prUrl: githubPrUrl,
    resolution,
    testNotes,
  });
  triggerUpdate();
  broadcastTasks();
  res.json({ taskId: task.id, message: 'Resolution review task created' });
});

// Start server
server.listen(config.server.port, () => {
  console.log(`Orch server listening on port ${config.server.port}`);
  console.log(`Dashboard: http://localhost:${config.server.port}`);
  console.log(`GitHub webhooks: http://localhost:${config.server.port}/webhooks/github`);
  console.log(`ADO webhooks: http://localhost:${config.server.port}/webhooks/ado`);

  // Log discovered repos
  if (config.repos.autoScan) {
    const repos = getScannedRepos();
    console.log(`\nDiscovered ${repos.length} repos:`);
    for (const repo of repos) {
      const icon = repo.source === 'github' ? '🐙' : repo.source === 'ado' ? '🔷' : '❓';
      console.log(`  ${icon} ${repo.remote || repo.localName} -> ${repo.localName}`);
    }
  }

  setTaskUpdateCallback(broadcastTasks);
  setOutputCallback(broadcastOutput);
  startProcessor();

  if (config.polling.enabled) {
    startPoller(config.polling.intervalMs);
  }
});
