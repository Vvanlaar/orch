import { config } from './config.js';
import { runClaude } from './claude-runner.js';
import { appendFeedback, distillFeedback, getUnprocessedFeedback, loadOrchestratorRules } from './orch-feedback.js';
import { getAllTasks, createTask } from './task-queue.js';
import {
  getMyAdoWorkItems,
  getMyGitHubPRs,
  getResolvedWithPRComments,
  getMyResolvedWorkItems,
  getReviewedItemsInSprint,
  type AdoWorkItem,
  type GitHubPR,
} from './user-items.js';
import type { OrchestratorAction, OrchestratorState, ChatMessage, Task, TaskType } from './types.js';

// --- State ---

let state: OrchestratorState = {
  status: 'idle',
  runId: 0,
  actions: [],
  chat: { status: 'idle', messages: [] },
};

let onUpdate: ((state: OrchestratorState) => void) | null = null;

export function setOrchestratorUpdateCallback(cb: (state: OrchestratorState) => void): void {
  onUpdate = cb;
}

function broadcast(): void {
  onUpdate?.(state);
}

export function getOrchestratorState(): OrchestratorState {
  return state;
}

// --- Data Gathering ---

interface GatheredData {
  adoWorkItems: AdoWorkItem[];
  githubPRs: GitHubPR[];
  prComments: (AdoWorkItem & { commentCount: number })[];
  resolvedItems: AdoWorkItem[];
  reviewedItems: { sprintName: string; items: AdoWorkItem[] };
  notifications: any[];
  existingTasks: Task[];
}

let notificationGetter: (() => any[]) | null = null;

export function setNotificationGetter(fn: () => any[]): void {
  notificationGetter = fn;
}

async function gatherWorkData(): Promise<GatheredData> {
  const [adoWorkItems, githubPRs, prComments, resolvedItems, reviewedItems] = await Promise.all([
    getMyAdoWorkItems().catch(() => [] as AdoWorkItem[]),
    getMyGitHubPRs().catch(() => [] as GitHubPR[]),
    getResolvedWithPRComments().catch(() => [] as (AdoWorkItem & { commentCount: number })[]),
    getMyResolvedWorkItems().catch(() => [] as AdoWorkItem[]),
    getReviewedItemsInSprint().catch(() => ({ sprintName: '', items: [] as AdoWorkItem[] })),
  ]);

  const notifications = notificationGetter?.() ?? [];
  const existingTasks = getAllTasks(50);

  return { adoWorkItems, githubPRs, prComments, resolvedItems, reviewedItems, notifications, existingTasks };
}

// --- Prompt Builders ---

function buildOrchestratorPrompt(data: GatheredData): string {
  const sections: string[] = [];

  sections.push('# Work Data Analysis\n');
  sections.push('Analyze the following work data and produce a prioritized action list.\n');

  // ADO Work Items
  if (data.adoWorkItems.length > 0) {
    sections.push('## ADO Work Items (assigned to me, active)');
    for (const wi of data.adoWorkItems) {
      sections.push(`- #${wi.id} [${wi.type}] "${wi.title}" (${wi.state}) project:${wi.project} url:${wi.url}${wi.githubPrUrl ? ` PR:${wi.githubPrUrl}` : ''}`);
    }
    sections.push('');
  }

  // GitHub PRs
  if (data.githubPRs.length > 0) {
    sections.push('## GitHub PRs (open, my involvement)');
    for (const pr of data.githubPRs) {
      sections.push(`- ${pr.repo}#${pr.number} "${pr.title}" role:${pr.role} comments:${pr.commentCount ?? 0}${pr.draft ? ' DRAFT' : ''} url:${pr.url}`);
    }
    sections.push('');
  }

  // PR Comments needing attention
  if (data.prComments.length > 0) {
    sections.push('## PR Review Comments (unresolved, need my response)');
    for (const wi of data.prComments) {
      sections.push(`- ADO #${wi.id} "${wi.title}" - ${wi.commentCount} unresolved comment threads on PR ${wi.githubPrUrl} adoUrl:${wi.url}`);
    }
    sections.push('');
  }

  // Resolved items (for review)
  if (data.resolvedItems.length > 0) {
    sections.push('## Resolved Items (I resolved, now assigned to others)');
    for (const wi of data.resolvedItems) {
      sections.push(`- #${wi.id} "${wi.title}" (${wi.state}) url:${wi.url}${wi.githubPrUrl ? ` PR:${wi.githubPrUrl}` : ''}`);
    }
    sections.push('');
  }

  // Reviewed items needing testing
  if (data.reviewedItems.items.length > 0) {
    sections.push(`## Reviewed Items (sprint: ${data.reviewedItems.sprintName}, ready for testing)`);
    for (const wi of data.reviewedItems.items) {
      sections.push(`- #${wi.id} "${wi.title}" reviewedBy:${wi.reviewedBy || 'unknown'} url:${wi.url}`);
    }
    sections.push('');
  }

  // Notifications
  if (data.notifications.length > 0) {
    sections.push('## Recent Notifications');
    for (const n of data.notifications.slice(0, 10)) {
      sections.push(`- [${n.type}] ${n.sessionName || 'session'} - ${n.lastMessage?.slice(0, 100) || 'no message'}`);
    }
    sections.push('');
  }

  // Existing tasks (to avoid duplicates)
  const activeTasks = data.existingTasks.filter(t => ['pending', 'running'].includes(t.status));
  if (activeTasks.length > 0) {
    sections.push('## Already Active Tasks (DO NOT duplicate)');
    for (const t of activeTasks) {
      sections.push(`- Task #${t.id} [${t.type}] "${t.context.title}" (${t.status}) repo:${t.repo}`);
    }
    sections.push('');
  }

  // Inject user preferences/rules from feedback distillation
  const rules = loadOrchestratorRules();
  if (rules) {
    sections.push('## User Preferences & Rules (MUST follow)\n');
    sections.push(rules);
    sections.push('');
  }

  sections.push(`## Instructions

Produce a JSON array of recommended actions. Each action should be one concrete task.

Priority framework:
- high: PR comments blocking others, active bugs, failing pipelines
- medium: feature implementation, code reviews, resolution reviews
- low: testing plans, documentation, cleanup

Valid taskType values: pr-review, issue-fix, code-gen, docs, pipeline-fix, resolution-review, pr-comment-fix, testing

Output ONLY a JSON array (no markdown fences, no explanation):
[
  {
    "taskType": "pr-comment-fix",
    "repo": "owner/repo",
    "title": "Short action title",
    "prompt": "Detailed instructions for Claude to execute this task",
    "priority": "high",
    "reasoning": "Why this should be done now",
    "sourceType": "pr-comments",
    "sourceId": "12345",
    "sourceUrl": "https://... (the url from the work data above)"
  }
]

If there is nothing actionable, return an empty array: []`);

  return sections.join('\n');
}

