# Orch - Claude Code Orchestrator

Orchestrates Claude Code processes for automated PR reviews, comment fixes, and ADO work item analysis. Dashboard shows tasks, processes, and work items in real-time via WebSocket.

## Workflow

After each code change, use the code-simplifier and review skills. Fix any errors and then commit.

## Commands
- `npm run dev` - Server + dashboard (hot reload)
- `npm run dev:server` - Server only (hot reload)
- `npm run dev:dashboard` - Vite dev server (:5173, proxies to :3011)
- `npm run build` - Build all
- `npm test` - Run tests

## Structure
- `src/server/` - Express + WebSocket, webhooks (GitHub, ADO)
- `src/core/` - Task queue, Claude runner, git ops, polling
- `src/dashboard/` - Svelte 5 (runes: `$state`, `$derived`, `$props`)

## Code Style
- TypeScript ESM (use `.js` extensions in server imports for runtime)
- Svelte 5 runes for dashboard state
- async/await preferred

## Env Vars
`GITHUB_TOKEN`, `ADO_PAT`, `ADO_ORG`, `REPOS_BASE_DIR`
