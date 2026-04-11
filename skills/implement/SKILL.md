---
name: implement
description: "Implement a feature from an approved plan — write code, run lint/tests, iterate until clean. Use when user says 'implement this', 'build the feature', 'execute the plan', or 'start implementing'. NOT for planning or reviewing."
allowed-tools: Read Write Edit Glob Grep Bash TodoWrite
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

Use the canonical logic in [`../feature-flow/references/ticket-resolution.md`](../feature-flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification (for acceptance criteria)
- `03-plan.md` — the approved implementation plan (**required** — if not found, ask the user)

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

Create or update `claudedocs/pipeline/<ticket-id>/04-implementation.md` with:
- Header (ticket, date, re-run feedback source if applicable)
- Empty section for each plan step
- Empty sections for tests, validation results, deviations

This is a **live** file — you'll update it after every step.

### 3. Execute plan steps

For each step in the plan, in order:

a. **Implement the change** following the plan's "Files" and "Pattern to follow" fields
b. **Run lint / typecheck** — fix any errors immediately before moving on
c. **Run build** (if applicable) — fix compilation errors immediately
d. **Update `04-implementation.md`** with:
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
- Update `04-implementation.md` with final validation results

### 6. Finalize the artifact

The complete `04-implementation.md` should contain:
- **Files created/modified** (per step, with brief description of each change)
- **Test files** created/modified
- **Lint results** (must be clean)
- **Test results** (pass/fail counts, must all pass)
- **Deviations** from the plan with rationale
- **Re-run notes** — what review/test feedback was addressed, if applicable

---

## Output

- **Artifact**: `claudedocs/pipeline/<ticket-id>/04-implementation.md` (updated incrementally throughout the process, finalized at the end)

## Presentation

Present to the user:

```
## Implementation Complete

[Summary: files changed, tests written, all passing, any deviations, re-run feedback addressed if applicable]

Artifacts saved to: claudedocs/pipeline/<ticket-id>/04-implementation.md
```

## Error Handling

- If lint/tests fail, fix them before presenting results — don't punt failures to the user
- If the plan is ambiguous, ask the user for clarification rather than guessing
- If a step can't be completed as specified, stop and flag it as a deviation before continuing
