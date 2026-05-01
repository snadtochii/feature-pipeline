---
name: test
description: "Test a feature through real browser interaction using Playwright, validating acceptance criteria. Use when user says 'test this feature', 'run UI tests', 'browser test', or 'E2E test'. NOT for unit tests — UI/E2E only."
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

# Test Stage (UI/E2E)

Test the feature through real browser interaction.

## Arguments

```
/feature-pipeline:test $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file.

## Prerequisites

The application must be running. Ask the user for the URL if not obvious from the project's `CLAUDE.md` or ticket frontmatter.

The project's `CLAUDE.md` is also read to extract a **test framework hint** for the codification step (e.g., "uses Playwright, specs in `e2e/`"). If the project doesn't document its framework, codification is skipped — the manual test run still produces its normal output.

## Ticket Resolution & Artifacts Setup

Use the canonical logic in [`../feature-flow/references/ticket-resolution.md`](../feature-flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification (for acceptance criteria)
- `04-implementation.md` — implementation summary (recommended, for test context)

## Process

1. **Read the project's `CLAUDE.md` for a test framework hint** — look for a `## Testing` section, a `## Commands` section with a test runner, or inline references like "Playwright specs in `e2e/`" / "Vitest with tests in `__tests__/`". Capture the framework name, test directory, and test command if present. This hint is passed to the ui-tester subagent for the codification step; if no hint is found, note that and let codification degrade gracefully.

2. Spawn `feature-pipeline:ui-tester` subagent:
   - Prompt: "Test this feature through real browser interaction. Spec with acceptance criteria: `<ticket content from 01-spec.md>`. Implementation summary: `<from 04-implementation.md if available>`. Application URL: `<url>`. Project test framework hint: `<from step 1, or 'none documented'>`. Test every acceptance criterion, take screenshots, check console for errors. Report bugs with reproduction steps. If ALL acceptance criteria pass AND a test framework hint is available, codify the passing run into an automated spec file in the project's test directory — mirror the conventions of existing specs, never rewrite an existing spec, and never check in a flaky one."
   - The subagent has access to Playwright and Chrome DevTools MCP, plus `Write` and `Edit` for the codification step

3. Save output to `<ticket-folder>/06-tests.md`
   - If bugs found, also save individual bug files to `<ticket-folder>/bugs/BUG-NNN.md` (zero-padded to 3 digits)
   - If specs were codified, the `06-tests.md` should list their paths under a "Codified specs" section so feature-flow and the user can see what landed in the project tree

## Output

- **Artifact**: `<ticket-folder>/06-tests.md`
- **Bug reports** (if any): `<ticket-folder>/bugs/BUG-001.md`, etc.
- **Codified specs** (if all criteria passed and the project has a documented test framework): new files in the project's test directory, paths listed in `06-tests.md`. This is a **contract change** — the test stage now potentially writes to the project tree, not just to the ticket folder. Users who don't want codification can omit the test framework hint from their project `CLAUDE.md`.

## Presentation

Present results to the user:

```
## Testing Complete

[Summary: tests passed/failed, bugs found by severity]

Artifacts saved to: <ticket-folder>/06-tests.md
```

## Error Handling

- If the application is not running, ask the user to start it and provide the URL
- If the ui-tester subagent fails, report it and ask: retry or skip
