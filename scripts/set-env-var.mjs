// Idempotent set/replace of a single KEY=VALUE in .env.
// usage: node scripts/set-env-var.mjs KEY VALUE
import { readFileSync, writeFileSync, existsSync } from 'fs';

const [, , key, value] = process.argv;
if (!key || value === undefined) {
  console.error('usage: node scripts/set-env-var.mjs KEY VALUE');
  process.exit(1);
}

const path = '.env';
const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}=.*$`, 'm');
let next;
let action;
if (re.test(content)) {
  next = content.replace(re, `${key}=${value}`);
  action = 'updated';
} else {
  next = content + (content.endsWith('\n') || content.length === 0 ? '' : '\n') + `${key}=${value}\n`;
  action = 'appended';
}
writeFileSync(path, next);
console.log(`${action} ${key}=${value}`);
