import { defineConfig } from 'vitest/config';

// Without an explicit `include`, vitest walks the whole tree and collects test
// files that were never meant for it:
//   - .workspaces/{clones,worktrees}/  — task-execution checkouts of OTHER repos
//     (ovp6 Angular specs that can't resolve their own path aliases here)
//   - .claude/worktrees/               — agent worktrees of this repo
//   - src/videoscan/scan.test.mjs      — a node:test file, run by `pnpm test:videoscan`
//
// All three failed the suite before this config existed, which made `pnpm test`
// useless as a gate. Scope it to the TypeScript tests under src/ instead.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.workspaces/**', '.claude/**', 'dist/**'],
  },
});