function buildChatPrompt(data: GatheredData, question: string): string {
  const sections: string[] = [];

  sections.push('# Work Context\n');

  // Summarize data
  if (data.adoWorkItems.length > 0) {
    sections.push(`## ADO Work Items (${data.adoWorkItems.length})`);
    for (const wi of data.adoWorkItems.slice(0, 15)) {
      sections.push(`- #${wi.id} [${wi.type}/${wi.state}] "${wi.title}"`);
    }
    sections.push('');
  }

  if (data.githubPRs.length > 0) {
    sections.push(`## GitHub PRs (${data.githubPRs.length})`);
    for (const pr of data.githubPRs.slice(0, 15)) {
      sections.push(`- ${pr.repo}#${pr.number} "${pr.title}" (${pr.role})`);
    }
    sections.push('');
  }

  // Recent completed tasks with output
  const recentDone = data.existingTasks
    .filter(t => t.status === 'completed' || t.status === 'failed')
    .slice(0, 20);
  if (recentDone.length > 0) {
    sections.push(`## Recent Completed/Failed Tasks (${recentDone.length})`);
    for (const t of recentDone) {
      const output = (t.output || t.result || t.error || '').slice(0, 2000);
      sections.push(`### Task #${t.id} [${t.type}] ${t.status} - "${t.context.title}"`);
      sections.push(`Repo: ${t.repo} | Completed: ${t.completedAt || 'N/A'}`);
      if (output) sections.push(`Output:\n${output}`);
      sections.push('');
    }
  }

  // Inject user preferences/rules
  const chatRules = loadOrchestratorRules();
  if (chatRules) {
    sections.push('## User Preferences & Rules (MUST follow)\n');
    sections.push(chatRules);
    sections.push('');
  }

  sections.push(`## Question\n\n${question}\n`);
  sections.push('Answer conversationally. Reference specific ticket IDs, PR numbers, and task IDs when relevant. Be concise.');

  return sections.join('\n');
}

// --- Run Functions ---

