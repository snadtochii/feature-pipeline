---
name: review-stage
description: "Review a built ticket's diff with four independent reviewers, then validate each finding and fix the accepted ones."
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
  - mcp__plugin_server-native_ps__pipeline_get_ticket
  - mcp__plugin_server-native_ps__pipeline_list_tickets
  - mcp__plugin_server-native_ps__pipeline_get_artifact
  - mcp__plugin_server-native_ps__pipeline_list_artifacts
  - mcp__plugin_server-native_ps__pipeline_write_artifact
argument-hint: "[ticket-id] [--base branch]"
---

# Review Stage

Run a ticket's review round from a fresh context that holds only the spec, the plan, the diff and the implementer's handoff. Four independent reviewers judge the change; the stage then validates every finding against the current code, records each as accepted, dismissed or deferred, and fixes the accepted ones smallest first.

The stage is **non-interactive end to end**: it never asks anything and never pauses. Every stop is a structured result (see Result). It fires no ticket transition, makes no commit, and captures no lessons. Standalone, under `flow`, or under standalone `build`'s stage chain, the four reviewers are its children.

## Arguments

```
/feature:review-stage $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to the ticket folder. Optional flag: `--base <branch>` — the branch the change forks from and its PR targets (a ship epic's integration branch, say); step 1 diffs against it instead of resolving the base itself. Without it, step 1's default resolution applies.

## Required Input

- `01-spec.md` — the ticket specification; reviewers get it in the shared base.
- `02-plan.md` — the approved plan; reviewers get it in the shared base, and the validate step dismisses findings outside its scope.
- `03-implementation.md` — **required**, with a `## Rationale` section in its current pass (the implement phase complete); reviewers get its neutral view, the validate step its full view, and the worktree re-bind its worktree view.
- `04-review.md` — optional; a prior round's state, read only by the Router.
- Each `blocked_by` entry's `01-spec.md` and `06-summary.md` (fallback `02-plan.md`, then `01-spec.md` alone) — optional blocker context for the reviewers.

Storage mechanics for these inputs: §1 and §5 of the stage's storage file (loaded at Entry step 2).

## Entry

**Runtime.** Bind the runtime reference, the plugin root and the project or worktree root from the brief's runtime block when there is one — [`stage-briefs.md`](../flow/references/stage-briefs.md) §3 makes it authoritative, so no runtime file is read — else, standalone (`/feature:review-stage` in the main conversation), per [../flow/references/runtime.md](../flow/references/runtime.md). Use the bound runtime's Spawn and Capacity operations for the four reviewers, and prefix each reviewer's complete prompt with the runtime block.

