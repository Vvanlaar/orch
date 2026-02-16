---
name: ado-fix-review-comments
description: Fix PR review comments, simplify code, and self-review
---

# Fix Review Comments Skill

## Process

### 1. Understand Each Comment
- Read the review comment carefully
- Understand what change is requested
- Check the surrounding code context via the diff hunk

### 2. Make Targeted Fixes
For each comment:
- Navigate to the file and line
- Implement the requested change
- Keep changes minimal and focused
- Maintain code style consistency

### 3. Run Code Simplifier
After all fixes:
- Run /code-simplifier on modified files
- Ensure code remains clean and readable

### 4. Self-Review
Before committing:
- Review all changes made
- Verify fixes are correct
- Check for regressions
- Ensure code style is consistent

### 5. Output Format
```
## Review Comment Fixes

### Comment 1: [file:line]
**Feedback:** [original comment]
**Fix:** [what was changed]

### Comment 2: [file:line]
...

## Code Simplification
[changes made by code-simplifier]

## Self-Review
- [ ] All comments addressed
- [ ] No regressions introduced
- [ ] Code style consistent
- [ ] Tests still pass (if applicable)
```
