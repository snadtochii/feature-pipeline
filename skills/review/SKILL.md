---
name: review
description: "Run parallel code reviews across correctness, security, performance, and architectural fit. Use when user says 'review these changes', 'check my code', 'run code review', or 'parallel review'. NOT for GitHub PR reviews."
allowed-tools: Read Glob Grep Bash Task TodoWrite
argument-hint: "[ticket-id]"
---

# Review Stage

Run parallel code reviews across four dimensions: correctness, security, performance, and architectural fit.

## Arguments

```
/feature-pipeline:review $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file.

## Ticket Resolution & Artifacts Setup

Use the canonical logic in [`../feature-flow/references/ticket-resolution.md`](../feature-flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- Code changes in the working tree (branch diff + unstaged changes)

## Process

### 1. Collect the diff

Gather all changes that should be reviewed, not just unstaged changes:

```bash
# Detect the base branch — prefer origin's HEAD, fall back to main
base=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/@@' || echo main)

# Branch-scope diff: everything committed on this branch since diverging from base
git diff "$base"...HEAD

# Unstaged changes on top of HEAD
git diff
```

If `origin/HEAD` isn't configured, default to `main`. If neither exists, ask the user which base branch to diff against.

Concatenate the branch-scope diff and unstaged diff as the review input. If the resulting diff is empty, report "No changes to review" and exit.

### 2. Spawn four subagents in parallel

All four run **concurrently** — launch them in a single message.

**a. `feature-pipeline:code-reviewer`** (correctness + quality):
> Review these code changes for correctness, bugs, logic errors, and adherence to project conventions. Changes: `<diff>`. Project root: `<project-path>`. Use confidence scoring — only report issues with confidence ≥ 80.

**b. `feature-pipeline:security-engineer`** (security):
> Review these code changes for security vulnerabilities. Changes: `<diff>`. Project root: `<project-path>`. Check for: input validation, auth issues, injection risks, data exposure, OWASP Top 10. Use confidence scoring — only report issues with confidence ≥ 80.

**c. `feature-pipeline:performance-engineer`** (performance):
> Review these code changes for performance issues. Changes: `<diff>`. Project root: `<project-path>`. Check for: N+1 queries, unnecessary re-renders, memory leaks, bundle size impact, algorithm complexity. Use confidence scoring — only report issues with confidence ≥ 80.

**d. `feature-pipeline:code-architect`** (architectural fit):
> Review these code changes for architectural fit. Changes: `<diff>`. Project root: `<project-path>`. Check for:
> - Does this change match existing patterns and conventions in the codebase?
> - Does it respect existing layer boundaries and abstractions?
> - Does it introduce unnecessary duplication or reinvent existing utilities?
> - Does the API/component design match the style of sibling code?
> - Are there coupling or cohesion concerns?
>
> Reference specific files and patterns with file:line. Use confidence scoring — only report issues with confidence ≥ 80.

### 3. Merge findings

Combine all four reviewers' output into `claudedocs/pipeline/<ticket-id>/05-review.md`:

- **Group by severity**: CRITICAL → WARNING → SUGGESTION
- **De-duplicate** overlapping findings (e.g., if both code-reviewer and code-architect flag the same issue)
- **Note which reviewer flagged each issue** (tag with `[correctness]`, `[security]`, `[performance]`, or `[architecture]`)
- **Include a summary** at the top: findings count per severity, per reviewer

## Output

- **Artifact**: `claudedocs/pipeline/<ticket-id>/05-review.md`

## Presentation

Present findings to the user:

```
## Review Complete

[Summary: issue counts by severity + by reviewer, key findings]

Artifacts saved to: claudedocs/pipeline/<ticket-id>/05-review.md
```

## Error Handling

- If a reviewer subagent fails, report it and continue with results from the other reviewers
- If there are no code changes (empty diff), report this and exit without running reviewers
- If `origin/HEAD` can't be determined, ask the user for the base branch before running the diff
