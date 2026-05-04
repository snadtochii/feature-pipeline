---
name: build
description: "Build the ticket end-to-end through one continuous loop — implement → review → test as internal checkpoints, fixes applied in-context, verdict-based exit. Use when user says 'build this ticket', 'run the build loop', 'implement, review, and test', or 'build it'. NOT for plan-only or for review-only runs."
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

# Build Stage

Build the ticket through one continuous loop with internal checkpoints (implement → review → test). All fixes happen in-context — no rewinds to earlier stages. Exit with verdict `pass`, `partial`, or `stuck`.

**This stage runs in the main conversation — NOT as a subagent.** (The four reviewer subagents in the review checkpoint and the `ui-tester` subagent in the test checkpoint run from within this stage.)

## Arguments

```
/feature-pipeline:build $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file. Optional flags: `--continue` (resume from prior artifacts on disk), `--ignore-blockers` (bypass blocker-validation refusal).

## Ticket Resolution & Artifacts Setup

Use the canonical logic in [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification (for acceptance criteria)
- `02-plan.md` — the approved implementation plan (**required** — if not found, refuse with: "Plan stage hasn't run. Run `/feature-pipeline:plan $1` first.")

When `--continue` is passed, also read whichever of these exist on disk to reconstruct state:
- `03-implementation.md` — completed plan steps from a prior build invocation
- `04-review.md` — review state from a prior build invocation
- `05-tests.md` — test state from a prior build invocation

## Epic refusal

Validate `kind` per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 4 before any work. If the ticket has `kind: epic`, abort and instruct the user to run build against a child ticket instead — epics are non-pipelineable.

## Blocker validation

Validate blockers per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 6. If any entry in `blocked_by` is not yet done (frontmatter `status: done` or `cancelled`, or folder under `done/`), abort with the message in Step 6 listing the unblocked blockers. Bypass with `--ignore-blockers` (prints a warning, proceeds at your risk — the blocker's foundational work isn't in place).

When `blocked_by` is non-empty (whether blockers are done or `--ignore-blockers` is used), build composes a **blocker context block** and prepends it to the review-checkpoint reviewer prompts (see Step 2). Per resolved Q3, the block uses each blocker's verbatim `01-spec.md` + `06-summary.md`. **Fallback for `--ignore-blockers` runs where a blocker is unfinished**: if `06-summary.md` is missing, use that blocker's `02-plan.md`; if `02-plan.md` is also missing, use `01-spec.md` alone. Note in the block which artifact was used per blocker.

---

## Behavioral Mindset

Ship working code in one continuous loop. Implement plan steps incrementally, edit small, verify often. When validation fails, fix in-context — never queue failures for later. When reviewers find issues, apply the high-confidence fixes in the same conversation; don't punt to a separate stage. When tests fail un-fixably, exit with `verdict: partial` — don't fake completion. The loop is the work; rewinding to earlier stages would discard the context the loop was just operating in.

Watch for stuck patterns (action↔observation repetition, agent monologue, ping-pong, repeated context errors). Emit `Turn N/25` at every iteration boundary so the count is recoverable from the transcript. On a stuck pattern or `Turn 26`, exit with `verdict: stuck` — surface the human gate, don't keep spinning.

## Focus Areas

- **Plan Execution**: Follow `02-plan.md` step-by-step, respecting task order and file boundaries; update `03-implementation.md` as a live checkpoint
- **Continuous Validation**: Run lint/typecheck after every meaningful change (skill-body fallback always on, regardless of whether a `PostToolUse` hook is also configured — see `references/validation-hook.md`)
- **In-Context Fixes**: Apply review findings (≥ 80 confidence) and test failures inside the same loop; defer only what's genuinely un-fixable in this run
- **Stuck Awareness**: Self-monitor for stuck patterns and the 25-turn ceiling; exit cleanly with `verdict: stuck` rather than spin
- **Single Source of Truth**: Compose reviewer prompts at spawn time with the shared confidence scale (`references/confidence-scale.md`) and any blocker context — do not delegate the rubric to agent bodies
- **Verdict Discipline**: Exit with one of `pass | partial | stuck`; always write `06-summary.md` regardless of verdict so downstream readers (and reopened-ticket regressions) have a uniform contract

## Boundaries

**Will:**
- Run implement, review, and test as in-loop checkpoints in one main-context invocation
- Spawn the 4 reviewer subagents in parallel (single message, four `Task` calls); merge findings into `04-review.md`
- Spawn the `ui-tester` subagent at the test checkpoint when the plan has UI signals; otherwise write a skip artifact to `05-tests.md`
- Apply review and test fixes in-context, with a documented tiebreak when fixes are mutually exclusive
- Update `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md` per the artifact contract
- Emit `Turn N/25` lines and self-detect stuck patterns

**Will Not:**
- Re-invoke `/feature-pipeline:plan` or any other skill mid-loop (build is forward-only)
- Persist iteration state to disk — turn count and stuck patterns are conversational state, observed in-transcript
- Inline the confidence rubric into reviewer agent bodies (the rubric is build-injected at spawn time, agent bodies must stay rubric-free)
- Skip validation steps; leave failing tests; add features beyond what `02-plan.md` specifies
- Exit silently on a stuck pattern or turn-cap hit — always write `06-summary.md` describing the loop state

---

## Process

The build loop runs three checkpoints in sequence: **implement** → **review** → **test** → exit verdict. All three checkpoints are part of the same main-context conversation.

### 1. Implement checkpoint

a. **Emit `Turn 1/25`** as the first iteration marker.

b. **Validation setup.** Read project `CLAUDE.md`, extract lint and typecheck commands. Common locations: a `## Commands` section, a `## Validation` section, a `## Testing` section, or inline references to `npm run lint` / `pnpm test` / `cargo check` / `pytest` / etc. Capture the commands for use after each meaningful change. If the project documents no commands, log a one-line warning ("No validation commands found in project CLAUDE.md — proceeding without skill-body validation") and continue.

   **Always run skill-body validation after each meaningful change**, regardless of whether a `PostToolUse` hook is also active. The two layers (hook + skill-body) are intentionally redundant — see `references/validation-hook.md` for rationale.

