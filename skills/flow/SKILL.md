---
name: flow
description: "Run the full feature pipeline (plan → build) on a ticket with a completion gate. Use when user says 'run the pipeline', 'flow this ticket', 'flow it', or 'build this ticket end-to-end'. NOT for single-stage runs — use /feature:plan or /feature:build directly for those."
allowed-tools:
  - Read
  - Edit
  - Glob
  - Grep
  - Bash
  - TodoWrite
  - Skill
argument-hint: "[ticket-id] [--continue|--ignore-blockers]"
---

# Feature Flow Pipeline

Orchestrates feature development through two flow-managed stages — `plan` and `build` — with one completion gate at the end. Build's internal checkpoints (implement, review, test) run as a single continuous loop inside the build skill and are not flow-managed.

Each stage is a separate skill that can also be invoked directly:
- `/feature:plan` — pre-plan synthesis (codebase exploration + open-questions surfacing) followed by interactive plan mode; writes `02-plan.md`
- `/feature:build` — implement → review → test as in-loop checkpoints; exits with verdict `pass | partial | stuck`; writes `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md`

## Arguments

```
/feature:flow $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket folder (e.g. `claudedocs/tickets/backlog/BL-1/`)
Remaining args = pipeline flags (see table below)

### Flags

| Flag | Effect | Example |
|------|--------|---------|
| `--continue` | Resume from on-disk state. If `02-plan.md` exists, skip plan and invoke build with `--continue` (build's own resumption logic reconstructs state from its artifacts). If `02-plan.md` is missing, start fresh. | `--continue` |
| `--ignore-blockers` | Bypass the `blocked_by` validation in flow's SETUP step 3; print a one-line warning and propagate the flag to plan + build invocations. | `--ignore-blockers` |

### Examples
```
/feature:flow BL-1                              # full pipeline on a backlog ticket
/feature:flow BL-1 --continue                   # resume after a stuck/partial run
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
| `build` | `01-spec.md`, `02-plan.md` (and on `--continue`, whichever of `03-implementation.md`/`04-review.md`/`05-tests.md` exist) | `03-implementation.md` (live, updated per plan step), `04-review.md` (merged from 4 reviewer subagents), `05-tests.md` (UI test results or skip artifact), `06-summary.md` (always written, content varies per verdict) |

---

## Responsibilities

flow owns:
1. Stage invocation (`/feature:plan` then `/feature:build`) per the SETUP/STAGE EXECUTION/COMPLETION sequence
2. Pre-stage validation: ticket resolution, epic refusal, blocker pre-check
3. Folder transitions (`backlog/` ↔ `in-progress/` ↔ `done/`) and frontmatter `status` updates
4. Artifact invalidation on plan re-run (see `.stale/` policy below)
5. Verdict-aware completion routing: `pass` → folder to `done/`; `partial`/`stuck` → capture user choice from build's option menu and route accordingly

It does NOT own:
- Stage internals — plan owns plan mode + Phase 1 synthesis; build owns its verdict gate, internal checkpoints, and `06-summary.md` write
- Agent coordination — plan and build spawn their own subagents
- Artifact writes — build writes 03 through 06 itself; flow only mutates frontmatter `status` fields and moves folders

---

## Artifact invalidation on deliberate re-runs (`.stale/`)

When the user deliberately re-runs plan against a ticket whose build artifacts already exist (e.g., the user deleted `02-plan.md` and re-ran flow), downstream artifacts become silently inconsistent with the new plan. Flow moves them to `<ticket-folder>/.stale/<timestamp>/` instead of leaving them in place.

**Downstream relationships**:

| Re-run stage | Downstream (invalidated) |
|---|---|
| `plan` | `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md` |
| `build` | (none — build is the last flow-managed stage) |

