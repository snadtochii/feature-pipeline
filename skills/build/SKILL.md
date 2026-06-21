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
/feature:build $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file. Optional flags: `--hint "<text>"` (thread a user note into the resumed loop — used by flow's verdict-gate `continue-with-hint` option), `--ignore-blockers` (bypass blocker-validation refusal), `--pr` (on verdict `pass`, open a GitHub PR and finalize into `review/` instead of `done/` — see [`references/pr-creation.md`](references/pr-creation.md)), `--no-ui-testing` (skip only the browser/ui-tester portion of the test checkpoint; lint/typecheck still run and still gate the verdict — see the test checkpoint's flag override).

Resumption is auto-detected from on-disk artifacts — see step 5 below. To start fresh against a partially-built ticket, delete the relevant artifacts (`03-implementation.md` onward) before invoking build.

## Ticket Resolution & Artifacts Setup

Use the canonical logic in [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification (for acceptance criteria)
- `02-plan.md` — the approved implementation plan (**required** — if not found, refuse with: "Plan stage hasn't run. Run `/feature:plan $1` first.")

For auto-resumption, also read whichever of these exist on disk to reconstruct state (see step 5 below for resumption logic):
- `03-implementation.md` — completed plan steps from a prior build invocation
- `04-review.md` — review state from a prior build invocation
- `05-tests.md` — test state from a prior build invocation

## Epic refusal

Validate `kind` per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 4 before any work. If the ticket has `kind: epic`, abort and instruct the user to run build against a child ticket instead — epics are non-pipelineable.

## Blocker validation

Validate blockers per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 6. If any entry in `blocked_by` is not yet done (frontmatter `status: done` or `cancelled`, or folder under `done/`), abort with the message in Step 6 listing the unblocked blockers. Bypass with `--ignore-blockers` (prints a warning, proceeds at your risk — the blocker's foundational work isn't in place).

When `blocked_by` is non-empty (whether blockers are done or `--ignore-blockers` is used), build composes a **blocker context block** and prepends it to the review-checkpoint reviewer prompts (see Step 2). Per resolved Q3, the block uses each blocker's verbatim `01-spec.md` + `06-summary.md`. **Fallback for `--ignore-blockers` runs where a blocker is unfinished**: if `06-summary.md` is missing, use that blocker's `02-plan.md`; if `02-plan.md` is also missing, use `01-spec.md` alone. Note in the block which artifact was used per blocker.

## State setup

Before the implement checkpoint, perform the start-of-pipeline transition per [`../flow/references/state-transitions.md`](../flow/references/state-transitions.md) Transition 1 (Start-of-pipeline → `in-progress`). Idempotent: if plan already ran in this pipeline invocation, the ticket is in `in-progress/` and only frontmatter is touched. If build is invoked directly on a `backlog/` ticket (re-run after manual artifact restoration, or unusual workflows), build moves the folder. (Build's own sources are `backlog/` and `in-progress/`; `review/` is handled separately — see the interception note below — and `done/` re-opens are a plan-side re-run.)

**`review/` is intercepted before this transition.** If the ticket is in `review/` (status `in-review`), the step-5 resumption check (first row) runs first: build inspects the PR's merge state and finalizes via Transition 6 (`review → done`) if merged, or reports the still-open PR and exits — it does NOT rebuild. The `review/ → in-progress` re-plan path (revise an open PR's code) belongs to `plan`, not build.

`<ticket-folder>` is rebound to the new location for the rest of this run.

---

## Behavioral Mindset

Ship working code in one continuous loop. Implement plan steps incrementally, edit small, verify often. When validation fails, fix in-context — never queue failures for later. When reviewers find issues, apply the high-confidence fixes in the same conversation; don't punt to a separate stage. When tests fail un-fixably, exit with `verdict: partial` — don't fake completion. The loop is the work; rewinding to earlier stages would discard the context the loop was just operating in.

Watch for stuck patterns (action↔observation repetition, agent monologue, ping-pong, repeated context errors, plus the outer-loop arbiter for logical oscillation — see `references/stuck-detection.md`). Emit `Turn N/25` at every iteration boundary so the count is recoverable from the transcript. On a stuck pattern or `Turn 26`, exit with `verdict: stuck` — surface the human gate, don't keep spinning.

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
- Spawn the `ui-tester` subagent at the test checkpoint when the plan has UI signals (unless `--no-ui-testing` forces the browser-portion skip); otherwise write a skip artifact to `05-tests.md`
- Apply review and test fixes in-context, with a documented tiebreak when fixes are mutually exclusive
- Update `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md` per the artifact contract
- Emit `Turn N/25` lines and self-detect stuck patterns

**Will Not:**
- Re-invoke `/feature:plan` or any other skill mid-loop (build is forward-only)
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
   6. **Watch the transcript for stuck patterns** (per `references/stuck-detection.md` patterns 1–5): action↔observation repetition, action↔error repetition, agent monologue, ping-pong between two states, repeated context errors. On detection, exit with `verdict: stuck` (skip directly to step 4 of this Process — Exit verdict).
   7. **Outer-loop arbiter check** (per `references/stuck-detection.md` pattern 6). When the current checkpoint has accumulated 4+ turns without exiting, fire the arbiter once via a `Task` call with the prompt in stuck-detection.md §6. Cache the verdict for the rest of the checkpoint. On `status: stuck`, exit with `verdict: stuck` (skip to step 4 — Exit verdict); include the arbiter's `reason` in `06-summary.md`.
   8. **On hitting `Turn 26`**, exit with `verdict: stuck` regardless of semantic-pattern detection. The hybrid stop rule per the redesign's Q4-b: either trigger fires the verdict.

d. **After all plan steps are implemented**, run final validation across all changes. Fix any cross-cutting failures in-context. Update `03-implementation.md` with the final implementation state. Proceed to the review checkpoint.

### 2. Review checkpoint

**Pre-check — Triviality short-circuit.** Before spawning reviewer subagents, check whether the diff is small enough that the four-subagent review is overkill (token cost > expected signal):

1. Read `01-spec.md` frontmatter — extract the `complexity` field.
2. Run `git diff --shortstat <base>...HEAD` (and add unstaged) to count lines and files changed.
3. If **all three** conditions hold — `complexity: S`, lines changed < 50, files changed < 3 — short-circuit:
   - Write `<ticket-folder>/04-review.md`:
     ```
     verdict: skipped (trivial diff)

     ## Reason
     Ticket complexity is S; diff is <X> lines across <Y> files (threshold: < 50 lines, < 3 files). Skipping the parallel reviewer subagents — token cost outweighs expected signal on small changes.
     ```
   - Proceed directly to the test checkpoint (step 3 of this Process).
4. Otherwise, proceed to step a below.

The thresholds (`complexity: S`, < 50 lines, < 3 files) are conservative — false-positive risk (a real bug in a 50-line diff) is mitigated because the test checkpoint still runs (or skips per its own logic), and the verdict gate still requires user approval. False-negative risk (real-bug ticket sized M+ but with a 30-line diff) is the more common case and that path runs full review.

a. **Collect the diff.**

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

   **a. `feature:code-reviewer`** (correctness + quality):
   > Review these code changes for correctness, bugs, logic errors, and adherence to project conventions. Use the confidence scale above — only report issues with confidence ≥ 80.

   **b. `feature:security-engineer`** (security):
   > Review these code changes for security vulnerabilities. Check for: input validation, auth issues, injection risks, data exposure, OWASP Top 10. Use the confidence scale above — only report issues with confidence ≥ 80.

   **c. `feature:performance-engineer`** (performance):
   > Review these code changes for performance issues. Check for: N+1 queries, unnecessary re-renders, memory leaks, bundle size impact, algorithm complexity. Use the confidence scale above — only report issues with confidence ≥ 80.

   **d. `feature:code-architect`** (architectural fit):
   > Review these code changes for architectural fit. Check for:
   > - Does this change match existing patterns and conventions in the codebase?
   > - Does it respect existing layer boundaries and abstractions?
   > - Does it introduce unnecessary duplication or reinvent existing utilities?
   > - Does the API/component design match the style of sibling code?
   > - Are there coupling or cohesion concerns?
   >
   > Reference specific files and patterns with file:line. Use the confidence scale above — only report issues with confidence ≥ 80.

d. **Merge findings into `<ticket-folder>/04-review.md`**:
   - **Group by severity**: CRITICAL → IMPORTANT → SUGGESTION
   - **De-duplicate** overlapping findings (e.g., if both code-reviewer and code-architect flag the same issue)
   - **Tag each finding** with `[correctness]` / `[security]` / `[performance]` / `[architecture]`
   - **Top-of-file summary** with counts per severity + per reviewer
   - **Reviewer failure handling**: if a reviewer subagent fails, report it inside the merged artifact and continue with results from the other reviewers (graceful partial-merge). All four failing → write a single error entry in `04-review.md` and exit with `verdict: stuck`.

e. **Apply applicable fixes in-context.** The model uses judgment to apply fixes from the merged findings. **Tiebreak when fixes are mutually exclusive**: `security > correctness > architecture > performance`. **Rationale (called out so future readers don't reverse-engineer it)**: security failures have the largest blast radius (real-world exposure); correctness is the AC contract; architecture is internal consistency that can be repaired later; performance is the most local and most easily revisited.

   Unresolvable conflicts go into `04-review.md` as `status: deferred (conflict)` with both reviewers' findings preserved. Deferred conflicts surface only via downstream `verdict: partial` if they end up causing AC failures.

f. **After fixes are applied**, run validation again (lint/typecheck) and update `03-implementation.md` to reflect the post-review state. Emit `Turn N/25` at the next iteration boundary; continue to monitor for stuck patterns. Proceed to the test checkpoint.

### 3. Test checkpoint

**Flag override — `--no-ui-testing`.** Checked first, before the skip-detection scan. If the build was invoked with `--no-ui-testing` (propagated from flow, or passed directly), skip the browser/ui-tester portion entirely: do **not** run the skip-detection scan (step a) or spawn `ui-tester` (step b). Write the flag-skip variant of the artifact to `05-tests.md` (see step c) and proceed straight to step d. This is independent of plan content — it forces the skip even when the plan has UI signals, so it does not depend on (or touch) the substring scan at all. Non-browser checks (lint/typecheck) are unaffected: they run in the implement checkpoint and still gate the verdict. Browser-level acceptance-criteria verification is deferred to a human at PR review. As with a no-UI skip, `skipped` here is a test-checkpoint label, not a verdict — build can still exit `pass`.

a. **Skip-detection scan.** Read `02-plan.md` and search (case-insensitive substring match) for any of: `component, page, route, screen, form, tsx, jsx, html, view, widget, composable, layout, template, partial`. Match → run `ui-tester` (step b). No match → skip (step c).

b. **Spawn `feature:ui-tester`** (when not skipped). Read the project's `CLAUDE.md` for a test framework hint (`## Testing` section, `## Commands` section, or inline references like "Playwright specs in `e2e/`"). Single `Task` call:

   > Test this feature through real browser interaction. Spec with acceptance criteria: `<contents of 01-spec.md>`. Implementation summary: `<from 03-implementation.md>`. Application URL: `<URL — see discovery rules below>`. Project test framework hint: `<from CLAUDE.md, or 'none documented'>`.
   >
   > **Verification is unconditional.** Every UI ticket gets browser-driven AC verification — regardless of whether a test framework is documented, regardless of `Out of Scope` tags in the spec. Out-of-scope governs what gets *built and checked in*, not what gets *verified live*. Test every acceptance criterion, take screenshots, check console for errors. Report failures with reproduction steps.
   >
   > **Codification is a separate, conditional output.** Only codify into a checked-in spec file when ALL of: (a) a project test framework is documented, (b) every AC passed, (c) the spec's `Out of Scope` does NOT exclude adding tests for this app. Otherwise emit the verification report and skip codification.
   >
   > **URL discovery — try in order, don't ask the user until 1–2 fail:**
   > 1. URL from project `CLAUDE.md` (e.g., `npm start # http://localhost:4200`).
   > 2. Probe common dev ports with `curl -s -o /dev/null -w "%{http_code}" http://localhost:<PORT>` (4200, 4321, 3000, 5173, 8080, 5000) — accept 200 / 302 / 401 (the last two indicate an auth-gated app, still reachable).
   > 3. Only if both fail, ask the user to start the server and provide the URL.

   Save subagent output to `<ticket-folder>/05-tests.md`. Failed criteria become a `## Failed Criteria` section inside `05-tests.md`. If specs were codified, list their paths under a `## Codified specs` section.

c. **Skip artifact** (when the skip-detection scan matched no UI signals, OR when `--no-ui-testing` forced the skip). **Important**: `skipped` is a **test-checkpoint label written into `05-tests.md`**, NOT a fourth build verdict. The build verdict set remains `pass | partial | stuck` per the locked redesign. When the test checkpoint is skipped, build can still exit with `verdict: pass` if the implement and review checkpoints completed cleanly. Write `<ticket-folder>/05-tests.md` with the variant matching the skip cause:

   **No UI signals in the plan** (skip-detection scan found nothing):

   ```
   verdict: skipped (no UI work in plan)

   ## Reason
   Keyword scan of 02-plan.md found no UI signals (component, page, route, screen, form, tsx, jsx, html, view, widget, composable, layout, template, partial).

   ## Acceptance Criteria
   - [ ] AC 1 — not-tested (no UI)
   - [ ] AC 2 — not-tested (no UI)
   ...
   ```

   **Forced by `--no-ui-testing`** (the plan may well have UI work — browser verification is deferred, not absent):

   ```
   verdict: skipped (UI testing disabled by --no-ui-testing)

   ## Reason
   Browser/UI verification skipped by the --no-ui-testing flag. Non-browser checks (lint/typecheck) still ran in the implement checkpoint and still gated this verdict. Browser-level acceptance-criteria verification is deferred to human review of the PR.

   ## Acceptance Criteria
   - [ ] AC 1 — not-verified (browser testing skipped by flag)
   - [ ] AC 2 — not-verified (browser testing skipped by flag)
   ...
   ```

d. **Apply test fixes in-context.** Test failures are observations the loop consumes — fix them inline using the same pattern as the review checkpoint. If fixes succeed, re-run the failing tests. If failures are un-fixable in this run, write the `## Failed Criteria` section to `05-tests.md` and prepare to exit with `verdict: partial`.

e. **Application not running.** If `ui-tester` reports the application is not running, ask the user to start it and provide the URL. Persistent inability to reach the app counts as a stuck pattern (repeated context errors) — exit with `verdict: stuck`.

f. **After test fixes are applied** (or skip artifact written), update `03-implementation.md` if any code changed, then proceed to step 4.

### 4. Exit verdict and gate routing

Build owns the verdict gate end-to-end: determine the verdict from loop state, write summary/lessons artifacts, present the gate to the user, capture the user's choice, and execute the resulting folder + frontmatter transition per [`../flow/references/state-transitions.md`](../flow/references/state-transitions.md) Decision Table.

#### 4a. Determine the verdict

Choose one based on loop state:

- **`pass`** — All `02-plan.md` Build Sequence steps implemented; all reviewer findings either applied or marked deferred-by-conflict; all UI tests pass (or skip artifact written).
- **`partial`** — Implementation is mostly complete but some acceptance criteria fail un-fixably in this run, or unresolvable review conflicts ended up causing AC failures.
- **`stuck`** — Semantic stuck pattern detected (per `references/stuck-detection.md`), `Turn 26` reached, all four reviewers failed, or persistent context errors.

#### 4b. Write summary and lesson artifacts

**Always write `06-summary.md`** regardless of verdict. Content varies:
- `pass`: completed work summary, files changed, validation passed, test results.
- `partial`: references the `## Failed Criteria` section in `05-tests.md`, lists deferred conflicts from `04-review.md`, lists what was completed.
- `stuck`: describes loop state at escalation — the detected stuck pattern (or "turn cap exceeded"), the last 3-5 iterations' actions, a suggested next-move for the user.

The uniform always-write contract means downstream readers (and reopened-ticket regressions) never have to handle a "missing summary = unknown verdict" failure mode.

**Append a one-line lesson to `claudedocs/tickets/_lessons.md`** at the same time. Format:

```
## <ticket-id> (<verdict>): <one-sentence lesson>
```

The lesson should be project-specific and actionable for future similar work — not a generic best-practice. Examples:

- `## FP-7 (pass): hooks/validate.sh must stay bash-3.2 compatible (macOS default) — no associative arrays or mapfile.`
- `## FP-12 (partial): bun's typecheck doesn't surface unused-import errors; ESLint catches them — keep both in validate.lint.`
- `## FP-15 (stuck): subagents kept failing to find the auth middleware after the lib/ → src/ rename; canonical path is now src/security/auth.ts.`

Skip the append if the lesson would be generic ("apply review fixes carefully") or already captured by an existing entry. The file is project-local context — plan's Phase 1 reads it on subsequent tickets to avoid re-deriving constraints. If `claudedocs/tickets/_lessons.md` doesn't exist, create it with a one-line header (`# Lessons learned across tickets`) and append.

#### 4c. Curate the lessons log

After the append, reconcile `claudedocs/tickets/_lessons.md` so the accumulated file stays high-signal for `plan`'s Phase 1 (which pastes it verbatim into the `requirements-analyst`). Runs on every verdict. The scan looks for duplicate entries, internal contradictions, and stale entries (path tokens whose referenced files no longer exist). The scan is automatic; any rewrite is gated behind explicit user approval, so curation can never silently corrupt the log.

**Silent no-op when there's nothing to act on** — missing/empty file, or no duplicates/contradictions/stale candidates. Present nothing and proceed to 4d.

When the scan finds something, present a findings summary grouped by category plus a three-way gate (`accept-and-rewrite` / `skip-for-now` / `something-else`), apply the user's choice, then proceed to 4d. The detection criteria, path-token extraction, gate format, and the lossless merge/flag rewrite rules (never deletes a fact, never auto-resolves a contradiction) live in `references/lessons-curation.md`.

#### 4d. Present the verdict gate

For **`pass`** (without `--pr`):

```
## Build Complete — verdict: pass

[Summary from 06-summary.md]

All artifacts: <ticket-folder>/

Would you like to commit these changes?
```

Capture the user's reply. Proceed to 4e regardless (commit decision affects git only, not the folder transition).

For **`pass` with `--pr`**: skip the interactive commit prompt — `--pr` is the user's authorization to ship. Present a non-interactive summary, then proceed to 4e:

```
## Build Complete — verdict: pass (--pr)

[Summary from 06-summary.md]

Opening a pull request per --pr (see references/pr-creation.md): branch from base → commit → push → gh pr create → finalize into review/.
```

For **`partial`** or **`stuck`**:

```
## Build Complete — verdict: <partial|stuck>

[Summary; for stuck, the detected pattern]

Options:
  - accept-as-partial — finalize as done/ with status: partial-completion
  - continue-with-hint — keep going with a user note (loop continues here, fresh 25-turn budget)
  - abort — revert ticket to backlog/, artifacts preserved in the folder
```

Capture the user's choice. Proceed to 4e.

#### 4e. Apply the transition

Per [`../flow/references/state-transitions.md`](../flow/references/state-transitions.md) Decision Table:

- **`pass` without `--pr`** (any commit decision) → Transition 2 (End-of-pipeline → `done/`).
  - If the user wants to commit, do the standard git workflow first (stage relevant files; create a commit message referencing the ticket ID).
  - Then apply Transition 2.
- **`pass` with `--pr`** → run the [`references/pr-creation.md`](references/pr-creation.md) sequence (preconditions → branch-decision matrix → gitignore-aware stage → commit → push → `gh pr create`). On success: Transition 5 (→ `review/`, status `in-review`) and record the PR URL + branch in `06-summary.md`. On degradation (gh missing/unauthenticated, non-GitHub origin, or push/PR failure): Transition 2 (→ `done/`) and record the reason in `06-summary.md`. The verdict stays `pass` either way. The branch-decision matrix may pause for a safety choice (commits-ahead of base / detached HEAD / stash-pop conflict) — those are safety prompts, not the commit gate that `--pr` skips.

- **`partial`** or **`stuck`** + **`accept-as-partial`** → Transition 4 (status flips to `partial-completion`), then Transition 2 (folder moves to `done/`, preserving `partial-completion` status).

- **`partial`** or **`stuck`** + **`continue-with-hint`** → Transition 4 (status flips to `partial-completion`; folder stays in `in-progress/`). Then:
  1. Ask the user for the hint text.
  2. Reset turn counter to `Turn 1/25`.
  3. Re-enter the build loop **in this same invocation** with the hint added to context.
  4. After the loop returns with a new verdict, restart this section from 4a.

- **`partial`** or **`stuck`** + **`abort`** → Transition 3 (folder reverts to `backlog/`, status `backlog`; for epic children, only the child's frontmatter reverts unless every sibling is also `backlog` or `cancelled` — the inverse all-children-done check).

#### 4f. Final user-facing message

After the transition fires, print:
- On `done/` transition: "Ticket moved to `done/`. Run `git log -1` to see the commit (if you confirmed) or `git status` (if you didn't)."
- On `backlog/` revert: "Ticket reverted to `backlog/`. Artifacts preserved in the folder."
- On `continue-with-hint`: no additional message — the loop just continues.

### 5. Auto-resumption from on-disk artifacts

At build start, before the implement checkpoint, inspect on-disk artifacts and route accordingly. The user signals "start fresh" by deleting `03-implementation.md` (and downstream); the build skill itself never asks. Git is the version-history layer if a backup is wanted.

**Routing table** (checked in order, first match wins):

| On disk | Routing |
|---|---|
| Ticket folder is in `review/` (status `in-review`) | The PR is open. Run the merge predicate in [`references/pr-creation.md`](references/pr-creation.md) (`gh pr view <branch> --json state`): **`MERGED`** → fire Transition 6 (`review → done`), print "PR merged; `<ticket-id>` finalized to `done/`." **otherwise** (open / closed / `gh` unavailable) → print "PR still open for `<ticket-id>`; merge it, then re-run to finalize." Runs on every re-invocation regardless of whether `--pr` was passed (checking an open PR is a pure resumption action). Exit without changes either way (no rebuild). Checked **first** so a `review/` ticket whose `06-summary.md` reads `pass` isn't mistaken for "already complete." |
| `06-summary.md` exists with verdict `pass` | Print "Build already complete for `<ticket-id>` (verdict: pass). Delete `03-implementation.md` onward to re-run, or run `/feature:plan` first if you want to revise the plan." Exit. |
| `05-tests.md` exists with failed criteria (a `## Failed Criteria` section is present) | Re-enter at the test checkpoint with the existing failed criteria as context; attempt fixes in-loop. |
| `04-review.md` exists, latest implement edit is older than `04-review.md`'s mtime | Review fixes never finished applying. Read `04-review.md`, apply pending fixes in-context, then proceed to the test checkpoint. |
| `04-review.md` exists, implement files were edited after `04-review.md` was written | Implementation diverged after review. Re-enter at the review checkpoint — re-run the 4 reviewers against the current diff. |
| `03-implementation.md` is partial (some plan steps not yet checked off) | Continue from the next un-implemented plan step. |
| Nothing relevant exists | Fresh start: implement step 1, Turn 1/25. |

**Turn-counter reset on resume**. Resumed sessions start at `Turn 1/25` — the prior budget is forfeited by design. A resumed session is a fresh attempt, and reusing an old counter would mislead.

**`--hint` flag**. When present (e.g., `/feature:build BL-1 --hint "the failing test wants the ARIA label inside the button, not on it"`), the hint text becomes part of the resumed (or fresh) loop's context. Used by flow's verdict-gate `continue-with-hint` option to thread user guidance into a follow-up build invocation.

---

## Output

The build skill writes these artifacts to `<ticket-folder>/` over the course of the loop:

- **`03-implementation.md`** — incremental updates, one section per plan step (live checkpoint, not post-hoc summary)
- **`04-review.md`** — written once at the end of the review checkpoint (merged from 4 reviewer subagents)
- **`05-tests.md`** — written once at the end of the test checkpoint (test results, or the skip artifact, or a `## Failed Criteria` section on partial)
- **`06-summary.md`** — written once at build exit, regardless of verdict (pass / partial / stuck content varies per the Verdict section above)

Failed test criteria live inside `05-tests.md` under `## Failed Criteria`; turn count and stuck patterns are conversational state, not file state.

## Presentation

Present to the user at exit (when the 4c curation step found something, its findings summary + gate is shown first, before this verdict gate):

```
## Build Complete — verdict: <pass|partial|stuck>

[Brief summary: files changed, validation state, reviewer findings count, test results, stuck-pattern detail if applicable]

[For pass: "Ready to move to done/ on completion gate."]
[For partial: "Some criteria un-fixable in this run. Options: accept-as-partial / continue-with-hint / abort."]
[For stuck: "Loop escalated. Options: continue-with-hint / abort / accept-as-partial."]

Artifacts saved to: <ticket-folder>/03-implementation.md, 04-review.md, 05-tests.md, 06-summary.md
```

## Error Handling

- **Plan missing**: `02-plan.md` not found → refuse with: "Plan stage hasn't run. Run `/feature:plan $1` first."
- **Project path unknown**: ask the user.
- **`origin/HEAD` not configured and `main` doesn't exist**: ask the user for the base branch.
- **Application URL needed for `ui-tester` but not provided** (and not in project `CLAUDE.md`): ask the user to start the app and provide the URL.
- **Subagent failure** (reviewer or `ui-tester` crashes/timeouts): report inside the merged artifact and continue with results from the others. All four reviewers failing simultaneously → write degraded `04-review.md` and exit `verdict: stuck`.
- **Validation commands not documented in project `CLAUDE.md`**: log warning, proceed without skill-body validation. Graceful degradation; the loop continues.
- **Stuck pattern detected or `Turn 26` reached**: not an error — handled via `verdict: stuck`. Always write `06-summary.md` describing the loop state.
