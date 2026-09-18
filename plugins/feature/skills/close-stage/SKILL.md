---
name: close-stage
description: "Close a built and reviewed ticket: browser pass or skip artifact, bounded fixes, verdict, summary, lessons, the verdict gate and the finalizer."
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - Agent
  - TodoWrite
  - pipeline_get_ticket
  - pipeline_list_tickets
  - pipeline_get_artifact
  - pipeline_list_artifacts
  - pipeline_write_artifact
  - pipeline_transition_ticket
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
  - mcp__plugin_server-native_ps__pipeline_add_lesson
  - mcp__plugin_server-native_ps__pipeline_list_lessons
  - mcp__plugin_server-native_ps__pipeline_update_lesson
  - mcp__plugin_server-native_ps__pipeline_delete_lesson
argument-hint: "[ticket-id] [--pr] [--no-commit] [--no-ui-testing]"
---

# Close Stage

Close a ticket whose implement phase and review round are done: run the test checkpoint (a browser pass through `ui-tester`, or its skip artifact), fix failed criteria inline within a fixed budget, decide the verdict, write `06-summary.md`, capture lessons, present the verdict gate, and hand the decided ending to the `finalizer`. The stage runs from a fresh context that holds the ticket's artifacts, not the implement history — everything it needs is on disk.

Its user-facing stops are the verdict gate's and a finalizer `needs-decision` relayed through it. Standalone, the stage asks them in the main conversation; under `flow` it runs as a stage subagent, and each stop pauses it while flow relays the question. `ui-tester` and `finalizer` are its leaf children.

## Arguments

```
/feature:close-stage $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to the ticket folder. Optional flags: `--pr` (on verdict `pass`, open a GitHub PR and finalize into `review/` instead of `done/` — see [`../build/references/pr-creation.md`](../build/references/pr-creation.md)), `--no-ui-testing` (skip only the browser/ui-tester portion of the test checkpoint; lint/typecheck ran in the implement phase and still gate the verdict — see the test checkpoint's flag override), `--no-commit` (on verdict `pass`, leave the changes uncommitted this run, skipping the commit prompt and beating any `git.commit` config — see Entry's commit-mode binding; contradicts `--pr` and stops the stage if both are passed — see Entry step 5). On routes that never reach the commit path, `--no-commit` is a harmless no-op.

## Required Input

- `01-spec.md` — the ticket specification (acceptance criteria for the tester and the summary).
- `02-plan.md` — the approved plan; the skip-detection scan reads it.
- `03-implementation.md` — **required**; its current pass carries `## Rationale` (the implement phase completed) or `## Stuck` (it exited stuck), per [`../build/references/implementation-handoff.md`](../build/references/implementation-handoff.md) §8. The stage reads it once and derives every view from that read: the neutral view for the tester, the newest steps plus `## Stuck` for a stuck summary, the worktree view for the re-bind, and the `constraints` / `rough edges` fields for lessons capture.
- `04-review.md` — **required** with `fix-step: complete`, unless the current pass carries `## Stuck`; its first-line label and each accepted finding's `outcome` feed the verdict.
- `05-tests.md`, `06-summary.md` — optional; a prior close run's state, read by the Router.

Storage mechanics for these inputs: §1 of the stage's storage file (loaded at Entry step 2).

## Entry

**Runtime.** Bind the runtime and plugin root per [../flow/references/runtime.md](../flow/references/runtime.md) before work. Use its operations for every role spawn — the UI tester and the finalizer. Prefix their complete prompts with the runtime block and honor its capacity policy and role boundaries.

Then run these in order. Any `error` below ends the stage with the Result line.

1. **Storage mode.** Detect it once per run per [`../flow/references/storage.md`](../flow/references/storage.md) §Mode detection.
2. **Load the stage's storage file** for that mode — [`references/storage-fs.md`](references/storage-fs.md) / [`references/storage-server.md`](references/storage-server.md) — **once, in full**. Every later `§N` cite in this skill refers to that file.
3. **Resolve the ticket** per [`ticket-resolution-fs.md`](../flow/references/ticket-resolution-fs.md) / [`ticket-resolution-server.md`](../flow/references/ticket-resolution-server.md) (for the detected mode), Steps 1–3. The stage is interactive, so that reference's ask-the-user points stand; a ticket that cannot be resolved → `error`, `failed-step: ticket`.
4. **Epic refusal.** Step 4 of the same reference: `kind: epic` → `error`, `failed-step: ticket`, instructing the user to close a child ticket instead — epics are non-pipelineable. Blockers are not re-checked: build validated them before any code was written.
5. **Flag validation.** `--pr` and `--no-commit` together contradict — `--pr` must commit and push. This check runs before any state mutation: stop with one line — `--pr and --no-commit contradict — --pr must commit and push. Drop one and re-run.` No work happens, no artifacts are written, no transition fires. Flow performs the same rejection in its SETUP, so a flow run never reaches the stage with the pair; this check guards direct invocation.
6. **Bind ticket metadata** — `status`, `kind`, `epic`, `parent`, and the mode-specific fields — once, per §2, upstream of the Router. Values read only inside a later step are unbound on routes that enter downstream of it.
7. **Bind the commit mode — same placement rule.** Bind `commit_mode` from the `git.commit` key of the optional `git:` block in `claudedocs/tickets/config.yaml` — from the config content already model-read for storage-mode detection above; no second `Read`, and never `yq`/`jq` (the file is a local repo file whatever the storage mode). Values: `prompt`, `always`, or `never`. Missing file, missing block, missing key, or `prompt` → `prompt`. Any other value → `prompt`, plus a one-line notice printed now — `git.commit: <value> is not a recognized mode (prompt | always | never) — treating as prompt.` — a config error never blocks a close. Then apply the per-run flags (the `--pr`+`--no-commit` pair was already rejected at step 5):
   - `--no-commit` → the effective `commit_mode` is `never` for this run, beating any config value.
   - `--pr` → the `--pr` path commits and pushes as ever ([`../build/references/pr-creation.md`](../build/references/pr-creation.md)); when the config says `never`, remember the override so the verdict gate prints its one-line notice (§4).

   The bound `commit_mode` is consumed only at the verdict gate (§4/§5); binding it here keeps it defined on every Router row that funnels there.
