import { spawn, ChildProcess, exec } from 'child_process';
import { EventEmitter } from 'events';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Task } from './types.js';
import { config } from './config.js';
import { loadLearnings } from './learnings.js';

// Process registry for steering running tasks
const runningProcesses = new Map<number, ChildProcess>();

// EventEmitter for streaming output
export const claudeEmitter = new EventEmitter();

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
    // Use stdin to pass prompt (avoids command line length limits on Windows)
    const args = options.allowEdits
      ? ['--dangerously-skip-permissions', '-p', '-']
      : ['--print', '--dangerously-skip-permissions', '-'];

    const proc = spawn('claude', args, {
      cwd: task.repoPath,
      shell: true,
      timeout: config.claude.timeout,
    });

    // Send prompt via stdin
    if (proc.stdin) {
      proc.stdin.write(prompt);
      proc.stdin.end();
    }

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

// Streaming version that emits output chunks in real-time
export async function runClaudeStreaming(
  taskId: number,
  task: Task,
  prompt: string,
  options: RunOptions = {}
): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    // Write prompt to temp file to avoid ENAMETOOLONG on Windows
    const promptDir = join(tmpdir(), 'orch-prompts');
    mkdirSync(promptDir, { recursive: true });
    const promptFile = join(promptDir, `task-${taskId}.txt`);
    writeFileSync(promptFile, prompt, 'utf-8');

    // Use stdin to pass prompt (avoids command line length limits)
    const args = options.allowEdits
      ? ['--dangerously-skip-permissions', '-p', '-']
      : ['--print', '--dangerously-skip-permissions', '-'];

    const proc = spawn('claude', args, {
      cwd: task.repoPath,
      shell: true,
      timeout: config.claude.timeout,
    });

    // Register for steering
    runningProcesses.set(taskId, proc);

    // Emit PID for tracking
    if (proc.pid) {
      claudeEmitter.emit('pid', taskId, proc.pid);
    }

    // Send prompt via stdin
    if (proc.stdin) {
      proc.stdin.write(prompt);
      proc.stdin.end();
    }

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      claudeEmitter.emit('output', taskId, chunk);
    });

    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      claudeEmitter.emit('output', taskId, `[stderr] ${chunk}`);
    });

    proc.on('close', (code) => {
      runningProcesses.delete(taskId);
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({ success: false, output: stdout, error: stderr || `Exit code: ${code}` });
      }
    });

    proc.on('error', (err) => {
      runningProcesses.delete(taskId);
      resolve({ success: false, output: '', error: err.message });
    });
  });
}

// Send input to a running Claude process (for steering)
export function steerTask(taskId: number, input: string): boolean {
  const proc = runningProcesses.get(taskId);
  if (!proc?.stdin) return false;
  proc.stdin.write(input + '\n');
  return true;
}

export function isTaskRunning(taskId: number): boolean {
  return runningProcesses.has(taskId);
}

export function killTask(taskId: number): boolean {
  const proc = runningProcesses.get(taskId);
  if (!proc) return false;
  proc.kill('SIGTERM');
  runningProcesses.delete(taskId);
  return true;
}

// Get PIDs of all running tasks (for process management UI)
export function getRunningTaskPids(): { taskId: number; pid: number }[] {
  const result: { taskId: number; pid: number }[] = [];
  for (const [taskId, proc] of runningProcesses) {
    if (proc.pid) {
      result.push({ taskId, pid: proc.pid });
    }
  }
  return result;
}

