import 'dotenv/config';
import type { Config } from './types.js';

function envOr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config: Config = {
  server: {
    port: parseInt(envOr('PORT', '3003')),
    dashboardPort: parseInt(envOr('DASHBOARD_PORT', '3004')),
  },
  github: {
    webhookSecret: envOr('GITHUB_WEBHOOK_SECRET', ''),
    token: envOr('GITHUB_TOKEN', ''),
  },
  ado: {
    organization: envOr('ADO_ORG', ''),
    pat: envOr('ADO_PAT', ''),
  },
  claude: {
    maxConcurrentTasks: parseInt(envOr('MAX_CONCURRENT_TASKS', '2')),
    timeout: parseInt(envOr('CLAUDE_TIMEOUT', '300000')),
  },
  repos: {
    baseDir: envOr('REPOS_BASE_DIR', '../'),
    mapping: JSON.parse(envOr('REPOS_MAPPING', '{}')),
    autoScan: envOr('REPOS_AUTO_SCAN', 'true') === 'true',
  },
  polling: {
    enabled: envOr('POLLING_ENABLED', 'true') === 'true',
    intervalMs: parseInt(envOr('POLLING_INTERVAL_MS', '60000')),
  },
};