8. **Working copy** per §1. `<ticket-folder>` is absolute and stays in the main checkout.

The Router's merge-check and already-complete rows run straight after Entry. Every other row first runs the two preparation steps below, because they touch the working tree and the handoff:

9. **Readiness.** Read `03-implementation.md` once, in full; every view this stage uses is derived from that one read, never re-read. Its current pass must carry a `## Rationale` or a `## Stuck` section ([`../build/references/implementation-handoff.md`](../build/references/implementation-handoff.md) §8). Without `## Stuck`, `04-review.md` must exist with `fix-step: complete` on its second line, and must belong to the current pass: newer than `03-implementation.md` (§7), unless the current pass already carries this stage's own `## Post-test` section, which is written after the review. A review older than the handoff with no `## Post-test` in the current pass reviewed an earlier pass. Any condition unmet → `error`, `failed-step: not-ready`.
10. **Worktree re-bind.** From the worktree view (handoff §6): a `## Worktree` section whose `wt-path` exists on disk → bind `<wt-path>`, `<branch>` and `<repo-root>`, and print `Resuming in worktree <wt-path> (branch <branch>).` A recorded path that is gone → `error`, `failed-step: worktree`; the stage cannot redo the work, so it never falls back to the main checkout, which would test and commit a tree that does not contain it. The recorded `excluded:` field is not bound: the stage stages nothing, and the finalizer re-derives the list itself before any commit. Bind `<root>` to `<wt-path>` when bound, else the project root from step 3. Every git and project command below, and the tester's working directory, are path-bound per [`../build/references/worktree.md`](../build/references/worktree.md) §3.

## Router

First match wins. Signals are read per §7.

