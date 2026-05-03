---
name: implement
description: "Implement a feature from an approved plan — write code, run lint/tests, iterate until clean. Use when user says 'implement this', 'build the feature', 'execute the plan', or 'start implementing'. NOT for planning or reviewing."
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - TodoWrite
argument-hint: "[ticket-id]"
---

# Implement Stage

Implement the feature following the approved plan. Writes code, runs lint/tests, and iterates until all checks pass.

**This stage runs in the main conversation — NOT as a subagent.**

## Arguments

```
/feature-pipeline:implement $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file.

## Ticket Resolution & Artifacts Setup

Use the canonical logic in [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification (for acceptance criteria)
- `03-plan.md` — the approved implementation plan (**required** — if not found, ask the user)

## Epic refusal

Validate `kind` per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 4 before any work. If the ticket has `kind: epic`, abort and instruct the user to run implement against a child ticket instead — epics are non-pipelineable.

## Blocker validation

Validate blockers per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 6. If any entry in `blocked_by` is not yet done (frontmatter `status: done` or `cancelled`, or folder under `done/`), abort with the message in Step 6 listing the unblocked blockers. Bypass with `--ignore-blockers` (prints a warning, proceeds at your risk — you may break the build because the blocker's foundational work isn't in place).

## Re-run Inputs

When invoked after a review or test failure, **also read**:
- `05-review.md` — apply review fixes (critical first, then warnings)
- `bugs/*.md` — apply test-stage bug fixes (by severity)

Log which feedback source is being addressed at the top of the implementation summary.

---

## Behavioral Mindset

Ship working code, not scaffolding. Follow the plan precisely — if the plan says create 3 files, create exactly 3 files. Run lint and tests after every meaningful change, not just at the end. When checks fail, fix them immediately before moving on. Never leave TODO comments or placeholder implementations.

## Focus Areas

- **Plan Execution**: Follow approved implementation plans step-by-step, respecting task order and file boundaries
- **Code Quality**: Write production-ready code matching existing project conventions, patterns, and style
- **Validation Loop**: Run linter, type checker, and test suite after each step; fix failures before moving on
- **Convention Adherence**: Read project `CLAUDE.md` and existing code patterns before writing; match import style, naming, error handling
- **Incremental Progress**: Update `04-implementation.md` after each plan step completes — turn the artifact into a live checkpoint, not a post-hoc summary

## Boundaries

**Will:**
- Write complete, production-ready code following project conventions
- Run all available validation tools (lint, typecheck, tests) and fix failures
- Follow approved plans precisely, flagging any needed deviations before making them
- Update the implementation artifact incrementally

**Will Not:**
- Change the plan or architecture without explicit approval
- Skip validation steps or leave failing tests
- Add features beyond what the plan specifies (no scope creep)
- Leave TODO comments, placeholder functions, or mock implementations

---

## Process

### 1. Load context comprehensively (before writing any code)

Read every relevant input upfront:
- `03-plan.md` — the approved plan (required)
- `01-spec.md` — the original spec for acceptance criteria
- `02-analysis.md` — gaps and risks identified during analysis
- `05-review.md` — if re-running after review feedback
- `bugs/*.md` — if re-running after test failures
- Project `CLAUDE.md` — conventions, commands, architectural rules
- Existing code patterns mentioned in the plan's "Pattern to follow" references

### 2. Initialize the implementation artifact

Create or update `<ticket-folder>/04-implementation.md` with:
- Header (ticket, date, re-run feedback source if applicable)
- Empty section for each plan step
- Empty sections for tests, validation results, deviations

This is a **live** file — you'll update it after every step.

### 3. Execute plan steps

For each step in the plan, in order:

a. **Re-read the current step from `03-plan.md`** — use `Read` with `offset`/`limit` to load just the relevant step's section, not the whole plan. On long implementations the plan drifts out of working context by step 4 or 5; re-reading each step against its source is nearly free and prevents the most common long-session failure mode (plan drift). Do this *every* step, even if the previous one felt fresh.
b. **Implement the change** following the plan's "Files" and "Pattern to follow" fields
c. **Run lint / typecheck** — fix any errors immediately before moving on
d. **Run build** (if applicable) — fix compilation errors immediately
e. **Update `04-implementation.md`** with:
   - Files created/modified for this step
   - Brief description of what was done
   - Any deviations from the plan (with rationale)
   - Validation state (lint/typecheck/build status)

Do not move to the next step until the current step's validation is clean.

### 4. Write tests

After all code changes are in place:
- Write tests for new or modified code following project test conventions
- Run tests as you write them; fix failures immediately
- Update `04-implementation.md` with the test files created/modified

### 5. Final validation

- Run the full test suite — all must pass
- Run lint one final time — must be clean
- **Scope check** — compare the actual diff against the plan's file list:
  - Run `git diff --stat <base-branch>...HEAD` (plus unstaged) to get the real set of touched files and line counts
  - Extract the planned file list from `03-plan.md`'s "Files" fields across all steps
  - Compare: if the actual touched-file count exceeds the planned count by more than 2x, OR if files outside the planned scope were touched without being flagged as deviations in earlier steps, **record a scope deviation notice** in `04-implementation.md` under a `## Scope Deviations` section with the specific files that drifted and a short rationale
  - This is a **flag, not a block** — the implementation still proceeds to step 6, but the deviation is surfaced in the implement gate so flow and the user can decide whether to approve
  - Skip this check if `03-plan.md` doesn't list specific files (shouldn't happen if the plan passed its own quality checklist, but degrade gracefully)
- Update `04-implementation.md` with final validation results

### 6. Finalize the artifact

The complete `04-implementation.md` should contain:
- **Files created/modified** (per step, with brief description of each change)
- **Test files** created/modified
- **Lint results** (must be clean)
- **Test results** (pass/fail counts, must all pass)
- **Deviations** from the plan with rationale (per-step inline deviations)
- **Scope Deviations** (conditional — only written if step 5 flagged the actual diff as materially larger than the plan's file list). Lists the out-of-plan files and why they were touched.
- **Re-run notes** — what review/test feedback was addressed, if applicable

---

## Output

- **Artifact**: `<ticket-folder>/04-implementation.md` (updated incrementally throughout the process, finalized at the end)

## Presentation

Present to the user:

```
## Implementation Complete

[Summary: files changed, tests written, all passing, any deviations, re-run feedback addressed if applicable]

Artifacts saved to: <ticket-folder>/04-implementation.md
```

## Error Handling

- If lint/tests fail, fix them before presenting results — don't punt failures to the user
- If the plan is ambiguous, ask the user for clarification rather than guessing
- If a step can't be completed as specified, stop and flag it as a deviation before continuing
