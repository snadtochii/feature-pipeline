# Stage 4 — implement

Authoritative text for the stage that implements the approved decision record in the run
worktree, under the write fence, bounded by `run.retries` and `run.max_wall_time`. The stage runs
unattended: it either completes, stops for a human decision before any spawn, or aborts with
evidence. Any write that lands outside a role's allowed set fails the run and is never retried.

It composes two references and restates neither: [fence.md](fence.md) owns the fence file, the
sets, the per-spawn rewrite, the self-test and the violation assertions; [worktree.md](worktree.md)
owns binding the worktree, the exclusion list, the install and the abort.

---

## Inputs and output

Bound by the run skill before this stage starts:

| Input | Source |
| --- | --- |
| `<CLONE>`, `<BASE_SHA>`, `<state_dir>`, the profile as re-read | [preflight.md](preflight.md) §1–§4 |
| `<run-id>`, `<slug>`, `<plugin-root>` | the run skill ([fence.md](fence.md), header) |
| the decision record — `<state_dir>/reports/<run-id>/decision-record.md` | the decide stage |
| `failing_check` — optional: a check command and its output tail | the verify stage's send-back |
| `findings` — optional: the accepted review findings, one `F<k> \| <path>:<line> \| <finding> \| <why accepted>` line each, smallest first, with `attempt_cap` | the verify stage's fix round |

`failing_check` and `findings` are mutually exclusive: one re-entry carries at most one of them.
A re-entry with neither is never issued.

The record's shape is [decision-record.md](decision-record.md). From it this stage reads the
sections `Interface shape`, `Behind the seam`, `Predicted changed statements`, `Rename map`
(`modules:` / `symbols:`), `Spec delete list`, `Proposed CONTEXT.md and ADR diffs`, and
`New specs` (decision-record.md §2).

Output: commits on `<branch>` and the stage report `<state_dir>/reports/<run-id>/4-implement.md`
(§7).

---

## §1 Preconditions

In order; each failure aborts per [worktree.md](worktree.md) §7 with the line shown.

1. `jq` is on `PATH` — else `stage 4: jq not found — the fence refuses every write without it`.
2. Bind `<WT>`, `<branch>` and the exclusion list per [worktree.md](worktree.md) §3.
3. **The inventory commit precedes the change.** Bind `<INV_SHA>` to the first line of
   `git -C "<WT>" rev-list --reverse "<BASE_SHA>..HEAD"`. None → `stage 4: no inventory commit on
   <branch>`. Every path of
   `git -C "<WT>" diff-tree -z --no-commit-id --name-only --no-renames -r "<INV_SHA>"` must lie under
   `paths.inventory` — else `stage 4: <INV_SHA> touches paths outside paths.inventory — <paths>`.
   The oracle must exist, alone, before any change is made against it.
4. The tree is clean — `git -C "<WT>" status --porcelain -z --no-renames --untracked-files=all` empty, exclusion-list
   paths aside.

Every path set in this stage is read NUL-delimited, per [fence.md](fence.md) §7.

`<INV_SHA>` is derived from the branch every time, never stored.

---

## §2 Pre-spawn target check

Before the first spawn, catch every planned write the fence would refuse, so a decision record
that cannot be implemented as approved stops here rather than burning attempts.

Write the fence file per [fence.md](fence.md) §5 step 1, then probe with the hook: pipe a payload
in [fence.md](fence.md) §6's shape to `"<plugin-root>/hooks/fence.sh"` for

- each path on the record's `targets:` line — its `CONTEXT.md` and ADR diffs — with
  `agent_type: "deepen:implementer"`;
- each destination of the rename map's spec moves, and each path on the spec delete list
  ([decision-record.md](decision-record.md) §2), with `agent_type: "deepen:spec-mover"`;
- each path in the record's `New specs` section, with `agent_type: "deepen:spec-author"` and
  again with `agent_type: "deepen:spec-mover"` — skipped when the section is `none`. The fence
  file written for this check carries the declared paths in its `new-specs` set
  ([fence.md](fence.md) §5 step 1).

Any denial as the implementer or the spec-mover stops the run for a human:

