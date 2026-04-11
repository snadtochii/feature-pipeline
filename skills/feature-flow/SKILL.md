---
name: feature-flow
description: "Run the full feature pipeline (analyze → plan → implement → review → test) on a ticket with human review gates. Use when user says 'run the pipeline', 'feature flow', or 'build this ticket end-to-end'. NOT for single-stage runs."
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
- `/feature-pipeline:analyze` — codebase exploration + spec analysis
- `/feature-pipeline:plan` — interactive implementation planning
- `/feature-pipeline:implement` — code writing + lint + tests
- `/feature-pipeline:review` — parallel code review (4 reviewers)
- `/feature-pipeline:test` — UI/E2E testing via Playwright

## Arguments

```
/feature-pipeline:feature-flow $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file (e.g. `.tickets/backlog/dark-mode.md`)
Remaining args = pipeline flags (see table below)

### Flags

| Flag | Effect | Example |
|------|--------|---------|
| `--from <stage>` | Start from this stage (skip earlier ones) | `--from plan` |
| `--to <stage>` | Stop after this stage | `--to review` |
| `--only <stage>` | Run just this one stage | `--only review` |
| `--skip <stage>` | Skip this stage in the flow | `--skip test` |
| `--continue` | Auto-detect last completed stage and resume from the next one | `--continue` |

Stage names: `analyze`, `plan`, `implement`, `review`, `test`

### Examples
```
/feature-pipeline:feature-flow BL-1                              # full pipeline
/feature-pipeline:feature-flow BL-1 --only analyze               # just analysis
/feature-pipeline:feature-flow BL-1 --from implement             # skip analysis + planning
/feature-pipeline:feature-flow BL-1 --from implement --to review # implement + review
/feature-pipeline:feature-flow BL-1 --skip test                  # everything except testing
/feature-pipeline:feature-flow BL-1 --continue                   # resume from where it left off
/feature-pipeline:feature-flow .tickets/backlog/dark-mode.md     # by file path
```

## Pipeline Order

**analyze → plan → implement → review → test → completion**

---

## Stage Contract

Each stage reads and writes artifacts in `claudedocs/pipeline/<ticket-id>/`. This contract is load-bearing — every stage depends on the previous stage's outputs landing in the expected place.

| Stage | Reads | Writes | Re-run reads |
|---|---|---|---|
| `discovery` (step 0, not part of feature-flow) | ticket draft from user | `.tickets/backlog/<id>-<slug>.md`, `claudedocs/pipeline/<id>/00-exploration.md` | — |
| `analyze` | `01-spec.md`, `00-exploration.md` (optional seed — used for incremental exploration if present) | `02-analysis.md` | (same) |
| `plan` | `01-spec.md`, `02-analysis.md` | `03-plan.md` | (same) |
| `implement` | `01-spec.md`, `03-plan.md` | `04-implementation.md` | **also** `05-review.md` (review loop-back), `bugs/*.md` (test loop-back) |
| `review` | working tree diff, project `CLAUDE.md` validation commands | `05-review.md` | (same) |
| `test` | `01-spec.md`, `04-implementation.md`, project `CLAUDE.md` test framework hint | `06-tests.md`, `bugs/*.md`; **conditionally** new spec files in the project's test directory (only when all acceptance criteria pass AND the project has a documented test framework — see the test skill's codification rules) | (same) |
| `feature-flow` | `.iterations.json` (at every gate) | `.iterations.json` (on loop-backs and reset), `07-summary.md` (on completion), `.stale/` moves on deliberate re-runs | — |

---

## Responsibilities

feature-flow owns:
1. Sequencing stages according to flags (`--from`, `--to`, `--only`, `--skip`, `--continue`)
2. Human gate coordination
3. Loop-back routing (review → implement, test → implement|plan)
4. Iteration budget enforcement (see `.iterations.json` — limit loop-backs before escalating)
5. Artifact invalidation on deliberate re-runs (see `.stale/` subfolder policy below)
6. Ticket folder transitions (backlog → in-progress → done)

It does NOT own:
- Stage-level logic — that lives in each stage skill
- Agent coordination — stage skills spawn their own subagents
- Direct code/artifact writes to the project tree — only `07-summary.md` and `.iterations.json`

---

## Artifact invalidation on deliberate re-runs (`.stale/`)

When the user deliberately re-runs an earlier stage (via `--only`, `--from`, or an implicit re-run from `--continue` after editing an upstream artifact), downstream artifacts become silently inconsistent with the re-run state. feature-flow moves them to `claudedocs/pipeline/<ticket-id>/.stale/<timestamp>/` instead of leaving them in place.

**Downstream relationships** (derived from the Stage Contract table above — every stage invalidates everything that reads its output, transitively):

| Re-run stage | Downstream (invalidated) |
|---|---|
| `analyze` | `02-analysis.md`, `03-plan.md`, `04-implementation.md`, `05-review.md`, `06-tests.md`, `bugs/`, `07-summary.md` |
| `plan` | `03-plan.md`, `04-implementation.md`, `05-review.md`, `06-tests.md`, `bugs/`, `07-summary.md` |
| `implement` | `04-implementation.md`, `05-review.md`, `06-tests.md`, `bugs/`, `07-summary.md` |
| `review` | `05-review.md`, `06-tests.md`, `bugs/`, `07-summary.md` |
| `test` | `06-tests.md`, `bugs/`, `07-summary.md` |

**Rules:**
1. **Non-destructive.** Move, don't delete. The user can always grep `.stale/` to see what was superseded.
2. **Timestamped subfolders.** Each re-run gets its own `.stale/<iso-timestamp>/` subfolder so multiple re-runs don't collide.
3. **Preserve structure.** `bugs/` moves as a unit into `.stale/<timestamp>/bugs/`.
4. **Automatic loop-backs skip staling.** The `.stale/` policy only fires on *deliberate* re-runs (`--only`, `--from`, manual re-invocation), NOT on review↔implement or test↔implement loop-backs — those are part of the same feature-flow session and the implement skill deliberately reads the prior review/bug reports to address them.
5. **`--continue` respects staling.** When resuming, feature-flow ignores anything under `.stale/`; artifact-presence detection only considers files at the top level of the pipeline folder.
6. **`.stale/` is git-ignored** globally via `.gitignore` — superseded artifacts aren't worth committing.

---

## Loop-back iteration budget

To prevent infinite review ↔ implement or test ↔ implement loops, feature-flow tracks loop-back counts in `claudedocs/pipeline/<ticket-id>/.iterations.json`:

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
1. **Initialize** `.iterations.json` with zeros when feature-flow first creates the pipeline folder. If the file already exists on a `--continue`, preserve its state.
2. **Increment before check.** When a loop-back would fire, increment the relevant counter, then compare.
3. **On budget exceeded**, DO NOT auto-route. Instead, print a summary of what each prior loop attempted (pulled from successive `04-implementation.md` re-run notes or `05-review.md` revisions) and ask the user: force another loop / rewrite plan / abort / accept with known issues.
4. **Reset on success.** When the pipeline completes (write `07-summary.md`), zero all counters. Record the final totals in `07-summary.md` for historical visibility.
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

3. **If `--continue` flag is set**, auto-detect the next stage by checking which artifacts exist in `claudedocs/pipeline/<ticket-id>/`:
   - `07-summary.md` exists → **pipeline already complete**. Print: "Pipeline already complete for `<ticket-id>`. Run with `--from <stage>` to re-run a specific stage." and exit without re-running anything.
   - `06-tests.md` exists → resume at completion (write `07-summary.md`, finalize ticket)
   - `05-review.md` exists → resume from `test`
   - `04-implementation.md` exists → resume from `review`
   - `03-plan.md` exists → resume from `implement`
   - `02-analysis.md` exists → resume from `plan`
   - `01-spec.md` exists (or nothing) → resume from `analyze`
   - `--continue` is equivalent to `--from <next-stage>` — other flags like `--to` and `--skip` can still be combined
   - Print which stage is being resumed: "Artifacts found through `<last-stage>`. Resuming from `<next-stage>`."

4. **Move ticket** from `backlog/` to `in-progress/` (if not already there — skip if ticket is already in `in-progress/`)

5. **Invalidate downstream artifacts** (if this run re-executes a stage whose artifact already exists):
   - For each stage in the determined list whose artifact already exists at the top level of `claudedocs/pipeline/<ticket-id>/`:
     - Look up its downstream set using the invalidation table in the "Artifact invalidation" section above
     - Move each downstream artifact that exists to `claudedocs/pipeline/<ticket-id>/.stale/<iso-timestamp>/`, preserving folder structure (`bugs/` moves as a unit)
   - Skip this step if the run is pure forward progress (all artifacts in the determined list are fresh/non-existent)
   - Skip this step on automatic loop-backs — those are handled inside the stage execution section, not here
   - Print which artifacts were staled: "Staled N downstream artifacts under `.stale/<timestamp>/` before re-running `<stage>`."

6. **Initialize `.iterations.json`** at `claudedocs/pipeline/<ticket-id>/.iterations.json`:
   - If the file does not exist, create it with all counters at 0 and the current timestamp
   - If it exists (fresh run, not `--continue`, of a ticket that previously ran), reset counters to 0 — a new `feature-flow` invocation is a fresh attempt
   - On `--continue`, preserve the existing counter state (we're resuming mid-loop)
   - If the user explicitly re-runs an earlier stage via `--only` or `--from`, reset counters for that stage and all downstream stages (see "Loop-back iteration budget" section)

---

## STAGE EXECUTION

For each stage in the determined list, invoke the corresponding stage skill and handle the review gate afterward.

---

### ANALYZE

1. Invoke the analyze skill: `/feature-pipeline:analyze <ticket-id>`
2. The skill spawns two sequential subagents and saves `02-analysis.md`
3. **GATE** — after the skill presents its findings:
   ```
   → Approve to proceed to planning
   → Reject with notes to re-analyze
   ```
4. If rejected → re-invoke `/feature-pipeline:analyze <ticket-id>` (the skill will see the conversation history with user feedback and the existing `02-analysis.md`)
5. If approved → proceed to next stage

---

### PLAN

1. Invoke the plan skill: `/feature-pipeline:plan <ticket-id>`
2. The skill enters plan mode for interactive planning — **plan mode itself is the gate**
3. The user refines the plan interactively until satisfied, then exits plan mode
4. The skill saves `03-plan.md`
5. Proceed to next stage

---

### IMPLEMENT

1. Invoke the implement skill: `/feature-pipeline:implement <ticket-id>`
2. The skill writes code, runs lint/tests, and saves `04-implementation.md` incrementally as it goes
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
2. The skill first runs deterministic validation (lint/typecheck/build) and short-circuits to a validation-failed `05-review.md` if any check fails. Otherwise it spawns **four parallel reviewers** (correctness, security, performance, architectural-fit) and saves `05-review.md`.
3. **GATE** — after the skill presents findings:
   ```
   → Approve to proceed to testing (no critical issues)
   → Send back for fixes (specify which issues to address)
   ```
4. If fixes needed → **check the iteration budget first**:
   - Read `.iterations.json` and increment `review_implement_loops`
   - If the new value is > 2 (this would be the 3rd loop-back), **do NOT auto-route**. Escalate:
     - Print a summary of prior attempts (pull deviations/re-run notes from successive `04-implementation.md` revisions and the sequence of `05-review.md` findings)
     - Ask the user: "We've looped review ↔ implement N times. Options: (a) force another loop, (b) re-plan the approach, (c) accept with known issues and proceed to test, (d) abort."
     - Route according to the user's choice; do not increment further without explicit approval
   - If the new value is ≤ 2, write the updated counter back to `.iterations.json` and re-invoke `/feature-pipeline:implement <ticket-id>` — the skill reads the review from `05-review.md` automatically
   - After fixes, run a quick pass to verify: invoke `/feature-pipeline:review <ticket-id>` again
5. If approved → proceed to next stage (counter persists; only resets on successful completion)

---

### TEST

1. Invoke the test skill: `/feature-pipeline:test <ticket-id>`
2. The skill spawns a UI tester and saves `06-tests.md`
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

1. Write pipeline summary to `claudedocs/pipeline/<ticket-id>/07-summary.md`:
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

   All artifacts: claudedocs/pipeline/<ticket-id>/

   Would you like to commit these changes?
   ```

4. If user wants to commit, use standard git workflow:
   - Stage relevant files
   - Create descriptive commit message referencing the ticket ID

5. **After commit (or if user declines commit), ALWAYS finalize the ticket**:
   - Move ticket file from `.tickets/in-progress/` to `.tickets/done/`
   - Update the `status` field in frontmatter from `in-progress` to `done`
   - This step is mandatory — do not end the pipeline without it

---

## Artifact Convention

All artifacts are numbered by stage order. The canonical layout:

```
claudedocs/pipeline/<ticket-id>/
├── 00-exploration.md       # Discovery-time codebase exploration (optional — only when the ticket went through /feature-pipeline:discovery)
├── 01-spec.md              # Enriched ticket specification
├── 02-analysis.md          # code-explorer + requirements-analyst output
├── 03-plan.md              # Implementation blueprint
├── 04-implementation.md    # Implementation summary + validation results (live — updated per step)
├── 05-review.md            # Merged review findings (4 reviewers)
├── 06-tests.md             # UI test execution results
├── 07-summary.md           # Pipeline completion summary
├── .iterations.json        # Loop-back counter state (see "Loop-back iteration budget" section)
├── bugs/                   # Bug reports from testing (if any)
│   ├── BUG-001.md
│   └── BUG-002.md
└── .stale/                 # Superseded artifacts after deliberate re-runs (see "Artifact invalidation" section)
    └── <iso-timestamp>/
```

**Naming rules:**
- Sequential: `NN-name.md` where `NN` is the stage order
- `01`–`07` are reserved for the canonical stages in order. Don't reuse numbers.
- `00-` is reserved for pre-spec artifacts (currently just `00-exploration.md`)
- Bug reports from the test stage go in `bugs/BUG-NNN.md` (zero-padded to 3)
- The ticket spec is ALWAYS `01-spec.md` — ticket-resolution writes it if missing
- `.stale/` is reserved for superseded artifacts after deliberate re-runs; stages ignore anything under it
- `.iterations.json` is feature-flow state, not a stage artifact

## Continuation & Partial Runs

When starting a stage, always check if previous stage artifacts exist in the pipeline directory. If they do, use them as input rather than requiring the user to re-run earlier stages.

This enables:
- Resuming a pipeline that was interrupted
- Re-running a single stage with `--only` using existing artifacts from earlier stages
- Skipping stages that were already completed
- Detecting fully-complete pipelines via `07-summary.md` presence (see SETUP step 3)

## Error Handling

- If a stage skill fails or returns an error, report it to the user and ask how to proceed (retry, skip, or abort)
- If the ticket file can't be found, ask the user for the correct path
- If the project path can't be determined, ask the user
