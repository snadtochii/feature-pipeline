---
name: feature-flow
description: Agentic feature development pipeline for personal projects. Orchestrates analysis, planning, implementation, review, and testing through specialized agents with human review gates between stages. Supports --from, --to, --only, --skip flags for partial runs.
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, mcp__playwright__browser_navigate, mcp__playwright__browser_snapshot, mcp__playwright__browser_take_screenshot, mcp__playwright__browser_click, mcp__playwright__browser_wait_for, mcp__playwright__browser_fill_form, mcp__chrome-devtools__take_screenshot, mcp__chrome-devtools__navigate_page, mcp__chrome-devtools__list_console_messages, mcp__serena__find_symbol, mcp__serena__get_symbols_overview, mcp__serena__search_for_pattern
---

# Feature Flow Pipeline

Orchestrates feature development for personal projects through specialized agents with human review gates.

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

## Pipeline Stages

The stages run in this order: **analyze → plan → implement → review → test**

Each stage (except implement) runs as a **subagent** to keep the main context clean. Implementation runs in **main context** for direct interaction.

---

## Stage Execution

### SETUP: Resolve Ticket & Create Artifacts Directory

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

5. **Determine which stages to run** based on flags (--from, --to, --only, --skip, --continue)

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

### STAGE 1: ANALYZE (subagent)

**Agent**: `feature-pipeline:code-explorer` (for codebase context) then `feature-pipeline:requirements-analyst` (for spec analysis)

**These two subagents MUST run sequentially** — the analyst needs the explorer's output.

**Process**:
1. First, spawn `feature-pipeline:code-explorer` subagent:
   - Prompt: "Explore the codebase for project `<project>` to understand the areas relevant to: `<ticket title + description>`. Focus on: existing patterns, related files, architecture layers, and dependencies. The project root is at `<project-path>`."
   - Wait for it to complete before proceeding

2. Then, spawn `feature-pipeline:requirements-analyst` subagent:
   - Prompt: "Analyze this feature specification for completeness and feasibility. Here is the spec: `<ticket content>`. Here is the codebase context: `<explorer output>`. Identify gaps, edge cases, risks, and questions. Assess complexity."
   - This subagent returns the analysis

3. Save combined output to `claudedocs/pipeline/<ticket-id>/02-analysis.md`

4. **Present to user**:
   ```
   ## Analysis Complete

   [Summary of key findings, gaps, questions]

   Artifacts saved to: claudedocs/pipeline/<ticket-id>/02-analysis.md

   → Approve to proceed to planning
   → Reject with notes to re-analyze
   ```

5. **GATE**: Wait for user response.
   - If approved → proceed to Stage 2
   - If rejected → re-run Stage 1 with user's notes added to the prompt

---

### STAGE 2: PLAN (main context, plan mode)

**This stage runs in the main conversation using Claude Code's plan mode — NOT as a subagent.**

**IMPORTANT**: The analysis from Stage 1 MUST be read and used as input. The plan must address any gaps, risks, or questions identified in the analysis.

**Process**:
1. Read the analysis findings from `claudedocs/pipeline/<ticket-id>/02-analysis.md`
2. Enter plan mode using `EnterPlanMode`
3. Explore the codebase as needed (read files, search for patterns, understand architecture)
4. Create an implementation plan that:
   - Addresses gaps and risks identified in the analysis
   - Lists specific files to create/modify
   - Describes component design and data flow
   - Defines a phased build sequence
   - Notes key decisions and trade-offs
5. The user can interactively refine the plan in plan mode — respond to feedback, adjust approach, answer questions
6. When the user approves the plan (exits plan mode), save it to `claudedocs/pipeline/<ticket-id>/03-plan.md`
7. Proceed to Stage 3

---

### STAGE 3: IMPLEMENT (main context)

**This stage runs directly in the main conversation — NOT as a subagent.**

Follow the `feature-pipeline:implementer` agent behavioral guidelines.

**Process**:
1. Read the approved plan from `claudedocs/pipeline/<ticket-id>/03-plan.md`
2. Read the project's CLAUDE.md and existing code patterns

#### 3a. Code Implementation
3. For each task in the plan:
   a. Implement the change
   b. Run lint/typecheck — fix all errors immediately
   c. Run build (if applicable) — fix all compilation errors immediately

#### 3b. Tests
4. After all code changes are implemented, write tests for new or modified code:
   - Follow the project's existing testing conventions (check CLAUDE.md, existing test files)
   - Run tests as you write them, fix failures immediately

#### 3c. Validation
5. Run the full test suite
6. Run lint one final time

#### 3d. Summary
7. Save implementation summary to `claudedocs/pipeline/<ticket-id>/04-implementation.md`:
   - Files created/modified (with brief description of each change)
   - Test files created/modified
   - Lint results (must be clean)
   - Test results (pass/fail counts, must all pass)
   - Any deviations from the plan with rationale

