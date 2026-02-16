import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Task } from './types.js';
import { runClaude } from './claude-runner.js';

const LEARNINGS_FILE = '.claude/learnings.md';

// Load learnings from .claude/learnings.md if it exists
export function loadLearnings(repoPath: string): string | null {
  const filePath = join(repoPath, LEARNINGS_FILE);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export interface Learning {
  taskType: string;
  errorPattern: string;
  solution: string;
  timestamp: string;
}

function buildLessonExtractionPrompt(failed: Task, success: Task): string {
  const failedOutput = failed.result || failed.streamingOutput || 'N/A';
  const successOutput = success.result || success.streamingOutput || 'N/A';

  return `Analyze this successful retry and extract a concise lesson learned.

## Failed Attempt
Task Type: ${failed.type}
Error: ${failed.error}
Output (truncated): ${failedOutput.slice(0, 2000)}

## Successful Retry
Output (truncated): ${successOutput.slice(0, 2000)}

Extract in JSON format ONLY (no markdown, no explanation, just the JSON):
{
  "errorPattern": "Brief description of what went wrong (1 sentence)",
  "solution": "What approach worked and why (1-2 sentences)"
}`;
}

function parseLessonFromOutput(output: string): { errorPattern: string; solution: string } | null {
  try {
    const jsonMatch = output.match(/\{[\s\S]*?"errorPattern"[\s\S]*?"solution"[\s\S]*?\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed.errorPattern && parsed.solution) {
      return { errorPattern: parsed.errorPattern, solution: parsed.solution };
    }
  } catch {
    // JSON parse failed
  }
  return null;
}

function formatLearningEntry(learning: Learning): string {
  return `## ${learning.taskType} - ${learning.timestamp}
**Error pattern:** ${learning.errorPattern}
**Solution:** ${learning.solution}
`;
}

export async function extractLesson(
  failedTask: Task,
  successfulRetry: Task
): Promise<Learning | null> {
  const prompt = buildLessonExtractionPrompt(failedTask, successfulRetry);
  const result = await runClaude(successfulRetry, prompt, { allowEdits: false });

  if (!result.success) {
    console.error('[learnings] Failed to extract lesson:', result.error);
    return null;
  }

  const parsed = parseLessonFromOutput(result.output);
  if (!parsed) {
    console.error('[learnings] Failed to parse lesson from output');
    return null;
  }

  return {
    taskType: successfulRetry.type,
    errorPattern: parsed.errorPattern,
    solution: parsed.solution,
    timestamp: new Date().toISOString().split('T')[0],
  };
}

export function storeLearning(learning: Learning, repoPath: string): void {
  const filePath = join(repoPath, LEARNINGS_FILE);
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existing = existsSync(filePath)
    ? readFileSync(filePath, 'utf-8')
    : '# Learnings\n\nAuto-generated lessons from task retries.\n\n';

  writeFileSync(filePath, existing + formatLearningEntry(learning) + '\n');
  console.log(`[learnings] Stored learning in ${filePath}`);
}

// Map task types to skill files
const skillMap: Record<string, string> = {
  'pr-comment-fix': 'ado-fix-review-comments.md',
  'resolution-review': 'ado-review-resolution.md',
  'pr-review': 'review-pr.md',
  'issue-fix': 'fix-issue.md',
  'code-gen': 'code-gen.md',
};

// Update skill file if relevant
export async function updateSkillIfRelevant(
  learning: Learning,
  task: Task
): Promise<boolean> {
  const skillFile = skillMap[task.type];
  if (!skillFile) return false;

  const skillPath = join(task.repoPath, '.claude/skills', skillFile);
  if (!existsSync(skillPath)) return false;

  const skillContent = readFileSync(skillPath, 'utf-8');

  // Ask Claude to suggest skill update
  const prompt = `Given this learning from a retry:
Error pattern: ${learning.errorPattern}
Solution: ${learning.solution}

And this skill file content:
---
${skillContent}
---

Should this skill be updated to incorporate the learning? If yes, provide the COMPLETE updated skill file content.
If no update is needed (the skill already covers this or it's too specific), reply with exactly: NO_UPDATE_NEEDED

Important: Only suggest updates that are general enough to help future tasks, not one-off fixes.`;

  const result = await runClaude(task, prompt, { allowEdits: false });

  if (!result.success) {
    console.error('[learnings] Failed to analyze skill update:', result.error);
    return false;
  }

  if (result.output.includes('NO_UPDATE_NEEDED')) {
    console.log(`[learnings] Skill ${skillFile} does not need update`);
    return false;
  }

  // Extract the skill content (should be the main part of the response)
  // We'll be conservative and only update if the response looks like valid markdown
  const outputTrimmed = result.output.trim();
  if (outputTrimmed.startsWith('#') || outputTrimmed.startsWith('---')) {
    writeFileSync(skillPath, outputTrimmed);
    console.log(`[learnings] Updated skill file: ${skillPath}`);
    return true;
  }

  console.log(`[learnings] Skipping skill update - response doesn't look like valid skill content`);
  return false;
}
