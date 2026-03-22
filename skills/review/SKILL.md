---
name: review
description: Run parallel code reviews for correctness, security, and performance. Spawns three reviewer agents and merges findings into 05-review.md. Can run standalone or as part of feature-flow pipeline.
---

# Review Stage

Run parallel code reviews across three dimensions: correctness, security, and performance.

## Arguments

```
/feature-pipeline:review <ticket>
```

- `<ticket>` — ticket ID (e.g. `BL-1`) or path to ticket file

## Ticket Resolution

1. If argument contains `/` or `.md`, read that file directly
2. If it looks like an ID (e.g. `BL-1`), search for it:
   - Check `.tickets/backlog/<id>.md`
   - Check `.tickets/in-progress/<id>.md`
   - Check `.tickets/review/<id>.md`
   - Try case-insensitive glob: `.tickets/**/*<id>*.md`
3. If not found, ask the user for the ticket path
4. Read the ticket content and extract frontmatter (id, title, project, tags)
5. Determine `<ticket-id>` from frontmatter `id` field, or slugified filename

## Artifacts Directory

- Path: `claudedocs/pipeline/<ticket-id>/`
- If it doesn't exist, create it and save the ticket content to `01-spec.md`
- If it exists, read existing artifacts for context

## Required Input

- Code changes in the working tree (via `git diff`)

## Process

1. Get the diff of all changes: `git diff` (or compare against the branch base)

2. Spawn three subagents **in parallel**:

   a. **`feature-pipeline:code-reviewer`** (correctness + quality):
      - Prompt: "Review these code changes for correctness, bugs, logic errors, and adherence to project conventions. Changes: `<git diff or file list>`. Project root: `<project-path>`. Use confidence scoring — only report issues with confidence >= 80."

   b. **`feature-pipeline:security-engineer`** (security):
      - Prompt: "Review these code changes for security vulnerabilities. Changes: `<git diff or file list>`. Project root: `<project-path>`. Check for: input validation, auth issues, injection risks, data exposure, OWASP Top 10."

   c. **`feature-pipeline:performance-engineer`** (performance):
      - Prompt: "Review these code changes for performance issues. Changes: `<git diff or file list>`. Project root: `<project-path>`. Check for: N+1 queries, unnecessary re-renders, memory leaks, bundle size impact, algorithm complexity."

3. Merge all findings into `claudedocs/pipeline/<ticket-id>/05-review.md`:
   - Group by severity (CRITICAL → WARNING → SUGGESTION)
   - De-duplicate overlapping findings
   - Note which reviewer flagged each issue

## Output

- **Artifact**: `claudedocs/pipeline/<ticket-id>/05-review.md`

## Presentation

Present findings to the user:

```
## Review Complete

[Summary: issue counts by severity, key findings]

Artifacts saved to: claudedocs/pipeline/<ticket-id>/05-review.md
```

## Error Handling

- If a reviewer subagent fails, report it and continue with results from the other reviewers
- If there are no code changes (empty diff), report this to the user
