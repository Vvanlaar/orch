import cors from 'cors';
import { exec, execSync, spawn } from 'child_process';
import express from 'express';
import { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { createServer } from 'http';
import { homedir, tmpdir } from 'os';
import path, { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';

import { killTask } from '../core/claude-runner.js';
import { config, WORKSPACES_DIR } from '../core/config.js';
import { cloneRepo, checkoutPRInWorktree } from '../core/git-ops.js';
import {
  detectAvailableTerminals,
  findTerminalPath,
  getKnownTerminals,
  getTerminalInteractiveSession,
  getTerminalPreference,
  isMacPlatform,
  isWindowsPlatform,
  setTerminalInteractiveSession,
  setTerminalPreference,
} from '../core/settings.js';
import { startPoller } from '../core/poller.js';
import { getEffectiveRepoMapping, getScannedRepos } from '../core/repo-scanner.js';
import { getAuthenticatedUser, getPull, listPullReviewComments, listOrgRepos } from '../core/github-api.js';
import { approveSuggestion, completeTask, createTask, deleteTask, dismissSuggestion, failTask, getAllTasks, getAllTasksWithOutput, getTask, getTasksWithPids, retryTask, updateTaskRepoPath } from '../core/task-queue.js';
import { initSettings } from '../core/settings.js';
import { isSupabaseConfigured } from '../core/db/client.js';
import { dbGetNotifications, dbInsertNotification } from '../core/db/notifications.js';
import { setOutputCallback, setTaskUpdateCallback, startProcessor, steerTask, triggerUpdate } from '../core/task-processor.js';
import { getVideoscanDir, listScans, mergeScans, generateReport } from '../core/videoscan-runner.js';
import type { TerminalId } from '../core/types.js';
import { getCurrentAdoUser, getMyAdoWorkItems, getMyGitHubPRs, getMyResolvedWorkItems, getResolvedWithPRComments, getReviewedItemsInSprint, getTeamMembers, getWorkItemsBySprints, type OwnerFilter } from '../core/user-items.js';
import { startNtfyListener } from '../core/ntfy-listener.js';
import { acceptAction, dismissAction, getOrchestratorState, runChatQuery, runOrchestrator, setNotificationGetter, setOrchestratorUpdateCallback } from '../core/orchestrator.js';
import { loadOrchestratorRules, saveOrchestratorRules } from '../core/orch-feedback.js';
import { createLogger, getRecentErrors } from '../core/logger.js';
import { asyncHandler, expressErrorMiddleware, installProcessHandlers } from '../core/error-handler.js';
import { adoRouter } from './webhooks/ado.js';
import { githubRouter } from './webhooks/github.js';

const log = createLogger('server');

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set<WebSocket>();

wss.on('connection', async (ws) => {
  clients.add(ws);
  try {
    // Send current tasks with streaming output on connect
    const tasks = await getAllTasksWithOutput(100);
    ws.send(JSON.stringify({ type: 'tasks', tasks }));
    // Send current orchestrator state
    ws.send(JSON.stringify({ type: 'orchestrator', state: getOrchestratorState() }));
  } catch (err) {
    log.error('Error sending initial WS data', err);
  }

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
  ws.on('error', (err) => log.error('WebSocket client error', err));
});

wss.on('error', (err) => log.error('WebSocket server error', err));

export async function broadcastTasks(): Promise<void> {
  const tasks = await getAllTasksWithOutput(100);
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

app.use(cors({ origin: true }));
app.use(express.json());

// Dashboard - serve built Svelte app or fallback to old HTML
const distDashboard = process.env.DASHBOARD_DIR || join(__dirname, '../../dist/dashboard');
const oldDashboard = join(__dirname, '../dashboard/index.old.html');

const dashboardIndexPath = join(distDashboard, 'index.html');
const hasDashboardBuild = existsSync(dashboardIndexPath);

if (hasDashboardBuild) {
  // Serve built Svelte dashboard static assets
  app.use(express.static(distDashboard));
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
app.get('/api/tasks', asyncHandler(async (_req, res) => {
  const tasks = await getAllTasks(100);
  res.json(tasks);
}));

app.get('/api/tasks/:id', asyncHandler(async (req, res) => {
  const task = await getTask(parseInt(req.params.id));
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  res.json(task);
}));

// Stop running task
app.post('/api/tasks/:id/stop', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id as string);
  const task = await getTask(id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'running') {
    res.status(400).json({ error: 'Task not running' });
    return;
  }
  killTask(id);
  await failTask(id, 'Stopped by user');
  await broadcastTasks();
  res.json({ success: true });
}));

// Delete task
app.delete('/api/tasks/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id as string);
  const success = await deleteTask(id);
  if (!success) {
    res.status(400).json({ error: 'Cannot delete task (not found or running)' });
    return;
  }
  await broadcastTasks();
  res.json({ success: true });
}));

// Retry failed task
app.post('/api/tasks/:id/retry', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const task = await getTask(id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'failed') {
    res.status(400).json({ error: 'Can only retry failed tasks' });
    return;
  }
  const newTask = await retryTask(id);
  if (!newTask) {
    res.status(500).json({ error: 'Failed to create retry task' });
    return;
  }
  triggerUpdate();
  await broadcastTasks();
  res.json({ taskId: newTask.id, message: `Retry task #${newTask.id} created (attempt ${newTask.context.retryCount})` });
}));

// Approve suggestion
app.post('/api/tasks/:id/approve', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const { extraPrompt } = req.body || {};
  const task = await approveSuggestion(id, extraPrompt);
  if (!task) {
    res.status(400).json({ error: 'Task not found or not a suggestion' });
    return;
  }
  triggerUpdate();
  await broadcastTasks();
  res.json({ success: true, message: `Task #${id} approved` });
}));

// Dismiss suggestion
app.post('/api/tasks/:id/dismiss', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  if (!(await dismissSuggestion(id))) {
    res.status(400).json({ error: 'Task not found or not a suggestion' });
    return;
  }
  await broadcastTasks();
  res.json({ success: true, message: `Task #${id} dismissed` });
}));

// Set repo path for needs-repo tasks
app.put('/api/tasks/:id/repo-path', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const task = await getTask(id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'needs-repo') {
    res.status(400).json({ error: 'Task not in needs-repo state' });
    return;
  }
  const { repoPath } = req.body;
  if (!repoPath || typeof repoPath !== 'string') {
    res.status(400).json({ error: 'repoPath required' });
    return;
  }
  await updateTaskRepoPath(id, repoPath);
  triggerUpdate();
  await broadcastTasks();
  res.json({ success: true });
}));

// Complete task manually (for terminal mode)
app.post('/api/tasks/:id/complete', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id);
  const task = await getTask(id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  if (task.status !== 'running') {
    res.status(400).json({ error: 'Task not running' });
    return;
  }
  await completeTask(id, req.body.result || 'Completed manually');
  await broadcastTasks();
  res.json({ success: true });
}));