| On disk | Route |
|---|---|
| Ticket is in `review/` (status `in-review`) | The PR is open. Run the merge predicate in [`../build/references/pr-creation.md`](../build/references/pr-creation.md) (branch-keyed `gh pr view <branch> --json state,mergeCommit`): **`MERGED` and reachable from `<base>`** (the predicate's fetch + `git merge-base --is-ancestor` gate) → fire Transition 6 (`review → done`) per [`state-transitions-fs.md`](../flow/references/state-transitions-fs.md) / [`state-transitions-server.md`](../flow/references/state-transitions-server.md), print "PR merged and reachable from `<base>`; `<ticket-id>` finalized to `done/`." and return `merged`. **Otherwise** (open / closed / merged-but-not-yet-reachable / `gh` unavailable) → print "PR still open for `<ticket-id>`; merge it, then re-run to finalize." and return `pr-open`. Runs whether or not `--pr` was passed, and needs neither readiness nor a worktree. Checked **first** so a `review/` ticket whose `06-summary.md` reads `pass` isn't mistaken for already complete. |
| `06-summary.md` exists, the ticket's own `status` is `in-progress` or `partial-completion`, and `06-summary.md` is not older than any of `03-implementation.md`, `04-review.md` and `05-tests.md` | Incomplete tail — the finalizer never ran, or returned an `error`. Run steps 9–10, then re-enter at the verdict gate (§4) with the verdict on `06-summary.md`'s first line: re-present the gate and re-collect the decision. A `pass` ending that asks nothing — `--pr`, `git.commit: always`, `never` or `--no-commit` — goes straight to the finalizer spawn (§5). The finalizer is idempotent, so an already-made commit, an already-pushed branch, an already-open PR or an already-fired transition is detected and reported rather than repeated. |
| `06-summary.md` exists with verdict `pass` | Print "Build already complete for `<ticket-id>` (verdict: pass). Delete `03-implementation.md` onward to re-run, or run `/feature:plan` first if you want to revise the plan." Return `already-complete`. |
| The ticket's own `status` is neither `in-progress` nor `partial-completion` | The ticket is not in a state the close stage can finalize: every transition the gate resolves has an `in-progress` or `partial-completion` source. Print "`<ticket-id>` is `<status>`, not in progress — run `/feature:build <ticket-id>` first." and return `error`, `failed-step: not-ready`. No artifact is written and no transition fires. |
| `05-tests.md` newer than `04-review.md`, with a `## Failed Criteria` section | Run steps 9–10, then re-enter the fix loop (§1 step d) with the recorded failed criteria and a fresh budget. The pre-flight state is not persisted, so the loop re-runs the pre-flight before its first tester re-spawn. Under `--no-ui-testing` the loop cannot re-verify a fix, so it is not entered: the recorded failures stay under `## Failed Criteria`, and the stage goes straight to §2, where they yield `partial`. |
| Otherwise | Run steps 9–10, then a fresh close from §1. An older `05-tests.md` or `06-summary.md` is overwritten. |

The rows never compare `03-implementation.md` with `05-tests.md`: the stage's own `## Post-test` append makes `03-implementation.md` the newer file. Once `05-tests.md` is newer than `04-review.md`, the ticket is this stage's — a caller routing between stages keys on the same rule.

## Process

### 1. Test checkpoint

**Upstream stuck.** When the verdict is already `stuck` from upstream — the current pass of `03-implementation.md` carries `## Stuck`, or `04-review.md` is labelled `stuck (<pattern>)` or `failed (all reviewers)` — skip this checkpoint entirely: write no `05-tests.md` and go to §2.

**Flag override — `--no-ui-testing`.** Checked first, before the skip-detection scan. If the stage was invoked with `--no-ui-testing` (propagated from flow, or passed directly), skip the browser/ui-tester portion entirely: do **not** run the skip-detection scan (step a) or spawn `ui-tester` (step b). Write the flag-skip variant of the artifact to `05-tests.md` (see step c) and proceed straight to §2. The flag also bars the fix loop (step d), which re-verifies through `ui-tester`: the Router's fix-loop row does not enter it under this flag. This is independent of plan content — it forces the skip even when the plan has UI signals, so it does not depend on (or touch) the substring scan at all. Non-browser checks (lint/typecheck) are unaffected: they ran in the implement phase and still gate the verdict. Browser-level acceptance-criteria verification is deferred to a human at PR review. The flag also short-circuits the reachability pre-flight below — a forced skip resolves no URL, runs no `curl`, and boots no `test.start` command (the pre-flight only runs where a spawn was actually going to happen).

a. **Skip-detection scan.** Read `02-plan.md` and search the text (case-insensitive) for any of these substrings: `component, page, route, screen, form, tsx, jsx, html, view, widget, composable, layout, template, partial`; and for any of these whole words, plural allowed: `dialog, modal, sheet` (so "stylesheet" or "spreadsheet" is no match). This list is the only copy of the keywords. Match → run the reachability pre-flight (below) before any spawn. No match → skip (step c).

**Reachability pre-flight (per [`references/test-preflight.md`](references/test-preflight.md)).** When step a matched UI signals (and `--no-ui-testing` was not set), run the pre-flight gate *before* spawning the `ui-tester` — the cheap `curl` is always paid first. It resolves a URL (`test.url` → project `CLAUDE.md` → common-port probe), `curl`s it (reachable iff HTTP `200/301/302/401/403`), and on an unreachable app optionally boots a declared `test.start` (backgrounded, bounded ~60s poll) that it then owns for teardown:
   - **Reachable** (directly, or after the `test.start` boot responds) → compose the auth recipe + resolved URL (test-preflight.md §5) and continue to step b.
   - **Unreachable with no `test.start`, or `test.start` timed out** → write the *app unreachable* skip artifact (step c), tear down any server the pre-flight started (step e), do **not** spawn `ui-tester`, do **not** prompt or hard-pause, and proceed to the verdict (§2). The skip is recorded in `06-summary.md`.

   The pre-flight reads the `test:` block by model-reading `claudedocs/tickets/config.yaml`; it never invokes `yq`/`jq` or `hooks/validate.sh`. Absent a `test:` block, URL resolution falls through to the CLAUDE.md → port-probe path and no `test.start` is booted.

   **With a worktree bound**, the pre-flight binds per [`references/test-preflight.md`](references/test-preflight.md) §3, which also states the fixed-port hazard it cannot solve: a server already listening at `test.url` from another checkout answers the `curl`, so nothing boots and `ui-tester` verifies code this run never wrote. Surface it — print one line before spawning — `--worktree: verifying against <url>; confirm that server is serving <wt-path>, not the main checkout.` — and repeat it as a `## Caveat` line in `05-tests.md`. A false green is the failure mode worth making visible; per-run port allocation is not something the `test:` contract models.

b. **Spawn `feature:ui-tester`** (when reachable). Read the project's `CLAUDE.md` for a test framework hint (`## Testing` section, `## Commands` section, or inline references like "Playwright specs in `e2e/`"). One role child through the selected runtime:

   > Test this feature through real browser interaction. Spec with acceptance criteria: `<contents of 01-spec.md>`. Implementation summary: `<the neutral view of 03-implementation.md — minus ## Rationale, per ../build/references/implementation-handoff.md §6>`. Application URL: `<the reachability-pre-flight-resolved URL — already verified reachable; do not re-discover it>`. Project test framework hint: `<from CLAUDE.md, or 'none documented'>`. Working directory: `<<root>>` — run the test runner there, and write any codified spec file under that directory, not elsewhere. Auth recipe: `<composed by the pre-flight per references/test-preflight.md §5 — auth.storage_state path and/or auth.attach_tab, or 'none declared'>`. Evidence home: `<the absolute directory resolved per the storage file's §8 — write every screenshot there>`.
   >
   > ## Required UI checks (use this exactly)
   >
   > `<verbatim contents of ../build/references/ui-checks.md>`
   >
   > **Verification is unconditional.** Every UI ticket gets browser-driven AC verification — regardless of whether a test framework is documented, regardless of `Out of Scope` tags in the spec. Out-of-scope governs what gets *built and checked in*, not what gets *verified live*. Test every acceptance criterion, run the required UI checks above, take screenshots, check console for errors. Report failures with reproduction steps.
   >
   > **Codification is a separate, conditional output.** Only codify into a checked-in spec file when ALL of: (a) a project test framework is documented, (b) every AC passed, (c) the spec's `Out of Scope` does NOT exclude adding tests for this app. Otherwise emit the verification report and skip codification.
   >
   > **Auth — use the injected recipe first, in priority order.** The close stage already resolved the URL and composed any declared auth recipe into this prompt (above), so don't re-discover the URL. Apply `auth.storage_state` (load it with `mcp__playwright__browser_set_storage_state`, filename = the injected path, BEFORE navigating; if that tool isn't exposed by the running Playwright MCP, fall through) → `auth.attach_tab` (attach to an already-authenticated same-origin tab) → your existing fallback (CLAUDE.md bypass hint → ask). If no recipe was injected, use your existing auth fallback unchanged.

   Save subagent output to `<ticket-folder>/05-tests.md` **as soon as the tester returns**, before any fix, so a re-run finds the failed criteria on disk. Failed criteria become a `## Failed Criteria` section inside `05-tests.md`; the injected block's §5 decides how required-check findings and failed checks are listed there, so a layout failure affects the verdict like any other failed criterion. If specs were codified, list their paths under a `## Codified specs` section. A tester crash or timeout is recorded in `05-tests.md` under `## Failed Criteria` — the crash or timeout named, and every acceptance criterion it left unverified listed — and the stage proceeds to the verdict without entering the fix loop, so the verdict is `partial`. Artifact verdict for this write: §4.

