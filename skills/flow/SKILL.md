---
name: flow
description: "Run the full feature pipeline on a ticket or an epic. For single tickets: plan → build. For epics (kind: epic): walks children in blocked_by topological order, recursing into per-child flow. Use when user says 'run the pipeline', 'flow this ticket', 'flow this epic', 'flow it', or 'build this ticket end-to-end'. NOT for single-stage runs — use /feature:plan or /feature:build directly for those."
allowed-tools:
  - Read
  - Glob
  - Grep
  - TodoWrite
  - Skill
argument-hint: "[ticket-id|epic-id] [--ignore-blockers]"
---

# Feature Flow Pipeline

Thin sequencer with two modes:

- **Single-ticket mode** (default): runs `plan → build` on the resolved ticket. Each stage owns its own state transitions (folder moves, frontmatter status) per [`references/state-transitions.md`](references/state-transitions.md); build owns the verdict gate end-to-end.
- **Epic mode** (when the resolved folder has `kind: epic` on `prd.md`): walks children in `blocked_by` topological order, recursively invoking `Skill flow` per child. Per-child state transitions and the all-children-done epic-subtree move fire inside each child's build verdict gate.

Flow's job in both modes is to resolve, validate, decide what to invoke, and invoke. It does not touch folder state, frontmatter, or artifact files directly.

Each stage is a separate skill that can also be invoked directly:
- `/feature:plan` — pre-plan synthesis (codebase exploration + open-questions surfacing) followed by plan design; writes `02-plan.md`. Performs the start-of-pipeline state transition itself. Flow always invokes it with `--auto` (non-interactive — no plan-mode gate); run directly without flow, it uses interactive plan mode.
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
/feature:flow BL-1                              # single-ticket; auto-resumes if artifacts exist
/feature:flow BL-1 --ignore-blockers            # exploratory run on a blocked ticket
/feature:flow claudedocs/tickets/backlog/BL-1/  # by folder path
/feature:flow EPIC-1                            # epic-mode: walks children in dependency order
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
- Stage internals — plan owns its Phase 1 synthesis and plan design (interactive plan mode standalone, non-interactive under `--auto`); build owns its loop and checkpoints
- Agent coordination — plan and build spawn their own subagents
- Artifact writes — every artifact is written by the stage that produces it

---

## Resumption auto-detection (single-ticket mode)

Flow inspects on-disk artifacts at start and routes to the right stage automatically. Users who want to start fresh against a partially-run ticket delete the relevant artifacts manually — git is the version-history layer if a backup is wanted.

**Routing table** (checked in order, first match wins):

