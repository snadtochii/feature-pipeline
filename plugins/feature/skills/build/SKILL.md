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
  - pipeline_get_ticket
  - pipeline_list_tickets
  - pipeline_get_artifact
  - pipeline_list_artifacts
  - pipeline_write_artifact
  - pipeline_transition_ticket
  - pipeline_update_ticket
  - pipeline_add_lesson
  - pipeline_list_lessons
  - pipeline_update_lesson
  - pipeline_delete_lesson
  - mcp__plugin_server-native_ps__pipeline_get_ticket
  - mcp__plugin_server-native_ps__pipeline_list_tickets
  - mcp__plugin_server-native_ps__pipeline_get_artifact
  - mcp__plugin_server-native_ps__pipeline_list_artifacts
  - mcp__plugin_server-native_ps__pipeline_write_artifact
  - mcp__plugin_server-native_ps__pipeline_transition_ticket
  - mcp__plugin_server-native_ps__pipeline_update_ticket
  - mcp__plugin_server-native_ps__pipeline_add_lesson
  - mcp__plugin_server-native_ps__pipeline_list_lessons
  - mcp__plugin_server-native_ps__pipeline_update_lesson
  - mcp__plugin_server-native_ps__pipeline_delete_lesson
argument-hint: "[ticket-id] [--pr] [--no-commit] [--no-ui-testing] [--worktree] [--hint text]"
---

# Build Stage

Build the ticket through one continuous loop with internal checkpoints (implement → review → test). All fixes happen in-context — no rewinds to earlier stages. Exit with verdict `pass`, `partial`, or `stuck`.

**This stage runs in the main conversation — NOT as a subagent.** (The four reviewer subagents in the review checkpoint and the `ui-tester` subagent in the test checkpoint run from within this stage.)

## Arguments