c. **Skip artifact** (when the skip-detection scan matched no UI signals, when `--no-ui-testing` forced the skip, OR when the reachability pre-flight found the app unreachable and un-bootable). **Important**: `skipped` is a **test-checkpoint label written into `05-tests.md`**, NOT a fourth verdict. The verdict set is `pass | partial | stuck`. When the test checkpoint is skipped, the stage can still reach `verdict: pass` if the implement phase and the review round completed cleanly. Write `<ticket-folder>/05-tests.md` with the variant matching the skip cause — when writing one, read [`references/skip-artifacts.md`](references/skip-artifacts.md) for the verbatim template bodies (the app-unreachable body lives in [`references/test-preflight.md`](references/test-preflight.md) §6, beside the pre-flight that produces it):

   - **No UI signals in the plan** — the skip-detection scan found nothing.
   - **Forced by `--no-ui-testing`** — the plan may well have UI work; browser verification is deferred, not absent.
   - **App unreachable** — the reachability pre-flight could not reach or boot the app.

   Artifact verdict for this write: §4.

d. **Fix loop — at most 2 iterations.** Failed criteria are observations the stage consumes inline, within a budget. The fix-loop budget is 2 iterations per invocation, never persisted; a re-entry through the Router starts a fresh one. One iteration:
   1. Fix every failed criterion inline, smallest change first, building nothing beyond `02-plan.md` and the failed criteria.
   2. **Validate after each edit.** The validation commands are resolved at the first fix: read the project instruction files for **both** runtimes — `CLAUDE.md` and `AGENTS.md` — for lint and typecheck commands (a `## Commands`, `## Validation` or `## Testing` section, or inline references), the current runtime's primary file first (`AGENTS.md` when `$PLUGIN_ROOT` is set and `$CLAUDE_PLUGIN_ROOT` is not, else `CLAUDE.md`), then the other; a file the runtime already loaded as project instructions is taken from context, not re-read. Run them as `cd "<root>" && <command>`. None documented → log one line (`No validation commands found in project CLAUDE.md/AGENTS.md — proceeding without skill-body validation`) and continue. The body commands run after each edit even when a `PostToolUse` hook is active — [`../build/references/validation-hook.md`](../build/references/validation-hook.md) explains why both layers run.
   3. **A fix that will not validate, or cannot be made cleanly, is reverted** with `Edit`, restoring its pre-edit text; the criterion stays failed. Never use `git checkout`, `git restore` or `git stash` on a file: the implement phase's uncommitted work lives in the same files.
   4. Re-run the pre-flight, then re-spawn `ui-tester` with the step b prompt narrowed to the failed criteria plus the required UI checks.
   5. Rewrite `05-tests.md` with the result (artifact verdict: §4).

   **Watch for stuck patterns** 1–5 in [`../build/references/stuck-detection.md`](../build/references/stuck-detection.md) (action↔observation repetition, action↔error repetition, monologue, ping-pong, repeated context errors) throughout the loop. On detection, stop fixing and mark the verdict `stuck`, naming the pattern. The arbiter (pattern 6) does not fire here; the 2-iteration budget bounds the loop.

   When the budget is spent with criteria still failing, the remaining failures stay under `## Failed Criteria` in `05-tests.md` and the verdict is `partial`.

e. **Teardown of a pre-flight-started server.** If the reachability pre-flight booted a `test.start` server (a PID was captured), tear it down (best-effort `kill`) after the test checkpoint — **even if the checkpoint errored**, and including the boot-then-timeout path — per [`references/test-preflight.md`](references/test-preflight.md) §4. A server that was already running when the pre-flight first probed is left untouched. Unreachability is not an interactive stop: the pre-flight converts an unreachable, un-bootable app into the *app unreachable* skip (step c) without prompting or hard-pausing.

