export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'needs-repo' | 'suggestion' | 'dismissed';

export type TerminalId = 'auto' | 'wt' | 'cmd' | 'powershell' | 'pwsh' | 'git-bash' | 'gnome-terminal' | 'xterm' | 'tmux' | 'terminal-app' | 'iterm2';

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
  // Fork info (for pushing to correct remote)
  headRepo?: string; // "owner/repo" of the PR source (fork)
  // Retry
  retryOfTaskId?: number;
  retryError?: string;
  retryCount?: number;
  // Remote-only mode (no local repo, use gh CLI remotely)
  remoteOnly?: boolean;
  ghRepoRef?: string; // "owner/repo" for gh commands
  // Ntfy suggestion workflow
  suggestionNote?: string; // user-appended instructions from ntfy reply
}

export interface Config {
  server: {
    port: number;
    dashboardPort: number;
  };
  github: {
    webhookSecret: string;
    token: string;
    org?: string;
    clientId?: string;
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

// --- Orchestrator types ---

export type OrchestratorStatus = 'idle' | 'gathering' | 'analyzing' | 'ready' | 'error';
export type ChatStatus = 'idle' | 'thinking' | 'error';

export interface OrchestratorAction {
  id: string;
  taskType: TaskType;
  repo: string;
  title: string;
  prompt: string;
  priority: 'high' | 'medium' | 'low';
  reasoning: string;
  sourceType: 'ado-workitem' | 'github-pr' | 'pr-comments' | 'testing' | 'notification';
  sourceId?: string;
  sourceUrl?: string;
  accepted?: boolean;
  dismissed?: boolean;
  dismissReason?: string;
  taskId?: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface OrchestratorState {
  status: OrchestratorStatus;
  runId: number;
  actions: OrchestratorAction[];
  completedAt?: string;
  error?: string;
  dataSummary?: {
    adoWorkItems: number;
    githubPRs: number;
    prComments: number;
    testingItems: number;
    notifications: number;
  };
  chat: {
    status: ChatStatus;
    messages: ChatMessage[];
    error?: string;
  };
}
