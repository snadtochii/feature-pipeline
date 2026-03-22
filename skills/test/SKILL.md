---
name: test
description: Test a feature through real browser interaction using Playwright. Spawns ui-tester agent to verify acceptance criteria and produces 06-tests.md. Can run standalone or as part of feature-flow pipeline.
---

# Test Stage (UI/E2E)

Test the feature through real browser interaction.

## Arguments

```
/feature-pipeline:test <ticket>
```

- `<ticket>` — ticket ID (e.g. `BL-1`) or path to ticket file

## Prerequisites

The application must be running. Ask the user for the URL if not obvious from the project.

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

- `01-spec.md` — the ticket specification (for acceptance criteria)
- `04-implementation.md` — implementation summary (recommended, for test context)

## Process

1. Spawn `feature-pipeline:ui-tester` subagent:
   - Prompt: "Test this feature through real browser interaction. Spec with acceptance criteria: `<ticket content from 01-spec.md>`. Implementation summary: `<from 04-implementation.md if available>`. Application URL: `<url>`. Test every acceptance criterion, take screenshots, check console for errors. Report bugs with reproduction steps."
   - The subagent has access to Playwright and Chrome DevTools MCP

2. Save output to `claudedocs/pipeline/<ticket-id>/06-tests.md`
   - If bugs found, also save individual bug files to `claudedocs/pipeline/<ticket-id>/bugs/`

## Output

- **Artifact**: `claudedocs/pipeline/<ticket-id>/06-tests.md`
- **Bug reports** (if any): `claudedocs/pipeline/<ticket-id>/bugs/BUG-001.md`, etc.

## Presentation

Present results to the user:

```
## Testing Complete

[Summary: tests passed/failed, bugs found by severity]

Artifacts saved to: claudedocs/pipeline/<ticket-id>/06-tests.md
```

## Error Handling

- If the application is not running, ask the user to start it and provide the URL
- If the ui-tester subagent fails, report it and ask: retry or skip
