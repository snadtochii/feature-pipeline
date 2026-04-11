---
name: test
description: "Test a feature through real browser interaction using Playwright, validating acceptance criteria. Use when user says 'test this feature', 'run UI tests', 'browser test', or 'E2E test'. NOT for unit tests — UI/E2E only."
allowed-tools: Read Write Edit Glob Grep Bash Task TodoWrite
argument-hint: "[ticket-id]"
---

# Test Stage (UI/E2E)

Test the feature through real browser interaction.

## Arguments

```
/feature-pipeline:test $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file.

## Prerequisites

The application must be running. Ask the user for the URL if not obvious from the project's `CLAUDE.md` or ticket frontmatter.

## Ticket Resolution & Artifacts Setup

Use the canonical logic in [`../feature-flow/references/ticket-resolution.md`](../feature-flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification (for acceptance criteria)
- `04-implementation.md` — implementation summary (recommended, for test context)

## Process

1. Spawn `feature-pipeline:ui-tester` subagent:
   - Prompt: "Test this feature through real browser interaction. Spec with acceptance criteria: `<ticket content from 01-spec.md>`. Implementation summary: `<from 04-implementation.md if available>`. Application URL: `<url>`. Test every acceptance criterion, take screenshots, check console for errors. Report bugs with reproduction steps."
   - The subagent has access to Playwright and Chrome DevTools MCP

2. Save output to `claudedocs/pipeline/<ticket-id>/06-tests.md`
   - If bugs found, also save individual bug files to `claudedocs/pipeline/<ticket-id>/bugs/BUG-NNN.md` (zero-padded to 3 digits)

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
