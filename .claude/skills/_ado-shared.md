# ADO Shared Patterns

Common patterns used by all ADO skills. **Read this file at the start of any ADO skill.**

---

## Auth — CRITICAL: manual base64, NOT `-u`

`curl -u ":$ADO_PAT"` fails silently on Windows/MSYS2. Always:

```bash
source ~/.env
B64=$(printf ':%s' "$ADO_PAT" | base64 -w0)
curl -s -H "Authorization: Basic $B64" ...
```

## Env Vars (`~/.env`)

| Var | Value |
|-----|-------|
| `ADO_PAT` | Personal Access Token |
| `ADO_ORG` | `bluebillywig` |
| `ADO_PROJECT` | `BBNew` |
| `ADO_TEAM` | `Core` |
| `AZURE_DEVOPS_ORG_URL` | `https://dev.azure.com/bluebillywig` |

---

## Fetch Ticket

```bash
source ~/.env && B64=$(printf ':%s' "$ADO_PAT" | base64 -w0)
curl -s -H "Authorization: Basic $B64" \
  "https://dev.azure.com/bluebillywig/BBNew/_apis/wit/workitems/<ID>?api-version=7.0"
```

With full expansion (relations, comments):

```bash
curl -s -H "Authorization: Basic $B64" \
  "https://dev.azure.com/bluebillywig/BBNew/_apis/wit/workitems/<ID>?api-version=7.0&\$expand=all"
```

---

## Write JSON Payload + PATCH (Windows)

Inline `-d '...'` breaks with HTML. Write via node, use `cygpath` for the path:

```bash
node << 'NS'
const fp = require('path').join(require('os').tmpdir(), 'ado-payload.json');
require('fs').writeFileSync(fp, JSON.stringify([
  { op: 'replace', path: '/fields/FIELD', value: 'VALUE' }
]));
NS
WINPATH=$(cygpath -w "$LOCALAPPDATA/Temp/ado-payload.json")
source ~/.env && B64=$(printf ':%s' "$ADO_PAT" | base64 -w0)
curl -s -H "Authorization: Basic $B64" -X PATCH \
  -H "Content-Type: application/json-patch+json" \
  "https://dev.azure.com/bluebillywig/BBNew/_apis/wit/workitems/<ID>?api-version=7.0" \
  -d @"$WINPATH"
```

Use `"op":"add"` for new tickets, `"op":"replace"` for existing.

---

## Update Ticket State

```bash
source ~/.env && B64=$(printf ':%s' "$ADO_PAT" | base64 -w0)
curl -s -H "Authorization: Basic $B64" -X PATCH \
  -H "Content-Type: application/json-patch+json" \
  "https://dev.azure.com/bluebillywig/BBNew/_apis/wit/workitems/<ID>?api-version=7.0" \
  -d '[{"op":"replace","path":"/fields/System.State","value":"<STATE>"}]'
```

Common states: `New`, `In Progress`, `Resolved`, `Closed`

---

## Get Current Sprint

```bash
source ~/.env && B64=$(printf ':%s' "$ADO_PAT" | base64 -w0)
curl -s -H "Authorization: Basic $B64" \
  "https://dev.azure.com/bluebillywig/BBNew/Core/_apis/work/teamsettings/iterations?\$timeframe=current&api-version=7.0"
```

Returns `value[0].path` e.g. `BBNew\\Sprints 2026\\Q1\\Sprint 8.45`.

---

## Windows/MSYS2 Notes

| Issue | Fix |
|-------|-----|
| `/dev/stdin` | Resolves to `C:\dev\stdin` — never pipe into `node -e` reading stdin |
| `/tmp/` | Resolves to `C:\tmp\` — always use `require('os').tmpdir()` |
| Multi-line node | Use `node << 'NS' ... NS` heredoc, not `node -e "..."` inline |
| `npm`/`npx` | Use `npm.cmd` / `npx.cmd` in Git Bash |

---

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using `-u ":$ADO_PAT"` | Use manual base64 auth header |
| Inline `-d` with HTML/JSON | Write to temp file via node, use `-d @"$WINPATH"` |
| Empty curl response | Check `$ADO_PAT` is set; add `-w "\nHTTP_CODE:%{http_code}"` to debug |
| Using MCP tools for ADO | MCP may not be connected — fall back to curl |
| `/tmp/` paths | Use `require('os').tmpdir()` instead |
| `"op":"replace"` on create | New tickets: `"op":"add"`, existing: `"op":"replace"` |
