---
name: analyze
description: "Analyze a feature ticket by exploring the codebase and assessing spec completeness. Use when user says 'analyze ticket', 'explore codebase for', 'assess this spec', or 'what gaps does this ticket have'. NOT for running the full pipeline."
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

# Analyze Stage

Explore the codebase and analyze the feature specification for completeness and feasibility.

## Arguments

```
/feature-pipeline:analyze $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file.

## Ticket Resolution & Artifacts Setup

Use the canonical logic in [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification (created by resolution logic if missing)
- `exploration.md` — optional, produced by `discover` if the ticket went through it; if present, used as a seed for incremental exploration. **Path depends on ticket shape**: at `<ticket-folder>/exploration.md` for solo tickets, or at `<epic-folder>/exploration.md` (one level above `tasks/<child>/`) for child tickets — see `../flow/references/ticket-resolution.md` Step 5.

## Process

**Refuse on epics**: before any work, validate `kind` per `../flow/references/ticket-resolution.md` Step 4. If the ticket has `kind: epic`, abort and instruct the user to run analyze against a child instead.

**Load blocker context**: per `../flow/references/ticket-resolution.md` Step 6, if the ticket has `blocked_by` entries, locate each blocker and load its available artifacts (`01-spec.md`, `02-analysis.md`, `03-plan.md`). Analyze does NOT refuse on unfinished blockers — it folds the blocker context into the subagent prompts below so the analysis reasons against the planned dependency rather than a blind codebase. Print one line per blocker loaded.

**These two subagents MUST run sequentially** — the analyst needs the explorer's output.

1. **Check for a discover-time exploration seed**. Resolve the exploration path per `../flow/references/ticket-resolution.md` Step 5: `<ticket-folder>/exploration.md` for solo tickets, `<epic-folder>/exploration.md` for child tickets:
   - **If it exists**, read its full content. Spawn `feature-pipeline:code-explorer` with an incremental prompt:
     > "Prior exploration has already been done for this feature by the discover stage. Here is that exploration: `<content of exploration.md>`. Your job is **incremental** — do NOT re-explore what's already covered. Instead, read the ticket spec and identify what additional codebase context is needed for ticket-scoped implementation (not idea-scoped): specific files that will be modified, integration points not yet traced, edge cases the existing exploration missed. Focus on: existing patterns relevant to the ticket's acceptance criteria, architecture layers the change will cross, and dependencies the change will touch. The project root is at `<project-path>`. Return *only* the additional context beyond what's already in the prior exploration."
   - **If it does not exist** (the ticket didn't go through discover, or the file was deleted), spawn code-explorer with the full prompt:
     > "Explore the codebase for project `<project>` to understand the areas relevant to: `<ticket title + description>`. Focus on: existing patterns, related files, architecture layers, and dependencies. The project root is at `<project-path>`."
   - Wait for it to complete before proceeding.

2. Then, spawn `feature-pipeline:requirements-analyst` subagent:
   - Prompt: "Analyze this feature specification for completeness and feasibility. Here is the spec: `<ticket content>`. Here is the codebase context: `<exploration.md content, if present>` + `<incremental explorer output>` (or just the full explorer output if there was no seed). Identify gaps, edge cases, risks, and questions. Assess complexity."
   - **If blocker context was loaded** (see "Load blocker context" above), append the Blocker Context section per `../flow/references/ticket-resolution.md` Step 6 to the prompt — it gives the analyst the dependency's spec/analysis/plan so it doesn't flag as gaps things the blocker is already designed to provide.
   - This subagent returns the analysis

3. Save combined output to `<ticket-folder>/02-analysis.md`. The `02-analysis.md` should reference `exploration.md` explicitly if it was used, so a reader understands the full picture.

## Output

- **Artifact**: `<ticket-folder>/02-analysis.md`

## Presentation

Present findings to the user:

```
## Analysis Complete

[Summary of key findings, gaps, questions]

Artifacts saved to: <ticket-folder>/02-analysis.md
```

## Error Handling

- If a subagent fails, report it to the user and ask: retry, skip, or abort
- If the project path can't be determined from the ticket, ask the user