**Rules:**
1. **Non-destructive.** Move, don't delete. The user can always grep `.stale/` to see what was superseded.
2. **Timestamped subfolders.** Each re-run gets its own `.stale/<iso-timestamp>/` subfolder so multiple re-runs don't collide.
3. **`--continue` respects staling.** When resuming, flow ignores anything under `.stale/`; artifact-presence detection only considers files at the top level of the ticket folder.
4. **Internal build checkpoints don't trigger staling.** Implement → review → test transitions inside one build invocation are part of the same loop and write through to the canonical artifacts directly.
5. **`.stale/` is git-ignored** globally via `.gitignore` — superseded artifacts aren't worth committing.

---

## SETUP

1. **Resolve the ticket** using the canonical logic in [`references/ticket-resolution.md`](references/ticket-resolution.md). The ticket argument is `$1`.

2. **Validate kind** per [`references/ticket-resolution.md`](references/ticket-resolution.md) Step 4. If `kind: epic`, abort with the epic-refusal message — flow runs against children, not epics.

3. **Validate blockers** per [`references/ticket-resolution.md`](references/ticket-resolution.md) Step 6. If the ticket has `blocked_by` entries that aren't done (and `--ignore-blockers` was not passed), abort with the Step 6 message listing the unblocked blockers. With `--ignore-blockers`, print a one-line warning and propagate the flag to plan + build invocations:
   ```
   ⚠ Bypassing blocker check for <ticket-id>. Unfinished blockers: <list>. Proceeding anyway.
   ```

4. **Move to `in-progress/`** — behavior depends on whether the ticket is solo or a child of an epic. Detect by inspecting the resolved `<ticket-folder>` path: if its immediate parent directory is named `tasks/`, the ticket is a child of an epic; otherwise it's solo.

   **Solo ticket** (`<ticket-folder>` matches `claudedocs/tickets/<state>/<id>/`):
   - If folder is in `backlog/` or `done/` (re-run of a completed ticket): move from `<state>/<id>/` to `in-progress/<id>/`.
   - If already in `in-progress/`: no move.
   - Update `01-spec.md`'s frontmatter `status` to `in-progress`.

   **Child of an epic** (`<ticket-folder>` matches `claudedocs/tickets/<state>/<EPIC>/tasks/<CHILD>/`):
   - Identify the epic folder: `claudedocs/tickets/<state>/<EPIC>/` (the deepest ancestor containing `prd.md`).
   - If the epic folder is in `backlog/` or `done/` (any-child-in-progress rule, or re-run of a completed epic): move the **entire epic subtree** from `<state>/<EPIC>/` to `in-progress/<EPIC>/`. Other children come along inside the subtree; their per-spec `status` fields are NOT touched — only the child currently being flowed has its status updated.
   - If the epic is already in `in-progress/`: no folder move (a sibling triggered the move earlier).
   - Update `prd.md`'s frontmatter `status` to `in-progress`.
   - Update the child's `01-spec.md` frontmatter `status` to `in-progress`.

   The move includes all artifacts (`01-spec.md`/`prd.md`, `exploration.md` if present, `02-plan.md`, etc.), `.stale/`, and (for epics) the entire `tasks/` subfolder. After this point, `<ticket-folder>` resolves to the new location for the rest of the run.

5. **Invalidate downstream artifacts** if `02-plan.md` is missing AND any of `03-implementation.md` / `04-review.md` / `05-tests.md` / `06-summary.md` exist on disk:
   - Move each existing build artifact to `<ticket-folder>/.stale/<iso-timestamp>/`
   - Print: "Staled N downstream artifacts under `.stale/<timestamp>/` before re-running plan."
   - Skip this step on pure forward progress (no build artifacts on disk) or on `--continue` runs that found `02-plan.md`

---

## STAGE EXECUTION

### PLAN

1. Decide whether to invoke plan:
   - If `02-plan.md` exists AND `--continue` was passed → skip plan invocation; proceed directly to BUILD.
   - Otherwise → invoke `/feature:plan <ticket-id>`.