f. **Post-test validation and the handoff append.** When the fix loop changed code, run the validation commands over the tree once and chain the `## Post-test` append to `03-implementation.md` onto that same call, per [`../build/references/implementation-handoff.md`](../build/references/implementation-handoff.md) §4 and §5: open with `set -o pipefail`, join the commands with `&&`, and use a quoted, entry-unique delimiter (`HANDOFF_TEST_<K>_END` for pass K), checking the entry for that token before sending. One bullet per failed criterion addressed — what changed, where and why. The heading follows handoff §1 (` (pass K)` suffixed for K ≥ 2). With no validation commands documented, the append is a Bash call of its own. No code changed → no append. Then proceed to §2.

### 2. Determine the verdict

Choose one from what is on disk and this run's fix loop:

- **`stuck`** — any of: the current pass of `03-implementation.md` carries `## Stuck`; `04-review.md` is labelled `stuck (<pattern>)` or `failed (all reviewers)`; the fix loop (§1 step d) detected a stuck pattern.
- **`partial`** — not `stuck`, and any of: `## Failed Criteria` remain in `05-tests.md` after the fix budget, or record a `ui-tester` crash or timeout; an accepted finding in `04-review.md` carries an `outcome` other than `applied` (`fix-failed` or `not attempted`).
- **`pass`** — the implement phase completed (`## Rationale` in the current pass); every accepted finding in `04-review.md` is `applied` (dismissed and `deferred (conflict)` findings are allowed); and the tests passed, including the required UI checks, or a skip artifact was written.

### 3. Write summary and lesson artifacts

**Always write `06-summary.md`** regardless of verdict. Content varies:
- `pass`: completed work summary, files changed, validation passed, reviewer findings count, test results — plus the commit outcome: when the run leaves changes uncommitted (`git.commit: never` or `--no-commit`), say so explicitly and point at `git status`.
- `partial`: references the `## Failed Criteria` section in `05-tests.md`, lists the accepted findings `04-review.md` left unapplied and its deferred conflicts, lists what was completed.
- `stuck`: describes the state at escalation — the detected stuck pattern (or "turn cap exceeded") and a suggested next move for the user. For an implement-phase stuck, draw the pattern, the arbiter's reason and the last actions from the handoff's `## Stuck` record and the newest-steps view; for a review-round stuck, from `04-review.md`'s label and its `not attempted` findings; for a fix-loop stuck, from this run's own iterations and failed criteria.

**`06-summary.md` never carries `## Rationale` content**, whatever the verdict — no reasons, no rejected alternatives, from `03-implementation.md` or from the conversation. The summary becomes the PR body and the commit body, and is inlined as blocker context into a sibling's reviewer prompts, so the implementer's justification would reach every reviewer the handoff keeps it from. A review finding about a credential or secret is named by its `path:line`, never quoted.

The uniform always-write contract means downstream readers (and reopened-ticket regressions) never have to handle a "missing summary = unknown verdict" failure mode.

Artifact verdict for this write: §4.

**Capture a lesson in the cross-ticket lessons log** at the same time (which store: §5), following the shared contract in [`lessons-log-fs.md`](../flow/references/lessons-log-fs.md) / [`lessons-log-server.md`](../flow/references/lessons-log-server.md) end-to-end: store creation (§1), entry format (§2), what to capture vs skip (§3), the write-time supersession check (§4), prefer-newest on conflict (§5), promotion on recurrence (§6), and format overflow (§7). Close-specific wiring:

