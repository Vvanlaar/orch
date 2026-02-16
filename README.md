# Orch - Claude Code Orchestrator

Event-driven orchestrator that connects GitHub and Azure DevOps to Claude Code.

## Features

- **Real-time Dashboard**: Monitor tasks at http://localhost:3004 (GitHub PRs + ADO items)
- **PR Reviews**: Auto-review PRs when opened/updated
- **PR Comment Fixes**: Auto-fix review comments on PRs
- **Issue Analysis**: Analyze and propose fixes for issues/work items
- **Resolution Review**: Verify resolved work items are complete and correct
- **Testing Assignment**: Bulk-assign reviewed items to testers
- **Code Generation**: Generate code from feature requests
- **Pipeline Fixes**: Analyze build failures and suggest fixes
- **Polling Mode**: No ngrok needed - polls APIs directly

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your tokens and repo mapping
npm run build      # Build server + dashboard
npm start          # Production server
```

### Development

```bash
npm run dev           # Server + dashboard (hot reload)
npm run dev:server    # Server only on :3004 (hot reload)
npm run dev:dashboard # Vite dev server on :5173 (proxies to :3004)
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
| `PORT` | Server port (default: 3004) |
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

1. Open dashboard at http://localhost:3004
2. Find "Testing Assignment" section - shows all reviewed items in current sprint
3. Select team members who are available for testing
4. Click "Copy Assign Command"
5. Paste `/ado-assign-testing --users "..."` in Claude Code

### Rules

- Items are distributed evenly among selected users
- Never assigns to the person who resolved the item
- Never assigns to the person who reviewed the item