2. The plan skill runs Phase 1 (pre-plan synthesis — spawns code-explorer + requirements-analyst subagents) and presents the synthesis: codebase patterns, open questions with proposed defaults, and a complexity check.
3. If the synthesis surfaces a complexity overflow (spec sized M, analysis suggests XL), the plan skill pauses for a user choice (proceed / cancel + re-discover). Flow respects the user's call: on cancel, abort the run; on proceed, continue.
4. The plan skill enters plan mode for interactive design — **plan mode itself is the gate**. The user refines the plan, addresses open questions inline, and exits plan mode when satisfied.
5. The plan skill saves `02-plan.md`. Proceed to BUILD.

No flow-managed gate after PLAN — plan mode is the gate.

### BUILD

1. Invoke `/feature:build <ticket-id>` with `--continue` if `--continue` was passed to flow, and with `--ignore-blockers` if applicable.
2. Build runs implement → review → test as one continuous loop with internal checkpoints, validates after every meaningful change, applies review fixes in-context, fixes test failures in-context, and self-monitors for stuck patterns + a 25-turn ceiling.
3. Build exits with one of three verdicts (`pass | partial | stuck`) and writes `06-summary.md` regardless of verdict. Build presents an exit message of the form:
   ```
   ## Build Complete — verdict: <pass|partial|stuck>
   [summary of work, validation state, verdict-specific options menu]
   ```
4. Flow captures the verdict from build's exit message and the user's choice (if applicable) for COMPLETION.

---

## COMPLETION

**IMPORTANT: All completion steps below are MANDATORY. Do not skip any of them.**

1. **Read the verdict** from build's exit message (also recorded in `06-summary.md`'s header).

2. **`pass`** — surface the user-facing completion gate:
   ```
   ## Pipeline Complete — verdict: pass

   [Summary from 06-summary.md]

   All artifacts: <ticket-folder>/

   Would you like to commit these changes?
   ```
   - If user wants to commit, use the standard git workflow: stage relevant files; create a commit message referencing the ticket ID.
   - Then run the **finalization** in step 5 below with target state `done`.

