# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Event-driven orchestrator connecting GitHub and Azure DevOps to Claude Code. Spawns Claude CLI subprocesses for automated PR reviews, comment fixes, work item analysis, and code generation. Real-time dashboard via WebSocket.

## Workflow

After each code change, use the code-simplifier and review skills. Fix any errors, then always commit and push.

## Commands

- `npm run dev` - Server + dashboard with hot reload (concurrently)
- `npm run dev:server` - Server only (tsx watch, port 3011)
- `npm run dev:dashboard` - Vite dev server (port 3010, proxies API/WS to 3011)
- `npm run build` - `tsc` (server/core) then `vite build` (dashboard)
- `npm test` - Vitest (run single: `npx vitest run path/to/test`)
- `npm start` - Production server from `dist/`

## Architecture

### Server (`src/server/index.ts`)
Single-file Express server (~1200 lines) with WebSocket. All API routes, webhook handlers, and dashboard serving in one file. Broadcasts task/output updates to all connected WS clients.

- **API routes**: `/api/tasks`, `/api/actions/*`, `/api/config/*`, `/api/repos/*`, `/api/github/*`, `/api/auth/*`
- **Webhooks**: `/webhooks/github` (HMAC-SHA256 verified), `/webhooks/ado`
- **WebSocket**: `/ws` — pushes task lists, output chunks, orchestrator state, notifications

### Core (`src/core/`)
- **task-queue.ts** - JSON file persistence (`orch-tasks.json`), in-memory streaming output (100KB cap), task state machine: `pending → running → completed|failed|needs-repo|suggestion|dismissed`
- **task-processor.ts** - Orchestrates execution: git clone/branch → Claude subprocess → post results to GitHub/ADO. Handles all task types (pr-review, pr-comment-fix, issue-fix, code-gen, resolution-review, testing, etc.)
- **claude-runner.ts** - Spawns `claude` CLI as subprocess. Passes prompts via stdin (avoids Windows ENAMETOOLONG). Modes: non-streaming, streaming (EventEmitter), terminal. Process registry for steering running tasks.
- **poller.ts** - Polls GitHub/ADO APIs at configurable interval. Deduplication via processed keys (`source:type:id:updatedAt`). Skips 404'd repos.
- **git-ops.ts** - Git wrapper: status, branch, commit, push, worktree creation/cleanup
- **github-api.ts** - Octokit wrapper with `GITHUB_TOKEN` PAT + `gh` CLI fallback
- **orchestrator.ts** - Gathers PRs + work items → Claude prompt → prioritized action list. State machine: `idle → gathering → analyzing → ready`
- **config.ts** - Env var loading, terminal detection, platform detection
- **types.ts** - All shared types (`Task`, `TaskContext`, `OrchestratorAction`, `TerminalId`)

### Dashboard (`src/dashboard/`)
Svelte 5 SPA with Tailwind CSS 4 + Flowbite. Dark theme (`#0d1117` background).

- **Stores** (`stores/*.svelte.ts`) - Svelte 5 runes (`$state`, `$derived`). ~14 stores for tasks, work items, orchestrator, WebSocket, auth, etc.
- **Components** (`components/`) - TaskList, WorkItems, OrchestratorPanel, ProcessList, TestingAssignment, etc.
- **API client** (`lib/api.ts`) - Fetch-based HTTP client for all REST endpoints

### Data Flow
```
Webhook/Poller → createTask() → broadcastTasks() → WS → dashboard store → reactive UI
Task execution: pending → runClaudeStreaming() → output chunks via WS → completeTask()
```

## Code Style

- **TypeScript ESM** — use `.js` extensions in `src/server/` and `src/core/` imports (required for Node ESM runtime)
- **Svelte 5 runes** — `$state`, `$derived`, `$props` (NOT legacy `$:` or stores)
- **Separate tsconfigs** — server uses `NodeNext` module resolution; dashboard uses `bundler` resolution
- **async/await** preferred over raw promises
- Dashboard store files use `.svelte.ts` extension for rune support

## Key Env Vars

`GITHUB_TOKEN`, `ADO_PAT`, `ADO_ORG`, `REPOS_BASE_DIR` (default `../`), `POLLING_ENABLED` (default `true`), `MAX_CONCURRENT_TASKS` (default `2`), `CLAUDE_TIMEOUT` (default `300000`ms)

## Generated Files

- `orch-tasks.json` - Task database (JSON, auto-created)
- `.orch-settings.json` - Terminal preferences
- `.workspaces/` - Git worktrees for isolated task execution
