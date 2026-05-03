---
name: flow
description: "Run the full feature pipeline (plan → implement → review → test) on a ticket with human review gates. Use when user says 'run the pipeline', 'flow this ticket', 'flow it', or 'build this ticket end-to-end'. NOT for single-stage runs."
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - TodoWrite
  - Skill
argument-hint: "[ticket-id] [--from|--to|--only|--skip|--continue]"
---

# Feature Flow Pipeline

Orchestrates feature development through stage skills with human review gates.

Each stage is a separate skill that can also be invoked directly:
- `/feature-pipeline:plan` — pre-plan synthesis (codebase exploration + open-questions surfacing) followed by interactive plan mode
- `/feature-pipeline:implement` — code writing + lint + tests
- `/feature-pipeline:review` — parallel code review (4 reviewers)
- `/feature-pipeline:test` — UI/E2E testing via Playwright

## Arguments

```
/feature-pipeline:flow $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket folder (e.g. `claudedocs/tickets/backlog/BL-1/`)
Remaining args = pipeline flags (see table below)

### Flags

| Flag | Effect | Example |
|------|--------|---------|
| `--from <stage>` | Start from this stage (skip earlier ones) | `--from plan` |
| `--to <stage>` | Stop after this stage | `--to review` |
| `--only <stage>` | Run just this one stage | `--only review` |
| `--skip <stage>` | Skip this stage in the flow | `--skip test` |
| `--continue` | Auto-detect last completed stage and resume from the next one | `--continue` |
| `--ignore-blockers` | Bypass `blocked_by` validation in `implement`/`review`/`test`; prints a warning and proceeds | `--ignore-blockers` |

Stage names: `plan`, `implement`, `review`, `test`

### Examples
```
/feature-pipeline:flow BL-1                              # full pipeline
/feature-pipeline:flow BL-1 --only plan                  # just the plan stage (Phase 1 synthesis + plan mode)
/feature-pipeline:flow BL-1 --from implement             # skip analysis + planning
/feature-pipeline:flow BL-1 --from implement --to review # implement + review
/feature-pipeline:flow BL-1 --skip test                  # everything except testing
/feature-pipeline:flow BL-1 --continue                   # resume from where it left off
/feature-pipeline:flow claudedocs/tickets/backlog/BL-1/             # by folder path
```

## Pipeline Order

**plan → implement → review → test → completion**

(`plan` includes pre-plan synthesis — codebase exploration + open-questions surfacing — before entering plan mode.)

---

## Stage Contract

Each stage reads and writes artifacts in `<ticket-folder>/`. This contract is load-bearing — every stage depends on the previous stage's outputs landing in the expected place.

| Stage | Reads | Writes | Re-run reads |
|---|---|---|---|
| `discover` (step 0, not part of flow) | ticket draft from user | **Single-mode** (N=1): `claudedocs/tickets/backlog/<id>/01-spec.md` + `exploration.md` in the same folder. **Multi-mode** (N>1): `claudedocs/tickets/backlog/<EPIC-ID>/prd.md` (kind: epic) + shared `exploration.md` + `tasks/<CHILD-ID>/01-spec.md` for each child. | — |
| `plan` | `01-spec.md`, `exploration.md` (optional seed — used for incremental exploration if present) | `02-plan.md` (includes Codebase Context + Open Questions Resolved sections from Phase 1 synthesis) | (same) |
| `implement` | `01-spec.md`, `02-plan.md` | `03-implementation.md` | **also** `04-review.md` (review loop-back), `bugs/*.md` (test loop-back) |
| `review` | working tree diff, project `CLAUDE.md` validation commands | `04-review.md` | (same) |
| `test` | `01-spec.md`, `03-implementation.md`, project `CLAUDE.md` test framework hint | `05-tests.md`, `bugs/*.md`; **conditionally** new spec files in the project's test directory (only when all acceptance criteria pass AND the project has a documented test framework — see the test skill's codification rules) | (same) |
| `flow` | `.iterations.json` (at every gate) | `.iterations.json` (on loop-backs and reset), `06-summary.md` (on completion), `.stale/` moves on deliberate re-runs | — |

---

## Responsibilities

flow owns:
1. Sequencing stages according to flags (`--from`, `--to`, `--only`, `--skip`, `--continue`)
2. Human gate coordination
3. Loop-back routing (review → implement, test → implement|plan)
4. Iteration budget enforcement (see `.iterations.json` — limit loop-backs before escalating)
5. Artifact invalidation on deliberate re-runs (see `.stale/` subfolder policy below)
6. Ticket folder transitions (backlog → in-progress → done)

It does NOT own:
- Stage-level logic — that lives in each stage skill
- Agent coordination — stage skills spawn their own subagents
- Direct code/artifact writes to the project tree — only `06-summary.md` and `.iterations.json`

---

## Artifact invalidation on deliberate re-runs (`.stale/`)

When the user deliberately re-runs an earlier stage (via `--only`, `--from`, or an implicit re-run from `--continue` after editing an upstream artifact), downstream artifacts become silently inconsistent with the re-run state. flow moves them to `<ticket-folder>/.stale/<timestamp>/` instead of leaving them in place.

**Downstream relationships** (derived from the Stage Contract table above — every stage invalidates everything that reads its output, transitively):

| Re-run stage | Downstream (invalidated) |
|---|---|
| `plan` | `02-plan.md`, `03-implementation.md`, `04-review.md`, `05-tests.md`, `bugs/`, `06-summary.md` |
| `implement` | `03-implementation.md`, `04-review.md`, `05-tests.md`, `bugs/`, `06-summary.md` |
| `review` | `04-review.md`, `05-tests.md`, `bugs/`, `06-summary.md` |
| `test` | `05-tests.md`, `bugs/`, `06-summary.md` |

**Rules:**
1. **Non-destructive.** Move, don't delete. The user can always grep `.stale/` to see what was superseded.
2. **Timestamped subfolders.** Each re-run gets its own `.stale/<iso-timestamp>/` subfolder so multiple re-runs don't collide.
3. **Preserve structure.** `bugs/` moves as a unit into `.stale/<timestamp>/bugs/`.
4. **Automatic loop-backs skip staling.** The `.stale/` policy only fires on *deliberate* re-runs (`--only`, `--from`, manual re-invocation), NOT on review↔implement or test↔implement loop-backs — those are part of the same flow session and the implement skill deliberately reads the prior review/bug reports to address them.
5. **`--continue` respects staling.** When resuming, flow ignores anything under `.stale/`; artifact-presence detection only considers files at the top level of the pipeline folder.
6. **`.stale/` is git-ignored** globally via `.gitignore` — superseded artifacts aren't worth committing.

---

## Loop-back iteration budget

To prevent infinite review ↔ implement or test ↔ implement loops, flow tracks loop-back counts in `<ticket-folder>/.iterations.json`:

```json
{
  "review_implement_loops": 0,
  "test_implement_loops": 0,
  "test_plan_loops": 0,
  "last_updated": "<iso-8601 timestamp>"
}
```

**Budgets:**
- `review_implement_loops` — max **2** (the 3rd attempt escalates to the user)
- `test_implement_loops` — max **2** (same)
- `test_plan_loops` — max **1** (plan-level loops are more expensive; tighter budget)

**Rules:**
1. **Initialize** `.iterations.json` with zeros when flow first creates the pipeline folder. If the file already exists on a `--continue`, preserve its state.
2. **Increment before check.** When a loop-back would fire, increment the relevant counter, then compare.
3. **On budget exceeded**, DO NOT auto-route. Instead, print a summary of what each prior loop attempted (pulled from successive `03-implementation.md` re-run notes or `04-review.md` revisions) and ask the user: force another loop / rewrite plan / abort / accept with known issues.
4. **Reset on success.** When the pipeline completes (write `06-summary.md`), zero all counters. Record the final totals in `06-summary.md` for historical visibility.
5. **Reset on deliberate re-run.** When the user explicitly re-runs an earlier stage (`--only plan`, `--from plan`), reset all downstream counters — that's a fresh attempt, not a loop.

---

## SETUP

1. **Resolve the ticket** using the canonical logic in [`references/ticket-resolution.md`](references/ticket-resolution.md). The ticket argument is `$1`.

2. **Determine which stages to run** based on flags:
   - `--only X` → run only X
   - `--from X` → run X and everything after
   - `--to X` → run everything up to and including X
   - `--skip X` → run all except X
   - Flags combine: `--from X --to Y --skip Z`

3. **If `--continue` flag is set**, auto-detect the next stage by checking which artifacts exist in `<ticket-folder>/`:
   - `06-summary.md` exists → **pipeline already complete**. Print: "Pipeline already complete for `<ticket-id>`. Run with `--from <stage>` to re-run a specific stage." and exit without re-running anything.
   - `05-tests.md` exists → resume at completion (write `06-summary.md`, finalize ticket)
   - `04-review.md` exists → resume from `test`
   - `03-implementation.md` exists → resume from `review`
   - `02-plan.md` exists → resume from `implement`
   - `01-spec.md` exists (or nothing) → resume from `plan`
   - `--continue` is equivalent to `--from <next-stage>` — other flags like `--to` and `--skip` can still be combined
   - Print which stage is being resumed: "Artifacts found through `<last-stage>`. Resuming from `<next-stage>`."

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

   The move includes all artifacts (`01-spec.md`/`prd.md`, `exploration.md` if present, `02-plan.md`, etc.), `bugs/`, `.iterations.json`, `.stale/`, and (for epics) the entire `tasks/` subfolder. After this point, `<ticket-folder>` resolves to the new location for the rest of the run.

5. **Invalidate downstream artifacts** (if this run re-executes a stage whose artifact already exists):
   - For each stage in the determined list whose artifact already exists at the top level of `<ticket-folder>/`:
     - Look up its downstream set using the invalidation table in the "Artifact invalidation" section above
     - Move each downstream artifact that exists to `<ticket-folder>/.stale/<iso-timestamp>/`, preserving folder structure (`bugs/` moves as a unit)
   - Skip this step if the run is pure forward progress (all artifacts in the determined list are fresh/non-existent)
   - Skip this step on automatic loop-backs — those are handled inside the stage execution section, not here
   - Print which artifacts were staled: "Staled N downstream artifacts under `.stale/<timestamp>/` before re-running `<stage>`."

6. **Initialize `.iterations.json`** at `<ticket-folder>/.iterations.json`:
   - If the file does not exist, create it with all counters at 0 and the current timestamp
   - If it exists (fresh run, not `--continue`, of a ticket that previously ran), reset counters to 0 — a new `flow` invocation is a fresh attempt
   - On `--continue`, preserve the existing counter state (we're resuming mid-loop)
   - If the user explicitly re-runs an earlier stage via `--only` or `--from`, reset counters for that stage and all downstream stages (see "Loop-back iteration budget" section)

7. **Validate blockers** per [`references/ticket-resolution.md`](references/ticket-resolution.md) Step 6. If the determined stage list includes any of `implement`, `review`, `test` AND the ticket has `blocked_by` entries that aren't done, abort flow with the Step 6 message (unless `--ignore-blockers` was passed; in that case print the warning and proceed). For plan-only runs, blocker validation does not refuse — plan auto-loads blocker context itself in Phase 1. Propagate `--ignore-blockers` to each stage skill invocation that needs it.

---

## STAGE EXECUTION

For each stage in the determined list, invoke the corresponding stage skill and handle the review gate afterward.

---

### PLAN

1. Invoke the plan skill: `/feature-pipeline:plan <ticket-id>`
2. The skill runs Phase 1 (pre-plan synthesis — spawns code-explorer + requirements-analyst subagents) and presents the synthesis: codebase patterns, open questions with proposed defaults, and a complexity check.
3. If the synthesis surfaces a complexity overflow (spec sized M, analysis suggests XL), the skill pauses for a user choice (proceed / cancel + re-discover). Flow respects the user's call: on cancel, abort the run; on proceed, continue.
4. The skill enters plan mode for interactive design — **plan mode itself is the gate**. The user refines the plan, addresses open questions inline, and exits plan mode when satisfied.
5. The skill saves `02-plan.md`. Proceed to next stage.

---

### IMPLEMENT

1. Invoke the implement skill: `/feature-pipeline:implement <ticket-id>`
2. The skill writes code, runs lint/tests, and saves `03-implementation.md` incrementally as it goes
3. **GATE** — after the skill presents its summary:
   ```
   → Approve to proceed to review
   → Request fixes with specific issues
   ```
4. If fixes requested → re-invoke `/feature-pipeline:implement <ticket-id>` (the skill will see conversation history with the fix requests)
5. If approved → proceed to next stage

---

### REVIEW

1. Invoke the review skill: `/feature-pipeline:review <ticket-id>`
2. The skill first runs deterministic validation (lint/typecheck/build) and short-circuits to a validation-failed `04-review.md` if any check fails. Otherwise it spawns **four parallel reviewers** (correctness, security, performance, architectural-fit) and saves `04-review.md`.
3. **GATE** — after the skill presents findings:
   ```
   → Approve to proceed to testing (no critical issues)
   → Send back for fixes (specify which issues to address)
   ```
4. If fixes needed → **check the iteration budget first**:
   - Read `.iterations.json` and increment `review_implement_loops`
   - If the new value is > 2 (this would be the 3rd loop-back), **do NOT auto-route**. Escalate:
     - Print a summary of prior attempts (pull deviations/re-run notes from successive `03-implementation.md` revisions and the sequence of `04-review.md` findings)
     - Ask the user: "We've looped review ↔ implement N times. Options: (a) force another loop, (b) re-plan the approach, (c) accept with known issues and proceed to test, (d) abort."
     - Route according to the user's choice; do not increment further without explicit approval
   - If the new value is ≤ 2, write the updated counter back to `.iterations.json` and re-invoke `/feature-pipeline:implement <ticket-id>` — the skill reads the review from `04-review.md` automatically
   - After fixes, run a quick pass to verify: invoke `/feature-pipeline:review <ticket-id>` again
5. If approved → proceed to next stage (counter persists; only resets on successful completion)

---

### TEST

1. Invoke the test skill: `/feature-pipeline:test <ticket-id>`
2. The skill spawns a UI tester and saves `05-tests.md`
3. **GATE** — after the skill presents results:
   ```
   → All pass → proceed to completion
   → Code bug → send back to implementation with bug details
   → Design flaw → send back to planning to revise approach
   ```
4. Route based on user response, **checking the iteration budget before each loop-back**:
   - **All pass** → COMPLETION
   - **Code bug** → read `.iterations.json`, increment `test_implement_loops`
     - If > 2, escalate to the user with a prior-attempts summary (same pattern as the review gate) and route according to the user's choice
     - Otherwise, write the updated counter and re-invoke `/feature-pipeline:implement <ticket-id>` — it reads bug reports from `bugs/*.md` automatically
   - **Design flaw** → read `.iterations.json`, increment `test_plan_loops`
     - If > 1, escalate (plan-level loops have a tighter budget — a second plan rewrite is almost always a signal that the spec or analysis is wrong, not the plan)
     - Otherwise, write the updated counter and re-invoke `/feature-pipeline:plan <ticket-id>` with test findings as input; downstream counters (`review_implement_loops`, `test_implement_loops`) reset to 0 because the plan is fresh

---

## COMPLETION

**IMPORTANT: All completion steps below are MANDATORY. Do not skip any of them.**

1. Write pipeline summary to `<ticket-folder>/06-summary.md`:
   - Ticket title and ID
   - Stages completed
   - Files created/modified
   - Review findings addressed
   - Test results
   - Total iterations per loop type (pulled from `.iterations.json` — record final counts so future readers can see how hard this ticket fought back)
2. **Reset `.iterations.json`** — set all counters to 0 with a fresh timestamp. The file stays in place for the next run of the same ticket (rare, but possible on re-opens).

3. **Present to user**:
   ```
   ## Pipeline Complete

   [Final summary]

   All artifacts: <ticket-folder>/

   Would you like to commit these changes?
   ```

4. If user wants to commit, use standard git workflow:
   - Stage relevant files
   - Create descriptive commit message referencing the ticket ID

5. **After commit (or if user declines commit), ALWAYS finalize the ticket** — behavior depends on whether the ticket is solo or a child of an epic.

   **Solo ticket**:
   - Move the folder from `claudedocs/tickets/in-progress/<id>/` to `claudedocs/tickets/done/<id>/` (folder moves as a unit, including all artifacts and state files).
   - Update `01-spec.md`'s frontmatter `status` from `in-progress` to `done`.

   **Child of an epic**:
   - Update **only the child's** `01-spec.md` frontmatter `status` from `in-progress` to `done`. Do NOT move the child's folder out of the epic subtree.
   - **All-children-done check**: scan every sibling under `<epic-folder>/tasks/*/01-spec.md` and read their `status` field. If every sibling is `done` or `cancelled`:
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
├── exploration.md          # Discover-time codebase exploration (optional — only when the ticket went through /feature-pipeline:discover)
├── 02-plan.md              # Implementation blueprint (includes Phase 1 synthesis as Codebase Context + Open Questions Resolved sections)
├── 03-implementation.md    # Implementation summary + validation results (live — updated per step)
├── 04-review.md            # Merged review findings (4 reviewers)
├── 05-tests.md             # UI test execution results
├── 06-summary.md           # Pipeline completion summary
├── .iterations.json        # Loop-back counter state (see "Loop-back iteration budget" section)
├── bugs/                   # Bug reports from testing (if any)
│   ├── BUG-001.md
│   └── BUG-002.md
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
    │   ├── ...
    │   ├── bugs/
    │   ├── .iterations.json
    │   └── .stale/
    ├── <CHILD-2-ID>/
    └── <CHILD-3-ID>/
```