function launchDetached(command: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    try {
      const proc = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
      proc.once('error', () => { if (!settled) { settled = true; resolve(false); } });
      proc.once('spawn', () => { if (!settled) { settled = true; proc.unref(); resolve(true); } });
    } catch { resolve(false); }
  });
}

type ShellResult = { success: boolean; terminal?: string; hint?: string; error?: string };

async function tryTerminalFallbacks(
  tryTerminal: (terminal: string) => Promise<boolean>,
  windowsFallbacks: string[],
  linuxFallbacks: string[],
  macFallbacks?: string[],
  sessionId?: string,
): Promise<ShellResult> {
  const preferred = getTerminalPreference();
  const fallbacks = isWindowsPlatform() ? windowsFallbacks : isMacPlatform() ? (macFallbacks ?? linuxFallbacks) : linuxFallbacks;

  if (preferred === 'auto') {
    for (const terminal of fallbacks) {
      if (await tryTerminal(terminal)) {
        const hint = terminal === 'tmux' && sessionId ? `Attach with: tmux attach -t ${sessionId}` : undefined;
        return { success: true, terminal, hint };
      }
    }
    const msg = isWindowsPlatform() ? 'Failed to open terminal' : 'Failed to open terminal. Install a supported terminal.';
    return { success: false, error: msg };
  }

  if (await tryTerminal(preferred)) {
    const hint = preferred === 'tmux' && sessionId ? `Attach with: tmux attach -t ${sessionId}` : undefined;
    return { success: true, terminal: preferred, hint };
  }
  return { success: false, error: `Failed to open ${preferred} terminal` };
}

function resolveWorkspacePath(repoPath: string, worktreePrefix?: string | number): string {
  if (!worktreePrefix) return repoPath;
  const repoName = path.basename(repoPath);
  const worktreeBase = path.join(WORKSPACES_DIR, 'worktrees', repoName);
  if (!existsSync(worktreeBase)) return repoPath;
  const prefix = String(worktreePrefix);
  const match = readdirSync(worktreeBase).find(e => e.startsWith(prefix));
  return match ? path.join(worktreeBase, match) : repoPath;
}

async function openShellAtPath(shellPath: string, title: string): Promise<ShellResult> {
  const sessionId = `orch-term-${Date.now()}`;
  const encode = (cmd: string) => Buffer.from(cmd, 'utf16le').toString('base64');
  const escapePsSingle = (v: string) => v.replace(/'/g, "''");
  const encodedPsCommand = encode(
    `Set-Location -LiteralPath '${escapePsSingle(shellPath)}'; $Host.UI.RawUI.WindowTitle='${escapePsSingle(title)}'`
  );

  const tryTerminal = (terminal: string): Promise<boolean> => {
    if (isWindowsPlatform()) {
      switch (terminal) {
        case 'wt': {
          const wtExe = findTerminalPath('wt') || 'wt';
          return launchDetached(wtExe, ['-w', '0', 'nt', '--title', title, '-d', shellPath]);
        }
        case 'powershell':
          return launchDetached('powershell', ['-NoExit', '-EncodedCommand', encodedPsCommand]);
        case 'pwsh': {
          const pwshExe = findTerminalPath('pwsh') || 'pwsh';
          return launchDetached(pwshExe, ['-NoExit', '-EncodedCommand', encodedPsCommand]);
        }
        case 'git-bash':
          return launchDetached('C:\\Program Files\\Git\\git-bash.exe', [`--cd=${shellPath}`]);
        default:
          return launchDetached('cmd.exe', ['/k', `cd /d "${shellPath}" & title ${title}`]);
      }
    }
    return new Promise(resolve => {
      const escapedPath = shellPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const cmds: Record<string, string> = {
        'terminal-app': `osascript -e 'tell application "Terminal" to do script "cd ${escapedPath}"'`,
        'iterm2': [
          'osascript',
          `-e 'tell application "iTerm2"'`,
          `-e 'create window with default profile'`,
          `-e 'tell current session of current window'`,
          `-e 'write text "cd ${escapedPath}"'`,
          `-e 'end tell'`,
          `-e 'end tell'`,
        ].join(' '),
        'gnome-terminal': `gnome-terminal --title="${title}" --working-directory="${shellPath}"`,
        'xterm': `xterm -T "${title}" -e "cd '${shellPath}' && exec bash"`,
      };
      const cmd = cmds[terminal] ?? `tmux new-session -d -s "${sessionId}" -c "${shellPath}"`;
      exec(cmd, err => resolve(!err));
    });
  };

  return tryTerminalFallbacks(tryTerminal, ['wt', 'git-bash', 'cmd'], ['gnome-terminal', 'xterm', 'tmux'], ['iterm2', 'terminal-app', 'tmux'], sessionId);
}

async function openShellWithCommand(cmd: string, title: string): Promise<ShellResult> {
  const tmpFile = path.join(tmpdir(), `orch-cmd-${Date.now()}.sh`);
  const escaped = cmd.replace(/\\/g, '\\\\').replace(/\$/g, '\\$').replace(/`/g, '\\`').replace(/"/g, '\\"');
  const script = `#!/bin/bash\necho "Press Enter to run (or edit):"\nread -e -p "$ " -i "${escaped}" input\neval "$input"\nrm -- "$0"\nexec bash\n`;
  writeFileSync(tmpFile, script, { mode: 0o755 });

  const unixPath = tmpFile.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

  const tryTerminal = (terminal: string): Promise<boolean> => {
    if (isWindowsPlatform()) {
      switch (terminal) {
        case 'wt': {
          const wtExe = findTerminalPath('wt') || 'wt';
          return launchDetached(wtExe, ['-w', '0', 'nt', '--title', title, '--', 'bash', unixPath]);
        }
        case 'git-bash':
          return launchDetached('C:\\Program Files\\Git\\git-bash.exe', ['--', unixPath]);
        case 'powershell':
          return launchDetached('powershell', ['-NoExit', '-Command', `bash '${unixPath}'`]);
        case 'pwsh': {
          const pwshExe = findTerminalPath('pwsh') || 'pwsh';
          return launchDetached(pwshExe, ['-NoExit', '-Command', `bash '${unixPath}'`]);
        }
        default:
          return launchDetached('cmd.exe', ['/k', `bash "${unixPath}" & title ${title}`]);
      }
    }
    return new Promise(resolve => {
      const cmds: Record<string, string> = {
        'terminal-app': `osascript -e 'tell application "Terminal" to do script "bash ${unixPath}"'`,
        'iterm2': [
          'osascript',
          `-e 'tell application "iTerm2"'`,
          `-e 'create window with default profile'`,
          `-e 'tell current session of current window'`,
          `-e 'write text "bash ${unixPath}"'`,
          `-e 'end tell'`,
          `-e 'end tell'`,
        ].join(' '),
        'gnome-terminal': `gnome-terminal --title="${title}" -- bash "${unixPath}"`,
        'xterm': `xterm -T "${title}" -e "bash '${unixPath}'"`,
      };
      exec(cmds[terminal] ?? `bash "${unixPath}"`, err => resolve(!err));
    });
  };

  const result = await tryTerminalFallbacks(tryTerminal, ['wt', 'git-bash', 'cmd'], ['gnome-terminal', 'xterm'], ['iterm2', 'terminal-app']);
  if (!result.success) {
    try { unlinkSync(tmpFile); } catch {}
  }
  return result;
}

function sendShellResult(res: express.Response, result: Awaited<ReturnType<typeof openShellAtPath>>): void {
  if (result.success) {
    res.json(result);
  } else {
    res.status(500).json({ error: result.error });
  }
}

// Open terminal in task's repo directory (resolves worktree for PR/ticket tasks)
app.post('/api/tasks/:id/terminal', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id as string);
  const task = await getTask(id);
  if (!task) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }
  const prefix = task.context.prNumber ? `pr-${task.context.prNumber}` : task.context.workItemId;
  const shellPath = resolveWorkspacePath(task.repoPath, prefix);
  sendShellResult(res, await openShellAtPath(shellPath, `Task #${id}: ${task.repo}`));
}));

