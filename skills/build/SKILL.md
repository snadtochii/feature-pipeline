---
name: build
description: "Build a ticket through one loop — implement → review → test — with a verdict-based exit."
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

Build reads `02-plan.md` only — never `02-plan.html` (plan's optional `--visual` derived view is a human-only review surface; any review decisions were already folded back into `02-plan.md` upstream).

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

**Flag override — `--no-ui-testing`.** Checked first, before the skip-detection scan. If the build was invoked with `--no-ui-testing` (propagated from flow, or passed directly), skip the browser/ui-tester portion entirely: do **not** run the skip-detection scan (step a) or spawn `ui-tester` (step b). Write the flag-skip variant of the artifact to `05-tests.md` (see step c) and proceed straight to step d. This is independent of plan content — it forces the skip even when the plan has UI signals, so it does not depend on (or touch) the substring scan at all. Non-browser checks (lint/typecheck) are unaffected: they run in the implement checkpoint and still gate the verdict. Browser-level acceptance-criteria verification is deferred to a human at PR review. As with a no-UI skip, `skipped` here is a test-checkpoint label, not a verdict — build can still exit `pass`. The flag also short-circuits the reachability pre-flight below — a forced skip resolves no URL, runs no `curl`, and boots no `test.start` command (the pre-flight only runs where a spawn was actually going to happen).

a. **Skip-detection scan.** Read `02-plan.md` — **excluding any trailing `## Review decisions` section** (the `--visual` fold-back audit trail, which can mention UI words like "HTML" incidentally and is not implementation signal) — and search the remaining text (case-insensitive substring match) for any of: `component, page, route, screen, form, tsx, jsx, html, view, widget, composable, layout, template, partial`. Match → run the reachability pre-flight (below) before any spawn. No match → skip (step c).

**Reachability pre-flight (per [`references/test-preflight.md`](references/test-preflight.md)).** When step a matched UI signals (and `--no-ui-testing` was not set), run the pre-flight gate *before* spawning the Opus `ui-tester` — the cheap `curl` is always paid first (AC9). It resolves a URL (`test.url` → project `CLAUDE.md` → common-port probe), `curl`s it (reachable iff HTTP `200/301/302/401/403`), and on an unreachable app optionally boots a declared `test.start` (backgrounded, bounded ~60s poll) that it then owns for teardown:
   - **Reachable** (directly, or after the `test.start` boot responds) → compose the auth recipe + resolved URL (test-preflight.md §5) and continue to step b.
   - **Unreachable with no `test.start`, or `test.start` timed out** → write the *app unreachable* skip artifact (step c), tear down any server the pre-flight started (step e), do **not** spawn `ui-tester`, do **not** prompt mid-loop or hard-pause, and proceed to the verdict (step 4). The skip is recorded in `06-summary.md`.

   The pre-flight reads the `test:` block by model-reading `claudedocs/tickets/config.yaml`; it never invokes `yq`/`jq` or `hooks/validate.sh`. Absent a `test:` block, URL resolution falls through to the existing CLAUDE.md → port-probe path and no `test.start` is booted — today's behavior (AC2).

b. **Spawn `feature:ui-tester`** (when reachable). Read the project's `CLAUDE.md` for a test framework hint (`## Testing` section, `## Commands` section, or inline references like "Playwright specs in `e2e/`"). Single `Task` call:

   > Test this feature through real browser interaction. Spec with acceptance criteria: `<contents of 01-spec.md>`. Implementation summary: `<from 03-implementation.md>`. Application URL: `<the reachability-pre-flight-resolved URL — already verified reachable; do not re-discover it>`. Project test framework hint: `<from CLAUDE.md, or 'none documented'>`. Auth recipe: `<composed by the pre-flight per references/test-preflight.md §5 — auth.storage_state path and/or auth.attach_tab, or 'none declared'>`.
   >
   > **Verification is unconditional.** Every UI ticket gets browser-driven AC verification — regardless of whether a test framework is documented, regardless of `Out of Scope` tags in the spec. Out-of-scope governs what gets *built and checked in*, not what gets *verified live*. Test every acceptance criterion, take screenshots, check console for errors. Report failures with reproduction steps.
   >
   > **Codification is a separate, conditional output.** Only codify into a checked-in spec file when ALL of: (a) a project test framework is documented, (b) every AC passed, (c) the spec's `Out of Scope` does NOT exclude adding tests for this app. Otherwise emit the verification report and skip codification.
   >
   > **Auth — use the injected recipe first, in priority order.** The build skill already resolved the URL and composed any declared auth recipe into this prompt (above), so don't re-discover the URL. Apply `auth.storage_state` (load it with `mcp__playwright__browser_set_storage_state`, filename = the injected path, BEFORE navigating; if that tool isn't exposed by the running Playwright MCP, fall through) → `auth.attach_tab` (attach to an already-authenticated same-origin tab) → your existing fallback (CLAUDE.md bypass hint → ask). If no recipe was injected, use your existing auth fallback unchanged.

   Save subagent output to `<ticket-folder>/05-tests.md`. Failed criteria become a `## Failed Criteria` section inside `05-tests.md`. If specs were codified, list their paths under a `## Codified specs` section.

