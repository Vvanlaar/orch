import { describe, it, expect, vi } from 'vitest';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';

// The runner reads VIDEOSCAN_DIR at import, so point it at a scratch dir first.
const dir = vi.hoisted(() => {
  process.env.VIDEOSCAN_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'videoscan-ckpt-'));
  return process.env.VIDEOSCAN_DIR as string;
});

// Local files only: never reach for a real Supabase from a test.
vi.mock('./db/client.js', async (orig) => ({
  ...(await orig<typeof import('./db/client.js')>()),
  isSupabaseConfigured: () => false,
}));

const { dropSpentCheckpoint, checkpointFilename } = await import('./videoscan-runner.js');

describe('dropSpentCheckpoint', () => {
  it('removes the leftover html/pdf once the checkpoint JSON is gone', async () => {
    const base = checkpointFilename('gone.nl').replace('.json', '');
    writeFileSync(join(dir, `${base}.html`), '');
    writeFileSync(join(dir, `${base}.pdf`), '');

    await dropSpentCheckpoint('gone.nl', 1);

    expect(existsSync(join(dir, `${base}.html`))).toBe(false);
    expect(existsSync(join(dir, `${base}.pdf`))).toBe(false);
  });

  it('leaves a checkpoint that is still on disk alone: it is live resume state', async () => {
    const checkpoint = checkpointFilename('live.nl');
    const html = checkpoint.replace('.json', '.html');
    writeFileSync(join(dir, checkpoint), '{}');
    writeFileSync(join(dir, html), '');

    await dropSpentCheckpoint('live.nl', 1);

    expect(existsSync(join(dir, checkpoint))).toBe(true);
    expect(existsSync(join(dir, html))).toBe(true);
  });
});