```
/feature:build $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket file. Optional flags: `--hint "<text>"` (thread a user note into the resumed loop — used by flow's verdict-gate `continue-with-hint` option), `--pr` (on verdict `pass`, open a GitHub PR and finalize into `review/` instead of `done/` — see [`references/pr-creation.md`](references/pr-creation.md)), `--no-ui-testing` (skip only the browser/ui-tester portion of the test checkpoint; lint/typecheck still run and still gate the verdict — see the test checkpoint's flag override), `--no-commit` (on verdict `pass`, leave the changes uncommitted this run, skipping the commit prompt and beating any `git.commit` config — see State setup's commit-mode binding; contradicts `--pr` and stops the build if both are passed — see Flag validation), `--worktree` (do this run's code work in a dedicated git worktree instead of the current checkout — see State setup's worktree binding and [`references/worktree.md`](references/worktree.md)). On resumption routes that never reach the commit path, `--no-commit` is a harmless no-op.

Resumption is auto-detected from the ticket's existing artifacts — see step 5 below. To start fresh against a partially-built ticket, delete the relevant artifacts (`03-implementation.md` onward) before invoking build — a user-side action; build itself never deletes artifacts. Start-fresh mechanics: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §10, for the mode detected at Ticket Resolution.

## Ticket Resolution & Artifacts Setup

**Storage mode.** Detect it once per run per [`../flow/references/storage.md`](../flow/references/storage.md) §Mode detection; every per-mode reference cited in this skill (`-fs` / `-server`) is the file for that mode.

Use the canonical logic in [`ticket-resolution-fs.md`](../flow/references/ticket-resolution-fs.md) / [`ticket-resolution-server.md`](../flow/references/ticket-resolution-server.md) (for the detected storage mode). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification (for acceptance criteria)
- `02-plan.md` — the approved implementation plan (**required** — if not found, refuse with: "Plan stage hasn't run. Run `/feature:plan $1` first.")

For auto-resumption, also read whichever of these exist to reconstruct state (see step 5 below for resumption logic):
- `03-implementation.md` — completed plan steps from a prior build invocation
- `04-review.md` — review state from a prior build invocation
- `05-tests.md` — test state from a prior build invocation

Storage mechanics for these inputs: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §1, for the mode detected above.

## Epic refusal

Validate `kind` per [`ticket-resolution-fs.md`](../flow/references/ticket-resolution-fs.md) / [`ticket-resolution-server.md`](../flow/references/ticket-resolution-server.md) (for the detected storage mode) Step 4 before any work. If the ticket has `kind: epic`, abort and instruct the user to run build against a child ticket instead — epics are non-pipelineable.

## Blocker validation

Validate blockers per [`ticket-resolution-fs.md`](../flow/references/ticket-resolution-fs.md) / [`ticket-resolution-server.md`](../flow/references/ticket-resolution-server.md) Step 6. If any entry in `blocked_by` is not yet done (status `done` or `cancelled` per Step 6's completion test), abort with the message in Step 6 listing the unblocked blockers. If a `blocked_by` entry is wrong, edit this ticket's `blocked_by` frontmatter.

When `blocked_by` is non-empty, build composes a **blocker context block** and prepends it to the review-checkpoint reviewer prompts. The block's artifact sources and missing-artifact fallback chain are defined where the composition happens — Process step 2b.

## Flag validation

`--pr` and `--no-commit` together contradict — `--pr` must commit and push. Like Epic refusal and Blocker validation, this check runs **before State setup**, so the stop precedes any state mutation: stop with one line — `--pr and --no-commit contradict — --pr must commit and push. Drop one and re-run.` No work happens, no artifacts are written, no transition fires. Flow performs the same rejection in its SETUP, so a flow run never reaches build with the pair; this check guards direct invocation.

This is the only contradictory pair. `--worktree` composes with all three of `--pr`, `--no-commit`, and `--no-ui-testing` — it selects *where* the code work happens, an axis independent of what the verdict gate does with the result.

## State setup

Before the implement checkpoint, perform the start-of-pipeline transition per [`state-transitions-fs.md`](../flow/references/state-transitions-fs.md) / [`state-transitions-server.md`](../flow/references/state-transitions-server.md) Transition 1 (Start-of-pipeline → `in-progress`), for the detected storage mode. Idempotent: if plan already ran in this pipeline invocation, the ticket is in `in-progress/` and only frontmatter is touched. If build is invoked directly on a `backlog/` ticket (re-run after manual artifact restoration, or unusual workflows), build moves the folder. (Build's own sources are `backlog/` and `in-progress/`; `review/` is handled separately — see the interception note below — and `done/` re-opens are a plan-side re-run.)

**`review/` is intercepted before this transition.** If the ticket is in `review/` (status `in-review`), the step-5 resumption check (first row) runs first: build inspects the PR's merge state and finalizes via Transition 6 (`review → done`) if merged, or reports the still-open PR and exits — it does NOT rebuild. The `review/ → in-progress` re-plan path (revise an open PR's code) belongs to `plan`, not build.

`<ticket-folder>` is rebound for the rest of this run (what it denotes: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §3, for the detected mode). When the worktree binding below is on, bind it as an **absolute path into the main checkout** and keep it bound across every later transition that moves the folder — a relative path would resolve against the worktree, where `claudedocs/` is absent or a stale fork-point copy ([`references/worktree.md`](references/worktree.md) §3).

**Bind ticket metadata — before the step-5 resumption routing.** Values read only inside a checkpoint are unbound on resumed runs that re-enter downstream of it, so build binds them here, upstream of the router: read `status`, `complexity` (used by the review checkpoint's triviality short-circuit), `kind`, `blocked_by`, and the mode-specific fields once via the Read ticket metadata operation — never parsed out of artifact bodies. Which fields exist and where they are read: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §2, for the detected mode.

**Bind the commit mode — same placement rule.** Bind `commit_mode` from the `git.commit` key of the optional `git:` block in `claudedocs/tickets/config.yaml` — from the config content already model-read for storage-mode detection above; no second `Read`, and never `yq`/`jq` (the file is a local repo file whatever the storage mode). Values: `prompt`, `always`, or `never`. Missing file, missing block, missing key, or `prompt` → `prompt`. Any other value → `prompt`, plus a one-line notice printed now — `git.commit: <value> is not a recognized mode (prompt | always | never) — treating as prompt.` — a config error never blocks a build. Then apply the per-run flags (the `--pr`+`--no-commit` pair was already rejected by Flag validation):
- `--no-commit` → the effective `commit_mode` is `never` for this run, beating any config value.
- `--pr` → the `--pr` path commits and pushes as ever ([`references/pr-creation.md`](references/pr-creation.md)); when the config says `never`, remember the override so the verdict gate prints its one-line notice (4c).

The bound `commit_mode` is consumed only at the verdict gate (4c/4d); binding it here keeps it defined on every resumption row that funnels there.

**Working copy and artifact writes.** Read build's storage file for the mode detected above — [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) — **once here, in full**; every later `§N` cite in this skill refers to that already-loaded file. §3 and §4 govern every `<ticket-folder>` read and write in this loop — where the artifacts live, and how each write lands the moment its producing step completes. Subagent spawn prompts inline the paths that step resolves; a subagent never follows a storage reference itself.

**Bind the worktree — same placement rule, and re-bind even without the flag.** Placed here, after the working-copy step, because both parts below read and write `03-implementation.md`, and the storage file's §3 is what makes `<ticket-folder>` readable. Every artifact touch below therefore goes through its §4 — never a bare filename — and the `## Worktree` write follows the same rule. This is still upstream of the step-5 router, which is what the placement rule requires. The guarded existence check: the storage file's §5.

The lifecycle itself is [`references/worktree.md`](references/worktree.md); this block binds its §0 inputs and decides whether to provision. Two parts, in this order:

