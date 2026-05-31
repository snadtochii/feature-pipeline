---
name: plan
description: "Create an interactive implementation plan for a ticket. Runs a pre-plan synthesis (codebase exploration + open-questions surfacing) before entering plan mode. Use when user says 'plan this ticket', 'create a plan for', 'let's plan', or 'design the implementation'. NOT for coding."
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - TodoWrite
argument-hint: "[ticket-id]"
---

# Plan Stage

Two phases:

1. **Pre-plan synthesis** — automatic codebase exploration + open-questions surfacing, presented to the user before plan mode entry.
2. **Plan mode** — interactive design, refined against the synthesis.

**This stage runs in the main conversation — NOT as a subagent.** (The subagents in Phase 1 run from within this stage.)

## Arguments

```
/feature:plan $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file.

## Ticket Resolution & Artifacts Setup

Use the canonical logic in [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification
- `exploration.md` — optional, produced by `discover` if the ticket went through it; if present, used as a seed for incremental exploration. **Path depends on ticket shape**: at `<ticket-folder>/exploration.md` for solo tickets, or at `<epic-folder>/exploration.md` (one level above `tasks/<child>/`) for child tickets — see `../flow/references/ticket-resolution.md` Step 5.

## Epic refusal

Validate `kind` per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 4 before any work. If the ticket has `kind: epic`, abort and instruct the user to run plan against a child ticket instead — epics are non-pipelineable.

## Blocker-aware context loading

Per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 6, if the ticket has `blocked_by` entries, locate each blocker and load its available artifacts (`01-spec.md`, `02-plan.md`). Plan does NOT refuse on unfinished blockers — it reads the blocker artifacts alongside this ticket's spec when entering plan mode, so the plan reasons against the planned dependency. Print one line per blocker loaded.

## State setup

Before Phase 1 synthesis, perform the start-of-pipeline transition per [`../flow/references/state-transitions.md`](../flow/references/state-transitions.md) Transition 1 (Start-of-pipeline: `backlog`/`done` → `in-progress`). Idempotent: if the ticket folder is already in `in-progress/`, no folder move; frontmatter `status` is still set to `in-progress` (overwriting any stale value).

This makes plan self-sufficient when invoked standalone — the ticket folder ends up in the correct state regardless of whether flow or the user invoked it. When invoked via flow, build's later State setup is a no-op for the folder move (frontmatter overwrite is harmless).

`<ticket-folder>` is rebound to the new location for the rest of this run.

---

## PHASE 1 — Pre-plan synthesis

Spawned automatically before plan mode entry. Produces a tight synthesis the user can react to in 30 seconds, not a 200-line document.

### Step 1.1 — Load context

Read all upfront inputs:
- `<ticket-folder>/01-spec.md` — the spec
- `exploration.md` — discover-time exploration if present (path resolution per ticket-resolution.md Step 5)
- Project `CLAUDE.md` — conventions, lint/test commands, architectural rules
- **Blocker artifacts** — for each `blocked_by` entry, the blocker's `01-spec.md` and (if present) `02-plan.md`
- `claudedocs/tickets/_lessons.md` — cross-ticket lessons learned, if the file exists. This is the append-only log build writes at every verdict gate. The contents become an additional context block passed to the requirements-analyst subagent in Step 1.3, so prior project-specific gotchas (deviating tools, invalidated assumptions, naming gotchas after refactors) inform the open-questions surface. If the file doesn't exist yet, skip — first ticket of the project.

### Step 1.2 — Spawn `code-explorer` subagent (incremental)

**If `exploration.md` exists**, prompt the explorer to do incremental work:

> "Prior exploration has already been done for this feature by the discover stage. Here is that exploration: `<content of exploration.md>`. Your job is **incremental** — do NOT re-explore what's already covered. Read the ticket spec and identify what additional codebase context is needed for ticket-scoped implementation: specific files that will be modified, integration points not yet traced, edge cases the existing exploration missed. Focus on existing patterns relevant to the ticket's acceptance criteria, architecture layers the change will cross, and dependencies the change will touch. Project root: `<project-path>`. Return only the additional context beyond what's already in the prior exploration, with concrete `file:line` references."

**If no `exploration.md`**, prompt the explorer to do a full ticket-scoped sweep:

> "Explore the codebase for project `<project>` to understand the areas relevant to: `<ticket title + description>`. Focus on: existing patterns relevant to the ticket's acceptance criteria, related files, architecture layers, and dependencies. Project root: `<project-path>`. Return concrete `file:line` references."

### Step 1.3 — Spawn `requirements-analyst` subagent (focused on open questions)

The analyst's job here is **NOT** to write a long analysis. It's to surface a short, actionable Open Questions list.

> "Review this feature spec against the codebase context to surface every open question whose answer materially shapes the implementation. Spec: `<ticket content>`. Codebase context: `<exploration.md content if present>` + `<incremental explorer output>`. Blocker context (if any): `<blocker spec(s) + plan(s) per Blocker Context format>`. Cross-ticket lessons (if `_lessons.md` exists): `<contents of claudedocs/tickets/_lessons.md>` — these are project-specific gotchas captured at prior tickets' verdict gates; weight them when scanning for open questions, since a recurring constraint that bit a prior ticket is exactly the kind of question worth surfacing here.
>
> Guidance:
> - Prefer few sharp questions over many shallow ones, but **never skip a real decision-making question** to hit a tidy count. If there are nine important questions, ask all nine. Quality bar: would skipping this question force the agent to assume something that could break the feature? If yes, ask it.
> - Lean toward **codebase-informed** or **integration-informed** questions — spec-level gaps should mostly have been resolved during discover's Phase 3. But if a spec-answerable question genuinely requires a user decision (the spec is ambiguous, two readings give different implementations, or the spec's intent doesn't match what the codebase expects), surface it. Better to ask than assume.
> - For each question, propose a **default answer** with a one-line rationale, so the user can confirm rather than originate. If you genuinely have no defensible default (pure user judgment, business preference), say so explicitly: `**Default**: (no default — user call)`.
> - Categorize each question by area: `[edge-case]`, `[integration]`, `[scope-clarification]`, `[risk]`, `[performance]`, or `[ambiguity]`.
> - If you genuinely find no questions that require user decisions, return an empty list — do not pad.
>
> Format each question as:
> ```
> N. <question> [<area>]
>    **Default**: <answer> — <rationale>
> ```
>
> Also return: a one-line **complexity reassessment** if the analysis reveals the ticket is materially bigger or smaller than its `complexity:` field suggests. Format: `Complexity: spec says <X>; analysis suggests <Y> — <reason>.` If they agree, return: `Complexity: spec's <X> is accurate.`"

