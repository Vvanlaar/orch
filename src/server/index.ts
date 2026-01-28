import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import path, { dirname, join } from 'path';
import { readFileSync } from 'fs';
import { config } from '../core/config.js';
import { githubRouter } from './webhooks/github.js';
import { adoRouter } from './webhooks/ado.js';
import { startProcessor, setTaskUpdateCallback, triggerUpdate } from '../core/task-processor.js';
import { startPoller } from '../core/poller.js';
import { getScannedRepos, getEffectiveRepoMapping } from '../core/repo-scanner.js';
import { getMyGitHubPRs, getMyAdoWorkItems } from '../core/user-items.js';
import { getAllTasks, getTask, createTask } from '../core/task-queue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  // Send current tasks on connect
  ws.send(JSON.stringify({ type: 'tasks', tasks: getAllTasks(100) }));
  ws.on('close', () => clients.delete(ws));
});

export function broadcastTasks(): void {
  const tasks = getAllTasks(100);
  const message = JSON.stringify({ type: 'tasks', tasks });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

app.use(express.json());

// Dashboard
app.get('/', (_req, res) => {
  const html = readFileSync(join(__dirname, '../dashboard/index.html'), 'utf-8');
  res.type('html').send(html);
});

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

// Trigger actions from dashboard
app.post('/api/actions/review-pr', (req, res) => {
  const { repo, prNumber, source, title, url, branch, baseBranch } = req.body;
  const repoMapping = getEffectiveRepoMapping();
  const localFolder = repoMapping[repo];

  if (!localFolder) {
    res.status(400).json({ error: `No local mapping for repo: ${repo}` });
    return;
  }

  const repoPath = path.resolve(config.repos.baseDir, localFolder);
  const task = createTask('pr-review', repo, repoPath, {
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
  startProcessor();

  if (config.polling.enabled) {
    startPoller(config.polling.intervalMs);
  }
});
