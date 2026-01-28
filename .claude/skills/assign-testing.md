---
name: assign-testing
description: Distribute reviewed work items to team members for testing
---

# Testing Assignment Skill

Assign reviewed ADO work items to team members for testing. Distributes items evenly while respecting the rule: never assign to the person who resolved or reviewed the item.

## Arguments

- `--users "email1,email2,..."` - Comma-separated list of team member emails to receive assignments

## Process

### 1. Parse User List

Extract the list of selected users from the `--users` argument. If not provided, prompt for them.

### 2. Fetch Reviewed Items

Call the Orch API to get reviewed items in current sprint:

```bash
curl -s http://localhost:3003/api/sprint/reviewed-items | jq
```

### 3. Distribution Algorithm

For each reviewed item:
1. Get `resolvedBy` and `reviewedBy` from the item
2. Filter out users who match resolvedBy or reviewedBy
3. Among remaining eligible users, pick the one with fewest assigned items
4. Add to that user's assignment list

### 4. Execute Assignments

For each assignment, update the ADO work item's AssignedTo field:

```bash
# ADO PATCH API to update AssignedTo
curl -X PATCH \
  "https://dev.azure.com/{org}/_apis/wit/workitems/{id}?api-version=7.1" \
  -H "Content-Type: application/json-patch+json" \
  -H "Authorization: Basic {base64_pat}" \
  -d '[{"op": "replace", "path": "/fields/System.AssignedTo", "value": "{user_email}"}]'
```

Use the ADO_ORG and ADO_PAT from environment or prompt for them.

### 5. Report Results

Output a summary:

```markdown
## Testing Assignment Complete

Sprint: [Sprint Name]
Total Items: [N]
Users: [N]

### Assignments
| User | Items | IDs |
|------|-------|-----|
| user1@example.com | 3 | #123, #456, #789 |
| user2@example.com | 2 | #234, #567 |

### Skipped (no eligible assignees)
- #111 - Both resolver and reviewer in selected list
```

## Rules

1. **Never assign to resolver** - The person in `resolvedBy` should not test their own work
2. **Never assign to reviewer** - The person in `reviewedBy` already reviewed it
3. **Even distribution** - Balance items across all eligible users
4. **Skip if impossible** - If all selected users are ineligible for an item, skip it

## Environment Variables Required

- `ADO_ORG` - Azure DevOps organization
- `ADO_PAT` - Azure DevOps personal access token with Work Items write permission
- `ADO_PROJECT` - Azure DevOps project name
- `ADO_TEAM` - Azure DevOps team name

## Example

```
/assign-testing --users "alice@example.com,bob@example.com,charlie@example.com"
```

This will:
1. Fetch all reviewed items in current sprint
2. Distribute them among Alice, Bob, and Charlie
3. Skip items where the only eligible user is none (e.g., Alice resolved and Bob reviewed, but Charlie isn't available)
4. Update ADO work items with new AssignedTo values
