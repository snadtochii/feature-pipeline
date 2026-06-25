---
name: plan
description: "Create an implementation plan for a ticket: pre-plan synthesis, then plan design."
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - TodoWrite
  - AskUserQuestion
argument-hint: "[ticket-id] [--visual]"
---

# Plan Stage

Two phases:

1. **Pre-plan synthesis** — automatic codebase exploration + open-questions surfacing, presented to the user before plan design.
2. **Plan design** — interactive plan mode by default; non-interactive when `flow` runs plan with `--auto` (designs the plan in normal conversation, no plan-mode gate).

**This stage runs in the main conversation — NOT as a subagent.** (The subagents in Phase 1 run from within this stage.)

## Arguments

```
/feature:plan $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file.

**Optional flag** `--auto` — set by `flow` when it invokes plan; runs plan **non-interactively** (auto mode: skips native plan mode, designs the plan in normal conversation, writes `02-plan.md`, returns). It is an internal flow→plan signal, not a user-facing knob — not advertised in `argument-hint`, but honored if present from any source. Without it (the standalone default), plan runs interactive plan mode.

**Optional flag** `--visual` — user-facing (default OFF). When set, after `02-plan.md` is written plan also generates `<ticket-folder>/02-plan.html` — a self-contained HTML review surface derived from the Markdown — and runs a conversational fold-back loop as the review gate (see [`references/visual-surface.md`](references/visual-surface.md)). Works in both interactive and auto mode, and is honored when `flow` propagates it. With the flag absent, none of the visual behavior runs and plan is byte-for-byte unchanged.

## Ticket Resolution & Artifacts Setup

Use the canonical logic in [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification
- `exploration.md` — optional, produced by `discover` if the ticket went through it; if present, used as a seed for incremental exploration. **Path depends on ticket shape**: at `<ticket-folder>/exploration.md` for solo tickets, or at `<epic-folder>/exploration.md` (one level above `tasks/<child>/`) for child tickets — see `../flow/references/ticket-resolution.md` Step 5.

## Epic refusal

Validate `kind` per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 4 before any work. If the ticket has `kind: epic`, abort and instruct the user to run plan against a child ticket instead — epics are non-pipelineable.

## Blocker-aware context loading

Per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 6, if the ticket has `blocked_by` entries, locate each blocker and load its available artifacts (`01-spec.md`, `02-plan.md`). Plan does NOT refuse on unfinished blockers — it reads the blocker artifacts alongside this ticket's spec when designing the plan, so the plan reasons against the planned dependency. Print one line per blocker loaded.

## State setup

Before Phase 1 synthesis, perform the start-of-pipeline transition per [`../flow/references/state-transitions.md`](../flow/references/state-transitions.md) Transition 1 (Start-of-pipeline: `backlog`/`review`/`done` → `in-progress`). Idempotent: if the ticket folder is already in `in-progress/`, no folder move; frontmatter `status` is still set to `in-progress` (overwriting any stale value). Re-planning a `review/` ticket (its PR is open but the code needs revision) is the intended `review/ → in-progress` revise path — plan pulls it back to `in-progress/` so the build loop rebuilds against the revised plan.

This makes plan self-sufficient when invoked standalone — the ticket folder ends up in the correct state regardless of whether flow or the user invoked it. When invoked via flow, build's later State setup is a no-op for the folder move (frontmatter overwrite is harmless).

`<ticket-folder>` is rebound to the new location for the rest of this run.

---

## PHASE 1 — Pre-plan synthesis

Spawned automatically before plan design. Produces a tight synthesis the user can react to in 30 seconds, not a 200-line document.

### Step 1.1 — Load context

Read all upfront inputs:
- `<ticket-folder>/01-spec.md` — the spec
- `exploration.md` — discover-time exploration if present (path resolution per ticket-resolution.md Step 5)
- Project `CLAUDE.md` — conventions, lint/test commands, architectural rules
- **Blocker artifacts** — for each `blocked_by` entry, the blocker's `01-spec.md` and (if present) `02-plan.md`
- `claudedocs/tickets/_lessons.md` — cross-ticket lessons learned, if the file exists. This is the cross-ticket log build appends to and reconciles (dedup / contradiction / stale-flag, user-gated) at every verdict gate. The contents become an additional context block passed to the requirements-analyst subagent in Step 1.3, so prior project-specific gotchas (deviating tools, invalidated assumptions, naming gotchas after refactors) inform the open-questions surface. If the file doesn't exist yet, skip — first ticket of the project.

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

<closing line — see "Closing line by mode" below>
```

If the Open Questions list is empty, say so explicitly: `**Open Questions**: none — the spec and discovery dialogue already resolved everything that's codebase-informed.` Move on.

**Closing line by mode:**
- **Interactive** (no `--auto`): end the briefing with "Entering plan mode. You can address questions inline as we plan."
- **Auto** (`--auto`): print the synthesis for auditability, then resolve open questions per the next block — do NOT print "Entering plan mode".

