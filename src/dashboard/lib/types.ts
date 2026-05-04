export interface PR {
  repo: string;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  url: string;
  role: 'author' | 'reviewer';
  updatedAt: string;
  branch?: string;
  baseBranch?: string;
  commentCount?: number;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  adoTicketId?: number;
  adoTicketUrl?: string;
}

export interface WorkItem {
  id: number;
  title: string;
  state: string;
  type: string;
  project: string;
  url: string;
  updatedAt: string;
  resolution?: string;
  githubPrUrl?: string;
  testNotes?: string;
  body?: string;
  assignedTo?: string;
  resolvedBy?: string;
  reviewedBy?: string;
  repositories?: string[];
  commentCount?: number;
  parentId?: number;
  parentTitle?: string;
}

export interface Task {
  id: number;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'needs-repo' | 'suggestion' | 'dismissed';
  repo: string;
  createdAt: string;
  startedAt?: string;
  result?: string;
  error?: string;
  streamingOutput?: string;
  machineId?: string;
  context?: {
    title?: string;
    url?: string;
    retryCount?: number;
    maxPages?: number;
    scanUrl?: string;
    urls?: string[];
    batchId?: string;
    batchLabel?: string;
  };
}

export interface TeamMember {
  email: string;
  displayName: string;
}

export interface ClaudeUsage {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
  updatedAt?: string;
}

export interface Process {
  pid: number;
  taskId?: number;
  taskType?: string;
  repo?: string;
  startTime?: string;
}

export type FilterType = 'all' | 'new' | 'active' | 'resolved' | 'reviewed' | 'resolved-by-me';
export type WorkItemMode = 'tickets' | 'prs';
export type OwnerFilter = 'my' | 'unassigned' | 'all';

export interface GitHubRepo {
  name: string;
  full_name: string;
  clone_url: string;
  description?: string;
  isLocal: boolean;
}

export interface Notification {
  id: string;
  type: 'stop' | 'plan-ready';
  sessionName: string;
  lastMessage: string;
  repo: string;
  machine: string;
  cwd: string;
  sessionId: string;
  timestamp: string;
}

// --- Orchestrator types ---

export type OrchestratorStatus = 'idle' | 'gathering' | 'analyzing' | 'ready' | 'error';
export type ChatStatus = 'idle' | 'thinking' | 'error';

export interface OrchestratorAction {
  id: string;
  taskType: string;
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
  runId?: number;
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

export type TerminalId = 'auto' | 'wt' | 'cmd' | 'powershell' | 'pwsh' | 'git-bash';

export interface Terminal {
  id: TerminalId;
  name: string;
  cmd: string | null;
  available?: boolean;
}

export interface TerminalConfig {
  preferred: TerminalId;
  interactiveSession: boolean;
  terminals: Terminal[];
}
