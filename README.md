# Orch - Claude Code Orchestrator

Event-driven orchestrator that connects GitHub and Azure DevOps to Claude Code.

## Features

- **Real-time Dashboard**: Monitor tasks at http://localhost:3011 in production, or http://localhost:3010 in dev (GitHub PRs + ADO items)
- **PR Reviews**: Auto-review PRs when opened/updated
- **PR Comment Fixes**: Auto-fix review comments on PRs
- **Issue Analysis**: Analyze and propose fixes for issues/work items
- **Resolution Review**: Verify resolved work items are complete and correct
- **Testing Assignment**: Bulk-assign reviewed items to testers
- **Code Generation**: Generate code from feature requests
- **Pipeline Fixes**: Analyze build failures and suggest fixes
- **Polling Mode**: No ngrok needed - polls APIs directly

## Setup

Requires pnpm 8+. Install via `npm i -g pnpm` or `corepack enable`.

```bash
pnpm install
cp .env.example .env
# Edit .env with your tokens and repo mapping
pnpm build         # Build server + dashboard
pnpm start         # Production server
```

### Development

```bash
pnpm dev              # Server + dashboard (hot reload)
pnpm dev:server       # Server only on :3011 (hot reload)
pnpm dev:dashboard    # Vite dev server on :3010 (proxies API/WS to :3011)
```

## Always-on LAN service