// Run Claude in a separate terminal window (Windows Terminal or cmd)
export async function runClaudeInTerminal(
  taskId: number,
  task: Task,
  prompt: string,
  options: RunOptions = {}
): Promise<ClaudeResult> {
  // Write prompt to temp file (prompts can be very long)
  const promptDir = join(tmpdir(), 'orch-prompts');
  mkdirSync(promptDir, { recursive: true });
  const promptFile = join(promptDir, `task-${taskId}.txt`);
  writeFileSync(promptFile, prompt, 'utf-8');

  const claudeArgs = options.allowEdits
    ? `--dangerously-skip-permissions -p "$(cat '${promptFile.replace(/\\/g, '/')}')"`
    : `--print --dangerously-skip-permissions "$(cat '${promptFile.replace(/\\/g, '/')}')"`;

  // Build command for Windows Terminal (wt) or fallback to cmd
  const repoPath = task.repoPath.replace(/\\/g, '/');
  const title = `Task #${taskId}: ${task.type}`;

  // Try Windows Terminal first, fall back to cmd
  const wtCmd = `wt -w 0 nt --title "${title}" -d "${repoPath}" cmd /k "claude ${claudeArgs}"`;
  const cmdCmd = `start "${title}" cmd /k "cd /d ${task.repoPath} && claude ${claudeArgs}"`;

  return new Promise((resolve) => {
    // Try wt first
    exec(wtCmd, (err) => {
      if (err) {
        // Fallback to cmd
        exec(cmdCmd, (cmdErr) => {
          if (cmdErr) {
            console.error('[terminal] Failed to open terminal:', cmdErr);
            resolve({ success: false, output: '', error: 'Failed to open terminal window' });
          } else {
            console.log(`[terminal] Opened cmd window for task #${taskId}`);
            claudeEmitter.emit('output', taskId, `[Terminal opened - running in external window]\nPrompt file: ${promptFile}\n`);
            resolve({ success: true, output: 'Running in external terminal' });
          }
        });
      } else {
        console.log(`[terminal] Opened Windows Terminal for task #${taskId}`);
        claudeEmitter.emit('output', taskId, `[Windows Terminal opened - running in external window]\nPrompt file: ${promptFile}\n`);
        resolve({ success: true, output: 'Running in external terminal' });
      }
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

export function buildPrCommentFixPrompt(context: Task['context']): string {
  const comments = context.reviewComments || [];
  const commentBlocks = comments.map((c, i) => `
### Comment ${i + 1}
- **File:** ${c.path}
- **Line:** ${c.line}
- **Feedback:** ${c.body}
${c.diffHunk ? `\`\`\`diff\n${c.diffHunk}\n\`\`\`` : ''}
`).join('\n');

  return `Fix the following PR review comments by making the requested changes:

## PR: ${context.title || 'PR #' + context.prNumber}
Branch: ${context.branch || 'unknown'}

## Review Comments to Address
${commentBlocks}

## Instructions
1. For each comment, navigate to the file and line mentioned
2. Understand the feedback and make the requested change
3. Keep changes minimal and focused on addressing the feedback
4. Maintain code style consistency with surrounding code

After making all changes, provide a brief summary of what was fixed for each comment.`;
}

export function buildCodeSimplifierPrompt(modifiedFiles: string[]): string {
  const fileList = modifiedFiles.map(f => `- ${f}`).join('\n');
  return `Run /code-simplifier on the following files that were just modified:

${fileList}

Focus on:
- Clarity and readability
- Consistent formatting
- Removing unnecessary complexity
- Keeping all functionality intact`;
}

export function buildSelfReviewPrompt(): string {
  return `Review the changes you just made to ensure they are correct:

1. Check that all review comments were properly addressed
2. Verify no regressions were introduced
3. Confirm code style is consistent
4. Look for any obvious issues

Provide a brief verdict: APPROVED (changes look good) or NEEDS ATTENTION (with explanation of issues found).`;
}

// Wrap prompt with retry context for failed tasks
export function wrapRetryPrompt(basePrompt: string, error: string, retryCount: number): string {
  return `## RETRY ATTEMPT ${retryCount}

A previous attempt at this task FAILED with the following error:

\`\`\`
${error}
\`\`\`

Analyze what went wrong and try a different approach. Consider:
- If a file wasn't found, check if the path is correct
- If a command failed, check the command syntax
- If there was a logic error, reconsider the approach
- If permissions failed, try an alternative method

---

${basePrompt}`;
}

const promptBuilders: Record<string, (ctx: Task['context']) => string> = {
  'pr-review': buildPrReviewPrompt,
  'issue-fix': buildIssueFixPrompt,
  'code-gen': buildCodeGenPrompt,
  'pipeline-fix': buildPipelineFixPrompt,
  'resolution-review': buildResolutionReviewPrompt,
  'pr-comment-fix': buildPrCommentFixPrompt,
  'docs': () => 'Update documentation based on recent changes. Format as markdown.',
};

export function buildPromptForTask(task: Task): string {
  const builder = promptBuilders[task.type];
  let prompt = builder
    ? builder(task.context)
    : `Analyze: ${task.context.title}\n\n${task.context.body || ''}`;

  // Prepend learnings if available
  const learnings = loadLearnings(task.repoPath);
  if (learnings) {
    prompt = `## Relevant Learnings from Previous Tasks\n\n${learnings}\n\n---\n\n${prompt}`;
  }

  // Wrap with retry context if retrying a failed task
  if (task.context.retryOfTaskId && task.context.retryError) {
    return wrapRetryPrompt(prompt, task.context.retryError, task.context.retryCount || 1);
  }

  return prompt;
}