app.post('/api/open-terminal', asyncHandler(async (req, res) => {
  const { repoName, workItemId } = req.body as { repoName: string; workItemId?: number };
  if (!repoName || typeof repoName !== 'string' || /\.\./.test(repoName)) {
    res.status(400).json({ error: 'Invalid repoName' });
    return;
  }
  // Allow .workspaces/clones/<name> but reject other path traversal
  const segments = repoName.replace(/\\/g, '/').split('/');
  if (segments.length > 3 || segments.length === 2 || (segments.length === 3 && (segments[0] !== '.workspaces' || segments[1] !== 'clones'))) {
    res.status(400).json({ error: 'Invalid repoName' });
    return;
  }
  if (workItemId !== undefined && (!Number.isInteger(workItemId) || workItemId <= 0)) {
    res.status(400).json({ error: 'workItemId must be a positive integer' });
    return;
  }
  let basePath = segments[0] === '.workspaces'
    ? path.join(WORKSPACES_DIR, ...segments.slice(1))
    : path.resolve(config.repos.baseDir, repoName);
  if (!existsSync(basePath)) {
    const cloned = autoClone(repoName, 'github');
    if (cloned) {
      basePath = cloned.repoPath;
    } else {
      res.status(404).json({ error: `Repo not found: ${basePath}` });
      return;
    }
  }
  const workspacePath = resolveWorkspacePath(basePath, workItemId);
  const title = workItemId ? `#${workItemId} ${repoName}` : repoName;
  sendShellResult(res, await openShellAtPath(workspacePath, title));
}));

app.post('/api/terminal/run-command', asyncHandler(async (req, res) => {
  const { command, title } = req.body as { command: string; title?: string };
  if (!command) { res.status(400).json({ error: 'command required' }); return; }
  sendShellResult(res, await openShellWithCommand(command, title ?? 'Orch Command'));
}));

/** Resolve a local folder name to an absolute path, returning null if no .git exists there. */
function resolveLocalRepo(localFolder: string): string | null {
  const full = localFolder.startsWith('.workspaces/')
    ? path.join(WORKSPACES_DIR, localFolder.slice('.workspaces/'.length))
    : path.resolve(config.repos.baseDir, localFolder);
  return existsSync(join(full, '.git')) ? full : null;
}

function resolveRepoPath(repo: string): { repoPath: string; localFolder: string } | null {
  const repoMapping = getEffectiveRepoMapping();
  let localFolder = repoMapping[repo];

  if (!localFolder) {
    const repoNameOnly = repo.split('/').pop();
    if (repoNameOnly) localFolder = repoMapping[repoNameOnly];
  }

  if (!localFolder) return null;
  const repoPath = resolveLocalRepo(localFolder);
  if (!repoPath) return null;
  return { repoPath, localFolder };
}

function resolveFromRepositoryField(repositories: string[] | undefined): { repoPath: string; repoName: string } | null {
  if (!repositories?.length) return null;
  const repoMapping = getEffectiveRepoMapping();
  for (const repo of repositories) {
    const resolved = resolveRepoPath(repo);
    if (resolved) return { repoPath: resolved.repoPath, repoName: repo };
    for (const [remote, local] of Object.entries(repoMapping)) {
      if (remote.endsWith('/' + repo) || local === repo) {
        const repoPath = resolveLocalRepo(local);
        if (repoPath) return { repoPath, repoName: remote };
      }
    }
  }
  return null;
}

/** Auto-clone a repo if not found locally. Returns clone path or null. */
function autoClone(
  repoIdentifier: string,
  source: 'github' | 'ado',
  project?: string,
): { repoPath: string; repoName: string } | null {
  const shortName = repoIdentifier.split('/').pop()!;
  const existingClonePath = path.join(WORKSPACES_DIR, 'clones', shortName);
  if (existsSync(path.join(existingClonePath, '.git'))) {
    return { repoPath: existingClonePath, repoName: repoIdentifier };
  }

  let cloneUrl: string;
  if (source === 'github') {
    const fullName = repoIdentifier.includes('/')
      ? repoIdentifier
      : `${config.github.org}/${repoIdentifier}`;
    cloneUrl = `https://github.com/${fullName}.git`;
  } else {
    cloneUrl = `https://dev.azure.com/${config.ado.organization}/${project || shortName}/_git/${shortName}`;
  }

  log.info(`auto-clone: ${cloneUrl} -> .workspaces/clones/${shortName}`);
  const clonedPath = cloneRepo(cloneUrl, shortName);
  if (!clonedPath) return null;
  log.info(`auto-clone success: ${clonedPath}`);
  return { repoPath: clonedPath, repoName: repoIdentifier };
}

