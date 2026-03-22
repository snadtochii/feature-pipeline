---
name: analyze
description: Analyze a feature ticket by exploring the codebase and assessing spec completeness. Spawns code-explorer then requirements-analyst sequentially. Saves 02-analysis.md artifact. Can run standalone or as part of feature-flow pipeline.
---

# Analyze Stage

Explore the codebase and analyze the feature specification for completeness and feasibility.

## Arguments

```
/feature-pipeline:analyze <ticket>
```

- `<ticket>` — ticket ID (e.g. `BL-1`) or path to ticket file (e.g. `.tickets/backlog/dark-mode.md`)

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
- If it exists, read `01-spec.md` for the spec

## Required Input

- `01-spec.md` — the ticket specification (created above if missing)

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