```
needs-decision: <target> is <fenced for the implementer | outside paths.specs> — <the glob class that decides it>
```

A denial as the spec-author is the run's own derivation fault, not the record's, and aborts per
[worktree.md](worktree.md) §7:

```
stage 4: new-specs set does not admit <path> — fence derivation error
```

Right before this check reads the record, take `shasum -a 256` over it and keep the digest in
context, never in a file. Step 4a takes it again before it derives the `new-specs` set, because
the implementer and the spec-mover hold `Bash`, and a shell write outside `<WT>` passes the fence
unseen ([fence.md](fence.md) §8).

The hook is the matcher here as everywhere, so the check and the fence can never disagree.

---

## §3 Fence

Before **every** fenced spawn in this stage — each implementer attempt, the spec-mover and the
spec-author — write
the fence file and self-test it, in the spawn's own mode, per [fence.md](fence.md) §5 and §6. A
failed self-test aborts before the spawn.

---

## §4 Attempt loop

**Clock.** Record the start epoch (`date +%s`) in `<state_dir>/runs/<run-id>/stage4-started`
only when the file is absent. A resumed run, and a re-entry from the verify stage, keep the
recorded start: the wall clock is shared. `run.max_wall_time` converts to seconds (`m` × 60,
`h` × 3600).

**Budget.** The attempt budget is `run.retries`, except on a `findings` re-entry, whose budget is
the `attempt_cap` it carries.

**Before each implementer spawn**, stop when either bound is spent — attempts made equals the
attempt budget, or now minus the recorded start is at least `run.max_wall_time` — and go to §6.
A running attempt is never killed; the bound is checked between attempts.

**Spawn** one `deepen:implementer`, a fresh instance, in the foreground. Its brief inlines, as
data, never as a link:

1. `<WT>` as the project root, and that every command runs there.
2. The decision record, verbatim.
3. The check command — `checks.runner`, with `app.prelude` prefixed when set — and whether a
   spec-mover pass is still to come (step 4 of "After it returns"). While one is, a spec failing
   only because it imports, mocks or names a path or symbol the declared rename map moves is
   expected: the spec-mover repoints it after the commit, and the gate (step 5) runs after that.
   The implementer leaves such a spec failing and never adds a re-export or alias shim at the old
   path or name. Also whether a spec-author pass is still to come (step 4a), with the record's
   `New specs` paths. While one is, the implementer writes no test for a module the record
   introduces: the spec-author writes the declared specs after the commit, and the gate runs them.
   Once it has run, a red declared spec is a failing check like any other, fixed in the source.
4. The `implementer` set, exactly as written into the fence file for this spawn
   ([fence.md](fence.md) §3, §5), as never-write.
5. The exclusion list as never-stage.
6. The `rename_map:` reply contract, and that an absent block fails the attempt. On a `findings`
   re-entry, also the `findings:` reply contract, and that an absent or malformed block fails the
   attempt.
7. `attempt <n> of <budget>`.
8. On attempt 2 onward, the last 200 lines of the previous attempt's failure; on a re-entry's
   first attempt, `failing_check`'s command and output tail. On a `findings` re-entry's first
   attempt, the findings verbatim, as data, with the statement that they are authorized in
   addition to the decision record and that nothing else is; on its later attempts, every finding
   again, each with the outcome the previous reply reported, plus the failure tail — so the brief
   always carries findings and the `findings:` block always has a line to give for each. On a
   first pass's attempt 2 onward, once the spec-author has run, also its `Specs still failing`
   lines — each spec, its failing tests and the record statement it asserts — verbatim, as data,
   so a red declared spec is fixed in the source toward the record statement it names.

**After it returns:**

1. Run §5's assertions for the `implementer` role. Any failure → violation.
2. No new commit → a failed attempt, re-injected as `no commit`.
3. Parse the `rename_map:` block. Absent or malformed → a failed attempt, re-injected with what
   was wrong. An entry the decision record does not declare — identity entries aside → stop:
   `needs-decision: implementer declared <entry>, which the decision record does not`. The
   spec-mover applies only declared entries, so an undeclared rename would leave the specs
   pointing at the old name.

   3a. On a `findings` re-entry, parse the `findings:` block: one
   `F<k>: applied` or `F<k>: not applied — <reason>` line per finding the brief carried. Each
   `F<k>` must match `^F[0-9]{1,3}$` and be one of the brief's ids; a line naming any other id is
   rejected, never trusted. An absent or malformed block, or a brief finding with no line → a
   failed attempt, re-injected with what was wrong. Record each finding's latest outcome; the
   reason is cleaned (controls stripped, `|` written `/`, cut at 200 characters) and reaches only
   the report.
