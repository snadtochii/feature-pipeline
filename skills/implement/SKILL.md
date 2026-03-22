---
name: implement
description: Implement a feature from an approved plan. Writes code, runs lint/tests, validates, and produces 04-implementation.md summary. Can run standalone or as part of feature-flow pipeline.
---

# Implement Stage

Implement the feature following the approved plan.

**This stage runs in the main conversation — NOT as a subagent.**

Follow the `feature-pipeline:implementer` agent behavioral guidelines.

## Arguments

```
/feature-pipeline:implement <ticket>
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

- `01-spec.md` — the ticket specification
- `03-plan.md` — the approved implementation plan (**required** — if not found, ask the user)

## Process

1. Read the approved plan from `claudedocs/pipeline/<ticket-id>/03-plan.md`
2. Read the project's CLAUDE.md and existing code patterns

### Code Implementation

3. For each task in the plan:
   a. Implement the change
   b. Run lint/typecheck — fix all errors immediately
   c. Run build (if applicable) — fix all compilation errors immediately

### Tests

4. After all code changes are implemented, write tests for new or modified code:
   - Follow the project's existing testing conventions (check CLAUDE.md, existing test files)
   - Run tests as you write them, fix failures immediately

### Validation

5. Run the full test suite
6. Run lint one final time

### Summary

7. Save implementation summary to `claudedocs/pipeline/<ticket-id>/04-implementation.md`:
   - Files created/modified (with brief description of each change)
   - Test files created/modified
   - Lint results (must be clean)
   - Test results (pass/fail counts, must all pass)
   - Any deviations from the plan with rationale

## Output

- **Artifact**: `claudedocs/pipeline/<ticket-id>/04-implementation.md`

## Presentation

Present to the user:

```
## Implementation Complete

[Summary: files changed, tests written, all passing, any deviations]

Artifacts saved to: claudedocs/pipeline/<ticket-id>/04-implementation.md
```

## Error Handling

- If lint/tests fail, fix them before presenting results — don't punt failures to the user
- If the plan is ambiguous, ask the user for clarification rather than guessing
