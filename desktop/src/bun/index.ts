import { BrowserWindow, PATHS } from "electrobun/bun";
import { join } from "path";

const port = process.env.PORT || "3011";
const SERVER_URL = `http://localhost:${port}`;

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

// Start the Express server from bundled dist
const serverPath = join(PATHS.RESOURCES_FOLDER, "dist", "server", "index.js");
await import(serverPath);

await waitForServer(SERVER_URL);

const mainWindow = new BrowserWindow({
  title: "Orch",
  url: SERVER_URL,
  width: 1280,
  height: 800,
});