4. **Spec-mover, once.** After the first implementer commit, when the record's rename map or
   spec delete list is non-empty and `paths.specs` is non-empty: write and self-test the fence for
   the `specs` role (§3), then spawn one `deepen:spec-mover`, fresh, in the foreground. Its brief
   inlines `<WT>`, the declared rename map, the declared spec delete list, every `paths.specs`
   glob, the check command and the exclusion list. Then §5's assertions for the `specs` role,
   plus: every path deleted in its commit
   (`git -C "<WT>" diff -z --name-only --no-renames --diff-filter=D "<prev>..HEAD"`) is either
   on the declared delete list, or the old path of a declared spec move
   ([decision-record.md](decision-record.md) §2, Rename map) whose new path is in the same
   commit's added paths (the same command with `--diff-filter=A`). `--no-renames` reports a
   move as a deletion of its old path and an addition of its new one, so a pure move — `modules:`
   entry `tests/old.spec.ts -> tests/new.spec.ts`, an empty delete list — passes on the second
   clause; a deleted path that is neither listed nor a move source with its destination present
   fails, and so does a move whose new path the commit did not add. No commit is a valid outcome. Otherwise the spec-mover is skipped, with
   the reason in the report. It never runs again in this stage, on any attempt or re-entry — its
   input is the decision record, which does not change.

   4a. **Spec-author, once.** After the first implementer commit and step 4 — run or skipped —
   when the record's `New specs` section is not `none`:
   - Take the record's digest again. A difference from §2's is
     `fence-violation: <the role spawned last> — run state changed — <record>`, handled per
     [fence.md](fence.md) §7: the declared paths the set is derived from must be the ones §2
     probed.
   - Write and self-test the fence for the `new-specs` role (§3).
   - Write the diff file:
     `git -C "<WT>" diff --no-renames "<INV_SHA>..HEAD" -- . ":(exclude)<inventory>" > "<state_dir>/runs/<run-id>/spec-author-diff.patch"`,
     then list the paths the same diff covers,
     `git -C "<WT>" diff -z --name-only --no-renames "<INV_SHA>..HEAD" -- . ":(exclude)<inventory>"`,
     read per [fence.md](fence.md) §7: a path starting with `<inventory>` aborts
     `stage 4: the spec-author diff carries inventory paths`. The check reads git's path list, not
     the patch text, so a hunk line that quotes a diff header cannot trip it.
   - Spawn one `deepen:spec-author`, fresh, in the foreground. Its brief inlines, as data, never
     as a link: `<WT>` as the project root; the declared `New specs` paths; the record's
     `Interface shape` and `Behind the seam` sections, verbatim; the diff file's absolute path —
     the path, never its text; the check command, as in the implementer's brief item 3; the
     exclusion list as never-stage; and as paths never to read: `<WT>/<inventory>`,
     `<state_dir>/inventory-drafts/`, `<state_dir>/reports/`, and everything under
     `<state_dir>/runs/` except the named diff file, with `!<inventory>**` on every `Grep` call.
   - Then, with `<prev>` the `HEAD` recorded before the spawn, the checks below, in order. The
     first that fails decides the outcome, and each names its own; the rest are not run. The
     committed paths are `git -C "<WT>" diff -z --name-only --no-renames "<prev>..HEAD"`, the
     added paths the same command with `--diff-filter=A`.
     1. §5's assertions for the `new-specs` role; a committed path outside the declared set; a
        declared path among the committed paths but not among the added paths — modified or
        deleted rather than added; or a declared path present at `<BASE_SHA>`
        (`git -C "<WT>" cat-file -e "<BASE_SHA>:<p>"` exits zero) →
        `fence-violation: spec-author — <assertion> — <paths>`, handled per
        [fence.md](fence.md) §7.
     2. More than one new commit (`git -C "<WT>" rev-list --count "<prev>..HEAD"` above `1`) →
        `fence-violation: spec-author — more than one commit — <shas>`, handled per
        [fence.md](fence.md) §7.
     3. The record's digest differs from §2's →
        `fence-violation: spec-author — run state changed — <record>`.
     4. No commit, or a declared path missing from the added paths → stop:
        `needs-decision: spec-author did not add <paths> — <its reported reason>`.

     All four passing means one commit whose paths and added paths each equal the declared set.

   Otherwise the spec-author is skipped, with the reason `New specs is none` in the report. It
   never runs again in this stage, on any attempt or re-entry — its input is the decision record,
   which does not change. A declared spec that is red after it runs is a gate failure (step 5),
   carried into the next attempt like any other.