export async function runOrchestrator(): Promise<void> {
  if (state.status === 'gathering' || state.status === 'analyzing') {
    throw new Error('Orchestrator already running');
  }

  state = { ...state, status: 'gathering', runId: state.runId + 1, actions: [], error: undefined, completedAt: undefined };
  broadcast();

  try {
    const data = await gatherWorkData();

    state = {
      ...state,
      status: 'analyzing',
      dataSummary: {
        adoWorkItems: data.adoWorkItems.length,
        githubPRs: data.githubPRs.length,
        prComments: data.prComments.length,
        testingItems: data.reviewedItems.items.length,
        notifications: data.notifications.length,
      },
    };
    broadcast();

    const prompt = buildOrchestratorPrompt(data);
    const syntheticTask = {
      id: -1,
      type: 'docs' as TaskType,
      status: 'running' as const,
      repo: 'orchestrator',
      repoPath: config.repos.baseDir || process.cwd(),
      context: { source: 'github' as const, event: 'orchestrate', title: 'Auto-orchestrator analysis' },
      createdAt: new Date().toISOString(),
    };

    const result = await runClaude(syntheticTask, prompt);

    if (!result.success) {
      throw new Error(result.error || 'Claude analysis failed');
    }

    // Parse JSON from output
    const jsonMatch = result.output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      state = { ...state, status: 'ready', actions: [], completedAt: new Date().toISOString() };
      broadcast();
      return;
    }

    const parsed: any[] = JSON.parse(jsonMatch[0]);
    const actions: OrchestratorAction[] = parsed.map((a, i) => ({
      id: `orch-${state.runId}-${i}`,
      taskType: a.taskType || 'docs',
      repo: a.repo || '',
      title: a.title || 'Untitled action',
      prompt: a.prompt || '',
      priority: a.priority || 'medium',
      reasoning: a.reasoning || '',
      sourceType: a.sourceType || 'ado-workitem',
      sourceId: a.sourceId,
      sourceUrl: a.sourceUrl,
    }));

    state = { ...state, status: 'ready', actions, completedAt: new Date().toISOString() };
    broadcast();

    // Fire-and-forget: distill feedback if enough unprocessed entries
    if (getUnprocessedFeedback().length >= 3) {
      distillFeedback().catch(err => console.error('[orch-feedback] Background distillation error:', err));
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    state = { ...state, status: 'error', error };
    broadcast();
    throw err;
  }
}

export async function runChatQuery(question: string): Promise<string> {
  // Add user message
  const userMsg: ChatMessage = { role: 'user', content: question, timestamp: new Date().toISOString() };
  state = { ...state, chat: { ...state.chat, status: 'thinking', messages: [...state.chat.messages, userMsg], error: undefined } };
  broadcast();

  try {
    const data = await gatherWorkData();
    const prompt = buildChatPrompt(data, question);

    const syntheticTask = {
      id: -2,
      type: 'docs' as TaskType,
      status: 'running' as const,
      repo: 'orchestrator',
      repoPath: config.repos.baseDir || process.cwd(),
      context: { source: 'github' as const, event: 'chat', title: 'Orchestrator chat' },
      createdAt: new Date().toISOString(),
    };

    const result = await runClaude(syntheticTask, prompt);
    const answer = result.success ? result.output : `Error: ${result.error}`;

    // Detect correction patterns in user question (negative directive + action verb)
    if (/\b(don'?t|stop|never|ignore|skip|no more)\b.*\b(suggest|recommend|create|add)\b/i.test(question)) {
      appendFeedback({ type: 'chat-correction', chatContext: question });
    }

    const assistantMsg: ChatMessage = { role: 'assistant', content: answer, timestamp: new Date().toISOString() };
    state = { ...state, chat: { ...state.chat, status: 'idle', messages: [...state.chat.messages, assistantMsg] } };
    broadcast();
    return answer;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    state = { ...state, chat: { ...state.chat, status: 'error', error } };
    broadcast();
    throw err;
  }
}

export function acceptAction(actionId: string): { taskId: number } | null {
  const idx = state.actions.findIndex(a => a.id === actionId);
  if (idx === -1 || state.actions[idx].accepted || state.actions[idx].dismissed) return null;

  const action = state.actions[idx];

  // Resolve repo path
  const repoMapping = config.repos.mapping || {};
  const repoPath = repoMapping[action.repo] || (config.repos.baseDir ? `${config.repos.baseDir}/${action.repo.split('/').pop()}` : process.cwd());

  const task = createTask(
    action.taskType as TaskType,
    action.repo,
    repoPath,
    {
      source: action.sourceType === 'github-pr' || action.sourceType === 'pr-comments' ? 'github' : 'ado',
      event: 'orchestrator',
      title: action.title,
      body: action.prompt,
      workItemId: action.sourceType === 'ado-workitem' ? parseInt(action.sourceId || '0') || undefined : undefined,
    }
  );

  appendFeedback({
    type: 'accept',
    actionId: action.id,
    actionTitle: action.title,
    actionTaskType: action.taskType,
    sourceType: action.sourceType,
    sourceId: action.sourceId,
  });

  const updated = [...state.actions];
  updated[idx] = { ...action, accepted: true, taskId: task.id };
  state = { ...state, actions: updated };
  broadcast();

  return { taskId: task.id };
}

export function dismissAction(actionId: string, reason?: string): boolean {
  const idx = state.actions.findIndex(a => a.id === actionId);
  if (idx === -1 || state.actions[idx].accepted || state.actions[idx].dismissed) return false;

  const action = state.actions[idx];
  appendFeedback({
    type: 'dismiss',
    actionId: action.id,
    actionTitle: action.title,
    actionTaskType: action.taskType,
    sourceType: action.sourceType,
    sourceId: action.sourceId,
    reason,
  });

  const updated = [...state.actions];
  updated[idx] = { ...updated[idx], dismissed: true, dismissReason: reason };
  state = { ...state, actions: updated };
  broadcast();
  return true;
}