### Step 1.4 — Present synthesis to the user

Format the output as a tight pre-plan-mode briefing:

```
## Pre-plan synthesis for <ticket-id>

**Codebase patterns to use** (top relevant, with file:line):
- <pattern 1> — `<file:line>`
- <pattern 2> — `<file:line>`
- <pattern 3> — `<file:line>`

**Open Questions** (resolve before/during planning):
1. <question> [<area>]
   **Default**: <answer> — <rationale>
...

**Complexity check**: <complexity reassessment line>

Entering plan mode. You can address questions inline as we plan.
```

If the Open Questions list is empty, say so explicitly: `**Open Questions**: none — the spec and discovery dialogue already resolved everything that's codebase-informed.` Move on.

If the complexity reassessment is materially off (e.g., spec says M, analysis says XL), pause briefly and surface:
```
⚠ Complexity overflow: spec sized this M, analysis suggests XL.
Options:
  → Proceed to plan with the larger scope (longer build loop expected)
  → Cancel and re-run /discover with the new understanding to produce an epic + children
  → Type your decision before plan mode entry
```

---

## PHASE 2 — Plan mode

### Step 2.1 — Enter plan mode

Use `EnterPlanMode`. The synthesis from Phase 1 is in conversation context — the user can reference patterns and resolve questions interactively.

### Step 2.2 — Design the plan

Create an implementation plan following the **Plan Structure** below, addressing the open questions inline as the user resolves them.

### Step 2.3 — Refine interactively

Respond to user feedback, adjust the approach, answer questions. Iterate until the user exits plan mode.

### Step 2.4 — Validate against checklist

Validate against the **Pre-exit quality checklist** below before exiting plan mode.

### Step 2.5 — Save the plan

When the user approves (exits plan mode), save the plan to `<ticket-folder>/02-plan.md`.

---

## Plan Structure

Every plan must contain these sections, in this order.

### Codebase Context
Concrete patterns, files, and abstractions the implementation will use. Promoted from Phase 1's pre-plan synthesis. Each entry has a `file:line` reference.

### Open Questions Resolved
The Phase 1 questions list, with the user's answers (or "plan around it" notes) captured inline. This becomes the audit trail for which gaps were addressed and how.

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

- [ ] Codebase Context section lists concrete `file:line` references — no abstract pattern names
- [ ] Open Questions Resolved section has an answer or "plan around it" note for every Phase 1 question
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

- **Artifact**: `<ticket-folder>/02-plan.md`

## Presentation

After saving the plan:

```
## Plan Saved

[Brief summary: architecture decision, step count, key files to change, build phases, open questions resolved count]

Artifacts saved to: <ticket-folder>/02-plan.md
```

## Error Handling

- If a Phase 1 subagent fails, report it to the user and ask: retry, skip the failed subagent and proceed with reduced context, or abort
- If the project path can't be determined from the ticket, ask the user
- If the synthesis surfaces a complexity overflow and the user chooses to cancel + re-discover, exit the skill cleanly without entering plan mode
