import https from 'https';
import type { Task } from './types.js';

const NTFY_TOPIC = process.env.NTFY_TOPIC;

const taskTypeLabels: Record<string, string> = {
  'pr-review': 'PR Review',
  'pr-comment-fix': 'PR Comment Fix',
  'issue-fix': 'Issue Fix',
  'code-gen': 'Code Gen',
  'pipeline-fix': 'Pipeline Fix',
  'resolution-review': 'Resolution Review',
  'testing': 'Testing',
  'docs': 'Docs',
};

function postNtfy(body: string, headers: Record<string, string> = {}): Promise<void> {
  if (!NTFY_TOPIC) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://ntfy.sh/${NTFY_TOPIC}`,
      { method: 'POST', headers: { ...headers } },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', (err) => {
      console.error('[ntfy] Send error:', err.message);
      reject(err);
    });
    req.end(body);
  });
}

export async function sendNtfySuggestion(task: Task): Promise<void> {
  const label = taskTypeLabels[task.type] || task.type;
  const repo = task.repo.split('/').pop() || task.repo;
  const title = `${label} -- ${repo}`;
  const desc = task.context.title || task.type;
  const body = `${desc}\nReply 'yes ${task.id}' to start, 'skip ${task.id}' to dismiss`;

  try {
    await postNtfy(body, {
      Title: title,
      Tags: 'question',
    });
    console.log(`[ntfy] Sent suggestion for task #${task.id}`);
  } catch {
    // logged in postNtfy
  }
}

export async function sendNtfyConfirmation(message: string): Promise<void> {
  try {
    await postNtfy(message, { Tags: 'white_check_mark' });
  } catch {
    // logged in postNtfy
  }
}
