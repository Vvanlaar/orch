import { spawn } from 'child_process';
import type { Task } from './types.js';
import { config } from './config.js';

export interface ClaudeResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface RunOptions {
  allowEdits?: boolean; // If true, Claude can make file changes (no --print)
}

export async function runClaude(task: Task, prompt: string, options: RunOptions = {}): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const args = options.allowEdits
      ? ['--dangerously-skip-permissions', '-p', prompt]
      : ['--print', '--dangerously-skip-permissions', prompt];

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
  return `Fix this issue by making the necessary code changes:

Title: ${context.title}
Description: ${context.body || 'No description provided'}

Instructions:
1. Analyze the codebase to understand the issue
2. Identify the root cause
3. Implement the fix by editing the relevant files
4. Verify the fix makes sense

After making changes, provide a brief markdown summary of what was fixed and which files were modified.`;
}

export function buildCodeGenPrompt(context: Task['context']): string {
  return `Implement the following feature by making the necessary code changes:

Title: ${context.title}
Description: ${context.body || 'No description provided'}

Instructions:
1. Understand the existing codebase structure and patterns
2. Plan the implementation
3. Write the code by creating/editing files as needed
4. Add tests if the project has a test suite
5. Follow existing code style and conventions

After making changes, provide a brief markdown summary of what was implemented and which files were created/modified.`;
}

export function buildPipelineFixPrompt(context: Task['context']): string {
  return `Fix this pipeline failure by making the necessary code changes:

${context.title}
${context.body || ''}
Branch: ${context.branch || 'unknown'}

Instructions:
1. Analyze the error to understand what failed
2. Identify the root cause in the code
3. Implement a fix by editing the relevant files
4. Verify the fix addresses the failure

After making changes, provide a brief markdown summary of what was fixed.`;
}

export function buildResolutionReviewPrompt(context: Task['context']): string {
  // Extract PR number if we have a GitHub URL
  let prInfo = '';
  if (context.prUrl) {
    const match = context.prUrl.match(/\/pull\/(\d+)/);
    if (match) {
      prInfo = `\nUse \`gh pr view ${match[1]}\` and \`gh pr diff ${match[1]}\` to review the PR.`;
    }
  }

  return `Review this resolved work item to verify the fix is complete and correct.

## Work Item Details
- **Title:** ${context.title}
- **ID:** #${context.workItemId || 'N/A'}
- **PR:** ${context.prUrl || 'Not provided'}
${prInfo}

## Resolution Notes
${context.resolution || 'No resolution notes provided'}

## Test Notes / Acceptance Criteria
${context.testNotes || 'No test notes provided'}

## Original Description
${context.body || 'No description provided'}

## Instructions
Follow the review-resolution skill process:

1. **Understand the Original Issue** - What problem was being solved?
2. **Review the PR Changes** - What code changes were made?
3. **Compare Against Test Notes** - Are all acceptance criteria met?
4. **Code Quality Check** - Any issues with the implementation?
5. **Provide Verdict** - APPROVED, NEEDS CHANGES, or NEEDS DISCUSSION

Format your response as:

## Resolution Review: ${context.title}

### Summary
[Brief summary of changes]

### Checklist
- [ ] Changes address the original issue
- [ ] Test notes/acceptance criteria met
- [ ] Code quality acceptable
- [ ] No obvious regressions

### Findings
[Detailed findings]

### Verdict: [APPROVED / NEEDS CHANGES / NEEDS DISCUSSION]
[Explanation]`;
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
    case 'resolution-review':
      return buildResolutionReviewPrompt(task.context);
    case 'docs':
      return `Update documentation based on recent changes. Format as markdown.`;
    default:
      return `Analyze: ${task.context.title}\n\n${task.context.body || ''}`;
  }
}
