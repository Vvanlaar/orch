---
name: mint-token
description: Create, list, or revoke a bearer token for the orch / bb-support-web dashboard. Use whenever the user wants to grant someone access to orch — "create a token for <name>", "make a token", "add a user", "give <name> access", "revoke <name>'s token", "list tokens", "who has access", or "/mint-token". Tokens gate the orch API/WS and the bb-support web UI; this is the canonical way to manage them.
---

# Mint orch access tokens

orch's HTTP/WS surface and the bb-support web UI are gated by pre-shared bearer
tokens kept in a single JSON file. Each token maps to a person and a scope. This
skill mints, lists, and revokes them without hand-editing JSON.

## The token file

`~/.claude/bb-support-web/tokens.json` (override with `BB_SUPPORT_DATA_DIR`).
Shape is owned by [`src/server/auth.ts`](../../../src/server/auth.ts):

```json
{
  "koert-a3zrg…": { "name": "Koert", "createdAt": "2026-07-03T…Z", "scopes": ["support"] }
}
```

**Scopes** — pick the least privilege that does the job:
- `support` — may hit `/api/support/*` only. This is the default for colleagues.
- `admin` — full API + WebSocket + dashboard access. `admin` satisfies every
  scope check, so only grant it to people who administer orch itself.

## Do this

Run the bundled script from the skill directory (use `node.exe` on this
machine per the npm/node Windows notes):

```bash
# Create — prints the token to stdout, status to stderr
node scripts/token-admin.mjs create "Koert"                 # support (default)
node scripts/token-admin.mjs create "Vince" --scope admin   # admin

# List — masked tokens + name + scope + createdAt
node scripts/token-admin.mjs list

# Revoke — by name (case-insensitive) or full token string
node scripts/token-admin.mjs revoke "Koert"
```

## After minting or revoking: restart the server

The server reads `tokens.json` **once at boot** ([`index.ts`](../../../src/server/index.ts)
`const apiTokens = loadTokens()`). A new token won't authenticate — and a
revoked one won't stop working — until the server restarts. If the app is
running, restart it (see the `run-app` skill); if it's stopped, the change is
picked up on next launch. Always tell the user this.

## Handing the token to the person

Report the full token string once so the user can pass it along, and remind
them to share it **out-of-band** (Signal, in person) — never over email or a
chat log, since anyone holding it inherits the host's HubSpot/ADO access. The
recipient pastes it into the dashboard's token field (saved to `localStorage`
after first use) or sends it as `Authorization: Bearer <token>`.

## Notes

- The token string starts with a readable name-slug prefix purely so entries
  are identifiable in the file; the whole string is the secret.
- Revocation is deletion — there's no disable/re-enable. Re-create if needed.
- If two tokens share a name, `revoke` by name refuses and asks for the exact
  token string, so you can't drop the wrong one.
