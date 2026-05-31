---
name: flow
description: "Run the full feature pipeline (plan → build) on a ticket. Use when user says 'run the pipeline', 'flow this ticket', 'flow it', or 'build this ticket end-to-end'. NOT for single-stage runs — use /feature:plan or /feature:build directly for those."
allowed-tools:
  - Read
  - Glob
  - Grep
  - TodoWrite
  - Skill
argument-hint: "[ticket-id] [--ignore-blockers]"
---

# Feature Flow Pipeline

Thin sequencer that runs `plan → build` on a ticket. Each stage owns its own state transitions (folder moves, frontmatter status) per [`references/state-transitions.md`](references/state-transitions.md); build owns the verdict gate end-to-end. Flow's job is to resolve the ticket, validate kind and blockers, decide which stages to invoke (per the resumption auto-detection table), and invoke them.

Each stage is a separate skill that can also be invoked directly:
- `/feature:plan` — pre-plan synthesis (codebase exploration + open-questions surfacing) followed by interactive plan mode; writes `02-plan.md`. Performs the start-of-pipeline state transition itself.
- `/feature:build` — implement → review → test as in-loop checkpoints; exits with verdict `pass | partial | stuck`; writes `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md`. Owns the verdict gate and the end-of-pipeline transitions.

## Arguments