**Open-questions resolution by mode:**
- **Interactive**: questions are resolved inline as the user reacts during plan mode (Phase 2).
- **Auto** (`--auto`): auto-resolve every question that carries a **Default** (record it in the plan's "Open Questions Resolved" section as `auto-resolved: <default>`). Collect the questions flagged `**Default**: (no default — user call)`; if **one or more** exist, fire a **single** batched `AskUserQuestion` listing only those, then proceed. If **zero** no-default questions exist, fire no prompt at all — auto-resolve everything and continue to plan design. If the user cancels/declines the batched prompt, abort the run cleanly (do not write `02-plan.md`).

**Complexity overflow** (both modes): if the complexity reassessment is materially off (e.g., spec says M, analysis says XL), pause and surface:
```
⚠ Complexity overflow: spec sized this M, analysis suggests XL.
Options:
  → Proceed with the larger scope (longer build loop expected)
  → Cancel and re-run /discover with the new understanding to produce an epic + children
  → Type your decision before continuing
```
This pause fires in auto mode too — it's a genuine "should we even proceed" gate, not a plan-mode artifact.

---

## PHASE 2 — Plan design

Plan design runs in one of two modes, selected by the `--auto` flag (set by `flow`). Both modes produce the same `02-plan.md` following the **Plan Structure** below, and both run the **Plan Quality Checklist** before writing it. They differ only in whether native plan mode (and its approval gate) is used.

### Interactive mode (default — no `--auto`)

1. **Enter plan mode** — use `EnterPlanMode`. The Phase 1 synthesis is in conversation context; the user can reference patterns and resolve questions interactively.
2. **Design the plan** following the **Plan Structure** below, addressing the open questions inline as the user resolves them.
3. **Refine interactively** — respond to feedback, adjust the approach, answer questions. Iterate until the user exits plan mode.
4. **Validate** against the **Plan Quality Checklist** below before exiting plan mode.
5. **Save** — when the user approves (exits plan mode), save the plan to `<ticket-folder>/02-plan.md`.
6. **Visual surface (only if `--visual`)** — after `02-plan.md` is written, generate `02-plan.html` and run the conversational fold-back loop per [`references/visual-surface.md`](references/visual-surface.md): render → review-in-browser → fold `-> note`/pasted edits into `02-plan.md` → regenerate the HTML → repeat until approved. Additive to the plan-mode gate; skipped entirely when `--visual` is absent.

### Auto mode (`--auto` — set by `flow`)

No native plan mode: do NOT call `EnterPlanMode`/`ExitPlanMode` (there is no approval prompt — that's the point).

1. **Design the plan** in normal conversation following the **Plan Structure** below, using the open-questions resolutions from Phase 1 (auto-resolved defaults + any batched no-default answers).
2. **Validate** against the **Plan Quality Checklist** below.
3. **Write** `<ticket-folder>/02-plan.md`.
4. **Visual surface (only if `--visual`)** — generate `02-plan.html` from the just-written `02-plan.md` and run the conversational fold-back loop per [`references/visual-surface.md`](references/visual-surface.md). This deliberately re-introduces a review pause that auto mode otherwise avoids — the explicitly-requested cost of opting in (`--auto` governs plan-mode usage; `--visual` governs the review gate, and the two compose). When `--visual` is absent, skip straight to step 5 — the non-blocking handoff is unchanged.
5. **Return** — print the non-blocking "Plan Saved" summary (see Presentation) and hand control back to `flow`, which proceeds to build. No approval gate.

**Boundary (both modes):** plan writes `02-plan.md` (plus, when `--visual` is set, the derived `02-plan.html` sibling and, if needed, a one-line `.gitignore` entry to cover it) plus its State-setup transition. It does not edit source code — implementation is build's job.

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

## Plan Quality Checklist

Before writing `02-plan.md`, verify every item (both modes run this gate — interactive mode before exiting plan mode, auto mode before the `Write`):

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
- [ ] If `--visual` is set: the plan has the structured sections the HTML surface will render (Architecture Decision, Implementation Steps with Files, Open Questions Resolved, Build Sequence, Critical Details) — the post-write `02-plan.html` generation, graceful degradation, and gitignore guard then run per [`references/visual-surface.md`](references/visual-surface.md) and are verified there before the surface is presented

If any item fails, refine the plan before writing it.

---

## Output

- **Artifact**: `<ticket-folder>/02-plan.md`
- **Artifact (only when `--visual`)**: `<ticket-folder>/02-plan.html` — a derived, self-contained HTML review surface generated from `02-plan.md`. Never read back by any stage; gitignore-guarded so `--pr` won't sweep it into a PR (see [`references/visual-surface.md`](references/visual-surface.md)).

## Presentation

After saving the plan:

```
## Plan Saved

[Brief summary: architecture decision, step count, key files to change, build phases, open questions resolved count]

Artifacts saved to: <ticket-folder>/02-plan.md
```

When `--visual` was set, add a line: `Visual review surface: <ticket-folder>/02-plan.html — open it in your browser.` plus a note if `.gitignore` was updated to cover it.

## Error Handling

- If a Phase 1 subagent fails, report it to the user and ask: retry, skip the failed subagent and proceed with reduced context, or abort
- If the project path can't be determined from the ticket, ask the user
- If the synthesis surfaces a complexity overflow and the user chooses to cancel + re-discover, exit the skill cleanly without designing a plan (in interactive mode, without entering plan mode)
- In auto mode, if the user cancels the batched no-default open-questions prompt, abort cleanly without writing `02-plan.md`