function autoCloneFromRepositories(
  repositories: string[] | undefined,
  project?: string,
): { repoPath: string; repoName: string } | null {
  if (!repositories?.length) return null;
  for (const repo of repositories) {
    const gh = autoClone(repo, 'github');
    if (gh) return gh;
    if (project) {
      const ado = autoClone(repo, 'ado', project);
      if (ado) return ado;
    }
  }
  return null;
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
app.get('/api/processes', asyncHandler(async (_req, res) => {
  try {
    const tasksWithPids = await getTasksWithPids();
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
    log.error('Process list error', err);
    res.json([]);
  }
}));

app.post('/api/processes/:pid/kill', (req, res) => {
  const pid = parseInt(req.params.pid);
  if (killProcessByPid(pid)) {
    res.json({ success: true });
  } else {
    res.status(400).json({ error: `Failed to kill process ${pid}` });
  }
});

app.post('/api/processes/kill-old', asyncHandler(async (_req, res) => {
  const tasksWithPids = await getTasksWithPids();
  const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

  let killed = 0;
  for (const task of tasksWithPids) {
    const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : Date.now();
    if (startedAt < twoHoursAgo && task.pid && killProcessByPid(task.pid, true)) {
      killed++;
    }
  }
  res.json({ success: true, message: `Killed ${killed} Orch process(es) older than 2 hours` });
}));

app.post('/api/processes/kill-all', asyncHandler(async (_req, res) => {
  const tasksWithPids = await getTasksWithPids();
  let killed = 0;
  for (const task of tasksWithPids) {
    if (task.pid && killProcessByPid(task.pid, true)) {
      killed++;
    }
  }
  res.json({ success: true, message: `Killed ${killed} Orch process(es)` });
}));

app.get('/api/repos', (_req, res) => {
  const repos = getScannedRepos();
  const mapping = getEffectiveRepoMapping();
  res.json({ repos, mapping });
});

// GitHub org repos - hardcoded to bluebillywig org (10min cache)
let orgReposCache: { data: any; expiry: number } | null = null;
const ORG_REPOS_TTL = 10 * 60 * 1000;

app.get('/api/github/org-repos', asyncHandler(async (req, res) => {
  const refresh = req.query.refresh === 'true';
  const now = Date.now();
  if (!refresh && orgReposCache && now < orgReposCache.expiry) {
    res.json(orgReposCache.data);
    return;
  }
  try {
    const data = await listOrgRepos(config.github.org || 'bluebillywig', { per_page: 100, sort: 'updated' });
    const localRepos = getScannedRepos();
    const localNames = new Set(localRepos.map(r => r.localName));
    // Also match bare names for .workspaces/clones/ entries
    for (const r of localRepos) {
      if (r.localName.startsWith('.workspaces/clones/')) {
        localNames.add(r.localName.slice('.workspaces/clones/'.length));
      }
    }
    const repos = data.map(r => ({
      name: r.name,
      full_name: r.full_name,
      clone_url: r.clone_url,
      description: r.description || undefined,
      isLocal: localNames.has(r.name),
    }));
    orgReposCache = { data: repos, expiry: Date.now() + ORG_REPOS_TTL };
    res.json(repos);
  } catch (err: any) {
    const msg = err?.response?.data?.message || err?.message || String(err);
    log.error('Failed to fetch org repos', err);
    res.status(500).json({ error: `Failed to fetch org repos: ${msg}` });
  }
}));

app.post('/api/repos/clone', (req, res) => {
  const { cloneUrl, targetName } = req.body;
  if (!cloneUrl || !targetName) {
    res.status(400).json({ success: false, error: 'cloneUrl and targetName required' });
    return;
  }
  // Validate URL format
  try {
    const url = new URL(cloneUrl);
    if (!['http:', 'https:', 'git:'].includes(url.protocol)) {
      res.status(400).json({ success: false, error: 'Invalid clone URL protocol' });
      return;
    }
  } catch {
    res.status(400).json({ success: false, error: 'Invalid clone URL' });
    return;
  }
  // Sanitize targetName - no path separators or traversal
  if (targetName.includes('/') || targetName.includes('\\') || targetName.includes('..')) {
    res.status(400).json({ success: false, error: 'Invalid target name' });
    return;
  }
  const clonedPath = cloneRepo(cloneUrl, targetName);
  if (clonedPath) {
    res.json({ success: true, path: clonedPath });
  } else {
    res.status(500).json({ success: false, error: 'Clone failed' });
  }
});

// Terminal configuration
app.get('/api/system/terminals', (_req, res) => {
  const terminals = detectAvailableTerminals();
  res.json(terminals);
});

app.get('/api/config/terminal', (_req, res) => {
  const preferred = getTerminalPreference();
  const interactiveSession = getTerminalInteractiveSession();
  const terminals = detectAvailableTerminals();
  res.json({ preferred, interactiveSession, terminals });
});

app.post('/api/config/terminal', (req, res) => {
  const { terminal, interactiveSession } = req.body as { terminal?: string; interactiveSession?: boolean };

  if (terminal === undefined && interactiveSession === undefined) {
    res.status(400).json({ error: 'terminal or interactiveSession is required' });
    return;
  }

  if (terminal !== undefined) {
    const validTerminals = new Set<TerminalId>(getKnownTerminals().map(t => t.id));
    if (!validTerminals.has(terminal as TerminalId)) {
      res.status(400).json({ error: 'Invalid terminal id' });
      return;
    }
    setTerminalPreference(terminal as TerminalId);
  }

  if (interactiveSession !== undefined) {
    if (typeof interactiveSession !== 'boolean') {
      res.status(400).json({ error: 'interactiveSession must be boolean' });
      return;
    }
    setTerminalInteractiveSession(interactiveSession);
  }

  res.json({
    success: true,
    preferred: getTerminalPreference(),
    interactiveSession: getTerminalInteractiveSession(),
  });
});

// Credentials config (reads/writes .env file)
const envPath = process.env.ENV_FILE_PATH || join(__dirname, '..', '..', '.env');

function readEnvLines(): string[] {
  try {
    return readFileSync(envPath, 'utf-8').split('\n');
  } catch {
    return [];
  }
}

function parseEnvLines(lines: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return vars;
}

function writeEnvFile(existingLines: string[], vars: Record<string, string>) {
  const remaining = { ...vars };
  const lines: string[] = [];
  for (const line of existingLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) { lines.push(line); continue; }
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) { lines.push(line); continue; }
    const key = trimmed.slice(0, eqIdx);
    if (key in remaining) {
      lines.push(`${key}=${remaining[key]}`);
      delete remaining[key];
    } else {
      lines.push(line);
    }
  }
  for (const [key, val] of Object.entries(remaining)) {
    lines.push(`${key}=${val}`);
  }
  writeFileSync(envPath, lines.join('\n'));
}

const credentialKeys = ['GITHUB_TOKEN', 'ADO_PAT', 'ADO_ORG', 'ADO_PROJECT', 'ADO_TEAM'] as const;

const configUpdaters: Record<string, (val: string) => void> = {
  ADO_PAT: (v) => { config.ado.pat = v; },
  ADO_ORG: (v) => { config.ado.organization = v; },
  ADO_PROJECT: (v) => { config.ado.project = v; },
  ADO_TEAM: (v) => { config.ado.team = v; },
  GITHUB_TOKEN: (v) => { config.github.token = v; },
};

app.get('/api/config/credentials', (_req, res) => {
  const env = parseEnvLines(readEnvLines());
  const result: Record<string, string> = {};
  for (const key of credentialKeys) {
    const val = env[key] || '';
    if ((key.includes('PAT') || key.includes('TOKEN')) && val.length > 4) {
      result[key] = '***' + val.slice(-4);
    } else {
      result[key] = val;
    }
  }
  res.json(result);
});

app.post('/api/config/credentials', (req, res) => {
  const updates = req.body as Record<string, string>;
  const lines = readEnvLines();
  const env = parseEnvLines(lines);
  let changed = false;
  for (const key of credentialKeys) {
    if (key in updates && typeof updates[key] === 'string') {
      const val = updates[key].trim();
      if (val.startsWith('***')) continue;
      env[key] = val;
      process.env[key] = val;
      configUpdaters[key]?.(val);
      changed = true;
    }
  }
  if (changed) {
    writeEnvFile(lines, env);
  }
  res.json({ success: true });
});

// GitHub OAuth Device Flow
app.get('/api/auth/github/status', (_req, res) => {
  res.json({
    authenticated: !!config.github.token,
    clientIdConfigured: !!config.github.clientId,
  });
});