c. **For each step in `02-plan.md`'s Build Sequence, in order:**
   1. **Re-read the current step from `02-plan.md`** — use `Read` with `offset`/`limit` to load just the relevant step's section. On long implementations the plan drifts out of working context by step 4 or 5; re-reading each step against its source is nearly free and prevents plan drift.
   2. **Implement the change** following the plan's "Files" and "Pattern to follow" fields.
   3. **Run validation** (lint/typecheck via `Bash`) — fix any errors immediately before moving on.
   4. **Update `03-implementation.md`** with files created/modified, brief description, any deviations from the plan with rationale, validation state.
   5. **Emit `Turn N/25`** at the start of the next iteration.
   6. **Watch the transcript for stuck patterns** (per `references/stuck-detection.md`): action↔observation repetition, action↔error repetition, agent monologue, ping-pong between two states, repeated context errors. On detection, exit with `verdict: stuck` (skip directly to step 4 of this Process — Exit verdict).
   7. **On hitting `Turn 26`**, exit with `verdict: stuck` regardless of semantic-pattern detection. The hybrid stop rule per the redesign's Q4-b: either trigger fires the verdict.

d. **After all plan steps are implemented**, run final validation across all changes. Fix any cross-cutting failures in-context. Update `03-implementation.md` with the final implementation state. Proceed to the review checkpoint.

### 2. Review checkpoint

a. **Collect the diff.** Mirror `skills/review/SKILL.md:65-80`'s logic:

   ```bash
   # Detect the base branch — prefer origin's HEAD, fall back to main
   base=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/@@' || echo main)

   # Branch-scope diff: everything committed on this branch since diverging from base
   git diff "$base"...HEAD

   # Unstaged changes on top of HEAD
   git diff
   ```

   If `origin/HEAD` isn't configured, default to `main`. If neither exists, ask the user which base branch to diff against. Concatenate the branch-scope diff and unstaged diff. Empty diff → record "No code changes to review" in `04-review.md` and proceed to the test checkpoint.

