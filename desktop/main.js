import { app, BrowserWindow, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// macOS/Linux: Electron doesn't inherit shell PATH — fix it before spawning child processes
if (process.platform !== 'win32') {
  const shellPaths = [
    '/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin',
    join(homedir(), '.local', 'bin'), join(homedir(), '.npm-global', 'bin'),
    join(homedir(), '.nvm', 'versions', 'node'),
  ];
  const current = process.env.PATH || '';
  const missing = shellPaths.filter(p => !current.includes(p) && existsSync(p));
  if (missing.length) process.env.PATH = [...missing, current].join(':');

  // Also try sourcing the real PATH from user's shell
  try {
    const { execSync } = await import('child_process');
    const shellPath = execSync('bash -ilc "echo $PATH"', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (shellPath) process.env.PATH = shellPath;
  } catch { /* fallback to static paths */ }
}

// Configure paths for desktop mode
process.env.DASHBOARD_DIR = join(__dirname, 'dashboard');
process.env.DESKTOP_MODE = 'true';

// ~/.orch/.env for credentials (writable location outside app bundle)
const orchDir = join(homedir(), '.orch');
if (!existsSync(orchDir)) mkdirSync(orchDir, { recursive: true });
const envFilePath = join(orchDir, '.env');
process.env.ENV_FILE_PATH = envFilePath;

// Load saved credentials into process.env before server import
if (existsSync(envFilePath)) {
  for (const line of readFileSync(envFilePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const port = process.env.PORT || '13011';
process.env.PORT = port;
const SERVER_URL = `http://localhost:${port}`;

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        await res.text();
        return;
      }
    } catch {
      // server not ready yet
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server failed to start within ${timeoutMs}ms`);
}

function showErrorWindow(err) {
  const errMsg = err instanceof Error ? err.message : String(err);
  const safe = errMsg.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = [
    '<html><body style="font-family:sans-serif;padding:2em">',
    '<h1>Orch failed to start</h1>',
    `<pre>${safe}</pre>`,
    '</body></html>',
  ].join('');

  const win = new BrowserWindow({ title: 'Orch - Error', width: 600, height: 400 });
  win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
}

app.whenReady().then(async () => {
  try {
    await import('./server/index.js');
    await waitForServer(SERVER_URL);

    const win = new BrowserWindow({ title: 'Orch', width: 1280, height: 800 });
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    win.loadURL(SERVER_URL);
  } catch (err) {
    console.error('[Orch Desktop] Fatal error:', err);
    showErrorWindow(err);
  }
});

app.on('window-all-closed', () => app.quit());