app.post('/api/auth/github/device', asyncHandler(async (_req, res) => {
  if (!config.github.clientId) {
    res.status(400).json({ error: 'GITHUB_OAUTH_CLIENT_ID not configured' });
    return;
  }
  try {
    const resp = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: config.github.clientId, scope: 'repo read:user' }),
    });
    const data = await resp.json();
    if (!resp.ok) { res.status(resp.status).json(data); return; }
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}));

app.post('/api/auth/github/poll', asyncHandler(async (req, res) => {
  const { device_code } = req.body;
  if (!device_code || typeof device_code !== 'string' || !config.github.clientId) {
    res.status(400).json({ error: 'Missing device_code or client_id' });
    return;
  }
  try {
    const resp = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: config.github.clientId,
        device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = await resp.json();
    if (data.error === 'authorization_pending') {
      res.json({ status: 'pending' });
    } else if (data.error === 'slow_down') {
      res.json({ status: 'slow_down' });
    } else if (data.error === 'expired_token') {
      res.json({ status: 'expired' });
    } else if (data.error === 'access_denied') {
      res.json({ status: 'denied' });
    } else if (data.access_token) {
      const token = String(data.access_token).replace(/[\r\n]/g, '');
      const lines = readEnvLines();
      const env = parseEnvLines(lines);
      env.GITHUB_TOKEN = token;
      process.env.GITHUB_TOKEN = token;
      config.github.token = token;
      writeEnvFile(lines, env);
      res.json({ status: 'complete' });
    } else {
      res.json({ status: 'error', error: data.error_description || data.error || 'Unknown error' });
    }
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}));

const validOwnerFilters: OwnerFilter[] = ['my', 'unassigned', 'all'];

app.get('/api/workitems', asyncHandler(async (req, res) => {
  const owner = (req.query.owner as string) || 'my';
  if (!validOwnerFilters.includes(owner as OwnerFilter)) {
    res.status(400).json({ error: 'owner must be my|unassigned|all' });
    return;
  }
  const items = await getWorkItemsBySprints(owner as OwnerFilter);
  res.json(items);
}));

app.get('/api/my/prs', asyncHandler(async (req, res) => {
  const refresh = req.query.refresh === 'true';
  const prs = await getMyGitHubPRs(refresh);
  res.json(prs);
}));

app.get('/api/my/workitems', asyncHandler(async (_req, res) => {
  const items = await getMyAdoWorkItems();
  res.json(items);
}));

app.get('/api/my/resolved-workitems', asyncHandler(async (_req, res) => {
  const items = await getMyResolvedWorkItems();
  res.json(items);
}));

app.get('/api/my/resolved-with-comments', asyncHandler(async (req, res) => {
  const refresh = req.query.refresh === 'true';
  const items = await getResolvedWithPRComments(refresh);
  res.json(items);
}));

app.get('/api/sprint/reviewed-items', asyncHandler(async (_req, res) => {
  const result = await getReviewedItemsInSprint();
  res.json(result);
}));

app.get('/api/team/members', asyncHandler(async (_req, res) => {
  const members = await getTeamMembers();
  res.json(members);
}));

app.get('/api/ado/me', asyncHandler(async (_req, res) => {
  const user = await getCurrentAdoUser();
  if (!user) {
    res.status(404).json({ error: 'Could not get current ADO user' });
    return;
  }
  res.json(user);
}));

let usageCache: { data: unknown; ts: number } | null = null;
let usageErrorCache: { status: number; ts: number } | null = null;
const USAGE_CACHE_MS = 60_000; // 1 minute
const USAGE_ERROR_CACHE_MS = 5 * 60_000; // 5 minutes for error backoff

function wrapUsageResponse(data: unknown, ts: number) {
  return { ...(data as Record<string, unknown>), updatedAt: new Date(ts).toISOString() };
}

app.get('/api/claude/usage', asyncHandler(async (_req, res) => {
  try {
    if (usageCache && Date.now() - usageCache.ts < USAGE_CACHE_MS) {
      return res.json(wrapUsageResponse(usageCache.data, usageCache.ts));
    }
    // Back off on recent upstream errors — return stale data if available
    if (usageErrorCache && Date.now() - usageErrorCache.ts < USAGE_ERROR_CACHE_MS) {
      if (usageCache) {
        return res.json(wrapUsageResponse(usageCache.data, usageCache.ts));
      }
      res.status(usageErrorCache.status).json({ error: `API error: ${usageErrorCache.status} (backoff)` });
      return;
    }
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
      usageErrorCache = { status: resp.status, ts: Date.now() };
      // Return stale data on error if available
      if (usageCache) {
        return res.json(wrapUsageResponse(usageCache.data, usageCache.ts));
      }
      res.status(resp.status).json({ error: `API error: ${resp.status}` });
      return;
    }
    usageErrorCache = null;
    const usage = await resp.json();
    const now = Date.now();
    usageCache = { data: usage, ts: now };
    res.json(wrapUsageResponse(usage, now));
  } catch (err) {
    // Return stale data on error if available
    if (usageCache) {
      return res.json(wrapUsageResponse(usageCache.data, usageCache.ts));
    }
    res.status(500).json({ error: String(err) });
  }
}));

// Trigger actions from dashboard
app.post('/api/actions/review-pr', asyncHandler(async (req, res) => {
  const { repo, prNumber, source, title, url, branch, baseBranch } = req.body;
  const resolved = resolveRepoPath(repo) ?? autoClone(repo, source || 'github');

  if (!resolved) {
    res.status(400).json({ error: `No local mapping for repo: ${repo}` });
    return;
  }

  const task = await createTask('pr-review', repo, resolved.repoPath, {
    source: source || 'github',
    event: 'manual.pr-review',
    prNumber,
    title,
    url,
    branch,
    baseBranch,
  });
  triggerUpdate();
  await broadcastTasks();
  res.json({ taskId: task.id, message: 'PR review task created' });
}));

