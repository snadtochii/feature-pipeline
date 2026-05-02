---
name: plan
description: "Create an interactive implementation plan for a ticket in plan mode. Use when user says 'plan this ticket', 'create a plan for', 'let's plan', or 'design the implementation'. NOT for analysis or coding."
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

# Plan Stage

Create an implementation plan through interactive plan mode.

**This stage runs in the main conversation — NOT as a subagent.**

## Arguments

```
/feature-pipeline:plan $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file.

## Ticket Resolution & Artifacts Setup

Use the canonical logic in [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification
- `02-analysis.md` — analysis findings (warn if not found, but proceed — the user may have skipped analysis)

## Process

1. Read all existing context:
   - `<ticket-folder>/01-spec.md` — the spec
   - `<ticket-folder>/02-analysis.md` — gaps, risks, codebase context (if present)
   - Project `CLAUDE.md` — conventions, lint/test commands, architectural rules
2. Enter plan mode using `EnterPlanMode`
3. Explore the codebase — find existing patterns with concrete file:line references before designing anything new
4. Create an implementation plan following the **Plan Structure** below
5. Refine the plan interactively — respond to user feedback, adjust the approach, answer questions
6. Validate against the **Pre-exit quality checklist** before exiting plan mode
7. When the user approves (exits plan mode), save the plan to `<ticket-folder>/03-plan.md`

---

## Plan Structure

Every plan must contain these sections, in this order.

### Patterns & Conventions Found
Before designing anything, document what already exists:
- Existing patterns with **file:line references** (concrete, not abstract)
- Similar features in the codebase the implementation should mirror
- Key abstractions to reuse
- Project conventions from `CLAUDE.md` that constrain the design

### Architecture Decision
- **One chosen approach** with rationale — not a menu of options to choose from
- Trade-offs acknowledged (what the chosen approach gives up)
- Why this fits the existing codebase

### Implementation Steps
For each step, specify:
- **Goal**: what this step achieves (one sentence)
- **Files**: explicit paths to create or modify
- **Pattern to follow**: concrete file reference the step should mirror — point to an actual file, not an abstract description
- **Technical notes**: architectural pattern, library/API usage, integration points with existing code
- **Edge cases to handle**: validation rules, error states, empty/loading states, accessibility concerns, concurrency or race conditions
- **Scope**: target 2–4 hours of work per step — break down larger, merge trivially small

### Build Sequence
Phased order with dependencies. Use a checklist format:
```
Phase 1 — Foundations
- [ ] Step 1.1: <goal>
- [ ] Step 1.2: <goal>

Phase 2 — Feature logic
- [ ] Step 2.1: <goal>
...
```

### Critical Details
Called out separately because they're easy to miss:
- **Error handling strategy** — what errors can happen, how they surface to the user
- **State management** — where state lives, how it's synchronized
- **Testing approach** — what gets unit-tested, what gets integration-tested, what gets UI-tested
- **Performance considerations** — known hot paths, expected scale, any optimizations needed
- **Security considerations** — input validation, auth checks, data exposure risks

---

## Pre-exit Quality Checklist

Before exiting plan mode, verify every item:

- [ ] Each step lists specific files (create/modify) — no vague "update the auth layer"
- [ ] Each step has at least one "pattern to follow" file reference
- [ ] No step exceeds ~4 hours of estimated work
- [ ] No step is trivially small (merge it into a neighbor)
- [ ] Steps follow logical dependencies (earlier steps don't depend on later ones)
- [ ] All spec acceptance criteria are addressed by at least one step
- [ ] Edge cases identified per step, not just "TBD"
- [ ] Critical Details section covers errors, state, testing, perf, security — even if "N/A"

If any item fails, refine the plan before exiting plan mode.

---

## Output

- **Artifact**: `<ticket-folder>/03-plan.md`

## Presentation

After saving the plan:

```
## Plan Saved

[Brief summary: architecture decision, step count, key files to change, build phases]

Artifacts saved to: <ticket-folder>/03-plan.md
```
