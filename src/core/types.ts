export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export type TerminalId = 'auto' | 'wt' | 'cmd' | 'powershell' | 'pwsh' | 'git-bash';

export interface Terminal {
  id: TerminalId;
  name: string;
  cmd: string | null;
  available?: boolean;
}

export type TaskType = 'pr-review' | 'issue-fix' | 'code-gen' | 'docs' | 'pipeline-fix' | 'resolution-review' | 'pr-comment-fix' | 'testing';

export interface Task {
  id: number;
  type: TaskType;
  status: TaskStatus;
  repo: string;
  repoPath: string;
  context: TaskContext;
  result?: string;
  error?: string;
  output?: string; // persisted full output on completion/failure
  streamingOutput?: string; // live output during run
  pid?: number; // OS process ID when running
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
  prUrl?: string;
  resolution?: string;
  testNotes?: string;
  reviewComments?: Array<{
    id: number;
    path: string;
    line: number;
    body: string;
    diffHunk?: string;
  }>;
  // Retry
  retryOfTaskId?: number;
  retryError?: string;
  retryCount?: number;
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
    project?: string;
    team?: string;
    reviewedByField?: string;
  };
  claude: {
    maxConcurrentTasks: number;
    timeout: number;
    terminalMode: boolean; // open tasks in separate terminal windows
    preferredTerminal: TerminalId;
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