app.post('/api/actions/checkout-pr-worktree', asyncHandler(async (req, res) => {
  const { repo, branch } = req.body as { repo: string; prNumber: number; branch?: string };
  const prNumber = Number(req.body.prNumber);
  if (!repo || !prNumber || prNumber < 1 || !Number.isInteger(prNumber)) {
    res.status(400).json({ error: 'repo and valid prNumber are required' }); return;
  }
  try {
    const resolved = resolveRepoPath(repo) ?? autoClone(repo, 'github');
    if (!resolved) { res.status(400).json({ error: `No local mapping for repo: ${repo}` }); return; }

    const worktreePath = checkoutPRInWorktree(resolved.repoPath, prNumber, branch);
    if (!worktreePath) { res.status(500).json({ error: 'Failed to create worktree' }); return; }
    sendShellResult(res, await openShellAtPath(worktreePath, `PR #${prNumber}`));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}));

app.post('/api/actions/analyze-workitem', asyncHandler(async (req, res) => {
  const { id, title, project, url, type, repositories } = req.body;
  const repoMapping = getEffectiveRepoMapping();

  // Try Repository field first
  let repoPath: string | null = null;
  let repoName = '';
  const fromField = resolveFromRepositoryField(repositories);
  if (fromField) {
    repoPath = fromField.repoPath;
    repoName = fromField.repoName;
    log.info(`analyze-workitem: Resolved from Repository field: ${repoName}`);
  }

  // Fallback: find a repo for this project
  if (!repoPath && project) {
    for (const [remote, local] of Object.entries(repoMapping)) {
      if (remote.toLowerCase().includes(project.toLowerCase())) {
        const candidate = resolveLocalRepo(local);
        if (candidate) {
          repoPath = candidate;
          repoName = remote;
          log.info(`analyze-workitem: Found by project: ${remote} -> ${local}`);
          break;
        }
      }
    }
  }

  if (!repoPath) {
    const cloned = autoCloneFromRepositories(repositories, project);
    if (cloned) { repoPath = cloned.repoPath; repoName = cloned.repoName; }
  }

  if (!repoPath) {
    res.status(400).json({ error: 'No repo found for this work item. Set the Repository field in ADO or clone the repo.' });
    return;
  }

  const taskType = type?.toLowerCase().includes('bug') ? 'issue-fix' : 'code-gen';
  const task = await createTask(taskType, repoName, repoPath, {
    source: 'ado',
    event: 'manual.workitem',
    workItemId: id,
    title,
    url,
  });
  triggerUpdate();
  await broadcastTasks();
  res.json({ taskId: task.id, message: `${taskType} task created` });
}));

app.post('/api/actions/fix-pr-comments', asyncHandler(async (req, res) => {
  const { repo, prNumber, source, title, url, branch, baseBranch } = req.body;
  const resolved = resolveRepoPath(repo) ?? autoClone(repo, source || 'github');

  if (!resolved) {
    res.status(400).json({ error: `No local mapping for repo: ${repo}` });
    return;
  }

  const [owner, repoName] = repo.split('/');

  let headBranch = branch;
  let baseBranchRef = baseBranch;
  let headRepo: string | undefined;

  try {
    const prData = await getPull(owner, repoName, prNumber);
    headBranch = headBranch || prData.head.ref;
    baseBranchRef = baseBranchRef || prData.base.ref;
    headRepo = prData.head.repo?.full_name;
    log.info(`fix-pr-comments: Fetched branch info: ${headBranch} -> ${baseBranchRef} (head: ${headRepo})`);
  } catch (err) {
    if (!headBranch) {
      log.error('fix-pr-comments: Failed to fetch PR branch info:', err);
      res.status(400).json({ error: 'Failed to fetch PR branch info' });
      return;
    }
  }

  try {
    const user = await getAuthenticatedUser();
    const comments = await listPullReviewComments(owner, repoName, prNumber);

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

    const task = await createTask('pr-comment-fix', repo, resolved.repoPath, {
      source: source || 'github',
      event: 'manual.fix-pr-comments',
      prNumber,
      title,
      url,
      branch: headBranch,
      baseBranch: baseBranchRef,
      headRepo,
      reviewComments,
    });

    triggerUpdate();
    await broadcastTasks();
    res.json({ taskId: task.id, message: `PR comment fix task created (${unresolvedComments.length} comments)` });
  } catch (err) {
    log.error('fix-pr-comments failed', err);
    res.status(500).json({ error: 'Failed to fetch review comments' });
  }
}));

app.post('/api/actions/test-workitem', asyncHandler(async (req, res) => {
  const { id, title, project, url, githubPrUrl, testNotes, body, repositories, selectedRepo } = req.body;
  const repoMapping = getEffectiveRepoMapping();

  log.info(`test-workitem: Project: ${project}, PR URL: ${githubPrUrl}, Selected: ${selectedRepo}`);

  let repoPath: string | null = null;
  let repoName = '';
  let remoteOnly = false;
  let ghRepoRef = '';

  // Use selectedRepo if provided
  if (selectedRepo) {
    const resolved = resolveRepoPath(selectedRepo);
    if (resolved) {
      repoPath = resolved.repoPath;
      repoName = selectedRepo;
      log.info(`test-workitem: Using selected repo: ${selectedRepo}`);
    }
  }

  // Try Repository field
  if (!repoPath) {
    const fromField = resolveFromRepositoryField(repositories);
    if (fromField) {
      repoPath = fromField.repoPath;
      repoName = fromField.repoName;
      log.info(`test-workitem: Resolved from Repository field: ${repoName}`);
    }
  }

  // Try to find repo from GitHub PR URL
  if (!repoPath && githubPrUrl) {
    const prMatch = githubPrUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull/);
    if (prMatch) {
      const ghRepo = prMatch[1];
      ghRepoRef = ghRepo; // Store for remote-only mode
      const resolved = resolveRepoPath(ghRepo);
      if (resolved) {
        repoPath = resolved.repoPath;
        repoName = ghRepo;
        log.info(`test-workitem: Found mapping for ${ghRepo}`);
      }
    }
  }

  // Fallback to project-based lookup
  if (!repoPath && project) {
    for (const [remote, local] of Object.entries(repoMapping)) {
      if (remote.toLowerCase().includes(project.toLowerCase())) {
        const candidate = resolveLocalRepo(local);
        if (candidate) {
          repoPath = candidate;
          repoName = remote;
          log.info(`test-workitem: Found by project: ${remote} -> ${local}`);
          break;
        }
      }
    }
  }

  // Auto-clone fallback before remote-only mode
  if (!repoPath) {
    const cloned = autoCloneFromRepositories(repositories, project)
      ?? (ghRepoRef ? autoClone(ghRepoRef, 'github') : null);
    if (cloned) { repoPath = cloned.repoPath; repoName = cloned.repoName; }
  }

  // Remote-only fallback: no local repo - use base dir and work from PR URL or ADO info only
  if (!repoPath) {
    if (!existsSync(config.repos.baseDir)) {
      res.status(400).json({ error: 'Cannot proceed: base directory does not exist' });
      return;
    }
    remoteOnly = true;
    repoPath = config.repos.baseDir;
    repoName = ghRepoRef || project || 'unknown';
    const mode = ghRepoRef ? `remote-only for ${ghRepoRef}` : 'ADO-only (no PR URL)';
    log.info(`test-workitem: ${mode}`);
  }

  const task = await createTask('testing', repoName, repoPath, {
    source: 'ado',
    event: 'manual.testing',
    workItemId: id,
    title,
    url,
    body,
    prUrl: githubPrUrl,
    testNotes,
    remoteOnly,
    ghRepoRef: remoteOnly ? ghRepoRef : undefined,
  });
  triggerUpdate();
  await broadcastTasks();
  const mode = remoteOnly ? ' (remote-only mode)' : '';
  res.json({ taskId: task.id, message: `Testing task created${mode} - terminal will open shortly` });
}));