The whole epic subtree moves between `<state>/` folders as a unit (see SETUP step 4 and COMPLETION step 5). Per-child `status` lives in each child's `01-spec.md` frontmatter; epic-level `status` lives in `prd.md` and tracks the folder location.

**Naming rules:**
- Sequential: `NN-name.md` where `NN` is the stage order
- `01-spec.md` IS the ticket — it carries frontmatter (live state metadata) and the spec body. There is no separate "ticket file" outside the folder.
- `02`–`06` are reserved for canonical stages in order: `02-plan.md`, `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md`. Don't reuse numbers.
- Plain (un-numbered) filenames at the ticket-folder root are reserved for pre-spec / pre-stage artifacts (currently just `exploration.md`); for child tickets of an epic, the shared `exploration.md` lives one level up at the epic folder, not in the child folder
- Bug reports from the test stage go in `bugs/BUG-NNN.md` (zero-padded to 3)
- `.stale/` is reserved for superseded artifacts after deliberate re-runs; stages ignore anything under it
- `.iterations.json` is flow state, not a stage artifact
- The ticket folder moves between state folders (`backlog/` → `in-progress/` → `done/`) as the pipeline advances. Everything inside moves with it.

## Continuation & Partial Runs

When starting a stage, always check if previous stage artifacts exist in the ticket folder. If they do, use them as input rather than requiring the user to re-run earlier stages.

This enables:
- Resuming a pipeline that was interrupted
- Re-running a single stage with `--only` using existing artifacts from earlier stages
- Skipping stages that were already completed
- Detecting fully-complete pipelines via `06-summary.md` presence (see SETUP step 3)

## Error Handling

- If a stage skill fails or returns an error, report it to the user and ask how to proceed (retry, skip, or abort)
- If the ticket file can't be found, ask the user for the correct path
- If the project path can't be determined, ask the user