```
/feature:flow $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket folder (e.g. `claudedocs/tickets/backlog/BL-1/`)
Remaining args = pipeline flags (see table below)

### Flags

| Flag | Effect | Example |
|------|--------|---------|
| `--ignore-blockers` | Bypass the `blocked_by` validation in flow's SETUP step 3; print a one-line warning and propagate the flag to plan + build invocations. | `--ignore-blockers` |

Resumption is auto-detected from on-disk artifacts — see "Resumption auto-detection" below. To start fresh against a partially-run ticket, delete the relevant artifacts before invoking flow.

### Examples
```
/feature:flow BL-1                              # full pipeline; auto-resumes if artifacts exist
/feature:flow BL-1 --ignore-blockers            # exploratory run on a blocked ticket
/feature:flow claudedocs/tickets/backlog/BL-1/  # by folder path
```

## Pipeline Order

**plan → build → completion**

Build runs implement, review, and test as internal checkpoints inside one continuous loop — those are not flow-managed stages and don't surface their own gates to flow.

---

## Stage Contract

Each stage reads and writes artifacts in `<ticket-folder>/`. This contract is load-bearing — build depends on plan's output landing in the expected place.

| Stage | Reads | Writes |
|---|---|---|
| `plan` | `01-spec.md`, `exploration.md` (optional seed — used for incremental Phase 1 synthesis if present) | `02-plan.md` (includes Codebase Context + Open Questions Resolved sections from Phase 1 synthesis) |
| `build` | `01-spec.md`, `02-plan.md` (plus whichever of `03-implementation.md`/`04-review.md`/`05-tests.md` exist on disk for auto-resumption) | `03-implementation.md` (live, updated per plan step), `04-review.md` (merged from 4 reviewer subagents), `05-tests.md` (UI test results or skip artifact), `06-summary.md` (always written, content varies per verdict) |

---

## Responsibilities

flow owns:
1. Ticket resolution (per `references/ticket-resolution.md`)
2. Kind validation (epic refusal) and blocker pre-check
3. Resumption auto-detection from on-disk artifacts (see below) — decides which stages to invoke
4. Stage invocation via `Skill plan` and `Skill build`

It does NOT own:
- State transitions (folder moves, frontmatter `status` updates) — plan and build perform these themselves per `references/state-transitions.md`
- The verdict gate — build owns it end-to-end (verdict, option menu, user-choice capture, transition dispatch)
- Stage internals — plan owns plan mode + Phase 1 synthesis; build owns its loop and checkpoints
- Agent coordination — plan and build spawn their own subagents
- Artifact writes — every artifact is written by the stage that produces it

---

## Resumption auto-detection

Flow inspects on-disk artifacts at start and routes to the right stage automatically. Users who want to start fresh against a partially-run ticket delete the relevant artifacts manually — git is the version-history layer if a backup is wanted.

**Routing table** (checked in order, first match wins):

| On disk | Routing |
|---|---|
| `06-summary.md` exists with verdict `pass` | Print "Pipeline already complete for `<ticket-id>` (verdict: pass). To re-run, delete the relevant artifacts (`02-plan.md` onward) or run a stage directly with `/feature:plan <id>` or `/feature:build <id>`." Exit without changes. |
| `06-summary.md` exists with verdict `partial` or `stuck` | Skip plan; invoke `/feature:build <ticket-id>` (build's own auto-resumption picks up where it left off). |
| `02-plan.md` exists, no `06-summary.md` | Skip plan; invoke `/feature:build <ticket-id>` (build's own auto-resumption picks up wherever its checkpoints landed). |
| Neither `02-plan.md` nor `06-summary.md` | Fresh start: invoke `/feature:plan <ticket-id>`, then `/feature:build <ticket-id>`. |

The user signals "start fresh on a partial ticket" by deleting `02-plan.md` (and downstream `03-`/`04-`/`05-`/`06-` if any). On the next flow invocation, the routing table matches the "neither exists" row and runs from scratch. Internal build checkpoints (implement → review → test inside one build invocation) write directly to the canonical artifacts — no special-casing needed.

---

## SETUP

1. **Resolve the ticket** using the canonical logic in [`references/ticket-resolution.md`](references/ticket-resolution.md). The ticket argument is `$1`.

2. **Validate kind** per [`references/ticket-resolution.md`](references/ticket-resolution.md) Step 4. If `kind: epic`, abort with the epic-refusal message — flow runs against children, not epics.

3. **Validate blockers** per [`references/ticket-resolution.md`](references/ticket-resolution.md) Step 6. If the ticket has `blocked_by` entries that aren't done (and `--ignore-blockers` was not passed), abort with the Step 6 message listing the unblocked blockers. With `--ignore-blockers`, print a one-line warning and propagate the flag to plan + build invocations:
   ```
   ⚠ Bypassing blocker check for <ticket-id>. Unfinished blockers: <list>. Proceeding anyway.
   ```

4. **Invalidate downstream artifacts** if `02-plan.md` is missing AND any of `03-implementation.md` / `04-review.md` / `05-tests.md` / `06-summary.md` exist on disk:
   - Delete each existing build artifact (the user signalled "start fresh" by removing `02-plan.md`).
   - Print: "Removed N downstream artifacts before re-running plan."
   - Skip this step on pure forward progress (no build artifacts on disk) or on auto-resumption runs that found `02-plan.md`.

---

## STAGE EXECUTION

Apply the resumption auto-detection routing table (above) to decide which stages to invoke:

- If `06-summary.md` exists with verdict `pass` — print the "already complete" message and exit.
- If `02-plan.md` exists (with or without `06-summary.md` reporting `partial`/`stuck`) — skip plan; invoke `Skill build` only. Build auto-resumes from on-disk artifacts per its own logic.
- Otherwise — invoke `Skill plan`, then (after plan returns) `Skill build`.

Both invocations propagate `--ignore-blockers` if it was passed to flow.

Plan and build perform their own state transitions (start-of-pipeline at start, end-of-pipeline at build's verdict gate) per [`references/state-transitions.md`](references/state-transitions.md). Flow does not touch folder state or frontmatter `status` directly.

After build returns, flow's work is done — build owns the verdict gate and has already applied the final transition. Flow exits cleanly.

---

## Artifact Convention

All artifacts live inside the per-ticket folder, numbered by stage order. There are two layouts depending on whether the ticket is solo or a child of a discover-produced epic.

### Solo ticket layout

```
claudedocs/tickets/<state>/<id>/        # the ticket folder; <state> ∈ {backlog, in-progress, done}
├── 01-spec.md              # The ticket — frontmatter (id, status, priority, ...) + spec body
├── exploration.md          # Discover-time codebase exploration (optional — only when the ticket went through /feature:discover)
├── 02-plan.md              # Implementation blueprint (includes Phase 1 synthesis as Codebase Context + Open Questions Resolved sections)
├── 03-implementation.md    # Implementation summary + validation results (live — updated per plan step)
├── 04-review.md            # Merged review findings (4 reviewer subagents)
├── 05-tests.md             # UI test results, skip artifact, or Failed Criteria section
└── 06-summary.md           # Build exit summary (always written, content varies per verdict)
```

### Epic with children layout (discover multi-mode output)

```
claudedocs/tickets/<state>/<EPIC-ID>/   # epic folder; <state> follows most-advanced child
├── prd.md                  # Parent PRD (frontmatter: kind: epic, children: [...]) — non-pipelineable
├── exploration.md          # Shared exploration, lives once for all siblings
└── tasks/
    ├── <CHILD-1-ID>/       # child ticket folder — same internal structure as a solo ticket above
    │   ├── 01-spec.md      # frontmatter: parent: <EPIC-ID>, blocked_by: [...] (optional)
    │   ├── 02-plan.md
    │   ├── 03-implementation.md
    │   ├── 04-review.md
    │   ├── 05-tests.md
    │   └── 06-summary.md
    ├── <CHILD-2-ID>/
    └── <CHILD-3-ID>/