app.post('/api/actions/review-resolution', asyncHandler(async (req, res) => {
  const { id, title, project, url, resolution, githubPrUrl, testNotes, body, repositories } = req.body;
  const repoMapping = getEffectiveRepoMapping();

  log.info(`review-resolution: Project: ${project}, PR URL: ${githubPrUrl}`);

  let repoPath: string | null = null;
  let repoName = '';

  // Try Repository field first
  const fromField = resolveFromRepositoryField(repositories);
  if (fromField) {
    repoPath = fromField.repoPath;
    repoName = fromField.repoName;
    log.info(`review-resolution: Resolved from Repository field: ${repoName}`);
  }

  // Try to find repo from GitHub PR URL
  if (!repoPath && githubPrUrl) {
    const prMatch = githubPrUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull/);
    if (prMatch) {
      const ghRepo = prMatch[1];
      const resolved = resolveRepoPath(ghRepo);
      if (resolved) {
        repoPath = resolved.repoPath;
        repoName = ghRepo;
        log.info(`review-resolution: Found mapping for ${ghRepo}`);
      }
    }
  }

  // Fallback to project-based lookup
  if (!repoPath && project) {
    for (const [remote, local] of Object.entries(repoMapping)) {
      if (remote.toLowerCase().includes(project.toLowerCase())) {
        const candidate = resolveLocalRepo(local);
        if (candidate) {
          repoPath = candidate;
          repoName = remote;
          log.info(`review-resolution: Found by project: ${remote} -> ${local}`);
          break;
        }
      }
    }
  }

  if (!repoPath) {
    const ghRepo = githubPrUrl?.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1];
    const cloned = autoCloneFromRepositories(repositories, project)
      ?? (ghRepo ? autoClone(ghRepo, 'github') : null);
    if (cloned) { repoPath = cloned.repoPath; repoName = cloned.repoName; }
  }

  if (!repoPath) {
    const hint = githubPrUrl ? 'for GitHub repo from PR URL' : `for project "${project}"`;
    res.status(400).json({ error: `No local repo mapping found ${hint}. Clone the repo or add manual mapping.` });
    return;
  }

  const task = await createTask('resolution-review', repoName, repoPath, {
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
  await broadcastTasks();
  res.json({ taskId: task.id, message: 'Resolution review task created' });
}));

// --- Videoscan API ---

app.post('/api/actions/start-videoscan', asyncHandler(async (req, res) => {
  const { url, maxPages, concurrency, delay } = req.body;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'url required' });
    return;
  }
  try { new URL(url); } catch { res.status(400).json({ error: 'Invalid URL' }); return; }

  const task = await createTask('videoscan', url, getVideoscanDir(), {
    source: 'github', // placeholder — videoscan has no source
    event: 'videoscan',
    title: `Videoscan: ${new URL(url).hostname}`,
    scanUrl: url,
    maxPages: maxPages || 50,
    concurrency: concurrency || 6,
    delay: delay ?? 200,
  });
  triggerUpdate();
  await broadcastTasks();
  res.json({ taskId: task.id, message: `Videoscan task #${task.id} created` });
}));

app.post('/api/actions/resume-videoscan', asyncHandler(async (req, res) => {
  const { filename, maxPages, concurrency, delay } = req.body;
  if (!filename || typeof filename !== 'string') {
    res.status(400).json({ error: 'filename required' });
    return;
  }
  // Prevent path traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }
  const resumePath = join(getVideoscanDir(), filename);
  if (!existsSync(resumePath)) {
    res.status(404).json({ error: 'Scan file not found' });
    return;
  }
  let scanData: { domain?: string };
  try { scanData = JSON.parse(readFileSync(resumePath, 'utf-8')); } catch { res.status(400).json({ error: 'Invalid JSON file' }); return; }
  const domain = scanData.domain || 'unknown';
  const scanUrl = `https://www.${domain}`;

  const task = await createTask('videoscan', scanUrl, getVideoscanDir(), {
    source: 'github',
    event: 'videoscan-resume',
    title: `Resume videoscan: ${domain}`,
    scanUrl,
    maxPages: maxPages || 200,
    concurrency: concurrency || 6,
    resumeFile: resumePath,
    delay: delay ?? 200,
  });
  triggerUpdate();
  await broadcastTasks();
  res.json({ taskId: task.id, message: `Resume task #${task.id} created` });
}));

app.get('/api/videoscans', (_req, res) => {
  res.json(listScans());
});

app.post('/api/videoscans/merge', (req, res) => {
  const { filenames } = req.body;
  if (!Array.isArray(filenames) || filenames.length < 2) {
    res.status(400).json({ error: 'Need at least 2 filenames to merge' });
    return;
  }
  try {
    const result = mergeScans(filenames);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/videoscans/files/:filename', (req, res) => {
  const { filename } = req.params;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }
  const filePath = join(getVideoscanDir(), filename);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  if (filename.endsWith('.html')) {
    res.type('html').sendFile(filePath);
  } else if (filename.endsWith('.json')) {
    res.type('json').sendFile(filePath);
  } else if (filename.endsWith('.pdf')) {
    res.type('pdf').sendFile(filePath);
  } else {
    res.status(400).json({ error: 'Unsupported file type' });
  }
});

app.post('/api/videoscans/generate-report', asyncHandler(async (req, res) => {
  const { filename } = req.body;
  if (!filename || typeof filename !== 'string') {
    res.status(400).json({ error: 'filename required' });
    return;
  }
  const result = await generateReport(filename);
  res.json(result);
}));

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { fields.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  fields.push(current.trim());
  return fields;
}

function ensureHttp(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

app.post('/api/videoscans/import-digitoegankelijk', asyncHandler(async (req, res) => {
  const { id } = req.body;
  if (!Number.isInteger(id) || id < 1 || id > 999999) {
    res.status(400).json({ error: 'id must be a positive integer' });
    return;
  }

  const csvUrl = `https://dashboard.digitoegankelijk.nl/organisaties/download/${id}`;
  const csvRes = await fetch(csvUrl, { signal: AbortSignal.timeout(15_000) });
  if (!csvRes.ok) {
    res.status(502).json({ error: `Failed to fetch CSV: HTTP ${csvRes.status}` });
    return;
  }
  const MAX_CSV_SIZE = 5 * 1024 * 1024;
  const contentLength = parseInt(csvRes.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_CSV_SIZE) {
    res.status(413).json({ error: 'CSV too large' });
    return;
  }
  const csvText = await csvRes.text();
  if (csvText.length > MAX_CSV_SIZE) {
    res.status(413).json({ error: 'CSV too large' });
    return;
  }
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) {
    res.status(400).json({ error: 'CSV has no data rows' });
    return;
  }

  const headers = parseCsvLine(lines[0]);
  const nameIdx = headers.findIndex(h => /^naam/i.test(h));
  const urlIdx = headers.findIndex(h => /^url/i.test(h));
  const typeIdx = headers.findIndex(h => /site of app/i.test(h));
  const statusIdx = headers.findIndex(h => /^status/i.test(h));

  if (urlIdx === -1) {
    res.status(400).json({ error: 'CSV missing URL column' });
    return;
  }

  let skippedApps = 0;
  const sites: { name: string; url: string; status: string; rootDomain: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (typeIdx !== -1 && /app/i.test(fields[typeIdx] || '')) {
      skippedApps++;
      continue;
    }
    const siteUrl = fields[urlIdx] || '';
    if (!siteUrl) continue;
    let hostname: string;
    try { hostname = new URL(ensureHttp(siteUrl)).hostname; } catch { continue; }
    const parts = hostname.replace(/^www\./, '').split('.');
    const rootDomain = parts.length >= 2 ? parts.slice(-2).join('.') : hostname;
    sites.push({
      name: nameIdx !== -1 ? (fields[nameIdx] || '') : '',
      url: ensureHttp(siteUrl),
      status: statusIdx !== -1 ? (fields[statusIdx] || '') : '',
      rootDomain,
    });
  }

  // Group by root domain
  const groupMap = new Map<string, typeof sites>();
  for (const site of sites) {
    if (!groupMap.has(site.rootDomain)) groupMap.set(site.rootDomain, []);
    groupMap.get(site.rootDomain)!.push(site);
  }

  const groups = [...groupMap.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([rootDomain, domainSites]) => ({
      rootDomain,
      sites: domainSites.map(({ name, url, status }) => ({ name, url, status })),
    }));

  const orgName = sites.length > 0 && sites[0].name ? sites[0].name.split(' - ')[0].split(' \u2013 ')[0].trim() : `Organisation ${id}`;

  res.json({ orgName, totalSites: sites.length, skippedApps, groups });
}));

