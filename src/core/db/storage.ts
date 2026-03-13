import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getSupabase, isSupabaseConfigured } from './client.js';
import { createLogger } from '../logger.js';

const log = createLogger('storage');

const BUCKET = 'videoscans';
let bucketEnsured = false;

/**
 * Ensure the storage bucket exists (creates on first use).
 */
async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;
  const { error } = await getSupabase().storage.createBucket(BUCKET, { public: false });
  if (error && !error.message.includes('already exists')) {
    log.error(`Failed to create bucket: ${error.message}`);
  }
  bucketEnsured = true;
}

/**
 * Upload a file to Supabase Storage. Overwrites if exists.
 */
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

/**
 * Upload all files for a scan (JSON + HTML + PDF + preview variants).
 */
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

/**
 * Download a file from Supabase Storage to local dir. Returns true if successful.
 */
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