3. **`partial`** — set frontmatter `status: partial-completion` (folder stays in `in-progress/`); show the user the option menu (already presented by build's exit message) and capture the reply:
   - `accept-as-partial` → run finalization (step 5) with target state `done`; preserve `status: partial-completion` in frontmatter.
   - `continue-with-hint` → ask the user for the hint text, then re-invoke `/feature:build <ticket-id> --continue --hint "<text>"`. After build returns, restart this COMPLETION section from step 1 with the new verdict.
   - `abort` → revert folder `in-progress/` → `backlog/`; reset frontmatter `status` to `backlog`. For epic children: revert only the child's frontmatter status; do NOT move the epic subtree back unless every other child is also `backlog` or `cancelled`.

4. **`stuck`** — same option menu and routing as `partial`. The `accept-as-partial` choice is also offered (same effect as the partial path).

5. **Finalization** (folder transition) — behavior depends on whether the ticket is solo or a child of an epic.

   **Solo ticket**:
   - Move the folder from `claudedocs/tickets/in-progress/<id>/` to `claudedocs/tickets/done/<id>/` (folder moves as a unit, including all artifacts).
   - Update `01-spec.md`'s frontmatter `status` from `in-progress` to `done` (or preserve `partial-completion` on `accept-as-partial`).

   **Child of an epic**:
   - Update **only the child's** `01-spec.md` frontmatter `status` from `in-progress` to `done` (or preserve `partial-completion` on `accept-as-partial`). Do NOT move the child's folder out of the epic subtree.
   - **All-children-done check**: scan every sibling under `<epic-folder>/tasks/*/01-spec.md` and read their `status` field. If every sibling is `done`, `cancelled`, or `partial-completion`:
     - Move the **entire epic subtree** from `in-progress/<EPIC>/` to `done/<EPIC>/`.
     - Update `prd.md`'s frontmatter `status` to `done`.
   - If at least one sibling is still `backlog` or `in-progress`, the epic stays in `in-progress/` — the subtree moves to `done/` only on the last sibling's completion.

   This step is mandatory — do not end the pipeline without it.

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
├── 06-summary.md           # Build exit summary (always written, content varies per verdict)
└── .stale/                 # Superseded artifacts after deliberate re-runs (see "Artifact invalidation" section)
    └── <iso-timestamp>/
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
    │   ├── 06-summary.md
    │   └── .stale/
    ├── <CHILD-2-ID>/
    └── <CHILD-3-ID>/
```

The whole epic subtree moves between `<state>/` folders as a unit (see SETUP step 4 and COMPLETION step 5). Per-child `status` lives in each child's `01-spec.md` frontmatter; epic-level `status` lives in `prd.md` and tracks the folder location.

**Naming rules:**
- Sequential: `NN-name.md` where `NN` is the stage order
- `01-spec.md` IS the ticket — it carries frontmatter (live state metadata) and the spec body. There is no separate "ticket file" outside the folder.
- `02`–`06` are reserved for canonical stages in order: `02-plan.md`, `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md`. Don't reuse numbers.
- Plain (un-numbered) filenames at the ticket-folder root are reserved for pre-spec / pre-stage artifacts (currently just `exploration.md`); for child tickets of an epic, the shared `exploration.md` lives one level up at the epic folder, not in the child folder.
- `.stale/` is reserved for superseded artifacts after deliberate re-runs; stages ignore anything under it.
- The ticket folder moves between state folders (`backlog/` → `in-progress/` → `done/`) as the pipeline advances. Everything inside moves with it.

---

## Standalone re-run guidance

To re-run a single stage outside flow, invoke the skill directly:
- `/feature:plan <id>` — re-runs Phase 1 synthesis + plan mode; overwrites `02-plan.md`.
- `/feature:build <id> --continue` — resumes from the latest on-disk artifact (`03-implementation.md`, `04-review.md`, or `05-tests.md`) per build's own resumption logic.

Stage skills handle their own ticket resolution and blocker validation; flow is not in the call chain when invoked this way.

## Continuation & Partial Runs

`--continue` is the only resume flag. On a `--continue` run, flow checks for `02-plan.md`: if present, plan is skipped and build is invoked with `--continue` (build reconstructs state from `03-implementation.md` / `04-review.md` / `05-tests.md` per its own resumption rules). If absent, flow runs as a fresh start.

If `06-summary.md` exists on a fresh (non-`--continue`) flow invocation, flow prints "Pipeline already complete for `<ticket-id>`. Re-run a stage directly with `/feature:plan <id>` or `/feature:build <id>`, or pass `--continue` to resume from a partial/stuck state." and exits without re-running anything.

## Error Handling

- **Stage skill failure** (plan or build crashes/returns an error mid-run): report it to the user and ask how to proceed (retry, skip with caveats, or abort).
- **Ticket not found**: defer to `references/ticket-resolution.md`'s error handling — ask the user for the correct path.
- **Project path can't be determined**: ask the user.
- **Plan mode cancelled**: abort flow; ticket folder stays in `in-progress/` (already moved by SETUP step 4). User can re-run with `--continue` once they're ready to resume.
- **Build returns a verdict but `06-summary.md` wasn't written** (build crashed mid-exit): log the inconsistency, present the verdict from conversation context, and ask the user before any folder transition.
- **User reply at the verdict gate is ambiguous**: ask once for clarification; on a second ambiguous reply, default to `abort` (safest for state).
- **Blocker validation fails** without `--ignore-blockers`: abort before SETUP step 4 (folder move); print the Step 6 message verbatim. The ticket folder stays in `backlog/` and frontmatter `status` is unchanged.
