import { spawn } from 'child_process';
import type { Task } from './types.js';
import { config } from './config.js';

export interface ClaudeResult {
  success: boolean;
  output: string;
  error?: string;
}

export async function runClaude(task: Task, prompt: string): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const args = ['--print', '--dangerously-skip-permissions', prompt];

    const proc = spawn('claude', args, {
      cwd: task.repoPath,
      shell: true,
      timeout: config.claude.timeout,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, output: stdout, error: stderr || `Exit code: ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

export function buildPrReviewPrompt(context: Task['context']): string {
  return `Review this pull request and provide feedback:

Title: ${context.title}
Description: ${context.body || 'No description provided'}
Branch: ${context.branch} -> ${context.baseBranch}

Use git diff to see the changes, then focus on:
1. Code quality issues
2. Potential bugs
3. Security concerns
4. Suggestions for improvement

Be concise and actionable. Format your response as markdown suitable for a PR comment.`;
}

export function buildIssueFixPrompt(context: Task['context']): string {
  return `Analyze this issue and propose a fix:

Title: ${context.title}
Description: ${context.body || 'No description provided'}

1. Identify the root cause
2. Propose a solution
3. If straightforward, implement the fix

Format your response as markdown. If you made changes, summarize what was changed.`;
}

export function buildCodeGenPrompt(context: Task['context']): string {
  return `Implement the following feature request:

Title: ${context.title}
Description: ${context.body || 'No description provided'}
${context.branch ? `Target branch: ${context.branch}` : ''}

1. Understand the requirements
2. Plan the implementation
3. Write the code
4. Add appropriate tests if the project has a test suite

Format your response as markdown summarizing what was implemented.`;
}

export function buildPipelineFixPrompt(context: Task['context']): string {
  return `Analyze this pipeline failure and suggest fixes:

${context.title}
${context.body || ''}
Branch: ${context.branch || 'unknown'}

1. Identify what failed
2. Determine the root cause
3. Suggest or implement a fix

Format your response as markdown.`;
}

export function buildPromptForTask(task: Task): string {
  switch (task.type) {
    case 'pr-review':
      return buildPrReviewPrompt(task.context);
    case 'issue-fix':
      return buildIssueFixPrompt(task.context);
    case 'code-gen':
      return buildCodeGenPrompt(task.context);
    case 'pipeline-fix':
      return buildPipelineFixPrompt(task.context);
    case 'docs':
      return `Update documentation based on recent changes. Format as markdown.`;
    default:
      return `Analyze: ${task.context.title}\n\n${task.context.body || ''}`;
  }
}
