---
name: sync-ado-repos
description: Sync GitHub repos from bluebillywig org to an ADO "Repository" picklist field on all work item types
---

# Sync GitHub Repos to ADO Picklist

Fetches all repos from `github.com/bluebillywig` and creates/updates a `Custom.Repository` picklist field on all work item types in Azure DevOps.

## Process

Write and execute a Node.js script (temp file or `node -e`). Use built-in `fetch` (Node 18+).

**Auth headers:**
- GitHub: `Authorization: Bearer {GITHUB_TOKEN}`
- ADO: `Authorization: Basic {base64(':' + ADO_PAT)}`

**ADO API version:** `7.1` for all calls except field creation (`4.1-preview.1`).

### 1. Read credentials from `.env`

Parse `C:\dev\ai\orch\.env` for `ADO_ORG`, `ADO_PAT`, `ADO_PROJECT`, `GITHUB_TOKEN`. Use `fs.readFileSync` with line parsing (split on `=`, trim, strip quotes).

### 2. Fetch all repos from `github.com/bluebillywig`

```
GET https://api.github.com/orgs/bluebillywig/repos?per_page=100&page=N
```

Paginate until empty page. Extract `.name`, sort alphabetically, log count.

### 3. Find or create picklist

Check if field `Custom.Repository` already exists (see step 5) and read its `pickList.id`. Alternatively, search:

```
GET https://dev.azure.com/{org}/_apis/work/processes/lists?api-version=7.1
```

**Create** (if not found):
```
POST .../lists?api-version=7.1
Body: { "type": "String", "items": [...repos], "isSuggested": false }
```

**Update** (if found):
```
PUT .../lists/{listId}?api-version=7.1
Body: { "id": "{listId}", "items": [...repos], "isSuggested": false }
```

### 4. Get process ID and work item types

```
GET https://dev.azure.com/{org}/_apis/work/processes?api-version=7.1
```

Use first inherited (non-system) process. Then fetch WITs:

```
GET https://dev.azure.com/{org}/_apis/work/processes/{processId}/workitemtypes?api-version=7.1
```

### 5. Create field if it doesn't exist

Check if field exists at org level (404 = doesn't exist):
```
GET https://dev.azure.com/{org}/_apis/wit/fields/Custom.Repository?api-version=7.1
```

If not found, create it. Field creation with picklist binding requires the older `processdefinitions` API:
```
POST https://dev.azure.com/{org}/_apis/work/processdefinitions/{processId}/fields?api-version=4.1-preview.1
Body: { "name": "Repository", "type": "picklistString", "pickList": { "id": "{picklistId}" } }
```

### 6. Add field to all work item types

For each WIT ref name:
```
POST .../workItemTypes/{witRefName}/fields?api-version=7.1
Body: { "referenceName": "Custom.Repository" }
```

- Ignore **409** (field already added)
- Skip WITs that reject customization (log and continue)

### 7. Report

Output markdown summary: repos synced, picklist created vs updated, WITs updated vs skipped. Include reminder to install [Multivalue control extension](https://marketplace.visualstudio.com/items?itemName=ms-devlabs.vsts-extensions-multivalue-control) for multi-select.

## Important Notes

- Handle errors gracefully -- if one WIT rejects the field, log and continue
- Run with `node.exe` directly to avoid Git Bash shell issues

## Verification

1. ADO > Project Settings > Process > Work item type -- verify "Repository" field exists
2. Open a work item -- confirm repo dropdown shows all bluebillywig repos
3. If multi-select needed: install Multivalue control extension
