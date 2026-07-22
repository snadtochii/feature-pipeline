---
name: stack-first
description: "Consult the project's preferred ecosystem before adding any new library, framework, tool, or dependency — including during planning when a package is being recommended or chosen. Reads the docs/STACK.md decision ledger, live-checks the preferred ecosystem for an in-ecosystem analog, surfaces the trade-off, and records the verdict before any install."
allowed-tools:
  - Read
  - Write
  - Edit
  - WebFetch
  - WebSearch
  - mcp__context7__resolve-library-id
  - mcp__context7__query-docs
---

# Stack First

A dependency-selection procedure. Run it at every tech-selection moment — before proposing or installing any new library, framework, CLI, or service, and whenever a plan step names a new dependency.

This skill hardcodes **no** ecosystem facts and **no** project rulings. Everything project-specific lives in the consuming repo's `docs/STACK.md`. Ecosystem facts are looked up live, per run.

## Procedure

Run these five steps in order. Do not skip step 5 — recording the verdict is the point.

### 1. Read the decision ledger

Read `docs/STACK.md` in the consuming project (repo root `docs/`).

- **If it exists**, load its header (the declared preferred ecosystem: name + index URL) and its rows.
- **If it is absent**, offer to create it from the contract in the [docs/STACK.md contract](#docsstackmd-contract) section below. Seed the header with the project's preferred ecosystem (ask the user for the ecosystem name + URL if it is not obvious from the project). Do not fabricate rulings — create the file with a header and an empty table, then continue. If the user declines, proceed without a ledger but still surface the trade-off (step 4) and tell the user the verdict cannot be recorded.

### 2. Check for an existing ruling

Search the ledger rows for the candidate package or its use case.

- **Ruling found** — `adopted`: proceed, cite the row. `rejected`: stop and cite the row's reason; do not install unless the user explicitly overrides (then treat it as a new decision → step 4). `exception`: note the exception's scope and reason, confirm the current case falls under it.
- **No ruling** — continue to step 3.

### 3. Live-check the preferred ecosystem

Using the ecosystem index URL from the ledger header, check for an **in-ecosystem analog** to the candidate.

- Search the ecosystem's index/docs (WebSearch / WebFetch) for a package that covers the same need.
- Verify the candidate's and any analog's **current** status and docs — prefer context7 (`resolve-library-id` then `query-docs`) when the MCP is available; otherwise fetch the official docs directly. Confirm the package is maintained, not deprecated/abandoned, and that the API you plan to use is current.
- Never rely on memory for ecosystem contents or version facts — look them up.

### 4. Surface the trade-off

Present a short, honest comparison to the user:

- The candidate vs. the in-ecosystem analog (if one exists).
- Maintenance/abandonment status, current-docs findings, and the fit with the project's declared ecosystem.
- A recommendation, with the trade-off the recommendation gives up (per the project's own dependency policy: in-ecosystem is preferred unless there is a concrete disqualifier — abandoned, deprecated, early-alpha/unstable).

Let the user decide. Do not silently install.

### 5. Record the verdict

Before any install proceeds, append a row to `docs/STACK.md` capturing the decision (see the row format below). This is mandatory — the decision moment is the recording moment. If the ledger does not exist and the user declined creation in step 1, tell the user the verdict is unrecorded and stop short of installing on their behalf.

## docs/STACK.md contract

`docs/STACK.md` is the consuming project's dependency decision ledger. It lives at the repo root `docs/` and is committed (not a secret; it is project knowledge).

### Header

The header declares the project's preferred ecosystem — a name and its index URL — so step 3 knows where to live-check:

```markdown
# Stack decisions

**Preferred ecosystem:** TanStack — https://tanstack.com

Consult this ledger before adding any dependency. Prefer the in-ecosystem option
unless there is a concrete disqualifier (abandoned, deprecated, early-alpha).
```

(TanStack is only an illustration — each project declares its own.)

### Rows

One row per decision, in a Markdown table:

```markdown
| Package | Status | Date | Reason |
|---------|--------|------|--------|
| some-lib | adopted | 2026-07-21 | No in-ecosystem analog; maintained; API current. |
| other-lib | rejected | 2026-07-21 | TanStack Query covers this; other-lib adds overlap. |
| third-lib | exception | 2026-07-21 | One-off for X; not a general adoption. |
```

- **Package** — the candidate package/tool name.
- **Status** — one of `adopted`, `exception`, `rejected`.
- **Date** — ISO date of the decision.
- **Reason** — one line: why, referencing the ecosystem check.

The row format is documented here so the ledger can also be hand-edited directly, outside this skill.

## Boundaries

- Records decisions; never installs packages itself.
- Ships zero ecosystem catalog and zero project rulings — all project-specific knowledge is read from, or written to, the consuming repo's `docs/STACK.md`.
- Ecosystem facts are always looked up live (step 3); never answered from memory.
