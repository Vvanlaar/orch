export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export type TaskType = 'pr-review' | 'issue-fix' | 'code-gen' | 'docs' | 'pipeline-fix';

export interface Task {
  id: number;
  type: TaskType;
  status: TaskStatus;
  repo: string;
  repoPath: string;
  context: TaskContext;
  result?: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TaskContext {
  source: 'github' | 'ado';
  event: string;
  prNumber?: number;
  issueNumber?: number;
  workItemId?: number;
  branch?: string;
  baseBranch?: string;
  title?: string;
  body?: string;
  url?: string;
}

export interface Config {
  server: {
    port: number;
    dashboardPort: number;
  };
  github: {
    webhookSecret: string;
    token: string;
  };
  ado: {
    organization: string;
    pat: string;
  };
  claude: {
    maxConcurrentTasks: number;
    timeout: number;
  };
  repos: {
    baseDir: string;
    mapping: Record<string, string>;
    autoScan: boolean;
  };
  polling: {
    enabled: boolean;
    intervalMs: number;
  };
}