5. **Gate.** Write `checks.runner` (with `app.prelude` when set) verbatim into
   `<state_dir>/runs/<run-id>/runner.sh` with `Write` and run
   `cd "<WT>" && bash "<state_dir>/runs/<run-id>/runner.sh"` (the profile's script-file rule,
   [profile.md](../../setup/references/profile.md) §3). Green → the stage is complete. Red → the
   next attempt, carrying the output tail.

**No runner.** `checks.runner` null → the stage makes exactly one attempt, and the report and the
evidence pack both carry `stage 4: gate skipped — no runner`.

**Re-entry.** The verify stage re-enters this section with `failing_check` (a send-back) or with
`findings` (its fix round): a fresh attempt budget, the shared clock, the spec-mover and the
spec-author not re-run.
§1 and §2 run again first.

---

## §5 Assertions after every agent return

After every return — implementer, spec-mover or spec-author, with a commit or without — run every
assertion in
[fence.md](fence.md) §7 for that role, with `<prev>` the `HEAD` recorded before the spawn. Any
failure is a violation, reported and handled exactly as fence.md §7 states: the run fails
through [worktree.md](worktree.md) §7, never retried and never softened into a warning.

---

## §6 Exhaustion

The attempt budget used up, or `run.max_wall_time` spent, without a green gate:

```
stage 4: exhausted — <n> attempts, <elapsed> — last failing check: <command>
```

The last output tail goes into `abort.md` as the deciding evidence, and the stage aborts through
[worktree.md](worktree.md) §7.

**A `findings` re-entry does not abort.** Its exhaustion writes, as the report's first line,

```
implement: fix round: exhausted — <n> attempts, <elapsed>
```

and returns to the verify stage without touching the worktree: the verify stage owns the reset
to its pre-round commit, and a failed fix round costs the findings, never the verified change.
With the wall time already spent before the first attempt, no attempt is made and every finding
is recorded `not applied — wall time spent`. Exhaustion stays an abort for a first pass and for
a `failing_check` re-entry.

---

## §7 Report

`<state_dir>/reports/<run-id>/4-implement.md`, standing alone for a reader who did not watch:

1. The first line — `implement: complete`, or `implement: aborted — <the line that aborted>`, or
   `implement: needs-decision — <the needs-decision line>`, or, after a `findings` re-entry only,
   `implement: fix round: exhausted — <n> attempts, <elapsed>` (§6).
2. Attempts used of the attempt budget; elapsed of `run.max_wall_time`.
3. Every commit — sha, role, paths.
4. Each implementer rename map, as declared.
5. The spec-mover outcome — skipped with its reason, applied, or entries it could not apply —
   and the spec-author outcome — skipped with its reason, or the paths it added and each new spec
   it reported still failing.
6. Writes the agents reported refused. A refusal is the fence working, recorded here, never a
   failure.
7. Degradations — `gate skipped — no runner`, `spec probes skipped — paths.specs is empty`, a
   skipped install.
8. Every self-test result, with its probe paths.
9. On a re-entry, the `failing_check` it started from, under its own heading; on a `findings`
   re-entry, a `## Fix round` heading with the findings it started from and each finding's latest
   outcome — `applied`, or `not applied — <reason>`. The earlier entries are kept.