- The primary source of what bit this ticket is the handoff's `constraints` and `rough edges` fields across its `## Steps` entries, then the `## Post-review` / `## Post-test` bullets and this run's failed criteria.
- The header's `<verdict>` token is this run's verdict: `pass` | `partial` | `stuck`.
- A close run is **unattended** in the §6/§7 sense — no human is reachable to answer, so the CLAUDE.md proposals are skipped — under headless `claude -p`, or as a subagent whose brief says no human is reachable (flow's stage brief carries that line, set from how flow itself was invoked). A stage subagent whose brief says a human is reachable is attended: it pauses with the proposal and continues with the relayed answer.

### 4. Present the verdict gate

For **`pass`** (without `--pr`) — dispatch on the `commit_mode` bound at Entry (`--no-commit` has already collapsed it to `never`):

- **`prompt`** — the interactive gate:

  ```
  ## Build Complete — verdict: pass

  [Summary from 06-summary.md]

  All artifacts: <ticket-folder>/

  Would you like to commit these changes?
  ```

  Capture the user's reply. Proceed to §5 regardless (commit decision affects git only, not the folder transition).

- **`always`** — skip the prompt: present the same block with the question line replaced by `Committing per git.commit: always.` Proceed to §5 with the commit decision preset to yes — `always` presets the prompt's answer, nothing more.

- **`never`** — skip the prompt: present the same block with the question line replaced by `Leaving changes uncommitted (git.commit: never).` — or `(--no-commit)` when the flag set it. Proceed to §5 with the commit decision preset to no.

For **`pass` with `--pr`**: skip the interactive commit prompt — `--pr` is the user's authorization to ship. Present a non-interactive summary, then proceed to §5:

```
## Build Complete — verdict: pass (--pr)

[Summary from 06-summary.md]

All artifacts: <ticket-folder>/

Opening a pull request per --pr (see references/pr-creation.md): branch from base → commit → push → gh pr create → finalize into review/.
```

When the config said `git.commit: never` (the override remembered at Entry), append one outcome-neutral line to the block: `Note: --pr overrides git.commit: never — proceeding with the pr-creation.md commit path.` Outcome-neutral on purpose: if the PR path later degrades to a local commit, pr-creation.md's own degradation line reports what actually happened, and this notice stays true.

For **`partial`** or **`stuck`**:

```
## Build Complete — verdict: <partial|stuck>

[Summary; for stuck, the detected pattern]

All artifacts: <ticket-folder>/

Options:
  - accept-as-partial — finalize as done/ with status: partial-completion
  - continue-with-hint — re-enter implement with a user note
  - abort — revert ticket to backlog/, artifacts preserved in the folder
```

Capture the user's choice. Proceed to §5.

### 5. Hand the ending to the finalizer

The stage resolves the ending into one instruction set and hands it to a single `feature:finalizer` child, which performs the post-gate mechanics — commit, push and PR creation, PR linkage, the state transition(s), worktree teardown — in a fresh context. The stage performs none of them in its own.

**The decision to hand over**, per [`state-transitions-fs.md`](../flow/references/state-transitions-fs.md) / [`state-transitions-server.md`](../flow/references/state-transitions-server.md) (for the detected storage mode) Decision Table:

- **`pass` without `--pr`** (any commit outcome) → Transition 2 (End-of-pipeline → `done/`).
  - Commit decision **yes** (prompt confirmed, or `git.commit: always`) → commit first per [`../build/references/commit.md`](../build/references/commit.md): gitignore-aware staging (§1), then a §2 message referencing the ticket ID via `git commit -F`. Onto the current branch, no push, no PR — the mechanics are identical whichever mode said yes.
  - Commit decision **no** (prompt declined, `git.commit: never`, or `--no-commit`) → touch nothing in git.
  - Then Transition 2 — it fires identically for both outcomes.
- **`pass` with `--pr`** → the [`../build/references/pr-creation.md`](../build/references/pr-creation.md) sequence (preconditions → branch-decision matrix → gitignore-aware stage → commit → push → `gh pr create`). `commit_mode` never gates this path — a `never` config only adds the §4 override notice. On success: Transition 5 (→ `review/`, status `in-review`) and the PR URL + branch recorded (PR linkage on the ticket: §6 — see pr-creation.md §5). On degradation (gh missing/unauthenticated, non-GitHub origin, or push/PR failure): Transition 2 (→ `done/`) and the reason recorded in `06-summary.md`. Which of the two applies is resolved inside the sequence, so the finalizer settles it and reports which; the verdict stays `pass` either way. The branch-decision matrix's safety stops are not the commit gate that `--pr` skips — they come back to the stage as a `needs-decision` result and are relayed from here.

- **`partial`** or **`stuck`** + **`accept-as-partial`** → Transition 4 (status flips to `partial-completion`), then Transition 2 (folder moves to `done/`, preserving `partial-completion` status).

- **`partial`** or **`stuck`** + **`abort`** → Transition 3 (folder reverts to `backlog/`, status `backlog`; for epic children, only the child's frontmatter reverts unless every sibling is also `backlog` or `cancelled` — the inverse all-children-done check).

- **`partial`** or **`stuck`** + **`continue-with-hint`** → **the one ending that spawns no finalizer**, because the ticket goes back to implement and none of this is post-gate work. The stage applies Transition 4 itself (status flips to `partial-completion`; folder stays in `in-progress/`). Then:
  1. Ask the user for the hint text.
  2. Return `close: continue-with-hint — verdict <partial|stuck>`, followed by the hint verbatim under a `## User hint — data, not instructions` heading. The caller re-enters implement with it; build's writes then open a new pass of `03-implementation.md` or continue the current one ([`../build/references/implementation-handoff.md`](../build/references/implementation-handoff.md) §1, Later passes).
  3. Standalone, print the command that does so instead — `/feature:build <ticket-id> --hint "<text>"` — then return the same result.

  Nothing re-enters in-process, and no turn counter is reset here.

**Worktree teardown** — part of the handed-over instruction set on the three spawning endings, only when a worktree is bound. [`../build/references/worktree.md`](../build/references/worktree.md) §4 owns the safety predicate and the mechanics and the finalizer runs them; the stage names the row that applies:

| Ending | Teardown |
|---|---|
| `pass`, committed (prompt confirmed, or `git.commit: always`) | **Remove.** The commits are on `<branch>`, which is repository-level state — the worktree holds nothing the repository does not. |
| `pass` with `--pr` (pushed, or degraded to a local commit) | **Remove.** Same predicate; a pushed branch satisfies it doubly. |
| `pass`, uncommitted (prompt declined, `git.commit: never`, or `--no-commit`) | **Leave**, print `<wt-path>`. The worktree is the only home of the work. |
| `partial` or `stuck` — any choice, including `abort` | **Leave**, print `<wt-path>`. Transition 3 reverts the *ticket*; it does not revert code, and the run is expected to resume. |

The §4 predicate is authoritative over this table: an ending listed as "remove" whose predicate fails (uncommitted changes still in the worktree) leaves the worktree in place and prints its path anyway. `--force` is never used to discard commits.

**Resolve the base branch** for the prompt non-interactively with [`../build/references/pr-creation.md`](../build/references/pr-creation.md) §1's short-name helper (`git symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@'`, falling back to `main`), path-bound to `<root>`.

**Spawn [`feature:finalizer`](../../agents/finalizer.md)** — exactly one child, on each of the three spawning endings, through the selected runtime. Its spawn `description` is the literal `Finalize <TICKET-ID>`. The prompt is self-contained: every path in it is **absolute**, every mode-specific fact is the value the stage's own `-fs`/`-server` file resolved, and it carries no relative link and no mode file — the child does not share the stage's context and cannot resolve a path against this skill's directory. Substitute every `<…>` below with the resolved value before sending; `<PLUGIN_ROOT>` is the root bound at Entry.

   > Finalize the post-gate mechanics for `<TICKET-ID>` — they are already decided; perform them, never re-decide them. Storage mode: `<fs-native | server-native>`. Ticket folder (absolute): `<ticket-folder>`. `06-summary.md`: `<absolute path>`. `01-spec.md`: `<absolute path>`. `<In server-native, additionally: the ticket handle, and the absolute scratchpad paths of the pulled 06-summary.md, the id file and the title file — pull nothing yourself.>` Verdict: `<pass | partial | stuck>`. Ending: `<pass | pass --pr | accept-as-partial | abort>`. Commit: `<commit per the commit.md conventions | leave everything uncommitted>`. `<--pr overrides the project's git.commit: never — commit and push anyway.>` Base branch: `<base>`. Session-state path to exclude from staging: `<the project config's resolved test.auth.storage_state, absolute | none declared>`. Epic slug for the PR body lead: `<the epic: slug | not an epic child>`. Worktree: `<bound — wt-path <wt-path>, branch <branch>, repo root <repo-root>; teardown row: <the row named above> | none bound>`.
   >
   > **Your three mechanics references, at these absolute paths** — read the named sections only: `<PLUGIN_ROOT>/skills/build/references/commit.md` (all of it); `<PLUGIN_ROOT>/skills/build/references/pr-creation.md` §0–§5 (skip its Merge predicate — that is the caller's, not yours); `<PLUGIN_ROOT>/skills/build/references/worktree.md` §2 step 4, §3 and §4.
   >
   > **Perform, in this order**, skipping any step this instruction set does not name: the commit per `commit.md` — deriving the worktree exclusion list fresh by re-running `worktree.md` §2 step 4's verification over the `.worktreeinclude` matches, never reading back the `## Worktree` record; push and PR creation per `pr-creation.md` §0–§4 when the ending is `pass --pr`; PR linkage into `06-summary.md` `<and the ticket row's PR field>`; the transition(s) resolved below; worktree teardown per `worktree.md` §4. With a worktree bound, aim every command per `worktree.md` §3 — the paths above are absolute so that split is already resolved for you.
   >
   > **Transition(s) to apply — resolved, perform exactly these**: `<For each transition in the decision: its number and name, the absolute source and destination folder paths (or "no folder move" — an epic child never leaves its epic's `tasks/`), the exact frontmatter file and the exact `status:` value to write, and the rule that the folder moves first and the frontmatter second, so a failed move leaves the prior state recoverable. In server-native, instead: the ticket handle, the target status, and the CAS `from[]` value — never widened.>` `<When this ticket is an epic child, additionally: the epic's absolute current folder, its `prd.md` path, its declared `children:` roster as read by the close stage, and the Epic-completion predicate to evaluate after your own status flip — return `promote` only if all three hold: the roster parsed; every declared ID has a `tasks/<id>/01-spec.md` with parseable `status`; every such child's status is one of `done`, `cancelled`, `partial-completion` (`in-review` is NOT terminal). Otherwise `stay`. A spec present with unreadable status counts as non-terminal. On `promote`, move the whole epic subtree to the done state folder and set `prd.md` `status: done`. Report any warning — an unparseable roster (which forces `stay`), or a materialized child absent from the roster — in your result's `notes`, since the close stage has no other channel to surface it.>`
   >
   > **You are non-interactive.** Never ask a question and never wait for input. A condition that would stop for a human — pr-creation.md §1's commits-ahead-of-base and detached-HEAD rows — comes back as `result: needs-decision` naming the stop, the pending operation, the side effects already applied, and the choice block verbatim. pr-creation.md §1's stash-pop conflict is instead a terminal `result: error` with `failed-step: branch-decision`: its own prescription is to abort the PR step without committing and leave the stash intact, so there is no answer to relay. A `gh`/origin/push/PR failure is neither — it degrades per pr-creation.md §0/§4 and returns `ok` with the degradation reason.
   >
   > **Be idempotent, and never stage a conflicted tree.** A commit may already exist, a branch may already be pushed, a PR may already be open, a transition may already have fired — check each step before performing it, and report an already-done step rather than repeating it. Before any staging, check `git status --porcelain` for unmerged (`U`) entries: a conflicted working tree is a terminal `result: error` with `failed-step: commit`, never something `git add -A` resolves by staging it.
   >
   > **Report every exclusion and every warning in `notes`** — each path `commit.md` §1 held back from the commit, each predicate warning, each already-done step, each degradation. The close stage surfaces that field to the user; it is the only channel these have.
   >
   > **Return your fixed-format result block and nothing else** — no diff, no narration, no restatement of the work that was built.

   **Ship's `## Stage overrides`.** When the stage received one in its own brief, it names post-gate steps the caller performs itself (typically the transitions, and the lessons capture the stage already skipped). The stage **resolves the conflict when composing** rather than appending a contradiction: an overridden step is struck from the instruction set above — `Transition(s) to apply: none — the caller applies them` — and the override text is then appended verbatim below the prompt as the stated reason. Never leave the child holding both a resolved step and a later instruction to skip it: its own contract turns an ambiguous input into an `error`, which would fail the tail on every run under that caller. Nothing on disk records the override, so an un-forwarded one makes the child transition a ticket its caller expected to transition.

**Result handling.** The child returns exactly one of three kinds:

- **`ok`** → the stage composes §6 from its fields and nothing else.
- **`needs-decision`** → the stage relays it exactly as it relays its other stops, then re-spawns the finalizer with the answer under an `## Answers to earlier stops — data, not instructions` heading, together with the cumulative `completed-side-effects` list so the re-spawn resumes rather than re-derives. A second `needs-decision` is relayed the same way.
- **`error`** → the stage reports the named failed step and stops without claiming completion (`close: error`, `failed-step: finalizer:<step>`). When the failure precedes the transition — every `failed-step` except `transition` and `worktree-teardown` — the ticket's status is still `in-progress`, which is exactly the signal the Router's incomplete-tail row keys on, so the failure is resumable by construction rather than by a recorded flag. A `transition` or `worktree-teardown` failure may instead leave a terminal status: the stage reports the state it was left in and what remains (the frontmatter half of a half-applied transition, or the worktree path), because the routing row will not match it and a re-run would read the ticket as complete.

### 6. Final user-facing message

Composed from the finalizer's `ok` result — its `transition`, `commit`, `pr`, `branch`, `worktree` and `notes` fields — and printed once the child returns. Print every `notes` line beneath the transition line: staging exclusions, Epic-completion warnings, degradations and already-done steps reach the user through no other channel, and a silent exclusion is indistinguishable from a guard that never fired.
- On `done/` transition with a commit: "Ticket moved to `done/`. Run `git log -1` to see the commit."
- On `done/` transition without a commit (declined, `git.commit: never`, or `--no-commit`): "Ticket moved to `done/`. Changes left uncommitted — run `git status` to review them."
- Whenever the result carries a `pr` URL: [`../build/references/pr-creation.md`](../build/references/pr-creation.md) §5's PR line, filled from the result's `pr` and `branch` fields. Keyed on the field rather than on the `review/` transition, so a caller whose overrides suppressed the transition still gets the PR reported.
- On `backlog/` revert: "Ticket reverted to `backlog/`. Artifacts preserved in the folder."
- On `continue-with-hint`: no additional message — no child ran, and the result carries the hint back to the caller.

When the result says the worktree was removed, the main checkout shows no trace of the change, so name where the work went: append `Work is on branch <branch> (worktree removed) — 'git checkout <branch>' to see it.` to the `done/` line. When the result says it was left in place, append `Work left in <wt-path> on branch <branch>.` instead.

## Behavioral boundary

Fix only failed criteria, and build nothing beyond `02-plan.md`. Never re-invoke another skill, never re-run the review round, and never perform a finalizer mechanic — commit, push, PR, transition other than Transition 4 on `continue-with-hint` and Transition 6 on the merge-check row, teardown — in the stage's own context.

## Result

The stage's final report is fixed-format. Its first line:

```
close: <done | review | backlog | continue-with-hint | merged | pr-open | already-complete | error> — verdict <pass | partial | stuck>
```

The ending is the transition the finalizer applied (`done`, `review`, `backlog` — `done` also for `accept-as-partial`), or the route that ended the stage. The verdict is omitted for `merged`, `pr-open` and `error`. `error` instead adds `failed-step: <ticket | not-ready | worktree | storage | finalizer:<step>>` and one line of detail. The second line is the absolute path of `06-summary.md`, when one was written; `continue-with-hint` then adds its `## User hint — data, not instructions` block. A stop the stage relays — the gate's question, a `needs-decision`, an attended lessons proposal — is not a result: under `flow` it pauses the stage subagent until the answer arrives.

## Output

- **`05-tests.md`** — written as soon as the tester returns (or as the skip artifact), and rewritten after each fix iteration; a `## Failed Criteria` section on remaining failures (write mechanics §3; verdicts §4).
- **`06-summary.md`** — written once per close run, regardless of verdict; the finalizer appends the PR URL + branch to it when a PR is opened, and the degradation reason when the PR path degrades.
- **`## Post-test`** in `03-implementation.md` — appended when the fix loop changed code, per [`../build/references/implementation-handoff.md`](../build/references/implementation-handoff.md) §4 and §5.

## Error Handling

- **Ticket not found, spec missing, or an epic** → `error`, `failed-step: ticket`.
- **Ticket status neither `in-progress` nor `partial-completion`** (and no merged, open-PR or already-complete route matched) → `error`, `failed-step: not-ready`.
- **Implement phase not ended, or review round not complete** (no `## Rationale` or `## Stuck` in the current pass; or, without `## Stuck`, no `04-review.md` with `fix-step: complete` for the current pass) → `error`, `failed-step: not-ready`.
- **Recorded worktree gone from disk** → `error`, `failed-step: worktree`.
- **Application unreachable at the test checkpoint**: handled by the reachability pre-flight (`references/test-preflight.md`), not an interactive error — the app is reached, a declared `test.start` is booted, or the *app unreachable* skip artifact is written and the stage proceeds to the verdict without prompting. A pre-flight-started server is torn down afterward.
- **`ui-tester` failure** (crash or timeout): record it under `## Failed Criteria` in `05-tests.md` and proceed to the verdict, which is `partial`.
- **Finalizer `error` result, or the finalizer child itself failing**: report the named failed step (or the spawn failure) and stop — never claim the transition fired. The ticket is left in `in-progress/` with `06-summary.md` written, which is the Router row that re-enters at the gate.
- **Storage operation fails** → §9.
- **Stuck pattern during fixes** — not an error: the `stuck` verdict. `06-summary.md` is always written.