8. **Present to user**:
   ```
   ## Implementation Complete

   [Summary: files changed, tests written, all passing, any deviations]

   Artifacts saved to: claudedocs/pipeline/<ticket-id>/04-implementation.md

   → Approve to proceed to review
   → Request fixes with specific issues
   ```

9. **GATE**: Wait for user response.
    - If approved → proceed to Stage 4
    - If fix → apply fixes, re-run validation, present again

---

### STAGE 4: REVIEW (subagents, parallel)

**Agents**: Three reviewers run in parallel as subagents.

**Process**:
1. Get the diff of all changes: `git diff` (or compare against the branch base)

2. Spawn three subagents in parallel:

   a. **`feature-pipeline:code-reviewer`** (correctness + quality):
      - Prompt: "Review these code changes for correctness, bugs, logic errors, and adherence to project conventions. Changes: `<git diff or file list>`. Project root: `<project-path>`. Use confidence scoring — only report issues with confidence >= 80."

   b. **`feature-pipeline:security-engineer`** (security):
      - Prompt: "Review these code changes for security vulnerabilities. Changes: `<git diff or file list>`. Project root: `<project-path>`. Check for: input validation, auth issues, injection risks, data exposure, OWASP Top 10."

   c. **`feature-pipeline:performance-engineer`** (performance):
      - Prompt: "Review these code changes for performance issues. Changes: `<git diff or file list>`. Project root: `<project-path>`. Check for: N+1 queries, unnecessary re-renders, memory leaks, bundle size impact, algorithm complexity."

3. Merge all findings into `claudedocs/pipeline/<ticket-id>/05-review.md`:
   - Group by severity (CRITICAL → WARNING → SUGGESTION)
   - De-duplicate overlapping findings
   - Note which reviewer flagged each issue

4. **Present to user**:
   ```
   ## Review Complete

   [Summary: issue counts by severity, key findings]

   Artifacts saved to: claudedocs/pipeline/<ticket-id>/05-review.md

   → Approve to proceed to testing (no critical issues)
   → Send back for fixes (list which issues to address)
   ```

5. **GATE**: Wait for user response.
   - If approved → proceed to Stage 5
   - If fix needed → go back to Stage 3 (implement) with review findings as input
     - Read the review, apply fixes, re-run validation
     - After fixes, run a quick single-reviewer pass to verify fixes
     - Present again

---

### STAGE 5: TEST (subagent)

**Agent**: `feature-pipeline:ui-tester`

**Prerequisite**: The application must be running. Ask the user for the URL if not obvious from the project.

**Process**:
1. Spawn `feature-pipeline:ui-tester` subagent:
   - Prompt: "Test this feature through real browser interaction. Spec with acceptance criteria: `<ticket content>`. Implementation summary: `<implementation output>`. Application URL: `<url>`. Test every acceptance criterion, take screenshots, check console for errors. Report bugs with reproduction steps."
   - The subagent has access to Playwright and Chrome DevTools MCP

2. Save output to `claudedocs/pipeline/<ticket-id>/06-tests.md`
   - If bugs found, also save individual bug files to `claudedocs/pipeline/<ticket-id>/bugs/`

3. **Present to user**:
   ```
   ## Testing Complete

   [Summary: tests passed/failed, bugs found by severity]

   Artifacts saved to: claudedocs/pipeline/<ticket-id>/06-tests.md

   → All pass → Complete the pipeline
   → Code bug → Send back to implementation (Stage 3) with bug details
   → Design flaw → Send back to planning (Stage 2) to revise approach
   ```

4. **GATE**: Wait for user response.
   - If all pass → proceed to Completion
   - If code bug → go back to Stage 3 with bug reports as input
   - If design flaw → go back to Stage 2 with test findings as input

---

### COMPLETION

**IMPORTANT: All completion steps below are MANDATORY. Do not skip any of them.**

1. Write pipeline summary to `claudedocs/pipeline/<ticket-id>/07-summary.md`:
   - Ticket title and ID
   - Stages completed and timestamps
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

## Artifact Naming Convention

All artifacts are numbered by stage order:

```
claudedocs/pipeline/<ticket-id>/
├── 01-spec.md              # Enriched ticket specification
├── 02-analysis.md          # requirements-analyst + code-explorer output
├── 03-plan.md              # code-architect / system-architect blueprint
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

- If a subagent fails or returns an error, report it to the user and ask how to proceed (retry, skip, or abort)
- If lint/tests fail during implementation, fix them before presenting results — don't punt failures to the user
- If the ticket file can't be found, ask the user for the correct path
- If the project path can't be determined, ask the user
