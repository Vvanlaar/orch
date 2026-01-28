# Orch - Event-driven Claude Code Orchestrator

## Quick Start
- `npm run dev` - Start API server with hot reload
- `npm run dev:dashboard` - Start Vite dev server (dashboard)
- `npm run build` - Build server + dashboard
- `npm test` - Run vitest tests

## Architecture

### Server (`src/server/`)
- `index.ts` - Express + WebSocket server, API endpoints, dashboard serving
- `webhooks/github.ts` - GitHub webhook handler
- `webhooks/ado.ts` - Azure DevOps webhook handler

### Core (`src/core/`)
- `config.ts` - Environment config (GitHub token, ADO PAT, repos)
- `types.ts` - Shared TypeScript types
- `task-queue.ts` - Task storage and retrieval
- `task-processor.ts` - Claude runner orchestration
- `claude-runner.ts` - Spawns Claude Code processes
- `user-items.ts` - Fetches user's PRs and ADO work items
- `repo-scanner.ts` - Discovers local repos
- `git-ops.ts` - Git operations
- `poller.ts` - Periodic polling for updates

### Dashboard (`src/dashboard/`) - Svelte 5
- `App.svelte` - Root component with global styles
- `main.ts` - Entry point
- `vite.config.ts` - Vite build config
- `components/` - UI components (Header, WorkItems, TaskList, TaskItem, ProcessList, TestingAssignment)
- `stores/*.svelte.ts` - Reactive state (websocket, tasks, workItems, testing, usage, processes)
- `lib/` - Types, utilities, API functions

## Code Style
- TypeScript with ESM modules (`.js` imports for server code)
- Express for HTTP, ws for WebSocket
- Svelte 5 with runes (`$state`, `$derived`, `$props`) for dashboard
- Prefer async/await over callbacks

## Dashboard Development
- `npm run dev:dashboard` - Vite dev server on :5173 (proxies API to :3000)
- `npm run build:dashboard` - Build to `dist/dashboard/`
- Server auto-serves built dashboard from `dist/dashboard/` in production

## API Endpoints
- `GET /api/my/prs` - User's GitHub PRs
- `GET /api/my/workitems` - User's ADO work items (assigned)
- `GET /api/my/resolved-workitems` - ADO items resolved by user
- `POST /api/actions/review-pr` - Create PR review task
- `POST /api/actions/fix-pr-comments` - Create PR comment fix task
- `POST /api/actions/analyze-workitem` - Create work item task
- `POST /api/actions/review-resolution` - Create resolution review task

## Environment Variables
- `GITHUB_TOKEN` - GitHub PAT
- `ADO_PAT` - Azure DevOps PAT
- `ADO_ORG` - Azure DevOps organization
- `REPOS_BASE_DIR` - Base directory for repos