b. **Compose the shared base for reviewer prompts** (single composition, used by all four reviewers):

   1. **Ticket context**: contents of `01-spec.md`, `02-plan.md`, `03-implementation.md`.
   2. **Diff**: output from step a.
   3. **Project root path**.
   4. **Blocker context** (only when `blocked_by` is non-empty per the Blocker validation section above): a `## Blocker context (from completed siblings)` block. For each blocker: include verbatim `01-spec.md` + `06-summary.md`. **Fallback for `--ignore-blockers` runs where a blocker is unfinished**: when `06-summary.md` is missing, use the blocker's `02-plan.md`; when `02-plan.md` is also missing, use `01-spec.md` alone. Note in the block which artifact was used per blocker. Omit the entire block when `blocked_by` is empty.
   5. **Confidence scale**: the verbatim contents of `references/confidence-scale.md` under a `## Confidence scale (use this exactly)` header. (R-2 fix: rubric lives in the reference, build injects it here, reviewer agent bodies stay rubric-free.)

c. **Spawn four reviewer subagents in parallel.** All four run **concurrently** — launch them in a single message with four `Task` tool calls. Each prompt = the shared base from step b + a per-reviewer suffix:

   **a. `feature-pipeline:code-reviewer`** (correctness + quality):
   > Review these code changes for correctness, bugs, logic errors, and adherence to project conventions. Use the confidence scale above — only report issues with confidence ≥ 80.

   **b. `feature-pipeline:security-engineer`** (security):
   > Review these code changes for security vulnerabilities. Check for: input validation, auth issues, injection risks, data exposure, OWASP Top 10. Use the confidence scale above — only report issues with confidence ≥ 80.

   **c. `feature-pipeline:performance-engineer`** (performance):
   > Review these code changes for performance issues. Check for: N+1 queries, unnecessary re-renders, memory leaks, bundle size impact, algorithm complexity. Use the confidence scale above — only report issues with confidence ≥ 80.

   **d. `feature-pipeline:code-architect`** (architectural fit):
   > Review these code changes for architectural fit. Check for:
   > - Does this change match existing patterns and conventions in the codebase?
   > - Does it respect existing layer boundaries and abstractions?
   > - Does it introduce unnecessary duplication or reinvent existing utilities?
   > - Does the API/component design match the style of sibling code?
   > - Are there coupling or cohesion concerns?
   >
   > Reference specific files and patterns with file:line. Use the confidence scale above — only report issues with confidence ≥ 80.

d. **Merge findings into `<ticket-folder>/04-review.md`** (mirror `skills/review/SKILL.md:105-112`):
   - **Group by severity**: CRITICAL → IMPORTANT → SUGGESTION
   - **De-duplicate** overlapping findings (e.g., if both code-reviewer and code-architect flag the same issue)
   - **Tag each finding** with `[correctness]` / `[security]` / `[performance]` / `[architecture]`
   - **Top-of-file summary** with counts per severity + per reviewer
   - **Reviewer failure handling**: if a reviewer subagent fails, report it inside the merged artifact and continue with results from the other reviewers (graceful partial-merge per `skills/review/SKILL.md:130-134`). All four failing → write a single error entry in `04-review.md` and exit with `verdict: stuck`.

