# Orch - Event-driven Claude Code Orchestrator

## Quick Start
- `npm run dev` - Start dev server with hot reload
- `npm run build` - Compile TypeScript
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

### Dashboard (`src/dashboard/`)
- `index.html` - Single-file dashboard (HTML/CSS/JS)

## Code Style
- TypeScript with ESM modules (`.js` imports)
- Express for HTTP, ws for WebSocket
- No React - vanilla JS in dashboard
- Prefer async/await over callbacks

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
