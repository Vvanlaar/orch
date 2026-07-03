---
name: run-app
description: Launch and drive the orch app (Express server + Svelte/Vite dashboard) locally or on the LAN. Triggers on "run the app", "start the app", "start orch", "run orch", "launch the dashboard", "make it available on the network", or confirming a change works in the real app.
---

# Run the orch app

Two processes, started together by one `concurrently` script:

- **Server** — Express + WebSocket, port **3011**, binds `127.0.0.1` only.
- **Dashboard** — Svelte 5 + Vite SPA, port **3010**. Proxies `/api` and `/ws`
  to `127.0.0.1:3011` server-side, so the server never needs network binding.

Use `pnpm.cmd` (not `pnpm`) — bare `pnpm`/`npm` fail silently in Git Bash on
this machine.

## Local (localhost only)

```bash
cd /c/dev/orch && pnpm.cmd dev      # run in background
```

Open http://localhost:3010 . Vite binds the dashboard to IPv6 `[::1]:3010`, so
verify over `localhost`, not `127.0.0.1`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3010/        # 200
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3011/api/tasks  # 200
```

## On the network (LAN) — use `serve:prod` for colleagues

```bash
cd /c/dev/orch && pnpm.cmd serve:prod   # full build, then compiled server + vite preview
```

`serve:prod` is the colleague-facing path: it runs `pnpm build` (tsc server +
vite dashboard) then serves the **compiled** server (`node dist/server`, prod
mode — serves the static dist bundle, no tsx watch) plus the built dashboard
via `vite preview --host` on **:3010** (same URL/firewall as before). No HMR
websocket, so a LAN browser's console stays clean.

`serve:network` is the same topology but with the **dev** backend (`tsx watch`)
— use it only when you want the server to hot-reload while still serving a
prod-built dashboard over the LAN.

Avoid `dev:network` for sharing: its HMR socket can't reach a remote browser
and floods the client console with `WebSocket connection to
'ws://<host>:3010/' failed` / `[vite] failed to connect to websocket`. Use it
only for self-testing the LAN binding on the host machine.

The server stays on `127.0.0.1:3011`; the preview proxy bridges API/WS for LAN
clients, so only the dashboard is exposed. Find the LAN IP with
`ipconfig | grep IPv4` and open `http://<LAN-IP>:3010`.

After editing dashboard source, re-run `serve:network` to rebuild — preview
serves a static bundle and will NOT pick up changes live.

Verify:
```bash
netstat -ano | grep ":3010" | grep LISTEN              # expect 0.0.0.0:3010
curl -s http://localhost:3010/ | grep -c "@vite/client" # expect 0 (no HMR client)
curl -s -o /dev/null -w "%{http_code}\n" http://<LAN-IP>:3010/api/tasks  # 200 (with token)
```

**Firewall:** other machines also need inbound TCP 3010 allowed. Add once
(elevated PowerShell):
```powershell
New-NetFirewallRule -DisplayName "orch dashboard 3010" -Direction Inbound `
  -Protocol TCP -LocalPort 3010 -Action Allow -Profile Private
```
CORS needs no change — the browser talks only to the Vite origin, which proxies
to the backend.

## Stopping / restarting (Windows gotcha)

Stopping the background task does **not** always kill the node subprocesses;
port 3011 often lingers and the next start hits EADDRINUSE. Clear it:

```bash
netstat -ano | grep ":3011" | grep LISTEN          # note the PID
taskkill //PID <pid> //T //F                        # //T kills the tree
```

## Driving it

It's a browser app. Loading it proves the entrypoint resolves; to actually
drive it, hit a route the change touches (`curl .../api/tasks`) or open the
dashboard and use the `playwright-cli` skill for a screenshot of the rendered
UI. A blank frame is a failed launch.
