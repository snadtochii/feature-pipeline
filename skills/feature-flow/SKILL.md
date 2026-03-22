---
name: feature-flow
description: Agentic feature development pipeline orchestrator. Sequences analyze, plan, implement, review, and test stage skills with human review gates. Supports --from, --to, --only, --skip, --continue flags for partial runs.
---

# Feature Flow Pipeline

Orchestrates feature development through stage skills with human review gates.

Each stage is a separate skill that can also be invoked directly:
- `/feature-pipeline:analyze` — codebase exploration + spec analysis
- `/feature-pipeline:plan` — interactive implementation planning
- `/feature-pipeline:implement` — code writing + lint + tests
- `/feature-pipeline:review` — parallel code review (3 reviewers)
- `/feature-pipeline:test` — UI/E2E testing via Playwright

## Arguments

```
/feature-pipeline:feature-flow <ticket> [flags]
```

- `<ticket>` — ticket ID (e.g. `BL-1`) or path to ticket file (e.g. `.tickets/backlog/dark-mode.md`)

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

## SETUP

1. **Find the ticket**:
   - If argument looks like a path (contains `/` or `.md`), read that file directly
   - If argument looks like an ID (e.g. `BL-1`), search for it:
     - Check `.tickets/backlog/<id>.md`
     - Check `.tickets/in-progress/<id>.md`
     - Check `.tickets/review/<id>.md`
     - Try case-insensitive glob: `.tickets/**/*<id>*.md`
   - If not found, ask the user for the ticket path

2. **Read the ticket content** and extract frontmatter (id, title, project, tags, etc.)

3. **Create artifacts directory**:
   - Path: `claudedocs/pipeline/<ticket-id>/` (use the id from frontmatter, or slugified filename)
   - If the directory already exists, this is a continuation — read existing artifacts to understand previous progress

4. **Save enriched spec**:
   - Write the ticket content to `claudedocs/pipeline/<ticket-id>/01-spec.md`

5. **Determine which stages to run** based on flags:
   - `--only X` → run only X
   - `--from X` → run X and everything after
   - `--to X` → run everything up to and including X
   - `--skip X` → run all except X
   - Flags combine: `--from X --to Y --skip Z`

6. **If `--continue` flag is set**, auto-detect the next stage by checking which artifacts exist:
   - Check for artifacts in `claudedocs/pipeline/<ticket-id>/` in reverse order:
     - `06-tests.md` exists → all stages done, go to COMPLETION
     - `05-review.md` exists → resume from `test`
     - `04-implementation.md` exists → resume from `review`
     - `03-plan.md` exists → resume from `implement`
     - `02-analysis.md` exists → resume from `plan`
     - `01-spec.md` exists (or nothing) → resume from `analyze`
   - This is equivalent to `--from <next-stage>` — other flags like `--to` and `--skip` can still be combined with it
   - Print which stage is being resumed: "Artifacts found through `<last-stage>`. Resuming from `<next-stage>`."

7. **Move ticket** from `backlog/` to `in-progress/` (if not already there — skip if ticket is already in `in-progress/`)

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
2. The skill writes code, runs lint/tests, and saves `04-implementation.md`
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
2. The skill spawns three parallel reviewers and saves `05-review.md`
3. **GATE** — after the skill presents findings:
   ```
   → Approve to proceed to testing (no critical issues)
   → Send back for fixes (specify which issues to address)
   ```
4. If fixes needed → go back to **IMPLEMENT** stage with review findings as input
   - Re-invoke `/feature-pipeline:implement <ticket-id>` — the skill reads the review from `05-review.md`
   - After fixes, run a quick single-reviewer pass to verify: invoke `/feature-pipeline:review <ticket-id>` again
5. If approved → proceed to next stage

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
4. Route based on user response:
   - All pass → COMPLETION
   - Code bug → go back to **IMPLEMENT** stage with bug reports as input
   - Design flaw → go back to **PLAN** stage with test findings as input

---

## COMPLETION

**IMPORTANT: All completion steps below are MANDATORY. Do not skip any of them.**

1. Write pipeline summary to `claudedocs/pipeline/<ticket-id>/07-summary.md`:
   - Ticket title and ID
   - Stages completed
   - Files created/modified
   - Review findings addressed
   - Test results
   - Total iterations (if any loops occurred)

2. **Present to user**:
   ```
   ## Pipeline Complete

   [Final summary]

   All artifacts: claudedocs/pipeline/<ticket-id>/

   Would you like to commit these changes?
   ```

3. If user wants to commit, use standard git workflow:
   - Stage relevant files
   - Create descriptive commit message referencing the ticket ID

4. **After commit (or if user declines commit), ALWAYS finalize the ticket**:
   - Move ticket file from `.tickets/in-progress/` to `.tickets/done/`
   - Update the `status` field in frontmatter from `in-progress` to `done`
   - This step is mandatory — do not end the pipeline without it

---

## Artifact Convention

All artifacts are numbered by stage order:

```
claudedocs/pipeline/<ticket-id>/
├── 01-spec.md              # Enriched ticket specification
├── 02-analysis.md          # code-explorer + requirements-analyst output
├── 03-plan.md              # Implementation blueprint
├── 04-implementation.md    # Implementation summary + validation results
├── 05-review.md            # Merged review findings (3 reviewers)
├── 06-tests.md             # UI test execution results
├── 07-summary.md           # Pipeline completion summary
└── bugs/                   # Bug reports from testing (if any)
    ├── BUG-001.md
    └── BUG-002.md
```

## Continuation & Partial Runs

When starting a stage, always check if previous stage artifacts exist in the pipeline directory. If they do, use them as input rather than requiring the user to re-run earlier stages.

This enables:
- Resuming a pipeline that was interrupted
- Re-running a single stage with `--only` using existing artifacts from earlier stages
- Skipping stages that were already completed

## Error Handling

- If a stage skill fails or returns an error, report it to the user and ask how to proceed (retry, skip, or abort)
- If the ticket file can't be found, ask the user for the correct path
- If the project path can't be determined, ask the user
