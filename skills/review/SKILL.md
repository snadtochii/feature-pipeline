---
name: review
description: "Run parallel code reviews across correctness, security, performance, and architectural fit. Use when user says 'review these changes', 'check my code', 'run code review', or 'parallel review'. NOT for GitHub PR reviews."
allowed-tools:
  - Read
  - Write
  - Glob
  - Grep
  - Bash
  - Task
  - TodoWrite
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

Use the canonical logic in [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- Code changes in the working tree (branch diff + unstaged changes)
- Project `CLAUDE.md` — read for lint/typecheck/build commands used by the deterministic validation step

## Epic refusal

Validate `kind` per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 4 before any work. If the ticket has `kind: epic`, abort and instruct the user to run review against a child ticket instead — epics are non-pipelineable.

## Blocker validation

Validate blockers per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 6. If any entry in `blocked_by` is not yet done, abort with the message in Step 6. Bypass with `--ignore-blockers` (prints a warning, proceeds — useful when reviewing a partial branch that integrates with unfinished blocker work).

## Process

### 0. Deterministic validation (fast-fail gate)

Cheap, deterministic checks run *before* spawning the expensive LLM reviewers. If any check fails, skip the parallel review entirely — there is no point asking 4 agents to review code that doesn't lint or compile.

1. **Read the project's `CLAUDE.md`** and look for lint / typecheck / build / test commands. Common locations: a `## Commands` section, a `Validation` section, or inline references to `npm run lint` / `pnpm test` / `cargo check` / `pytest` / etc.
2. **If no validation commands are documented**, log a single-line warning ("No validation commands found in project CLAUDE.md — proceeding to AI review without deterministic gate") and continue to step 1. Graceful degradation — the skill still works on projects without a documented setup.
3. **Run each documented check** via Bash, in order: lint first, then typecheck, then build. Stop on the first failure — later checks would pile on noise.
4. **If any check fails**, do NOT spawn the parallel reviewers. Instead:
   - Write a validation-failed `05-review.md` with this shape (single CRITICAL finding tagged `[validation]`):
     - **Verdict line:** "FAILED deterministic validation — AI review skipped"
     - **Summary counts:** `CRITICAL: 1 (validation)`, `WARNING: 0`, `SUGGESTION: 0`
     - **Finding body:** name of the failed check, the exact command run, and a trimmed excerpt of the failure output (roughly the first 30 lines)
     - **Fix guidance line:** "Re-run `/feature-pipeline:implement <ticket-id>` to address the failing check before requesting AI review"
   - Present the failure to the user with the guidance: "Deterministic validation failed — re-run implement to fix before AI review."
   - Exit the skill. flow treats this as a review gate failure with 1 CRITICAL finding, so its loop-back routing (and iteration budget) apply normally — this is a feature, not a bug: it means broken builds still count against the review ↔ implement budget, which keeps the feedback loop tight.
5. **If all checks pass**, proceed to step 1 below.

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

Combine all four reviewers' output into `<ticket-folder>/05-review.md`:

- **Group by severity**: CRITICAL → WARNING → SUGGESTION
- **De-duplicate** overlapping findings (e.g., if both code-reviewer and code-architect flag the same issue)
- **Note which reviewer flagged each issue** (tag with `[correctness]`, `[security]`, `[performance]`, or `[architecture]`)
- **Include a summary** at the top: findings count per severity, per reviewer

## Output

- **Artifact**: `<ticket-folder>/05-review.md`

## Presentation

Present findings to the user:

```
## Review Complete

[Summary: issue counts by severity + by reviewer, key findings]

Artifacts saved to: <ticket-folder>/05-review.md
```

## Error Handling

- If a reviewer subagent fails, report it and continue with results from the other reviewers
- If there are no code changes (empty diff), report this and exit without running reviewers
- If `origin/HEAD` can't be determined, ask the user for the base branch before running the diff