One machine holds the HubSpot token, the ADO PAT and the bb-kb index; everyone
else reaches `bb-support` through it — in a browser at `/support`, or from their
own Claude Code via `ask.mjs --remote` (see
[bb-support's Remote mode](https://github.com/bluebillywig/bb-skills/blob/master/bb-support/SKILL.md#remote-mode--run-without-local-creds)).

**1. Bind to the LAN.** In `.env`:

```env
HOST=0.0.0.0
PORT=3011
```

In production (`node dist/server/index.js`) the API *and* the built SPA are both
served on `PORT`, so `DASHBOARD_PORT` / 3010 is dev-only.

**2. Choose an auth mode.** A non-loopback bind refuses to start unless one of
the two is set up (`src/server/support.ts` `assertBindAuthValid`).

#### Open mode — no token for callers (easiest)

```env
BB_SUPPORT_ALLOW_ANONYMOUS=1
```

Anyone who can reach the host uses `/support` in a browser, or points
`ask.mjs --remote` at it, with no credential at all. The LAN is the security
boundary.

On a wildcard bind (`0.0.0.0`) this boots **only if every network interface on
the host is on a private network** — RFC1918, link-local, or IPv6 unique-local.
If the machine has a publicly-routable address, startup fails and names it,
because a wildcard bind would otherwise serve customer data unauthenticated on
that address. Bind to the private IP explicitly if you need to.

**`POST /api/support/note` is the exception — it always requires a bearer
token**, even in open mode: it posts (and with `update` overwrites) an
investigation note on a live customer's HubSpot ticket under this host's
private-app token, so it stays attributable. So open mode still needs a
`tokens.json` with one entry for whoever posts notes back; reads and `/ask` are
unaffected either way.

#### Token mode — a pre-shared bearer string per person

Populate `~/.claude/bb-support-web/tokens.json`. Scopes decide reach:

```json
{
  "<token-alice>": { "name": "Alice", "scopes": ["support"] },
  "<token-you>":   { "name": "You",   "scopes": ["admin"] }
}
```

`support` reaches only `/api/support/*`; everything else (tasks, repos,
terminals, config, the WS feed) needs `admin` — except `/api/whoami` and
`/api/notifications/incoming`, which are unauthenticated by design (see
`PUBLIC_API` in `src/server/index.ts`). An entry with no `scopes` defaults to
`["support"]`. Generate one with
`node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
Tokens load once at boot — adding one needs a restart.

> A **missing** `tokens.json` is fine — it reads as "no tokens". A **zero-byte or
> malformed** one throws at boot. Delete the file rather than emptying it.

**3. Build and register the service.**

```bash
pnpm build
```

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\dev\orch\scripts\start-service.cmd" -WorkingDirectory "C:\dev\orch"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName "orch" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
```

`AtLogOn` as the interactive user, **not** `AtStartup`/SYSTEM: `runSupportQuery`
spawns the `claude` CLI, which reads that user's `~/.claude/.credentials.json`.

`scripts/start-service.cmd` fixes cwd (`.env` and `REPOS_BASE_DIR=../` are
cwd-relative), pins an explicit Node version path, and logs to
`orch-service.log`. It must keep CRLF line endings — cmd.exe eats the first
character of every line in an LF-only batch file. `.gitattributes` enforces that.

**4. Open the firewall** (elevated, once):

```powershell
New-NetFirewallRule -DisplayName "orch (LAN)" -Direction Inbound -Protocol TCP -LocalPort 3011 -Action Allow -Profile Private,Domain
```

**5. Hand out the hostname, not the IP** — `http://<hostname>:3011/`. A laptop on
DHCP will change address.

### Caveats

- **Sleep takes the service down.** A laptop host is offline whenever it sleeps;
  say so to anyone who depends on it.
- **`HUBSPOT_AUTO_INVESTIGATE=true` becomes always-on.** The poller spends Claude
  quota and posts investigation notes onto live customer tickets flagged with the
  `ai_investigate_bbsupport` property. Set it to `false` if you don't want that
  running unattended.
- **The host's creds are the team's creds.** Every caller reads the host's
  HubSpot tickets and ADO project.
- **Open mode opens more than the question box.** `/ask` spends this host's
  Claude subscription (10 per 5 min, budgeted per client IP, so anyone behind the
  same NAT shares it); `/reveal` un-masks the customer names in a run's PII
  mappings; `/events/:runId` and `/cancel/:runId` are guarded only by knowing the
  run's UUID. All coherent on a trusted LAN — just know that's the trade.
- **HTTP only.** LAN as the boundary. Terminate TLS at a reverse proxy if you
  need more, and don't expose this to the internet.

### Verifying

```bash
# Open mode
curl http://<hostname>:3011/api/support/health   # {"status":"ok","authMode":"anonymous","noteAuthMode":"token"}
curl -X POST http://<hostname>:3011/api/support/gather \
  -H 'Content-Type: application/json' -d '{"question":"how does live transcoding work"}'   # 200, no token
curl -X POST http://<hostname>:3011/api/support/note \
  -H 'Content-Type: application/json' -d '{"ticketId":"1","bodyHtml":"<p>x</p>"}'          # 401 — the write gate

# Token mode
curl -H "Authorization: Bearer <support-token>" http://<hostname>:3011/api/tasks   # 403 — proves the admin gate
```

## Tech Stack

- **Server**: Express + WebSocket, TypeScript
- **Dashboard**: Svelte 5 + Vite (~21KB gzipped)
- **State**: Svelte runes (`$state`, `$derived`)

## Dashboard Features

- Work items view with filters (GitHub PRs + ADO items)
- Testing assignment for reviewed sprint items
- Process management and task monitoring
- Repo cloning from GitHub org

## Modes

### Polling (default, recommended for local dev)
Polls GitHub/ADO APIs periodically. No external access needed.

```env
POLLING_ENABLED=true
POLLING_INTERVAL_MS=60000
```

### Webhooks (for production/instant response)
Requires exposing your server via ngrok/cloudflared.

```env
POLLING_ENABLED=false
```

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3011) |
| `MAX_CONCURRENT_TASKS` | Concurrent Claude tasks (default: 2) |
| `CLAUDE_TIMEOUT` | Claude task timeout in ms (default: 300000) |
| `PREFERRED_TERMINAL` | Terminal for Claude (default: auto) |
| `GITHUB_WEBHOOK_SECRET` | Secret for GitHub webhook verification |
| `GITHUB_TOKEN` | GitHub PAT for posting comments |
| `ADO_ORG` | Azure DevOps organization name |
| `ADO_PAT` | Azure DevOps Personal Access Token |
| `ADO_PROJECT` | ADO project name (for Testing Assignment) |
| `ADO_TEAM` | ADO team name (for Testing Assignment) |
| `ADO_REVIEWED_BY_FIELD` | Custom field for reviewer (default: `Custom.ReviewedBy`) |
| `HOST` | Bind address (default: `127.0.0.1`; `0.0.0.0` for LAN — see [Always-on LAN service](#always-on-lan-service) for the auth it requires) |
| `HUBSPOT_PRIVATE_APP_TOKEN` | HubSpot legacy private-app token used by `/api/support/*` |
| `HUBSPOT_HUB_ID` | HubSpot account id (BB: `1054725`) |
| `HUBSPOT_AUTO_INVESTIGATE` | Poll for `ai_investigate_bbsupport` tickets and post AI notes (default: `false`) |
| `BB_SUPPORT_SCRIPTS_DIR` | Where to load `bb-support/scripts/*.mjs` from (default: a sibling `bb-skills` checkout) |
| `BB_SUPPORT_DATA_DIR` | Tokens / audit / keys dir (default: `~/.claude/bb-support-web`) |
| `REPOS_BASE_DIR` | Base directory for repos (default: `../`) |
| `REPOS_AUTO_SCAN` | Auto-discover git repos (default: `true`) |
| `REPOS_MAPPING` | Manual repo mapping (optional, merged with auto) |
| `POLLING_ENABLED` | Enable polling mode (default: `true`) |
| `POLLING_INTERVAL_MS` | Poll interval in ms (default: `60000`) |

### Repo Discovery

By default, Orch auto-scans `REPOS_BASE_DIR` for git repos and reads their remotes:

```env
REPOS_BASE_DIR=../
REPOS_AUTO_SCAN=true
```

On startup, it logs discovered repos:
```
Discovered 3 repos:
  owner/frontend -> frontend
  owner/backend -> backend
  MyOrg/Project/api -> api
```

### Manual Mapping (optional)

Override or add repos manually:

```env
REPOS_MAPPING={"owner/special-repo": "my-local-name"}
```

## Webhooks

Expose the server via ngrok/cloudflared, then configure:

### GitHub
- URL: `https://your-tunnel/webhooks/github`
- Content type: `application/json`
- Events: Pull requests, Issues

### Azure DevOps
- URL: `https://your-tunnel/webhooks/ado`
- Events: Pull request created/updated, Work item created, Build completed

## Branch Naming (ADO)

Work items auto-generate branches: `[type]/[id]-short-description`
- Bug → `bug/12345-fix-issue`
- Feature/Story → `feat/12346-new-feature`
- Other → `maintenance/12347-task`

## Testing Assignment

Bulk-assign "Reviewed" work items to team members for testing.

### Setup

```env
ADO_PROJECT=MyProject
ADO_TEAM=MyTeam
ADO_REVIEWED_BY_FIELD=Custom.ReviewedBy
```

### Usage

1. Open dashboard at http://localhost:3011
2. Find "Testing Assignment" section - shows all reviewed items in current sprint
3. Select team members who are available for testing
4. Click "Copy Assign Command"
5. Paste `/bb-assign-testing --users "..."` in Claude Code

### Rules

- Items are distributed evenly among selected users
- Never assigns to the person who resolved the item
- Never assigns to the person who reviewed the item
