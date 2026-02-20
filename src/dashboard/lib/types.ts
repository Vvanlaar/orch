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
}

export interface Task {
  id: number;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'needs-repo';
  repo: string;
  createdAt: string;
  result?: string;
  error?: string;
  streamingOutput?: string;
  context?: {
    title?: string;
    url?: string;
    retryCount?: number;
  };
}

export interface TeamMember {
  email: string;
  displayName: string;
}

export interface ClaudeUsage {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
}

export interface Process {
  pid: number;
  taskId?: number;
  taskType?: string;
  repo?: string;
  startTime?: string;
}

export type FilterType = 'all' | 'new' | 'active' | 'resolved' | 'reviewed' | 'resolved-by-me';
export type OwnerFilter = 'my' | 'unassigned' | 'all';

export interface GitHubRepo {
  name: string;
  full_name: string;
  clone_url: string;
  description?: string;
  isLocal: boolean;
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