c. **Skip artifact** (when the skip-detection scan matched no UI signals, when `--no-ui-testing` forced the skip, OR when the reachability pre-flight found the app unreachable and un-bootable). **Important**: `skipped` is a **test-checkpoint label written into `05-tests.md`**, NOT a fourth build verdict. The build verdict set remains `pass | partial | stuck` per the locked redesign. When the test checkpoint is skipped, build can still exit with `verdict: pass` if the implement and review checkpoints completed cleanly. Write `<ticket-folder>/05-tests.md` with the variant matching the skip cause:

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

   **App unreachable** (the reachability pre-flight could not reach or boot the app) — body per [`references/test-preflight.md`](references/test-preflight.md) §6:

   ```
   verdict: skipped (app unreachable)

   ## Reason
   The application could not be reached by the pre-flight gate (resolved URL, and whether a test.start was declared / timed out). The Opus ui-tester subagent was not spawned. Browser-level acceptance-criteria verification is deferred.

   ## Acceptance Criteria
   - [ ] AC 1 — not-tested (app unreachable)
   - [ ] AC 2 — not-tested (app unreachable)
   ...
   ```

d. **Apply test fixes in-context.** Test failures are observations the loop consumes — fix them inline using the same pattern as the review checkpoint. If fixes succeed, re-run the failing tests. If failures are un-fixable in this run, write the `## Failed Criteria` section to `05-tests.md` and prepare to exit with `verdict: partial`.

e. **Teardown of a pre-flight-started server.** If the reachability pre-flight booted a `test.start` server (a PID was captured), tear it down (best-effort `kill`) after the test checkpoint — **even if the checkpoint errored**, and including the boot-then-timeout path — per [`references/test-preflight.md`](references/test-preflight.md) §4. A server that was already running when the pre-flight first probed is left untouched. Unreachability is not an interactive stop: the pre-flight converts an unreachable, un-bootable app into the *app unreachable* skip (step c) without prompting or hard-pausing.

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

**Capture a lesson in `claudedocs/tickets/_lessons.md`** at the same time. Entry format — **one sentence, one topic, ≤200 characters**:

```
## <ticket-id> (<verdict>): <one-sentence lesson>
```

The lesson should be project-specific and actionable for future similar work — not a generic best-practice. Examples:

- `## FP-7 (pass): hooks/validate.sh must stay bash-3.2 compatible (macOS default) — no associative arrays or mapfile.`
- `## FP-12 (partial): bun's typecheck doesn't surface unused-import errors; ESLint catches them — keep both in validate.lint.`
- `## FP-15 (stuck): subagents kept failing to find the auth middleware after the lib/ → src/ rename; canonical path is now src/security/auth.ts.`

Capture rules:

- **Write-time supersession check.** Before appending, read `_lessons.md` and scan the existing `^## ` entries (any producer, including `debug/` ones) for one making a prescriptive point about the **same named subject** — the same concrete path, tool, command, or setting. Same subject → **update/merge that one line in place**, citing all IDs in ascending order (`## FP-9, FP-28 (pass): <lesson>`; keep per-ID verdicts when they differ), or **skip** when the existing entry already fully covers the point. Different or no shared subject → append. No user gate: the check never deletes a distinct fact, only replaces the superseded line — git holds the history. Lines not matching `^## ` are preserved byte-for-byte; never repair or normalize the file.
- **Promotion on recurrence.** A same-topic second capture means the gotcha recurs — propose promoting it into the project's `CLAUDE.md` under a `## Lessons` section (created if missing). The proposal must **show the exact line to be added and the target file/section** — never a bare yes/no — and the edit is applied only after the user approves that shown content (CLAUDE.md is a standing-instruction file loaded into every future session; the promoted text originates from `_lessons.md`, which is editable outside the pipeline). On accept: apply the CLAUDE.md edit and remove the entry from `_lessons.md`. On decline: keep the merged line in the log.
- **Format overflow.** A lesson that can't fit one sentence on one topic is not a lesson — it's a durable rule. Propose it as a project-`CLAUDE.md` edit instead (same content-surfacing confirmation — show the exact text and target, never a bare yes/no); on decline, capture a one-sentence compression in `_lessons.md` — never silently lose the fact.
- **Skip entirely** when the lesson would be generic ("apply review fixes carefully"). Lesson text is free text — handle it with `Read`/`Write` only; never interpolate it into shell commands.
- If `claudedocs/tickets/_lessons.md` doesn't exist, create it with a one-line header (`# Lessons learned across tickets`) and append.

The file is project-local context — plan's Phase 1 selects ticket-relevant entries from it on subsequent tickets to avoid re-deriving constraints.

#### 4c. Present the verdict gate

For **`pass`** (without `--pr`):

```
## Build Complete — verdict: pass

[Summary from 06-summary.md]

All artifacts: <ticket-folder>/

Would you like to commit these changes?
```

Capture the user's reply. Proceed to 4d regardless (commit decision affects git only, not the folder transition).

For **`pass` with `--pr`**: skip the interactive commit prompt — `--pr` is the user's authorization to ship. Present a non-interactive summary, then proceed to 4d:

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

Capture the user's choice. Proceed to 4d.

#### 4d. Apply the transition

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

#### 4e. Final user-facing message

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

- **Plan missing**: `02-plan.md` not found → refuse with: "Plan stage hasn't run. Run `/feature:plan $1` first."
- **Project path unknown**: ask the user.
- **`origin/HEAD` not configured and `main` doesn't exist**: ask the user for the base branch.
- **Application unreachable at the test checkpoint**: handled by the reachability pre-flight (`references/test-preflight.md`), not an interactive error — the app is reached, a declared `test.start` is booted, or the *app unreachable* skip artifact is written and the loop proceeds to the verdict without prompting. A pre-flight-started server is torn down afterward.
- **Subagent failure** (reviewer or `ui-tester` crashes/timeouts): report inside the merged artifact and continue with results from the others. All four reviewers failing simultaneously → write degraded `04-review.md` and exit `verdict: stuck`.
- **Validation commands not documented in project `CLAUDE.md`**: log warning, proceed without skill-body validation. Graceful degradation; the loop continues.
- **Stuck pattern detected or `Turn 26` reached**: not an error — handled via `verdict: stuck`. Always write `06-summary.md` describing the loop state.
