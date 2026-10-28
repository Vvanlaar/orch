// Creating videoscan tasks, shared by the HTTP routes and the bb-core runner so
// both validate and default the same way.
import { createTask } from './task-queue.js';
import { getVideoscanDir } from './videoscan-runner.js';
import type { Task, TaskContext } from './types.js';

/** A bad request: the route answers it with `status`, the runner fails the job with the message. */
export class VideoscanRequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Context the caller adds on top: bb-core job id, machine pin. */
type ExtraContext = Pick<TaskContext, 'bbCoreJobId' | 'targetMachineId'>;

interface BatchInput {
  batchId?: unknown;
  batchLabel?: unknown;
}

function batchContext({ batchId, batchLabel }: BatchInput): Pick<TaskContext, 'batchId' | 'batchLabel'> {
  return {
    ...(typeof batchId === 'string' && batchId ? { batchId } : {}),
    ...(typeof batchLabel === 'string' && batchLabel ? { batchLabel } : {}),
  };
}

export interface StartVideoscanInput extends BatchInput {
  url?: unknown;
  maxPages?: unknown;
  delay?: unknown;
  /** 'video' (or absent) is a plain videoscan */
  mode?: unknown;
}

export async function startVideoscanTask(input: StartVideoscanInput, extra: ExtraContext = {}): Promise<Task> {
  const { url, maxPages, delay, mode } = input;
  if (!url || typeof url !== 'string') throw new VideoscanRequestError(400, 'url required');
  try { new URL(url); } catch { throw new VideoscanRequestError(400, 'Invalid URL'); }
  if (mode !== undefined && mode !== 'video' && mode !== 'sovereignty') {
    throw new VideoscanRequestError(400, 'mode must be "video", "sovereignty" or absent');
  }
  const sovereignty = mode === 'sovereignty';

  return createTask('videoscan', url, getVideoscanDir(), {
    source: 'github', // placeholder — videoscan has no source
    event: 'videoscan',
    title: `${sovereignty ? 'Sovereignty scan' : 'Videoscan'}: ${new URL(url).hostname}`,
    scanUrl: url,
    // A sovereignty scan is a quick scan
    maxPages: (maxPages as number) || (sovereignty ? 500 : 50),
    ...(sovereignty ? { scanMode: 'sovereignty' as const } : {}),
    delay: (delay as number) ?? 200,
    ...batchContext(input),
    ...extra,
  });
}

export interface StartVideoscanUrlsInput extends BatchInput {
  urls?: unknown;
  maxPages?: unknown;
  delay?: unknown;
  mode?: unknown;
}

export async function startVideoscanUrlsTask(input: StartVideoscanUrlsInput, extra: ExtraContext = {}): Promise<Task> {
  const { urls, maxPages, delay, mode } = input;
  // scan.mjs runs a mode on a crawl only (it seeds the crawl with known video pages instead)
  if (mode !== undefined) throw new VideoscanRequestError(400, 'mode is only supported for a crawl (start-videoscan)');
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 500) {
    throw new VideoscanRequestError(400, 'urls must be an array of 1-500 URLs');
  }
  const invalidUrl = urls.find((u: string) => { try { new URL(u); return false; } catch { return true; } });
  if (invalidUrl) throw new VideoscanRequestError(400, `Invalid URL: ${invalidUrl}`);

  const domain = new URL(urls[0]).hostname;
  return createTask('videoscan', urls[0], getVideoscanDir(), {
    source: 'github',
    event: 'videoscan',
    title: `Videoscan: ${domain} (${urls.length} URLs)`,
    scanUrl: urls[0],
    urls,
    maxPages: (maxPages as number) || 50,
    delay: (delay as number) ?? 200,
    ...batchContext(input),
    ...extra,
  });
}