1. **Re-bind an existing worktree — unconditional, flag or no flag.** Only when the artifact listing already gathered above shows `03-implementation.md` exists (never an unguarded read — the storage file's §5): if it carries a `## Worktree` block whose `<wt-path>` still exists on disk, bind `<wt-path>`, `<branch>`, `<repo-root>`, and the `excluded:` list from it and print one line — `Resuming in worktree <wt-path> (branch <branch>).` `<repo-root>` matters because the verdict gate's teardown and [`references/worktree.md`](references/worktree.md) §5 run their `git -C` commands against it, and a resumed run is exactly when teardown fires. The `excluded:` list matters because [`commit.md`](references/commit.md) §1 applies it at every commit; **re-derive it** by re-running [`references/worktree.md`](references/worktree.md) §2 step 4's verification over the `.worktreeinclude` matches rather than trusting the record — the recorded list can be stale or absent, and an empty one silently disables the guard that keeps a copied secrets file out of `git add -A`. A record written before `<repo-root>` was included → derive it with `git -C "<wt-path>" rev-parse --path-format=absolute --git-common-dir` and strip the trailing `/.git`.

   A prior run's code lives in that worktree and nowhere else, so a resumed run that ignored it would review an empty diff in the main checkout while `03-implementation.md` claims the steps are done. This is why the check does not depend on `--worktree` being passed again: the flag selects where a *new* run works; the record is what makes a *resumed* one correct. Recorded path gone from disk (removed by hand, or torn down after a prior push) → print one line saying so and continue in the main checkout.

2. **Provision — only when `--worktree` was passed and part 1 found nothing.** In order, cheapest first:
   - **Skip entirely when this run will not build** — the ticket is in `review/` / status `in-review` (the interception above already read that signal), or `06-summary.md` exists with verdict `pass`. Both are step-5 rows that exit without touching code. This is checked **first**, before anything below: the two signals are already in hand, while the steps below cost two reference loads, a git call and an artifact read per blocker, and a spec-plus-plan read — all of it discarded on a run that builds nothing, and the eligibility notice would announce a decision about a build that never happens.
   - Evaluate [`references/worktree.md`](references/worktree.md) §1 eligibility against the ticket's `repos:` and `blocked_by`, both bound above. Ineligible → print the §1 notice, leave the worktree unbound, and build in place. Every §1 miss is a notice, never an error.
   - Eligible → bind the remaining §0 inputs (§1 has already resolved `<repo-root>` and needs `<BASE_BRANCH>`, so those two come from it): `<TICKET-ID>`; `<BASE_BRANCH>` as the **short** branch name via [`references/pr-creation.md`](references/pr-creation.md) §1's helper (`git symbolic-ref --short … | sed 's@^origin/@@'` — never the `origin/`-prefixed form); `<branch>` per pr-creation.md §2, its `<type>`/`<slug>` inferred from `01-spec.md`'s title and `tags` plus `02-plan.md` (the work has not happened yet, so the spec and plan are the input — `ship --parallel` names its branches from exactly the same pre-implementation information); `<ticket-folder>` absolute; setup-failure policy = **notice and continue in the worktree** (the declared dependencies may already be adequate, and an explicit isolation request is not worth failing over a setup command); removal trigger = the verdict-gate endings in 4d.
   - Run [`references/worktree.md`](references/worktree.md) §2, then record the result in `03-implementation.md` under a `## Worktree` heading naming `<wt-path>`, `<branch>`, `<repo-root>`, and `excluded:` (§2 step 4's exclusion list, empty when every copied path is properly ignored) — the record part 1 reads next invocation.

   Two consequences of writing that record on a fresh run, both intended: `03-implementation.md` now exists before any plan step, so the step-5 router matches its "partial" row rather than "nothing relevant exists" — correct, since the run does have state to resume. And flow's SETUP invalidation deletes `03-implementation.md` when `02-plan.md` is absent, which drops the record while the worktree survives; [`references/worktree.md`](references/worktree.md) §5 is the recovery path for that residue.

Once bound, **every** git and project command in this loop is explicitly path-bound per [`references/worktree.md`](references/worktree.md) §3 — the checkpoints, the subagent spawn prompts, and the verdict gate cite that checklist rather than restating it.

---

## Behavioral Mindset

Ship working code in one continuous loop. Implement plan steps incrementally, edit small, verify often. When validation fails, fix in-context — never queue failures for later. When reviewers find issues, apply the high-confidence fixes in the same conversation; don't punt to a separate stage. When tests fail un-fixably, exit with `verdict: partial` — don't fake completion. Build only what `02-plan.md` specifies — no features beyond it. The loop is forward-only: never re-invoke `/feature:plan` or any other skill mid-loop — rewinding to earlier stages would discard the context the loop was just operating in. Emit `Turn N/25` at every iteration boundary so the count is recoverable from the transcript; on a stuck pattern or the turn cap, exit with `verdict: stuck` — surface the human gate, don't keep spinning.

---

## Process

The build loop runs three checkpoints in sequence: **implement** → **review** → **test** → exit verdict. All three checkpoints are part of the same main-context conversation.

### 1. Implement checkpoint

a. **Emit `Turn 1/25`** as the first iteration marker.

b. **Validation setup.** Read project `CLAUDE.md`, extract lint and typecheck commands. Common locations: a `## Commands` section, a `## Validation` section, a `## Testing` section, or inline references to `npm run lint` / `pnpm test` / `cargo check` / `pytest` / etc. Capture the commands for use after each meaningful change. If the project documents no commands, log a one-line warning ("No validation commands found in project CLAUDE.md — proceeding without skill-body validation") and continue.

   **Always run skill-body validation after each meaningful change**, regardless of whether a `PostToolUse` hook is also active. The two layers (hook + skill-body) are intentionally redundant — see `references/validation-hook.md` for rationale.

   With a worktree bound (State setup), run these commands as `cd "<wt-path>" && <command>` so they see the worktree's own dependencies, and target every edit at an absolute path inside `<wt-path>` — per [`references/worktree.md`](references/worktree.md) §3. The `PostToolUse` hook needs nothing: it walks up from the edited file, so worktree edits resolve on their own.

c. **For each step in `02-plan.md`'s Build Sequence, in order:**
   1. **Re-read the current step from `02-plan.md`** — use `Read` with `offset`/`limit` to load just the relevant step's section. On long implementations the plan drifts out of working context by step 4 or 5; re-reading each step against its source is nearly free and prevents plan drift.
   2. **Implement the change** following the plan's "Files" and "Pattern to follow" fields.
   3. **Run validation** (lint/typecheck via `Bash`) — fix any errors immediately before moving on.
   4. **Update `03-implementation.md`** with files created/modified, brief description, any deviations from the plan with rationale, validation state.
   5. **Emit `Turn N/25`** at the start of the next iteration.
   6. **Watch the transcript for stuck patterns** (per `references/stuck-detection.md` patterns 1–5): action↔observation repetition, action↔error repetition, agent monologue, ping-pong between two states, repeated context errors. On detection, exit with `verdict: stuck` (skip directly to step 4 of this Process — Exit verdict).
   7. **Outer-loop arbiter check** (per `references/stuck-detection.md` pattern 6). When the current checkpoint has accumulated 4+ turns without exiting, fire the arbiter once via a `Task` call with the prompt in stuck-detection.md §6. Cache the verdict for the rest of the checkpoint. On `status: stuck`, exit with `verdict: stuck` (skip to step 4 — Exit verdict); include the arbiter's `reason` in `06-summary.md`.
   8. **On hitting `Turn 26`**, exit with `verdict: stuck` regardless of semantic-pattern detection. The hybrid stop rule: either trigger fires the verdict.

d. **After all plan steps are implemented**, run final validation across all changes. Fix any cross-cutting failures in-context. Update `03-implementation.md` with the final implementation state. Proceed to the review checkpoint.

### 2. Review checkpoint

**Pre-check — Triviality short-circuit.** Before spawning reviewer subagents, check whether the diff is small enough that the four-subagent review is overkill (token cost > expected signal):

1. Take the `complexity` value bound at State setup (ticket metadata — never re-parsed from an artifact body).
2. Run `git diff --shortstat <base>...HEAD` (and add unstaged) to count lines and files changed — prefixed `git -C "<wt-path>"` when a worktree is bound ([`references/worktree.md`](references/worktree.md) §3), which is where the changes actually are.
3. If **all three** conditions hold — `complexity: S`, lines changed < 50, files changed < 3 — short-circuit:
   - Write `<ticket-folder>/04-review.md`:
     ```
     verdict: skipped (trivial diff)

     ## Reason
     Ticket complexity is S; diff is <X> lines across <Y> files (threshold: < 50 lines, < 3 files). Skipping the parallel reviewer subagents — token cost outweighs expected signal on small changes.
     ```
     Artifact verdict for this write: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §6.
   - Proceed directly to the test checkpoint (step 3 of this Process).
4. Otherwise, proceed to step a below.

a. **Collect the diff.**

   ```bash
   # Detect the base branch — prefer origin's HEAD, fall back to main
   base=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/@@' || echo main)

   # Branch-scope diff: everything committed on this branch since diverging from base
   git diff "$base"...HEAD

   # Unstaged changes on top of HEAD
   git diff
   ```

   With a worktree bound, prefix all three commands `git -C "<wt-path>"` ([`references/worktree.md`](references/worktree.md) §3) — run against the main checkout they would diff a tree that has none of this run's changes and report a clean review of nothing.

   If `origin/HEAD` isn't configured, default to `main`. If neither exists, ask the user which base branch to diff against. Concatenate the branch-scope diff and unstaged diff. Empty diff → record "No code changes to review" in `04-review.md` and proceed to the test checkpoint.

b. **Compose the shared base for reviewer prompts** (single composition, used by all four reviewers):

   1. **Ticket context**: contents of `01-spec.md`, `02-plan.md`, `03-implementation.md`.
   2. **Diff**: output from step a.
   3. **Project root path** — `<wt-path>` when a worktree is bound ([`references/worktree.md`](references/worktree.md) §3), else the main checkout. A reviewer given the right diff and a root pointing at a tree without the change reads files that contradict the hunks and reports confident false findings.
   4. **Blocker context** (only when `blocked_by` is non-empty per the Blocker validation section above): a `## Blocker context (from completed siblings)` block. For each blocker: include verbatim `01-spec.md` + `06-summary.md`. **Fallback when `06-summary.md` is missing** (e.g. a `cancelled` blocker): use the blocker's `02-plan.md`; when `02-plan.md` is also missing, use `01-spec.md` alone. Note in the block which artifact was used per blocker. Omit the entire block when `blocked_by` is empty. Blocker artifact retrieval and what "missing" means: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §7 — the block inlines the artifact text, never a reference.
   5. **Confidence scale**: the verbatim contents of `references/confidence-scale.md` under a `## Confidence scale (use this exactly)` header. (The rubric lives in the reference and build injects it here — reviewer agent bodies stay rubric-free.)

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
   - **Artifact verdict for this write**: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §6.

e. **Apply applicable fixes in-context.** The model uses judgment to apply fixes from the merged findings. **Tiebreak when fixes are mutually exclusive**: `security > correctness > architecture > performance` — security has the largest blast radius, correctness is the AC contract, architecture can be repaired later, performance is the most local and most easily revisited.

   Unresolvable conflicts go into `04-review.md` as `status: deferred (conflict)` with both reviewers' findings preserved. Deferred conflicts surface only via downstream `verdict: partial` if they end up causing AC failures.

f. **After fixes are applied**, run validation again (lint/typecheck) and update `03-implementation.md` to reflect the post-review state. Emit `Turn N/25` at the next iteration boundary; continue to monitor for stuck patterns. Proceed to the test checkpoint.

### 3. Test checkpoint

**Flag override — `--no-ui-testing`.** Checked first, before the skip-detection scan. If the build was invoked with `--no-ui-testing` (propagated from flow, or passed directly), skip the browser/ui-tester portion entirely: do **not** run the skip-detection scan (step a) or spawn `ui-tester` (step b). Write the flag-skip variant of the artifact to `05-tests.md` (see step c) and proceed straight to step d. This is independent of plan content — it forces the skip even when the plan has UI signals, so it does not depend on (or touch) the substring scan at all. Non-browser checks (lint/typecheck) are unaffected: they run in the implement checkpoint and still gate the verdict. Browser-level acceptance-criteria verification is deferred to a human at PR review. The flag also short-circuits the reachability pre-flight below — a forced skip resolves no URL, runs no `curl`, and boots no `test.start` command (the pre-flight only runs where a spawn was actually going to happen).

a. **Skip-detection scan.** Read `02-plan.md` and search the text (case-insensitive substring match) for any of: `component, page, route, screen, form, tsx, jsx, html, view, widget, composable, layout, template, partial`. Match → run the reachability pre-flight (below) before any spawn. No match → skip (step c).

**Reachability pre-flight (per [`references/test-preflight.md`](references/test-preflight.md)).** When step a matched UI signals (and `--no-ui-testing` was not set), run the pre-flight gate *before* spawning the Opus `ui-tester` — the cheap `curl` is always paid first. It resolves a URL (`test.url` → project `CLAUDE.md` → common-port probe), `curl`s it (reachable iff HTTP `200/301/302/401/403`), and on an unreachable app optionally boots a declared `test.start` (backgrounded, bounded ~60s poll) that it then owns for teardown:
   - **Reachable** (directly, or after the `test.start` boot responds) → compose the auth recipe + resolved URL (test-preflight.md §5) and continue to step b.
   - **Unreachable with no `test.start`, or `test.start` timed out** → write the *app unreachable* skip artifact (step c), tear down any server the pre-flight started (step e), do **not** spawn `ui-tester`, do **not** prompt mid-loop or hard-pause, and proceed to the verdict (step 4). The skip is recorded in `06-summary.md`.

   The pre-flight reads the `test:` block by model-reading `claudedocs/tickets/config.yaml`; it never invokes `yq`/`jq` or `hooks/validate.sh`. Absent a `test:` block, URL resolution falls through to the CLAUDE.md → port-probe path and no `test.start` is booted.

   **With a worktree bound**, the pre-flight binds per [`references/test-preflight.md`](references/test-preflight.md) §3, which also states the fixed-port hazard it cannot solve: a server already listening at `test.url` from another checkout answers the `curl`, so nothing boots and `ui-tester` verifies code this run never wrote. Surface it — print one line before spawning — `--worktree: verifying against <url>; confirm that server is serving <wt-path>, not the main checkout.` — and repeat it as a `## Caveat` line in `05-tests.md`. A false green is the failure mode worth making visible; per-run port allocation is not something the `test:` contract models.

b. **Spawn `feature:ui-tester`** (when reachable). Read the project's `CLAUDE.md` for a test framework hint (`## Testing` section, `## Commands` section, or inline references like "Playwright specs in `e2e/`"). Single `Task` call:

   > Test this feature through real browser interaction. Spec with acceptance criteria: `<contents of 01-spec.md>`. Implementation summary: `<from 03-implementation.md>`. Application URL: `<the reachability-pre-flight-resolved URL — already verified reachable; do not re-discover it>`. Project test framework hint: `<from CLAUDE.md, or 'none documented'>`. Working directory: `<<wt-path> when a worktree is bound, else the project root>` — run the test runner there, and write any codified spec file under that directory, not elsewhere. Auth recipe: `<composed by the pre-flight per references/test-preflight.md §5 — auth.storage_state path and/or auth.attach_tab, or 'none declared'>`.
   >
   > **Verification is unconditional.** Every UI ticket gets browser-driven AC verification — regardless of whether a test framework is documented, regardless of `Out of Scope` tags in the spec. Out-of-scope governs what gets *built and checked in*, not what gets *verified live*. Test every acceptance criterion, take screenshots, check console for errors. Report failures with reproduction steps.
   >
   > **Codification is a separate, conditional output.** Only codify into a checked-in spec file when ALL of: (a) a project test framework is documented, (b) every AC passed, (c) the spec's `Out of Scope` does NOT exclude adding tests for this app. Otherwise emit the verification report and skip codification.
   >
   > **Auth — use the injected recipe first, in priority order.** The build skill already resolved the URL and composed any declared auth recipe into this prompt (above), so don't re-discover the URL. Apply `auth.storage_state` (load it with `mcp__playwright__browser_set_storage_state`, filename = the injected path, BEFORE navigating; if that tool isn't exposed by the running Playwright MCP, fall through) → `auth.attach_tab` (attach to an already-authenticated same-origin tab) → your existing fallback (CLAUDE.md bypass hint → ask). If no recipe was injected, use your existing auth fallback unchanged.

   Save subagent output to `<ticket-folder>/05-tests.md`. Failed criteria become a `## Failed Criteria` section inside `05-tests.md`. If specs were codified, list their paths under a `## Codified specs` section. Artifact verdict for this write: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §6.

c. **Skip artifact** (when the skip-detection scan matched no UI signals, when `--no-ui-testing` forced the skip, OR when the reachability pre-flight found the app unreachable and un-bootable). **Important**: `skipped` is a **test-checkpoint label written into `05-tests.md`**, NOT a fourth build verdict. The build verdict set is `pass | partial | stuck`. When the test checkpoint is skipped, build can still exit with `verdict: pass` if the implement and review checkpoints completed cleanly. Write `<ticket-folder>/05-tests.md` with the variant matching the skip cause — when writing one, read [`references/skip-artifacts.md`](references/skip-artifacts.md) for the verbatim template bodies (the app-unreachable body lives in [`references/test-preflight.md`](references/test-preflight.md) §6, beside the pre-flight that produces it):

   - **No UI signals in the plan** — the skip-detection scan found nothing.
   - **Forced by `--no-ui-testing`** — the plan may well have UI work; browser verification is deferred, not absent.
   - **App unreachable** — the reachability pre-flight could not reach or boot the app.

   Artifact verdict for this write: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §6.

d. **Apply test fixes in-context.** Test failures are observations the loop consumes — fix them inline using the same pattern as the review checkpoint. If fixes succeed, re-run the failing tests. If failures are un-fixable in this run, write the `## Failed Criteria` section to `05-tests.md` and prepare to exit with `verdict: partial`.

e. **Teardown of a pre-flight-started server.** If the reachability pre-flight booted a `test.start` server (a PID was captured), tear it down (best-effort `kill`) after the test checkpoint — **even if the checkpoint errored**, and including the boot-then-timeout path — per [`references/test-preflight.md`](references/test-preflight.md) §4. A server that was already running when the pre-flight first probed is left untouched. Unreachability is not an interactive stop: the pre-flight converts an unreachable, un-bootable app into the *app unreachable* skip (step c) without prompting or hard-pausing.

f. **After test fixes are applied** (or skip artifact written), update `03-implementation.md` if any code changed, then proceed to step 4.

### 4. Exit verdict and gate routing

Build owns the verdict gate end-to-end: determine the verdict from loop state, write summary/lessons artifacts, present the gate to the user, capture the user's choice, and execute the resulting folder + frontmatter transition per [`state-transitions-fs.md`](../flow/references/state-transitions-fs.md) / [`state-transitions-server.md`](../flow/references/state-transitions-server.md) (for the detected storage mode) Decision Table.

#### 4a. Determine the verdict

Choose one based on loop state:

- **`pass`** — All `02-plan.md` Build Sequence steps implemented; all reviewer findings either applied or marked deferred-by-conflict; all UI tests pass (or skip artifact written).
- **`partial`** — Implementation is mostly complete but some acceptance criteria fail un-fixably in this run, or unresolvable review conflicts ended up causing AC failures.
- **`stuck`** — Semantic stuck pattern detected (per `references/stuck-detection.md`), `Turn 26` reached, all four reviewers failed, or persistent context errors.

#### 4b. Write summary and lesson artifacts

**Always write `06-summary.md`** regardless of verdict. Content varies:
- `pass`: completed work summary, files changed, validation passed, reviewer findings count, test results — plus the commit outcome: when the run leaves changes uncommitted (`git.commit: never` or `--no-commit`), say so explicitly and point at `git status`.
- `partial`: references the `## Failed Criteria` section in `05-tests.md`, lists deferred conflicts from `04-review.md`, lists what was completed.
- `stuck`: describes loop state at escalation — the detected stuck pattern (or "turn cap exceeded"), the last 3-5 iterations' actions, a suggested next-move for the user.

The uniform always-write contract means downstream readers (and reopened-ticket regressions) never have to handle a "missing summary = unknown verdict" failure mode.

Artifact verdict for this write: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §6.

**Capture a lesson in the cross-ticket lessons log** at the same time (which store: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §8, for the detected mode), following the shared contract in [`lessons-log-fs.md`](../flow/references/lessons-log-fs.md) / [`lessons-log-server.md`](../flow/references/lessons-log-server.md) end-to-end: store creation (§1), entry format (§2), what to capture vs skip (§3), the write-time supersession check (§4), prefer-newest on conflict (§5), promotion on recurrence (§6), and format overflow (§7). Build-specific wiring:

- The header's `<verdict>` token is this run's verdict: `pass` | `partial` | `stuck`.
- A build run is **unattended** in the §6/§7 sense — no user present to answer, so the CLAUDE.md proposals are skipped — when it runs as an autonomous orchestrator's subagent or under headless `claude -p`.

#### 4c. Present the verdict gate

For **`pass`** (without `--pr`) — dispatch on the `commit_mode` bound at State setup (`--no-commit` has already collapsed it to `never`):

- **`prompt`** — the interactive gate:

  ```
  ## Build Complete — verdict: pass

  [Summary from 06-summary.md]

  All artifacts: <ticket-folder>/

  Would you like to commit these changes?
  ```

  Capture the user's reply. Proceed to 4d regardless (commit decision affects git only, not the folder transition).

- **`always`** — skip the prompt: present the same block with the question line replaced by `Committing per git.commit: always.` Proceed to 4d with the commit decision preset to yes — `always` presets the prompt's answer, nothing more.

- **`never`** — skip the prompt: present the same block with the question line replaced by `Leaving changes uncommitted (git.commit: never).` — or `(--no-commit)` when the flag set it. Proceed to 4d with the commit decision preset to no.

For **`pass` with `--pr`**: skip the interactive commit prompt — `--pr` is the user's authorization to ship. Present a non-interactive summary, then proceed to 4d:

```
## Build Complete — verdict: pass (--pr)

[Summary from 06-summary.md]

All artifacts: <ticket-folder>/

Opening a pull request per --pr (see references/pr-creation.md): branch from base → commit → push → gh pr create → finalize into review/.
```

When the config said `git.commit: never` (the override remembered at State setup), append one outcome-neutral line to the block: `Note: --pr overrides git.commit: never — proceeding with the pr-creation.md commit path.` Outcome-neutral on purpose: if the PR path later degrades to a local commit, pr-creation.md's own degradation line reports what actually happened, and this notice stays true.

For **`partial`** or **`stuck`**:

```
## Build Complete — verdict: <partial|stuck>

[Summary; for stuck, the detected pattern]

All artifacts: <ticket-folder>/

Options:
  - accept-as-partial — finalize as done/ with status: partial-completion
  - continue-with-hint — keep going with a user note (loop continues here, fresh 25-turn budget)
  - abort — revert ticket to backlog/, artifacts preserved in the folder
```

Capture the user's choice. Proceed to 4d.

#### 4d. Apply the transition

Per [`state-transitions-fs.md`](../flow/references/state-transitions-fs.md) / [`state-transitions-server.md`](../flow/references/state-transitions-server.md) (for the detected storage mode) Decision Table:

- **`pass` without `--pr`** (any commit outcome) → Transition 2 (End-of-pipeline → `done/`).
  - Commit decision **yes** (prompt confirmed, or `git.commit: always`) → commit first per [`references/commit.md`](references/commit.md): gitignore-aware staging (§1), then a §2 message referencing the ticket ID via `git commit -F`. Onto the current branch, no push, no PR — the mechanics are identical whichever mode said yes.
  - Commit decision **no** (prompt declined, `git.commit: never`, or `--no-commit`) → touch nothing in git.
  - Then apply Transition 2 — it fires identically for both outcomes.
- **`pass` with `--pr`** → run the [`references/pr-creation.md`](references/pr-creation.md) sequence (preconditions → branch-decision matrix → gitignore-aware stage → commit → push → `gh pr create`). `commit_mode` never gates this path — a `never` config only adds the 4c override notice. On success: Transition 5 (→ `review/`, status `in-review`) and record the PR URL + branch (PR linkage on the ticket: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §9, for the detected mode — see pr-creation.md §5). On degradation (gh missing/unauthenticated, non-GitHub origin, or push/PR failure): Transition 2 (→ `done/`) and record the reason in `06-summary.md`. The verdict stays `pass` either way. The branch-decision matrix may pause for a safety choice (commits-ahead of base / detached HEAD / stash-pop conflict) — those are safety prompts, not the commit gate that `--pr` skips.

- **`partial`** or **`stuck`** + **`accept-as-partial`** → Transition 4 (status flips to `partial-completion`), then Transition 2 (folder moves to `done/`, preserving `partial-completion` status).

- **`partial`** or **`stuck`** + **`continue-with-hint`** → Transition 4 (status flips to `partial-completion`; folder stays in `in-progress/`). Then:
  1. Ask the user for the hint text.
  2. Reset turn counter to `Turn 1/25`.
  3. Re-enter the build loop **in this same invocation** with the hint added to context.
  4. After the loop returns with a new verdict, restart this section from 4a.

- **`partial`** or **`stuck`** + **`abort`** → Transition 3 (folder reverts to `backlog/`, status `backlog`; for epic children, only the child's frontmatter reverts unless every sibling is also `backlog` or `cancelled` — the inverse all-children-done check).

**Worktree teardown** — runs after the transition above, only when a worktree is bound. [`references/worktree.md`](references/worktree.md) §4 owns the safety predicate and the mechanics; this is the trigger table:

| Ending | Teardown |
|---|---|
| `pass`, committed (prompt confirmed, or `git.commit: always`) | **Remove.** The commits are on `<branch>`, which is repository-level state — the worktree holds nothing the repository does not. |
| `pass` with `--pr` (pushed, or degraded to a local commit) | **Remove.** Same predicate; a pushed branch satisfies it doubly. |
| `pass`, uncommitted (prompt declined, `git.commit: never`, or `--no-commit`) | **Leave**, print `<wt-path>`. The worktree is the only home of the work. |
| `partial` or `stuck` — any choice, including `abort` | **Leave**, print `<wt-path>`. Transition 3 reverts the *ticket*; it does not revert code, and the run is expected to resume. |

The §4 predicate is authoritative over this table: an ending listed as "remove" whose predicate fails (uncommitted changes still in the worktree) leaves the worktree in place and prints its path anyway. `--force` is never used to discard commits.

#### 4e. Final user-facing message

After the transition fires, print:
- On `done/` transition with a commit: "Ticket moved to `done/`. Run `git log -1` to see the commit."
- On `done/` transition without a commit (declined, `git.commit: never`, or `--no-commit`): "Ticket moved to `done/`. Changes left uncommitted — run `git status` to review them."
- On `backlog/` revert: "Ticket reverted to `backlog/`. Artifacts preserved in the folder."
- On `continue-with-hint`: no additional message — the loop just continues.

When a worktree was removed, the main checkout shows no trace of the change, so name where the work went: append `Work is on branch <branch> (worktree removed) — 'git checkout <branch>' to see it.` to the `done/` line. When a worktree was left in place, append `Work left in <wt-path> on branch <branch>.` instead.

### 5. Auto-resumption from existing artifacts

At build start, before the implement checkpoint, inspect the ticket's existing artifacts and route accordingly. The user signals "start fresh" by deleting `03-implementation.md` (and downstream); the build skill itself never asks. Deletion mechanics and version history: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §10, for the mode detected at Ticket Resolution.

**Routing table** (checked in order, first match wins):

| On disk | Routing |
|---|---|
| Ticket folder is in `review/` (status `in-review`) | The PR is open. Run the merge predicate in [`references/pr-creation.md`](references/pr-creation.md) (branch-keyed `gh pr view <branch> --json state,mergeCommit`): **`MERGED` and reachable from `<base>`** (the predicate's fetch + `git merge-base --is-ancestor` gate) → fire Transition 6 (`review → done`), print "PR merged and reachable from `<base>`; `<ticket-id>` finalized to `done/`." **otherwise** (open / closed / merged-but-not-yet-reachable / `gh` unavailable) → print "PR still open for `<ticket-id>`; merge it, then re-run to finalize." Runs on every re-invocation regardless of whether `--pr` was passed (checking an open PR is a pure resumption action). Exit without changes either way (no rebuild). Checked **first** so a `review/` ticket whose `06-summary.md` reads `pass` isn't mistaken for "already complete." |
| `06-summary.md` exists with verdict `pass` | Print "Build already complete for `<ticket-id>` (verdict: pass). Delete `03-implementation.md` onward to re-run, or run `/feature:plan` first if you want to revise the plan." Exit. |
| `05-tests.md` exists with failed criteria (a `## Failed Criteria` section is present) | Re-enter at the test checkpoint with the existing failed criteria as context; attempt fixes in-loop. |
| `04-review.md` exists, latest implement edit is older than `04-review.md`'s mtime | Review fixes never finished applying. Read `04-review.md`, apply pending fixes in-context, then proceed to the test checkpoint. |
| `04-review.md` exists, implement files were edited after `04-review.md` was written | Implementation diverged after review. Re-enter at the review checkpoint — re-run the 4 reviewers against the current diff. |
| `03-implementation.md` is partial (some plan steps not yet checked off) | Continue from the next un-implemented plan step. |
| Nothing relevant exists | Fresh start: implement step 1, Turn 1/25. |

**Signal keying.** How each routing signal above is read — the first row's state signal, artifact presence, verdict, and the two recency comparisons: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §10, for the mode detected at Ticket Resolution, read after State setup's metadata binding and working-copy step.

**Worktree re-binding happens upstream.** State setup re-binds a recorded `<wt-path>` before this router runs, and does so whether or not `--worktree` was passed again — so every row below already operates on the right tree. Without that ordering, the rows that re-enter at the review or test checkpoint would inspect a main checkout holding none of the prior run's code.

**Turn-counter reset on resume**. Resumed sessions start at `Turn 1/25` — the prior budget is forfeited.

**`--hint` flag**. When present (e.g., `/feature:build BL-1 --hint "the failing test wants the ARIA label inside the button, not on it"`), the hint text becomes part of the resumed (or fresh) loop's context. Used by flow's verdict-gate `continue-with-hint` option to thread user guidance into a follow-up build invocation.

---

## Output

The build skill writes these artifacts to `<ticket-folder>/` over the course of the loop (write mechanics: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §4, for the detected mode; the verdict rule per write site is §6):

- **`03-implementation.md`** — incremental updates, one section per plan step (live checkpoint, not post-hoc summary)
- **`04-review.md`** — written once at the end of the review checkpoint (merged from 4 reviewer subagents)
- **`05-tests.md`** — written once at the end of the test checkpoint (test results, or the skip artifact, or a `## Failed Criteria` section on partial)
- **`06-summary.md`** — written once at build exit, regardless of verdict (pass / partial / stuck content varies per the Verdict section above)

Failed test criteria live inside `05-tests.md` under `## Failed Criteria`; turn count and stuck patterns are conversational state, not file state.

The user-facing exit presentation is the verdict-gate blocks in Process step 4c.

## Error Handling

- **Plan missing**: `02-plan.md` not found → refuse with: "Plan stage hasn't run. Run `/feature:plan $1` first."
- **Project path unknown**: ask the user.
- **`origin/HEAD` not configured and `main` doesn't exist**: ask the user for the base branch.
- **Application unreachable at the test checkpoint**: handled by the reachability pre-flight (`references/test-preflight.md`), not an interactive error — the app is reached, a declared `test.start` is booted, or the *app unreachable* skip artifact is written and the loop proceeds to the verdict without prompting. A pre-flight-started server is torn down afterward.
- **Subagent failure** (reviewer or `ui-tester` crashes/timeouts): report inside the merged artifact and continue with results from the others. All four reviewers failing simultaneously → write degraded `04-review.md` and exit `verdict: stuck`.
- **Validation commands not documented in project `CLAUDE.md`**: log warning, proceed without skill-body validation. Graceful degradation; the loop continues.
- **Storage operation fails mid-loop**: [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) §12, for the mode detected at Ticket Resolution.
- **Stuck pattern detected or `Turn 26` reached**: not an error — handled via `verdict: stuck`. Always write `06-summary.md` describing the loop state.
