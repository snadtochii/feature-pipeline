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
| the decision record — `<state_dir>/reports/<run-id>/` | the decide stage |
| `failing_check` — optional: a check command and its output tail | the verify stage's fix round |

From the decision record this stage reads: the declared interface change, the predicted behavior
changes, the declared rename map (`modules:` / `symbols:`), the declared spec delete list, and
the proposed `CONTEXT.md` and ADR diffs.

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
4. The tree is clean — `git -C "<WT>" status --porcelain -z --no-renames` empty, exclusion-list
   paths aside.

Every path set in this stage is read NUL-delimited, per [fence.md](fence.md) §7.

`<INV_SHA>` is derived from the branch every time, never stored.

---

## §2 Pre-spawn target check

Before the first spawn, catch every planned write the fence would refuse, so a decision record
that cannot be implemented as approved stops here rather than burning attempts.

Write the fence file per [fence.md](fence.md) §5 step 1, then probe with the hook: pipe a payload
in [fence.md](fence.md) §6's shape to `"<plugin-root>/hooks/fence.sh"` for

- each target of the record's `CONTEXT.md` and ADR diffs, with `agent_type: "deepen:implementer"`;
- each destination of the rename map's spec moves, and each path on the spec delete list, with
  `agent_type: "deepen:spec-mover"`.

Any denial stops the run for a human:

```
needs-decision: <target> is <fenced for the implementer | outside paths.specs> — <the glob class that decides it>
```

The hook is the matcher here as everywhere, so the check and the fence can never disagree.

---

## §3 Fence

Before **every** fenced spawn in this stage — each implementer attempt and the spec-mover — write
the fence file and self-test it, in the spawn's own mode, per [fence.md](fence.md) §5 and §6. A
failed self-test aborts before the spawn.

---

## §4 Attempt loop

**Clock.** Record the start epoch (`date +%s`) in `<state_dir>/runs/<run-id>/stage4-started`
only when the file is absent. A resumed run, and a re-entry from the verify stage, keep the
recorded start: the wall clock is shared. `run.max_wall_time` converts to seconds (`m` × 60,
`h` × 3600).

**Before each implementer spawn**, stop when either bound is spent — attempts made equals
`run.retries`, or now minus the recorded start is at least `run.max_wall_time` — and go to §6.
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
   path or name.
4. The `implementer` set, exactly as written into the fence file for this spawn
   ([fence.md](fence.md) §3, §5), as never-write.
5. The exclusion list as never-stage.
6. The `rename_map:` reply contract, and that an absent block fails the attempt.
7. `attempt <n> of <run.retries>`.
8. On attempt 2 onward, the last 200 lines of the previous attempt's failure; on a re-entry's
   first attempt, `failing_check`'s command and output tail.

**After it returns:**

1. Run §5's assertions for the `implementer` role. Any failure → violation.
2. No new commit → a failed attempt, re-injected as `no commit`.
3. Parse the `rename_map:` block. Absent or malformed → a failed attempt, re-injected with what
   was wrong. An entry the decision record does not declare — identity entries aside → stop:
   `needs-decision: implementer declared <entry>, which the decision record does not`. The
   spec-mover applies only declared entries, so an undeclared rename would leave the specs
   pointing at the old name.
4. **Spec-mover, once.** After the first implementer commit, when the record's rename map or
   spec delete list is non-empty and `paths.specs` is non-empty: write and self-test the fence for
   the `specs` role (§3), then spawn one `deepen:spec-mover`, fresh, in the foreground. Its brief
   inlines `<WT>`, the declared rename map, the declared spec delete list, every `paths.specs`
   glob, the check command and the exclusion list. Then §5's assertions for the `specs` role,
   plus: every path deleted in its commit
   (`git -C "<WT>" diff -z --name-only --no-renames --diff-filter=D "<prev>..HEAD"`) is on the
   declared delete list. No commit is a valid outcome. Otherwise the spec-mover is skipped, with
   the reason in the report. It never runs again in this stage, on any attempt or re-entry — its
   input is the decision record, which does not change.
5. **Gate.** Write `checks.runner` (with `app.prelude` when set) verbatim into
   `<state_dir>/runs/<run-id>/runner.sh` with `Write` and run
   `cd "<WT>" && bash "<state_dir>/runs/<run-id>/runner.sh"` (the profile's script-file rule,
   [profile.md](../../setup/references/profile.md) §3). Green → the stage is complete. Red → the
   next attempt, carrying the output tail.

**No runner.** `checks.runner` null → the stage makes exactly one attempt, and the report and the
evidence pack both carry `stage 4: gate skipped — no runner`.

**Re-entry.** The verify stage's fix round re-enters this section with `failing_check`: a fresh
`run.retries` budget, the shared clock, the spec-mover not re-run. §1 and §2 run again first.

---

## §5 Assertions after every agent return

After every return — implementer or spec-mover, with a commit or without — run every assertion in
[fence.md](fence.md) §7 for that role, with `<prev>` the `HEAD` recorded before the spawn. Any
failure is a violation, reported and handled exactly as fence.md §7 states: the run fails
through [worktree.md](worktree.md) §7, never retried and never softened into a warning.

---

## §6 Exhaustion

`run.retries` attempts made, or `run.max_wall_time` spent, without a green gate:

```
stage 4: exhausted — <n> attempts, <elapsed> — last failing check: <command>
```

The last output tail goes into `abort.md` as the deciding evidence, and the stage aborts through
[worktree.md](worktree.md) §7.

---

## §7 Report

`<state_dir>/reports/<run-id>/4-implement.md`, standing alone for a reader who did not watch:

1. The first line — `implement: complete`, or `implement: aborted — <the line that aborted>`, or
   `implement: needs-decision — <the needs-decision line>`.
2. Attempts used of `run.retries`; elapsed of `run.max_wall_time`.
3. Every commit — sha, role, paths.
4. Each implementer rename map, as declared.
5. The spec-mover outcome — skipped with its reason, applied, or entries it could not apply.
6. Writes the agents reported refused. A refusal is the fence working, recorded here, never a
   failure.
7. Degradations — `gate skipped — no runner`, `spec probes skipped — paths.specs is empty`, a
   skipped install.
8. Every self-test result, with its probe paths.
9. On a re-entry, the `failing_check` it started from, under its own heading; the earlier entries
   are kept.