Every message in this stage re-reads its whole window (the runtime reference's tool-result rule: several tool calls in one message re-read it once), so the numbered steps below are the message sequence: the ticket resolution (step 2) and the preparation read (step 3) are one message each, and nothing fetched there is read a second time later in the stage. Any `error` below ends the stage with the Result line and writes nothing.

1. **Storage mode.** From the brief's `Storage mode:` line when there is one (the same §3 makes it authoritative); standalone, detect it once per [`storage.md`](../flow/references/storage.md) §Mode detection. No storage file is read here — step 2's call fetches it.
2. **Resolve the ticket** per [`ticket-resolution-fs.md`](../flow/references/ticket-resolution-fs.md) / [`ticket-resolution-server.md`](../flow/references/ticket-resolution-server.md) (for the bound mode), Steps 1–3 — one call that fetches that reference together with the stage's storage file for the bound mode, [`references/storage-fs.md`](references/storage-fs.md) / [`references/storage-server.md`](references/storage-server.md), read **once, in full** (every later `§N` cite in this skill refers to it), and locates the ticket. Wherever the resolution reference would ask the user — ticket not found, spec missing, an ambiguous project root — return `error` with `failed-step: ticket` instead.
3. **The preparation read** — one message of parallel tool calls, its contents the list in §1 of the storage file now in hand; no artifact goes through a Bash print (the runtime reference's tool-result rule). It binds the working copy: `<ticket-folder>` is absolute.

The remaining steps are computed from that read:

4. **Epic refusal.** Step 4 of the ticket-resolution reference: `kind: epic` → `error`, `failed-step: ticket`, naming the epic's children.
5. **Bind ticket metadata** — `complexity`, `kind`, `blocked_by` — once, per §2, upstream of the router below.
6. **Readiness.** From the preparation read's copy of `03-implementation.md` — every view this stage uses (worktree, neutral, full) is derived from that one read, never re-read. The file must exist, and its current pass must carry a `## Rationale` section — the implement phase's done signal in [`../build/references/implementation-handoff.md`](../build/references/implementation-handoff.md) §8. Otherwise → `error`, `failed-step: implement-incomplete`.
7. **Worktree re-bind.** From the worktree view (handoff §6): a `## Worktree` section whose `wt-path` exists on disk → bind `<wt-path>`, `<branch>` and `<repo-root>`. A recorded path that is gone → `error`, `failed-step: worktree`; the stage never falls back to the main checkout and never provisions a worktree. With a worktree bound, **re-derive the exclusion list** by re-running [`../build/references/worktree.md`](../build/references/worktree.md) §2 step 4's verification over the `.worktreeinclude` matches — never trust the recorded `excluded:` field — and bind `<excluded>`: the copied paths that are not ignored, which must never reach a reviewer prompt. The existence check and that verification are one call, issued only when a worktree is recorded. Bind `<root>` to `<wt-path>` when bound, else the project root from step 2. Every git and project command below, and the reviewers' project root, are path-bound per [`../build/references/worktree.md`](../build/references/worktree.md) §3; `<ticket-folder>` stays in the main checkout.

## Router

First match wins. Signals are read per §6.

| On disk | Route |
|---|---|
| `04-review.md` with `fix-step: pending`, whatever the recency | Resume: run step 1's collection (step 7 bounds fixes by the diff and step 8 notes a fix outside it), then continue at the fix step (step 7) from the recorded decisions. No reviewer is spawned. Recency is not consulted: a round's own `## Post-review` append can leave `03-implementation.md` newer than its pending `04-review.md`. |
| `04-review.md` newer than `03-implementation.md`, with `fix-step: complete` and the `failed (all reviewers)` label | Full review from step 1 — a reviewer failure is retried, never returned as recorded. |
| `04-review.md` newer than `03-implementation.md`, with `fix-step: complete` | Already reviewed. Return the result its body records; write nothing. A `stuck` round is returned as recorded too; deleting `04-review.md` starts a fresh round. |
| Otherwise (absent, or `03-implementation.md` newer) | Full review from step 1. An existing `04-review.md` is overwritten, never appended to. |

## Process

### 1. Resolve the base and collect the diff

The diff is everything between the merge-base and the working tree, plus untracked files, excluding the ticket store and every `<excluded>` path. Resolve the base and produce the counts and the diff in **one** Bash call — shell variables do not survive between calls:

```bash
cd "<root>" || exit 1
want=<base-arg>
if [ -n "$want" ]; then
  case "$want" in *@{*) echo "NO_BASE"; exit 1 ;; esac
  git check-ref-format --branch "$want" >/dev/null 2>&1 || { echo "NO_BASE"; exit 1; }
  if git rev-parse --verify -q "origin/$want^{commit}" >/dev/null; then base="origin/$want"
  elif git rev-parse --verify -q "$want^{commit}" >/dev/null; then base="$want"
  else echo "NO_BASE"; exit 1; fi
else
  base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)
  [ -n "$base" ] || for b in origin/main origin/master main master; do
    git rev-parse --verify -q "$b^{commit}" >/dev/null && { base=$b; break; }
  done
  [ -n "$base" ] || { echo "NO_BASE"; exit 1; }
fi
mb=$(git merge-base "$base" HEAD) || exit 1
echo "=== BASE $base"
git diff --shortstat "$mb" -- . ':(exclude)claudedocs/' <exclude-pathspecs>
git ls-files -z --others --exclude-standard -- . ':(exclude)claudedocs/' <exclude-pathspecs> |
  while IFS= read -r -d '' f; do printf 'untracked %s %s\n' "$(wc -l < "$f")" "$f"; done
echo "=== DIFF"
git diff "$mb" -- . ':(exclude)claudedocs/' <exclude-pathspecs>
git ls-files -z --others --exclude-standard -- . ':(exclude)claudedocs/' <exclude-pathspecs> |
  while IFS= read -r -d '' f; do git diff --no-index -- /dev/null "$f"; done
true
```

`<base-arg>` is `''` without `--base`, else the `--base` value single-quoted, an embedded `'` written as `'\''`. The script validates it with `git check-ref-format --branch` before any use — a name starting with `-`, carrying ref-illegal characters, or containing `@{` (which `check-ref-format` would expand to a different branch) is rejected — then prefers `origin/<branch>`, falls back to the local `<branch>`, and otherwise stops. A given `--base` never falls back to the default resolution: a wrong base silently widens the diff. `<exclude-pathspecs>` is one single-quoted `':(exclude)<path>'` per `<excluded>` entry, empty when none is bound; an embedded `'` in a path is written as `'\''`. Untracked file names never pass through the model: the NUL-delimited loop quotes them, so a name with spaces, `$( )` or a leading `-` stays data. `git diff --no-index` exits non-zero when it prints a diff, which is why the call ends in `true` and never runs under `pipefail`; a binary file prints as `Binary files … differ`. The remote-tracking base (`origin/main`) is intended — it is only ever diffed against. `NO_BASE` → `error`, `failed-step: base`.

The **diff union** is the tracked diff plus the rendered untracked files. `claudedocs/` is excluded because the ticket's own artifacts are not the change under review. Empty union → write `04-review.md` with the `verdict: skipped (no changes)` label and `fix-step: complete` (§3, §4), and return `no-diff`.

### 2. Triviality short-circuit

Before spawning reviewers, check whether the diff is small enough that four reviewers cost more than they find. Count lines and files over the diff union from step 1's output: the `--shortstat` line, plus each `untracked` line's count and one file each. If **all three** hold — `complexity: S` (bound at Entry, never re-parsed from an artifact body), lines changed < 50, files changed < 3 — write `04-review.md`:

```
verdict: skipped (trivial diff)
fix-step: complete

## Reason
Ticket complexity is S; diff is <X> lines across <Y> files (threshold: < 50 lines, < 3 files). Skipping the parallel reviewer subagents — token cost outweighs expected signal on small changes.
```

Artifact verdict for this write: §4. Return `skipped-trivial`. Otherwise continue.

### 3. Compose the shared base

One composition, used by all four reviewers:

1. **Ticket context**: `01-spec.md` and `02-plan.md`, plus the **neutral view** of `03-implementation.md` — the file minus every `## Rationale` section, per [`../build/references/implementation-handoff.md`](../build/references/implementation-handoff.md) §6. Inline the resolved text; reviewers judge the change without the implementer's reasons.
2. **Diff**: the diff union from step 1.
3. **Project root path**: `<root>`. A reviewer given the right diff and a root pointing at a tree without the change reads files that contradict the hunks and reports confident false findings.
4. **Blocker context** — only when `blocked_by` is non-empty: a `## Blocker context (from completed siblings)` block. Locate each blocker with the ticket-resolution reference's Step 6 lookup, but never refuse — the stage composes context, it does not gate. For each blocker include verbatim `01-spec.md` + `06-summary.md`; when `06-summary.md` is missing (a `cancelled` blocker, say) use its `02-plan.md`, and when that is missing too, `01-spec.md` alone. Note in the block which artifact was used per blocker. Retrieval and what "missing" means: §5. The block inlines artifact text, never a reference. Omit it entirely when `blocked_by` is empty.
5. **Confidence scale**: the verbatim contents of [`references/confidence-scale.md`](references/confidence-scale.md) under a `## Confidence scale (use this exactly)` header. The rubric lives in the reference and the stage injects it here — reviewer agent bodies stay rubric-free.

### 4. Spawn the four independent reviewer roles

Use the selected runtime's Spawn and Capacity operations: run concurrently when slots permit, otherwise in bounded batches. Every role receives the same shared base from step 3 plus its own suffix; another reviewer's findings never enter that prompt. Collect all four results before step 5; capacity-queued roles remain pending, not skipped or failed. Each prompt includes its runtime block and the role instructions required by that runtime:

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

### 5. Merge

- **Group by severity**: CRITICAL → IMPORTANT → SUGGESTION.
- **De-duplicate** overlapping findings (e.g. code-reviewer and code-architect flagging the same issue) before any tiebreak.
- **Tag each finding** `[correctness]` / `[security]` / `[performance]` / `[architecture]`, give it a stable id `F<k>`, and keep its `path:line`.
- **Summary** at the top: counts per severity and per reviewer, and reviewers returned `<N>/4`.
- **Secret material**: a finding about a credential or secret names its `path:line` and never quotes the value — `04-review.md` can reach a PR body.
- **Reviewer failure**: record a failed reviewer under `## Reviewer failures` and continue with the others (label `reviewed (partial — <N>/4 reviewers)`, §4). All four failing → write `04-review.md` with `verdict: failed (all reviewers)`, `fix-step: complete` and the error entry, and return `reviewers-failed`.

### 6. Validate every finding

Before any code edit, decide each finding. For each one, read only the **current code** at its `path:line` (`Read`/`Grep`/`Glob`, path-bound to `<root>`; independent reads go out as parallel calls in one turn). Judge it against that code, the diff from step 1 and the **full view** of `03-implementation.md` — `## Rationale` included (handoff §6) — both already in context from Entry step 6 and step 1, so a finding is judged the way the implementer would, with the reasons and discovered constraints in hand. A finding with no `path:line` (a design-level note) is checked against the diff and `02-plan.md`.

- **accepted — `<reason>`**: the finding is real and applies to the current code.
- **dismissed — `<reason>`**: a false positive; stale (no longer applies); contradicted by a recorded constraint or rationale that still holds (name the step); or outside `02-plan.md`'s scope.
- **deferred (conflict) — `<both findings>`**: two accepted findings whose fixes are mutually exclusive and that the tiebreak cannot settle. Both reviewers' findings are preserved.

**Tiebreak when accepted fixes are mutually exclusive**: `security > correctness > architecture > performance` — security has the largest blast radius, correctness is the acceptance-criteria contract, architecture can be repaired later, performance is the most local and most easily revisited. The losing finding is dismissed with the tiebreak as its reason.

Then do the **pending write** of `04-review.md` per §3 — every decision recorded, `fix-step: pending` — before touching any code:

```
verdict: <label per §4>
fix-step: pending|complete

# Review — <TICKET-ID>

## Summary
<counts per severity and per reviewer; reviewers returned N/4>

## Findings
### CRITICAL
- [F1] [security] path:line — finding (reviewer, confidence)
  - decision: accepted — <reason> | dismissed — <reason> | deferred (conflict) — <both findings>
  - outcome: applied | fix-failed — <error> | not attempted

### IMPORTANT
...

### SUGGESTION
...

## Reviewer failures
<none, or one line per failed reviewer>

## Post-review validation
<commands and result, or none documented>
```

`outcome` lines and `## Post-review validation` appear only in the complete write (step 9).

### 7. Fix the accepted findings

**Validation commands** — resolved here, the first point that runs them. Read the project instruction files for **both** runtimes — `CLAUDE.md` and `AGENTS.md` — for lint and typecheck commands (a `## Commands`, `## Validation` or `## Testing` section, or inline references), the current runtime's primary file first (`AGENTS.md` when `$PLUGIN_ROOT` is set and `$CLAUDE_PLUGIN_ROOT` is not, else `CLAUDE.md`), then the other; a file the runtime already loaded as project instructions is taken from context, not re-read. Run them as `cd "<root>" && <command>`. None documented → log one line (`No validation commands found in project CLAUDE.md/AGENTS.md — proceeding without skill-body validation`) and continue. The body commands run after each edit even when a `PostToolUse` hook is active — [`../build/references/validation-hook.md`](../build/references/validation-hook.md) explains why both layers run.

On the resume route, start here from the decisions recorded in `04-review.md`. A finding whose fix already landed before an interruption reads as already applied against the current code: record it `applied`.

- Work through every accepted finding, whatever its severity, **smallest change first**. A fix touches a file outside the diff only when the finding requires it.
- **Validate after each edit**: the `PostToolUse` hook plus the commands resolved above.
- **At most 2 edit-validate attempts per accepted finding** — the review stage's hard maximum ([`../build/references/stuck-detection.md`](../build/references/stuck-detection.md), Hard maximum per stage), counted within this invocation. After the second red run, the fix is reverted and recorded `fix-failed`.
- **A fix that will not validate, or cannot be made cleanly, is reverted** with `Edit`, restoring that finding's pre-edit text, and recorded `fix-failed — <error>`. Never use `git checkout`, `git restore` or `git stash` on a file: the implement phase's uncommitted work lives in the same files. A fix that did not land is never reported as applied.
- **Watch for stuck patterns** 1–5 in [`../build/references/stuck-detection.md`](../build/references/stuck-detection.md) (action↔observation repetition, action↔error repetition, monologue, ping-pong, repeated context errors). On detection, stop fixing, mark every remaining accepted finding `not attempted`, and continue to step 8 with result `stuck`, naming the pattern.

### 8. Post-review validation and the handoff append

Run the validation commands over the tree once. When at least one fix was applied, chain the `## Post-review` append to `03-implementation.md` onto that same call, per handoff §5: open with `set -o pipefail`, join the commands with `&&`, and use a quoted, entry-unique delimiter (`HANDOFF_REVIEW_<R>_END`), checking the entry for that token before sending. One bullet per applied finding — `[F<k>] <finding>: what changed, where, why` (handoff §4) — and say so when a fix touched a file outside the diff. With no validation commands documented, the append is a Bash call of its own, issued alone and completed before step 9's write. On the resume route, a `## Post-review` heading for this round already present in the current pass means the append landed before the interruption: do not append it again.

The heading follows handoff §1: the review stage never opens a pass. The first review round of pass K writes `## Post-review` (` (pass K)` suffixed for K ≥ 2); a later round in the same pass writes `## Post-review (round R)`, or `## Post-review (pass K, round R)`, R counting from 2.

A red run appends nothing: fix it in context, or revert the offending fix and mark it `fix-failed`, then re-issue the combined call. No fix applied → no append, but the validation result is still recorded.

### 9. Complete write

Write the final `04-review.md` per §3 — `fix-step: complete`; on a `stuck` exit the first line becomes the `stuck (<pattern>)` label (§4) — an `outcome` line on every accepted finding, and `## Post-review validation` naming the commands and their result (or `none documented`). This is always the stage's last write, so `04-review.md` ends newer than `03-implementation.md`.

## Behavioral boundary

Fix only accepted findings, and build nothing beyond `02-plan.md`. Never re-invoke another skill, never commit, never transition the ticket, never capture a lesson.

## Result

The stage's final report is fixed-format. Its first line:

```
review: <reviewed | skipped-trivial | no-diff | reviewers-failed | stuck | error> — applied <a>, dismissed <d>, deferred <c>, fix-failed <f>
```

The counts appear only for `reviewed` and `stuck`. `stuck` also names the detected pattern. `error` instead adds `failed-step: <ticket | implement-incomplete | worktree | base | storage>` and one line of detail. The second line is the absolute path of `04-review.md` (omitted on `error`). Nothing else — no finding text, no rationale, no diff.

Every result except `error` is also on disk as `04-review.md`'s first-line label and `fix-step:` marker, so a caller reads the artifact rather than depending on the report.

## Output

- **`04-review.md`** — the pending write after validation, and the complete write as the last action (write mechanics §3; labels §4).
- **`## Post-review`** in `03-implementation.md` — appended when at least one fix was applied, per [`../build/references/implementation-handoff.md`](../build/references/implementation-handoff.md) §4 and §5.

## Error Handling

- **Ticket not found, spec missing, ambiguous project root, or an epic** → `error`, `failed-step: ticket`.
- **No `## Rationale` in the current pass of `03-implementation.md`, or no file** → `error`, `failed-step: implement-incomplete`.
- **Recorded worktree gone from disk** → `error`, `failed-step: worktree`.
- **No base resolves**, or `--base` names a branch that fails validation or resolves neither remotely nor locally → `error`, `failed-step: base`.
- **Storage operation fails** → §7.
- **Reviewer failure** — not an error: recorded in `04-review.md`; all four failing is the `reviewers-failed` result.
- **Stuck pattern during fixes** — not an error: the `stuck` result, with remaining findings `not attempted`.