e. **Apply applicable fixes in-context.** The model uses judgment to apply fixes from the merged findings. **Tiebreak when fixes are mutually exclusive**: `security > correctness > architecture > performance`. **Rationale (called out so future readers don't reverse-engineer it)**: security failures have the largest blast radius (real-world exposure); correctness is the AC contract; architecture is internal consistency that can be repaired later; performance is the most local and most easily revisited.

   Unresolvable conflicts go into `04-review.md` as `status: deferred (conflict)` with both reviewers' findings preserved. Deferred conflicts surface only via downstream `verdict: partial` if they end up causing AC failures.

f. **After fixes are applied**, run validation again (lint/typecheck) and update `03-implementation.md` to reflect the post-review state. Emit `Turn N/25` at the next iteration boundary; continue to monitor for stuck patterns. Proceed to the test checkpoint.

### 3. Test checkpoint

a. **Skip-detection scan.** Read `02-plan.md` and search (case-insensitive substring match) for any of: `component, page, route, screen, form, tsx, jsx, html, view`. Match → run `ui-tester` (step b). No match → skip (step c).

b. **Spawn `feature-pipeline:ui-tester`** (when not skipped). Read the project's `CLAUDE.md` for a test framework hint (`## Testing` section, `## Commands` section, or inline references like "Playwright specs in `e2e/`"). Single `Task` call:

   > Test this feature through real browser interaction. Spec with acceptance criteria: `<contents of 01-spec.md>`. Implementation summary: `<from 03-implementation.md>`. Application URL: `<URL from project CLAUDE.md or asked from user>`. Project test framework hint: `<from CLAUDE.md, or 'none documented'>`. Test every acceptance criterion, take screenshots, check console for errors. Report any failures with reproduction steps. If ALL acceptance criteria pass AND a test framework hint is available, codify the passing run into an automated spec file in the project's test directory — mirror the conventions of existing specs, never rewrite an existing spec, and never check in a flaky one.

   Save subagent output to `<ticket-folder>/05-tests.md`. Failed criteria become a `## Failed Criteria` section inside `05-tests.md`. If specs were codified, list their paths under a `## Codified specs` section.

c. **Skip artifact** (when no UI signals matched). **Important**: `skipped` is a **test-checkpoint label written into `05-tests.md`**, NOT a fourth build verdict. The build verdict set remains `pass | partial | stuck` per the locked redesign. When the test checkpoint is skipped, build can still exit with `verdict: pass` if the implement and review checkpoints completed cleanly. Write `<ticket-folder>/05-tests.md`:

   ```
   verdict: skipped (no UI work in plan)

   ## Reason
   Keyword scan of 02-plan.md found no UI signals (component, page, route, screen, form, tsx, jsx, html, view).

   ## Acceptance Criteria
   - [ ] AC 1 — not-tested (no UI)
   - [ ] AC 2 — not-tested (no UI)
   ...
   ```

d. **Apply test fixes in-context.** Test failures are observations the loop consumes — fix them inline using the same pattern as the review checkpoint. If fixes succeed, re-run the failing tests. If failures are un-fixable in this run, write the `## Failed Criteria` section to `05-tests.md` and prepare to exit with `verdict: partial`.

e. **Application not running.** If `ui-tester` reports the application is not running, ask the user to start it and provide the URL (matches `skills/test/SKILL.md:82-84` pattern). Persistent inability to reach the app counts as a stuck pattern (repeated context errors) — exit with `verdict: stuck`.

f. **After test fixes are applied** (or skip artifact written), update `03-implementation.md` if any code changed, then proceed to step 4.

### 4. Exit verdict

Choose one based on loop state:

- **`pass`** — All `02-plan.md` Build Sequence steps implemented; all reviewer findings either applied or marked deferred-by-conflict; all UI tests pass (or skip artifact written). Surface the completion gate to the user; on approval, the ticket folder moves to `done/`. (The folder move happens in flow's COMPLETION step; build returns the verdict.)
- **`partial`** — Implementation is mostly complete but some acceptance criteria fail un-fixably in this run, or unresolvable review conflicts ended up causing AC failures. Stay in `in-progress/`. Set frontmatter `status: partial-completion`. Surface the human gate with options:
  - **accept-as-partial** (move to `done/`, keep `status: partial-completion`)
  - **continue-with-hint** (re-enter the loop with a user note, fresh 25-turn budget)
  - **abort** (revert folder move, ticket back in `backlog/`)
- **`stuck`** — Semantic stuck pattern detected, or `Turn 26` reached, or all four reviewers failed, or persistent context errors. Same human-gate options as `partial`. The user reads `06-summary.md` to understand the loop state at escalation and pick.

**Always write `06-summary.md`** regardless of verdict (resolved Q8). Content varies:
- `pass`: completed work summary, files changed, validation passed, test results.
- `partial`: references the `## Failed Criteria` section in `05-tests.md`, lists deferred conflicts from `04-review.md`, lists what was completed.
- `stuck`: describes loop state at escalation — the detected stuck pattern (or "turn cap exceeded"), the last 3-5 iterations' actions, a suggested next-move for the user.

The uniform always-write contract means downstream readers (and reopened-ticket regressions) never have to handle a "missing summary = unknown verdict" failure mode.

### 5. `--continue` resumption

When `--continue` is passed:

1. **State reconstruction**. Read whichever artifacts exist on disk:
   - `03-implementation.md` for completed plan steps
   - `04-review.md` for review state
   - `05-tests.md` for test state (including any prior skip artifact or failed criteria)
2. **Determine where to resume**. If `05-tests.md` exists with failed criteria → re-enter at the test checkpoint. Else if `04-review.md` exists → re-enter at the review checkpoint (re-running the 4 reviewers against the fresh diff). Else if `03-implementation.md` is partial → continue from the next un-implemented plan step. Else → fresh start.
3. **Reset the turn counter**. Resumed sessions start at `Turn 1/25` — the prior budget is forfeited by design. A resumed session is a fresh attempt, and reusing a stale counter would mislead.
4. **Surface a user note** if the user provided one with `--continue` (e.g., `--continue --hint "the failing test wants the ARIA label inside the button, not on it"`). The hint becomes part of the resumed loop's context.

The user-facing flow surface for `--continue` lives in `flow/SKILL.md`; this section documents the mechanic for direct invocation.

---

## Output

The build skill writes these artifacts to `<ticket-folder>/` over the course of the loop:

- **`03-implementation.md`** — incremental updates, one section per plan step (live checkpoint, not post-hoc summary)
- **`04-review.md`** — written once at the end of the review checkpoint (merged from 4 reviewer subagents)
- **`05-tests.md`** — written once at the end of the test checkpoint (test results, or the skip artifact, or a `## Failed Criteria` section on partial)
- **`06-summary.md`** — written once at build exit, regardless of verdict (pass / partial / stuck content varies per the Verdict section above)

Failed test criteria live inside `05-tests.md` under `## Failed Criteria`; turn count and stuck patterns are conversational state, not file state.

## Presentation

Present to the user at exit:

```
## Build Complete — verdict: <pass|partial|stuck>

[Brief summary: files changed, validation state, reviewer findings count, test results, stuck-pattern detail if applicable]

[For pass: "Ready to move to done/ on completion gate."]
[For partial: "Some criteria un-fixable in this run. Options: accept-as-partial / continue-with-hint / abort."]
[For stuck: "Loop escalated. Options: continue-with-hint / abort / accept-as-partial."]

Artifacts saved to: <ticket-folder>/03-implementation.md, 04-review.md, 05-tests.md, 06-summary.md
```

## Error Handling

- **Plan missing**: `02-plan.md` not found → refuse with: "Plan stage hasn't run. Run `/feature-pipeline:plan $1` first."
- **Project path unknown**: ask the user.
- **`origin/HEAD` not configured and `main` doesn't exist**: ask the user for the base branch.
- **Application URL needed for `ui-tester` but not provided** (and not in project `CLAUDE.md`): ask the user to start the app and provide the URL.
- **Subagent failure** (reviewer or `ui-tester` crashes/timeouts): report inside the merged artifact and continue with results from the others. All four reviewers failing simultaneously → write degraded `04-review.md` and exit `verdict: stuck`.
- **Validation commands not documented in project `CLAUDE.md`**: log warning, proceed without skill-body validation. Graceful degradation; the loop continues.
- **Stuck pattern detected or `Turn 26` reached**: not an error — handled via `verdict: stuck`. Always write `06-summary.md` describing the loop state.
- **`--continue` passed on a freshly-planned ticket** (no `03-implementation.md` yet): treat as fresh start; warn about the stale flag.
