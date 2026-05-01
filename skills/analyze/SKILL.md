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
- `00-exploration.md` — optional, produced by `discovery` if the ticket went through it; if present, used as a seed for incremental exploration

## Process

**These two subagents MUST run sequentially** — the analyst needs the explorer's output.

1. **Check for a discovery-time exploration seed**. Look for `<ticket-folder>/00-exploration.md`:
   - **If it exists**, read its full content. Spawn `feature-pipeline:code-explorer` with an incremental prompt:
     > "Prior exploration has already been done for this feature by the discovery stage. Here is that exploration: `<content of 00-exploration.md>`. Your job is **incremental** — do NOT re-explore what's already covered. Instead, read the ticket spec and identify what additional codebase context is needed for ticket-scoped implementation (not idea-scoped): specific files that will be modified, integration points not yet traced, edge cases the existing exploration missed. Focus on: existing patterns relevant to the ticket's acceptance criteria, architecture layers the change will cross, and dependencies the change will touch. The project root is at `<project-path>`. Return *only* the additional context beyond what's already in the prior exploration."
   - **If it does not exist** (the ticket didn't go through discovery, or the file was deleted), spawn code-explorer with the full prompt:
     > "Explore the codebase for project `<project>` to understand the areas relevant to: `<ticket title + description>`. Focus on: existing patterns, related files, architecture layers, and dependencies. The project root is at `<project-path>`."
   - Wait for it to complete before proceeding.

2. Then, spawn `feature-pipeline:requirements-analyst` subagent:
   - Prompt: "Analyze this feature specification for completeness and feasibility. Here is the spec: `<ticket content>`. Here is the codebase context: `<00-exploration.md content, if present>` + `<incremental explorer output>` (or just the full explorer output if there was no seed). Identify gaps, edge cases, risks, and questions. Assess complexity."
   - This subagent returns the analysis

3. Save combined output to `<ticket-folder>/02-analysis.md`. The `02-analysis.md` should reference `00-exploration.md` explicitly if it was used, so a reader understands the full picture.

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
