import { app, BrowserWindow } from 'electron';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Configure paths for desktop mode
process.env.DASHBOARD_DIR = join(__dirname, 'dashboard');
process.env.DESKTOP_MODE = 'true';

// ~/.orch/.env for credentials (writable location outside app bundle)
const orchDir = join(homedir(), '.orch');
if (!existsSync(orchDir)) mkdirSync(orchDir, { recursive: true });
process.env.ENV_FILE_PATH = join(orchDir, '.env');

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
    win.loadURL(SERVER_URL);
  } catch (err) {
    console.error('[Orch Desktop] Fatal error:', err);
    showErrorWindow(err);
  }
});

app.on('window-all-closed', () => app.quit());
