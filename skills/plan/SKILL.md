---
name: plan
description: Create an interactive implementation plan in plan mode. Reads analysis artifacts, explores the codebase, and produces 03-plan.md blueprint. Can run standalone or as part of feature-flow pipeline.
---

# Plan Stage

Create an implementation plan through interactive plan mode.

**This stage runs in the main conversation — NOT as a subagent.**

## Arguments

```
/feature-pipeline:plan <ticket>
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
- `02-analysis.md` — analysis findings (warn if not found, but proceed — the user may have skipped analysis)

## Process

1. Read the analysis findings from `claudedocs/pipeline/<ticket-id>/02-analysis.md`
2. Enter plan mode using `EnterPlanMode`
3. Explore the codebase as needed (read files, search for patterns, understand architecture)
4. Create an implementation plan that:
   - Addresses gaps and risks identified in the analysis
   - Lists specific files to create/modify
   - Describes component design and data flow
   - Defines a phased build sequence
   - Notes key decisions and trade-offs
5. The user can interactively refine the plan in plan mode — respond to feedback, adjust approach, answer questions
6. When the user approves the plan (exits plan mode), save it to `claudedocs/pipeline/<ticket-id>/03-plan.md`

## Output

- **Artifact**: `claudedocs/pipeline/<ticket-id>/03-plan.md`

## Presentation

After saving the plan:

```
## Plan Saved

[Brief summary of the plan: key decisions, files to change, build sequence]

Artifacts saved to: claudedocs/pipeline/<ticket-id>/03-plan.md
```