```

The whole epic subtree moves between `<state>/` folders as a unit per [`references/state-transitions.md`](references/state-transitions.md) (Transitions 1, 2, and 3 each have epic-child variants). Per-child `status` lives in each child's `01-spec.md` frontmatter; epic-level `status` lives in `prd.md` and tracks the folder location.

**Naming rules:**
- Sequential: `NN-name.md` where `NN` is the stage order
- `01-spec.md` IS the ticket — it carries frontmatter (live state metadata) and the spec body. There is no separate "ticket file" outside the folder.
- `02`–`06` are reserved for canonical stages in order: `02-plan.md`, `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md`. Don't reuse numbers.
- Plain (un-numbered) filenames at the ticket-folder root are reserved for pre-spec / pre-stage artifacts (currently just `exploration.md`); for child tickets of an epic, the shared `exploration.md` lives one level up at the epic folder, not in the child folder.
- The ticket folder moves between state folders (`backlog/` → `in-progress/` → `done/`) as the pipeline advances. Everything inside moves with it.

---

## Standalone re-run guidance

To re-run a single stage outside flow, invoke the skill directly:
- `/feature:plan <id>` — re-runs Phase 1 synthesis + plan mode; overwrites `02-plan.md`.
- `/feature:build <id>` — auto-resumes from the latest on-disk artifact (`03-implementation.md`, `04-review.md`, or `05-tests.md`) per build's own resumption logic.

Stage skills handle their own ticket resolution and blocker validation; flow is not in the call chain when invoked this way.

## Continuation & Partial Runs

Resumption is auto-detected — see "Resumption auto-detection" above. The user signals "start fresh" by deleting `02-plan.md` (and downstream artifacts if they want a full reset).

When build exits `partial` or `stuck`, the verdict gate (owned by build) presents `accept-as-partial | continue-with-hint | abort`. The `continue-with-hint` path continues the build loop in-process with the user's hint added to context — there is no flow-level re-invocation.

## Error Handling

- **Stage skill failure** (plan or build crashes/returns an error mid-run): report it to the user and ask how to proceed (retry or abort).
- **Ticket not found**: defer to `references/ticket-resolution.md`'s error handling — ask the user for the correct path.
- **Project path can't be determined**: ask the user.
- **Blocker validation fails** without `--ignore-blockers`: abort at SETUP step 3; print the Step 6 message verbatim. The ticket folder stays in `backlog/` and frontmatter `status` is unchanged (flow has not touched state at this point).

Plan-mode cancellation, verdict-gate ambiguity, and verdict-vs-summary inconsistencies are all handled inside the stages that produce them (plan and build respectively), not in flow.
