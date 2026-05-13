import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getSupabase, isSupabaseConfigured } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('storage');

const BUCKET = 'videoscans';
let bucketEnsured = false;

async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  const { error } = await getSupabase().storage.createBucket(BUCKET, { public: false });
  if (error && !error.message.includes('already exists')) {
    log.error(`Failed to create bucket: ${error.message}`);
  }
  bucketEnsured = true;
}

export async function uploadFile(filename: string, localDir: string): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  const filePath = join(localDir, filename);
  if (!existsSync(filePath)) return false;

  await ensureBucket();
  const content = readFileSync(filePath);
  const contentType = filename.endsWith('.html') ? 'text/html'
    : filename.endsWith('.pdf') ? 'application/pdf'
    : filename.endsWith('.json') ? 'application/json'
    : 'application/octet-stream';

  const { error } = await getSupabase().storage
    .from(BUCKET)
    .upload(filename, content, { contentType, upsert: true });

  if (error) {
    log.error(`Upload failed ${filename}: ${error.message}`);
    return false;
  }
  log.info(`Uploaded ${filename}`);
  return true;
}

export async function uploadScanFiles(jsonFilename: string, localDir: string): Promise<void> {
  if (!isSupabaseConfigured()) return;

  const base = jsonFilename.replace('.json', '');
  const variants = [
    `${base}.json`,
    `${base}.html`,
    `${base}.pdf`,
    `${base}-preview.html`,
    `${base}-preview.pdf`,
  ];

  await Promise.all(
    variants
      .filter(f => existsSync(join(localDir, f)))
      .map(f => uploadFile(f, localDir))
  );
}

export async function deleteScanFiles(jsonFilename: string): Promise<void> {
  if (!isSupabaseConfigured()) return;

  const base = jsonFilename.replace('.json', '');
  const variants = [
    `${base}.json`,
    `${base}.html`,
    `${base}.pdf`,
    `${base}-preview.html`,
    `${base}-preview.pdf`,
  ];

  await ensureBucket();
  const { error } = await getSupabase().storage
    .from(BUCKET)
    .remove(variants);

  if (error) log.warn(`Storage delete failed for ${jsonFilename}: ${error.message}`);
  else log.info(`Deleted storage files for ${jsonFilename}`);
}

export type SignedUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'not-configured' | 'not-found' | 'sign-failed'; error?: string };

// Direct-from-Storage URL — avoids proxying 5-50MB reports through orch (doubles egress).
export async function createSignedUrl(filename: string, expiresIn = 3600): Promise<SignedUrlResult> {
  if (!isSupabaseConfigured()) return { ok: false, reason: 'not-configured' };
  await ensureBucket();
  const { data, error } = await getSupabase().storage
    .from(BUCKET)
    .createSignedUrl(filename, expiresIn);
  if (data?.signedUrl) return { ok: true, url: data.signedUrl };
  const message = error?.message || '';
  // supabase-js surfaces missing objects as "Object not found" / status 404
  const isNotFound = /not[\s_-]?found/i.test(message) || (error as { statusCode?: string | number } | null)?.statusCode === '404';
  if (isNotFound) return { ok: false, reason: 'not-found', error: message };
  log.warn(`Signed URL failed ${filename}: ${message || 'no url'}`);
  return { ok: false, reason: 'sign-failed', error: message };
}

export async function downloadFile(filename: string, localDir: string): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;

  await ensureBucket();
  const { data, error } = await getSupabase().storage
    .from(BUCKET)
    .download(filename);

  if (error || !data) {
    log.warn(`Download failed ${filename}: ${error?.message || 'no data'}`);
    return false;
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  writeFileSync(join(localDir, filename), buffer);
  log.info(`Downloaded ${filename}`);
  return true;
}