| On disk | Routing |
|---|---|
| Ticket folder is in `review/` (status `in-review`) | PR is open — skip plan; invoke `/feature:build <ticket-id>` (pass-through). Build owns the merge-check: it finalizes the ticket to `done/` via Transition 6 if the PR has merged, else reports the still-open PR. Must be checked **first** so a `review/` ticket whose `06-summary.md` reads `pass` isn't mistaken for "already complete." |
| `06-summary.md` exists with verdict `pass` | Print "Pipeline already complete for `<ticket-id>` (verdict: pass). To re-run, delete the relevant artifacts (`02-plan.md` onward) or run a stage directly with `/feature:plan <id>` or `/feature:build <id>`." Exit without changes. |
| `06-summary.md` exists with verdict `partial` or `stuck` | Skip plan; invoke `/feature:build <ticket-id>` (build's own auto-resumption picks up where it left off). |
| `02-plan.md` exists, no `06-summary.md` | Skip plan; invoke `/feature:build <ticket-id>` (build's own auto-resumption picks up wherever its checkpoints landed). |
| Neither `02-plan.md` nor `06-summary.md` | Fresh start: invoke `/feature:plan <ticket-id>`, then `/feature:build <ticket-id>`. |

The user signals "start fresh on a partial ticket" by deleting `02-plan.md` (and downstream `03-`/`04-`/`05-`/`06-` if any). On the next flow invocation, the routing table matches the "neither exists" row and runs from scratch. Internal build checkpoints (implement → review → test inside one build invocation) write directly to the canonical artifacts — no special-casing needed.

**Epic-mode** has its own implicit resumption: the walker skips children whose `status` is already `done`, `partial-completion`, or `cancelled` (per EPIC-MODE EXECUTION step 4a). Each remaining child inherits the single-ticket routing table above via the recursive flow call.

---

## SETUP

1. **Resolve the ticket** using the canonical logic in [`references/ticket-resolution.md`](references/ticket-resolution.md). The ticket argument is `$1`.

2. **Branch on `kind`** (read from frontmatter — `prd.md` if the folder is an epic, `01-spec.md` otherwise):
   - `kind: epic` → proceed to **EPIC-MODE EXECUTION** below; skip the remaining SETUP steps (epic walker handles per-child blocker validation and artifact invalidation by recursing into single-ticket flow per child).
   - Otherwise (no `kind` field, or `kind` has a non-`epic` value) → single-ticket mode; continue with steps 3–4.

3. **Validate blockers** per [`references/ticket-resolution.md`](references/ticket-resolution.md) Step 6. If the ticket has `blocked_by` entries that aren't done (and `--ignore-blockers` was not passed), abort with the Step 6 message listing the unblocked blockers. With `--ignore-blockers`, print a one-line warning and propagate the flag to plan + build invocations:
   ```
   ⚠ Bypassing blocker check for <ticket-id>. Unfinished blockers: <list>. Proceeding anyway.
   ```

4. **Invalidate downstream artifacts** if `02-plan.md` is missing AND any of `03-implementation.md` / `04-review.md` / `05-tests.md` / `06-summary.md` exist on disk:
   - Delete each existing build artifact (the user signalled "start fresh" by removing `02-plan.md`).
   - Print: "Removed N downstream artifacts before re-running plan."
   - Skip this step on pure forward progress (no build artifacts on disk) or on auto-resumption runs that found `02-plan.md`.

---

## STAGE EXECUTION (single-ticket mode)

Apply the resumption auto-detection routing table (above) to decide which stages to invoke:

- If `06-summary.md` exists with verdict `pass` — print the "already complete" message and exit.
- If `02-plan.md` exists (with or without `06-summary.md` reporting `partial`/`stuck`) — skip plan; invoke `Skill build` only. Build auto-resumes from on-disk artifacts per its own logic.
- Otherwise — invoke `Skill plan` **with `--auto`** (non-interactive plan; this is what makes flow's plan→build handoff seamless — no plan-mode approval gate), then (after plan returns) `Skill build`.

Both invocations propagate `--ignore-blockers` if it was passed to flow. Flow additionally always passes `--auto` to `Skill plan` (build has no such flag, so it is not propagated there). `--auto` is internal flow→plan wiring, not a user-facing flow flag — that's why it's absent from the Flags table above.

Plan and build perform their own state transitions (start-of-pipeline at start, end-of-pipeline at build's verdict gate) per [`references/state-transitions.md`](references/state-transitions.md). Flow does not touch folder state or frontmatter `status` directly.

After build returns, flow's work is done — build owns the verdict gate and has already applied the final transition. Flow exits cleanly.

---

## EPIC-MODE EXECUTION

Entered when SETUP step 2 detects `kind: epic` on the resolved folder. Flow walks the epic's children in `blocked_by` topological order, invoking `/feature:flow <CHILD-ID>` recursively for each child. Per-child state transitions (and the all-children-done check that moves the epic subtree to `done/` on the last child's finalization) fire from each child's build invocation per [`references/state-transitions.md`](references/state-transitions.md) Transition 2 — flow's epic walker doesn't perform any state transitions itself.

### 1. Load epic context

a. Read `<epic-folder>/prd.md` frontmatter: `id`, `children` (list), `status`.

b. If `status: done` (epic already complete), print:
   ```
   Epic <EPIC-ID> already complete. Delete artifacts inside individual children or re-run a specific child via `/feature:flow <CHILD-ID>` to redo work.
   ```
   Exit cleanly.

c. If `children` is empty or missing, print "Epic `<EPIC-ID>` has no children — nothing to walk." Exit cleanly.

d. For each child ID in `children`, locate the child folder under `<epic-folder>/tasks/<CHILD-ID>/` and read its `01-spec.md` frontmatter: `id`, `title`, `status`, `blocked_by` (defaults to `[]`).

   If a child folder is missing on disk, warn the user and skip that child (continue with the others). The data is corrupted but the walk is still useful.

### 2. Topological sort

a. Build a directed graph from `blocked_by`: an edge points from each blocker TO its dependent. So blockers come BEFORE dependents in topological order.

b. Sort the `children` list topologically. Ties (children with the same dependency depth) break by the order in `prd.md`'s `children` list — `discover` already chose a sensible order.

c. **Cycle detection**: if the graph has a cycle, abort with an error listing the cycle's children and instruct the user to fix `blocked_by` in the offending specs. Cycles shouldn't occur because `discover` validates first-child-has-no-blockers + DAG shape, but defensive.

### 3. Print initial aggregate progress

```
## Epic <EPIC-ID> — <epic-slug> (<N>/<M> children complete)

  ✓ <CHILD-1-ID>: <title> (done)
  ◐ <CHILD-2-ID>: <title> (partial-completion)
  ► <CHILD-3-ID>: <title> (next — backlog)
    <CHILD-4-ID>: <title> (backlog)
    <CHILD-5-ID>: <title> (backlog, blocked_by: <CHILD-3-ID>)

Starting walk through remaining children in dependency order.
```

**Status icon mapping**:
- `done` → ✓
- `partial-completion` → ◐
- `cancelled` → ⨯
- `in-review` → ◓ (PR open, awaiting merge — non-terminal)
- `in-progress` → ► (rare on entry; expected only mid-walk or after a crash)
- `backlog` → (space)

The "next" child gets a ► marker on the line that's about to start. `<M>` = total children; `<N>` = count of children with terminal status (`done`, `partial-completion`, or `cancelled`).

### 4. Walk children

For each child in topologically-sorted order:

a. **Skip if already terminal.** If the child's `status` is `done`, `partial-completion`, or `cancelled`, skip silently to the next child. (Auto-resumption of an in-flight epic relies on this — completed children are passed over.)

b. **Print the running message**:
   ```
   → Running <CHILD-ID>: <title>
   ```

c. **Invoke `Skill flow <CHILD-ID>`** (recursive). The inner flow detects `kind: epic` is NOT set on the child, falls into single-ticket mode, and runs plan + build per the existing logic. Propagate `--ignore-blockers` if the epic-level invocation had it.

d. **Re-read the child's `01-spec.md` frontmatter** after the recursive flow returns. Build's verdict gate (inside the child's flow run) already moved the folder and updated `status` per `state-transitions.md`. The new status determines the walker's next move:

   - `done` or `partial-completion` → child completed cleanly (build verdict `pass` + commit confirmed/declined, or verdict `partial`/`stuck` + user choice `accept-as-partial`). Continue walker silently.
   - `in-review` → child's PR was opened (build ran with `--pr`); the PR is open, awaiting merge. Non-terminal but an expected outcome — the child is "advanced enough." Continue the walker; the child finalizes to `done/` on a future walk once its PR merges (build's `review/` pass-through fires Transition 6).
   - `backlog` → user chose `abort` at the child's verdict gate. The child has been reverted. Stop the walker. Print:
     ```
     Child <CHILD-ID> aborted (reverted to backlog/). Stopping epic walk.
     Run /feature:flow <EPIC-ID> again to resume.
     ```
     Exit cleanly.
   - `in-progress` → shouldn't happen (build always finalizes). Treat as anomaly: warn the user, stop the walker. Print:
     ```
     Child <CHILD-ID> is unexpectedly still in-progress after flow returned. Stopping epic walk for safety. Inspect the child's artifacts and re-run when state is consistent.
     ```
     Exit cleanly.

e. **Print updated aggregate progress** (same format as Step 3, with the just-completed child now marked terminal).

### 5. Completion

After the loop exits successfully (all children walked, no aborts):

a. The all-children-done check inside the **last child's** build verdict gate (Transition 2's epic variant in `state-transitions.md`) already moved the epic subtree from `in-progress/<EPIC>/` to `done/<EPIC>/` and updated `prd.md`'s `status` to `done`. Flow does NOT repeat this — it has already happened.

b. Print:
   ```
   ## Epic <EPIC-ID> — done (<M>/<M> children complete)

   All artifacts: claudedocs/tickets/done/<EPIC-ID>/
   ```

c. Exit cleanly.

### Error handling (epic-mode specific)

- **Recursive flow crashes on a child**: surface to the user, list which child failed, ask whether to continue with remaining children or abort the walk.
- **Topological sort detects a cycle**: abort with the cycle listed; user must fix the `blocked_by` chain manually.
- **`prd.md` malformed or missing**: defer to ticket-resolution.md's error handling.
- **Child folder missing for a `children` entry**: warn, skip that child, continue with the others.

---

## Artifact Convention

All artifacts live inside the per-ticket folder, numbered by stage order. There are two layouts depending on whether the ticket is solo or a child of a discover-produced epic.

### Solo ticket layout

```
claudedocs/tickets/<state>/<id>/        # the ticket folder; <state> ∈ {backlog, in-progress, review, done}
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
├── prd.md                  # Parent PRD (frontmatter: kind: epic, children: [...]) — flow walks children in epic-mode; plan/build refuse to run directly against this
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
- The ticket folder moves between state folders (`backlog/` → `in-progress/` → `review/` → `done/`) as the pipeline advances. Everything inside moves with it. (`review/` is on the path only for `--pr` runs; a non-`--pr` `pass` goes straight `in-progress/` → `done/`.)

---

## Standalone re-run guidance

To re-run a single stage outside flow, invoke the skill directly:
- `/feature:plan <id>` — re-runs Phase 1 synthesis + interactive plan mode (standalone has no `--auto`, so the plan-mode gate applies); overwrites `02-plan.md`.
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