// --- Orchestrator API ---

app.post('/api/orchestrate', asyncHandler(async (_req, res) => {
  const orchState = getOrchestratorState();
  if (orchState.status === 'gathering' || orchState.status === 'analyzing') {
    return res.status(409).json({ error: 'Orchestrator already running' });
  }
  try {
    // Don't await — let it run in background
    runOrchestrator().catch(err => log.error('Orchestrator error', err));
    res.json({ message: 'Orchestration started', runId: getOrchestratorState().runId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}));

app.get('/api/orchestrator/state', (_req, res) => {
  res.json(getOrchestratorState());
});

app.post('/api/orchestrator/:id/accept', asyncHandler(async (req, res) => {
  const result = await acceptAction(req.params.id);
  if (!result) return res.status(404).json({ error: 'Action not found or already handled' });
  await broadcastTasks();
  res.json(result);
}));

app.post('/api/orchestrator/:id/dismiss', asyncHandler(async (req, res) => {
  const reason = req.body?.reason;
  const ok = await dismissAction(req.params.id, reason);
  if (!ok) return res.status(404).json({ error: 'Action not found or already handled' });
  res.json({ ok: true });
}));

app.get('/api/orchestrator/rules', asyncHandler(async (_req, res) => {
  const rules = await loadOrchestratorRules();
  res.json({ rules });
}));

app.post('/api/orchestrator/rules', asyncHandler(async (req, res) => {
  const { rules } = req.body;
  if (typeof rules !== 'string') return res.status(400).json({ error: 'rules string required' });
  await saveOrchestratorRules(rules);
  res.json({ ok: true });
}));

app.post('/api/orchestrator/chat', asyncHandler(async (req, res) => {
  const { question } = req.body;
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question required' });
  }
  try {
    const answer = await runChatQuery(question);
    res.json({ answer });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}));

// Notifications
const notificationLogPath = join(homedir(), '.claude', 'notification-log.jsonl');

// Errors API
app.get('/api/errors', (_req, res) => {
  const limit = parseInt(String((_req as any).query?.limit)) || 50;
  res.json(getRecentErrors(limit));
});

app.get('/api/notifications', asyncHandler(async (_req, res) => {
  try {
    if (isSupabaseConfigured()) {
      const entries = await dbGetNotifications(200);
      // Flatten data back into top-level for compatibility
      res.json(entries.map(e => ({ id: e.id, type: e.type, timestamp: e.created_at, ...e.data })));
      return;
    }
    if (!existsSync(notificationLogPath)) return res.json([]);
    const content = await readFile(notificationLogPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    const entries = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < 200; i--) {
      try { entries.push(JSON.parse(lines[i])); } catch {}
    }
    res.json(entries);
  } catch {
    res.json([]);
  }
}));

app.post('/api/notifications/incoming', asyncHandler(async (req, res) => {
  const notification = req.body;
  if (!notification || typeof notification.id !== 'string' || !notification.type || !notification.timestamp) {
    return res.status(400).json({ error: 'invalid notification' });
  }
  // Persist to DB or JSONL
  if (isSupabaseConfigured()) {
    try { await dbInsertNotification(notification); } catch (err) { log.error('Failed to insert notification to DB', err); }
  } else {
    try { appendFileSync(notificationLogPath, JSON.stringify(notification) + '\n'); } catch {}
  }
  // Broadcast to WebSocket clients
  const message = JSON.stringify({ type: 'notification', notification });
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
  res.json({ ok: true });
}));

// SPA catch-all: serve index.html for non-API routes (client-side routing)
if (hasDashboardBuild) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) return next();
    res.sendFile(dashboardIndexPath);
  });
}

// Error middleware (must be after all routes)
app.use(expressErrorMiddleware);

// Start server
installProcessHandlers();
server.listen(config.server.port, () => {
  log.info(`Orch server listening on port ${config.server.port}`);
  log.info(`Dashboard: http://localhost:${config.server.port}`);
  log.info(`GitHub webhooks: http://localhost:${config.server.port}/webhooks/github`);
  log.info(`ADO webhooks: http://localhost:${config.server.port}/webhooks/ado`);

  // Log discovered repos
  if (config.repos.autoScan) {
    const repos = getScannedRepos();
    log.info(`Discovered ${repos.length} repos:`);
    for (const repo of repos) {
      const icon = repo.source === 'github' ? '🐙' : repo.source === 'ado' ? '🔷' : '❓';
      log.info(`  ${icon} ${repo.remote || repo.localName} -> ${repo.localName}`);
    }
  }

  setTaskUpdateCallback(() => { broadcastTasks().catch(err => log.error('broadcastTasks error', err)); });
  setOutputCallback(broadcastOutput);

  // Initialize settings from DB, then start processor
  initSettings()
    .then(() => startProcessor())
    .catch(err => log.error('Startup error', err));

  // Wire orchestrator broadcasts
  setOrchestratorUpdateCallback((orchState) => {
    const message = JSON.stringify({ type: 'orchestrator', state: orchState });
    clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    });
  });

  // Wire notification getter for orchestrator context
  setNotificationGetter(() => {
    try {
      if (!existsSync(notificationLogPath)) return [];
      const content = readFileSync(notificationLogPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const entries: any[] = [];
      for (let i = lines.length - 1; i >= 0 && entries.length < 20; i--) {
        try { entries.push(JSON.parse(lines[i])); } catch {}
      }
      return entries;
    } catch { return []; }
  });

  if (config.polling.enabled) {
    startPoller(config.polling.intervalMs).catch(err => log.error('Poller start error', err));
  }

  startNtfyListener();
});
