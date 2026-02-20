import 'dotenv/config';
import type { Config, TerminalId } from './types.js';

function envOr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config: Config = {
  server: {
    port: parseInt(envOr('PORT', '3011')),
    dashboardPort: parseInt(envOr('DASHBOARD_PORT', '3010')),
  },
  github: {
    webhookSecret: envOr('GITHUB_WEBHOOK_SECRET', ''),
    token: envOr('GITHUB_TOKEN', ''),
    org: envOr('GITHUB_ORG', 'bluebillywig'),
  },
  ado: {
    organization: envOr('ADO_ORG', ''),
    pat: envOr('ADO_PAT', ''),
    project: envOr('ADO_PROJECT', ''),
    team: envOr('ADO_TEAM', ''),
    reviewedByField: envOr('ADO_REVIEWED_BY_FIELD', 'Microsoft.VSTS.Common.ReviewedBy'),
  },
  claude: {
    maxConcurrentTasks: parseInt(envOr('MAX_CONCURRENT_TASKS', '2')),
    timeout: parseInt(envOr('CLAUDE_TIMEOUT', '300000')),
    terminalMode: envOr('CLAUDE_TERMINAL_MODE', 'false') === 'true',
    preferredTerminal: envOr('PREFERRED_TERMINAL', 'auto') as TerminalId,
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
