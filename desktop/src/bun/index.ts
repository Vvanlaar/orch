import { BrowserWindow, PATHS } from "electrobun/bun";
import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const port = process.env.PORT || "3011";
const SERVER_URL = `http://localhost:${port}`;

// Configure paths for desktop mode
process.env.DASHBOARD_DIR = join(PATHS.RESOURCES_FOLDER, "dashboard");
process.env.DESKTOP_MODE = "true";

// ~/.orch/.env for credentials (writable location outside app bundle)
const orchDir = join(homedir(), ".orch");
if (!existsSync(orchDir)) mkdirSync(orchDir, { recursive: true });
process.env.ENV_FILE_PATH = join(orchDir, ".env");

async function waitForServer(url: string, timeoutMs = 15000): Promise<void> {
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
    await Bun.sleep(200);
  }
  throw new Error(`Server failed to start within ${timeoutMs}ms`);
}

function showErrorWindow(err: unknown): void {
  const errMsg = err instanceof Error ? err.message : String(err);
  const safe = errMsg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = [
    "<html><body style='font-family:sans-serif;padding:2em'>",
    "<h1>Orch failed to start</h1>",
    `<pre>${safe}</pre>`,
    "</body></html>",
  ].join("");

  try {
    new BrowserWindow({
      title: "Orch - Error",
      url: `data:text/html,${html}`,
      width: 600,
      height: 400,
    });
  } catch {
    // nothing more we can do
  }
}

try {
  // Static import -- Bun.build() bundles all deps at build time
  await import("../../../src/server/index.ts");
  await waitForServer(SERVER_URL);

  new BrowserWindow({
    title: "Orch",
    url: SERVER_URL,
    width: 1280,
    height: 800,
  });
} catch (err) {
  console.error("[Orch Desktop] Fatal error:", err);
  showErrorWindow(err);
}
