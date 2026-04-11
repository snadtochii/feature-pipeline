---
name: analyze
description: "Analyze a feature ticket by exploring the codebase and assessing spec completeness. Use when user says 'analyze ticket', 'explore codebase for', 'assess this spec', 'what gaps does this ticket have', or invokes /feature-pipeline:analyze. NOT for running the full pipeline — use feature-flow for that."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite
argument-hint: [ticket-id]
---

# Analyze Stage

Explore the codebase and analyze the feature specification for completeness and feasibility.

## Arguments

```
/feature-pipeline:analyze $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file.

## Ticket Resolution & Artifacts Setup

Use the canonical logic in [`../feature-flow/references/ticket-resolution.md`](../feature-flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification (created by resolution logic if missing)

## Process

**These two subagents MUST run sequentially** — the analyst needs the explorer's output.

1. Spawn `feature-pipeline:code-explorer` subagent:
   - Prompt: "Explore the codebase for project `<project>` to understand the areas relevant to: `<ticket title + description>`. Focus on: existing patterns, related files, architecture layers, and dependencies. The project root is at `<project-path>`."
   - Wait for it to complete before proceeding

2. Then, spawn `feature-pipeline:requirements-analyst` subagent:
   - Prompt: "Analyze this feature specification for completeness and feasibility. Here is the spec: `<ticket content>`. Here is the codebase context: `<explorer output>`. Identify gaps, edge cases, risks, and questions. Assess complexity."
   - This subagent returns the analysis

3. Save combined output to `claudedocs/pipeline/<ticket-id>/02-analysis.md`

## Output

- **Artifact**: `claudedocs/pipeline/<ticket-id>/02-analysis.md`

## Presentation

Present findings to the user:

```
## Analysis Complete

[Summary of key findings, gaps, questions]

Artifacts saved to: claudedocs/pipeline/<ticket-id>/02-analysis.md
```

## Error Handling

- If a subagent fails, report it to the user and ask: retry, skip, or abort
- If the project path can't be determined from the ticket, ask the user
