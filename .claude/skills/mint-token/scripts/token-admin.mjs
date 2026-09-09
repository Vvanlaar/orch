#!/usr/bin/env node
// Manage orch/bb-support-web bearer tokens in tokens.json.
//
// The token file and its shape are owned by src/server/auth.ts — this script
// mirrors that contract exactly so the server accepts what it writes:
//   { "<token>": { name, createdAt, scopes: string[] } }
// Scopes: "support" (may hit /api/support/* only), "videoscan" (may run and
// read videoscans only) or "admin" (full access; admin satisfies every scope
// check). support and videoscan do NOT imply each other — pass --scope twice to
// grant both. A missing scopes list defaults to support (least privilege) in
// auth.ts, but we always write it explicitly.
//
// Usage:
//   node token-admin.mjs create "<name>" [--scope support|videoscan|admin ...]
//   node token-admin.mjs list
//   node token-admin.mjs revoke "<name-or-token>"

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const DATA_DIR = process.env.BB_SUPPORT_DATA_DIR || join(homedir(), '.claude', 'bb-support-web');
const TOKENS_FILE = join(DATA_DIR, 'tokens.json');

// Mirrors SCOPES in src/server/auth.ts. The legacy "*" alias is honored by the
// server on read but deliberately not mintable here.
const VALID_SCOPES = ['support', 'videoscan', 'admin'];

function load() {
  if (!existsSync(TOKENS_FILE)) return {};
  const parsed = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function save(tokens) {
  mkdirSync(dirname(TOKENS_FILE), { recursive: true });
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2) + '\n');
}

// A readable name-slug prefix makes tokens self-identifying in the file while
// the random tail supplies the entropy. Prefix is cosmetic; the whole string
// is the secret.
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 16) || 'user';
}

function mask(token) {
  return token.length <= 12 ? token : token.slice(0, 8) + '…';
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'create') {
  // Walk argv once, consuming each --scope's value, so the name can appear
  // before or after the flags. Picking "the first non---arg" instead would mint
  // a token *named* "videoscan" for `create --scope videoscan "Luuk"`.
  const scopes = [];
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--scope') {
      positional.push(rest[i]);
      continue;
    }
    const v = rest[++i];
    if (!v || v.startsWith('--')) {
      console.error('--scope needs a value.');
      process.exit(1);
    }
    if (!VALID_SCOPES.includes(v)) {
      console.error(`Invalid scope "${v}" — use ${VALID_SCOPES.join(', ')}.`);
      process.exit(1);
    }
    if (!scopes.includes(v)) scopes.push(v);
  }
  const name = positional.find((a) => !a.startsWith('--'));
  if (!name) {
    console.error(`Usage: create "<name>" [--scope ${VALID_SCOPES.join('|')} ...]`);
    process.exit(1);
  }
  if (scopes.length === 0) scopes.push('support');
  const tokens = load();
  const token = `${slug(name)}-${randomBytes(24).toString('base64url')}`;
  tokens[token] = { name, createdAt: new Date().toISOString(), scopes };
  save(tokens);
  console.log(token);
  console.error(`✓ Created ${scopes.join('+')} token for "${name}". Restart the server to load it.`);
} else if (cmd === 'list') {
  const tokens = load();
  const rows = Object.entries(tokens);
  if (rows.length === 0) {
    console.log('(no tokens)');
  } else {
    for (const [token, entry] of rows) {
      const scopes = Array.isArray(entry?.scopes) && entry.scopes.length ? entry.scopes.join(',') : 'support';
      console.log(`${mask(token).padEnd(10)}  ${(entry?.name || '(unnamed)').padEnd(24)}  [${scopes}]  ${entry?.createdAt || ''}`);
    }
  }
} else if (cmd === 'revoke') {
  const target = rest[0];
  if (!target) {
    console.error('Usage: revoke "<name-or-token>"');
    process.exit(1);
  }
  const tokens = load();
  // Match by exact token first, then by exact name (case-insensitive).
  let key = Object.hasOwn(tokens, target) ? target : null;
  if (!key) {
    const matches = Object.entries(tokens).filter(([, e]) => (e?.name || '').toLowerCase() === target.toLowerCase());
    if (matches.length > 1) {
      console.error(`Ambiguous: ${matches.length} tokens named "${target}". Revoke by token string instead.`);
      process.exit(1);
    }
    key = matches[0]?.[0] || null;
  }
  if (!key) {
    console.error(`No token found for "${target}".`);
    process.exit(1);
  }
  const removed = tokens[key];
  delete tokens[key];
  save(tokens);
  console.error(`✓ Revoked ${mask(key)} ("${removed?.name || 'unnamed'}"). Restart the server to enforce it.`);
} else {
  console.error('Usage: token-admin.mjs <create|list|revoke> ...');
  process.exit(1);
}
