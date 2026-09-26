# Stage 2 — characterize

Authoritative text for the stage that turns the picked candidate into the run's oracle: it creates
the run worktree at `<BASE_SHA>`, starts the app on the untouched tree, has the fenced QA role
write the behavior inventory without ever seeing a plan, replays every check itself, measures how
much of the candidate's code the checks reach, and commits the inventory alone as the run branch's
first commit. The stage either completes, stops for a human decision before a server starts, or
aborts with evidence. A write outside the QA role's set fails the run and is never retried.

It composes these references and restates none of them: [worktree.md](worktree.md) owns creating
and binding the worktree, the exclusion list, the install and the abort;
[dev-server.md](dev-server.md) the wrapper scripts, the server's start, readiness, residue, seam
auth and stop; [inventory.md](inventory.md) the inventory's shape, layout and check round;
[coverage.md](coverage.md) the touched-function list, the measurement, the estimate and the
threshold; [fence.md](fence.md) the fence file, the `qa` set, the self-test and the violations;
and the run skill ([../SKILL.md](../SKILL.md)) the report grammar, the question and the common
abort.

---

## Inputs and output

Bound by the run skill before this stage starts:

| Input | Source |
| --- | --- |
| `<CLONE>`, `<BASE_SHA>`, `<state_dir>`, the profile as re-read | [preflight.md](preflight.md) §1–§4 |
| `<run-id>`, `<slug>`, `<plugin-root>`, `candidate_id` | the run state, `<state_dir>/runs/<run-id>/run-state` |
| the `## Pick` block | `<state_dir>/reports/<run-id>/1-discover.md` ([candidates.md](candidates.md) §5) |
| `CONTEXT.md` | `<WT>` at `<BASE_SHA>` |

Nothing else is read: no stage after this one has run, and none of their output may reach the QA
role.

Output: the worktree `<WT>` on `<branch>` ([worktree.md](worktree.md) §1); one inventory commit on
it; drafts, `characterize.md`, `touched-functions.tsv`, `estimate.md` and screenshots under
`<run_dir>` = `<state_dir>/inventory-drafts/<run-id>`; working files under `<runs>` =
`<state_dir>/runs/<run-id>`; the report `<state_dir>/reports/<run-id>/2-characterize.md` (§9).

Every path set is read NUL-delimited ([fence.md](fence.md) §7) and every command is path-bound
([worktree.md](worktree.md) §6). **Every exit path — complete, needs-decision, abort — first stops a
running server** per [dev-server.md](dev-server.md) §7.

---

## §0 Re-entry

Read the report, when it exists, before anything else:

- **No report** → a fresh stage: §1.
- **Status `complete` or `aborted`** → return without touching anything.
- **Status `needs-decision`** → take the last `decision:` line under `## Decisions`. `retry` → bind
  the worktree per [worktree.md](worktree.md) §3 (which re-reads the exclusion list), run §2 again,
  restore the loop state from the report's `resume:` line, and resume at the section it names.
  Any other text → write the same question again with the same options. `abort` is the run
  skill's.

The `resume:` line carries everything the stage's loop needs to continue where it stopped rather
than as a fresh first pass:

```
resume: <§3|§6> pass=<first|repair|extension> repair=<used|unused> extension=<used|unused> k=<k> r=<r>
```

`pass` is the pass in progress, `repair` and `extension` whether the stage's single repair pass and
single extension pass were already spent, and `k` and `r` the spawn and round numbers in use when
it stopped — the retried start reuses them, each a positive integer. The stage writes this line
itself, so one that does not match the shape exactly aborts `characterize: aborted — unreadable
resume line`.

A re-entry never creates the worktree again. The rewritten report keeps the earlier `## Decisions`
lines.

---

## §1 Worktree

1. `jq` is on `PATH` — else abort `characterize: jq not found — the fence refuses every write
   without it`.
2. [worktree.md](worktree.md) §1 names and checks, then §2: create `<WT>` on `<branch>` at
   `<BASE_SHA>`, then its §4 copy and exclusion list and its §5 install.

From here on every abort goes through [worktree.md](worktree.md) §7 by way of the run skill's
common abort.

---

## §2 Preparation

1. **`<now>` and `<now-source>`** ([inventory.md](inventory.md) §6) — the profile's `app.now`,
   when set, converted to UTC with a `Z` suffix, and `<now-source>` = `profile`; else
   `git -C "<WT>" show -s --format=%cI "<BASE_SHA>"`, converted the same way, and `<now-source>` =
   `base-commit`. The profile and `<BASE_SHA>` are fixed within a run, so a §0 retry computes the
   same pair.
2. **The pick.** From the `## Pick` block, only `id`, `name`, `files` and `structural_key` travel
   to the QA role. `next_change`, `category`, `est_diff_lines` and `adr_conflict` describe the
   intended change and stay out of every brief. Write `files` one per line to `<runs>/touched-files`.
   A file absent at `<BASE_SHA>` is a report line; its functions cannot be listed.
3. **Glossary.** `<WT>/CONTEXT.md` when present, verbatim. Absent → capability row 11's line and
   the matrix is `derived`.
4. **Degradations.** For every capability the profile does not supply, its `effect if missing`
   line, verbatim from [profile.md](../../setup/references/profile.md) §6 — rows 3 (on the first
   ready wait), 4, 5, 6, 7, 8, 9 and 11, row 13 when `<runs>/worktreeinclude-skipped`
   ([worktree.md](worktree.md) §4) is non-empty, and row 14 when `checks.e2e` is null, browser
   tools are available and `app.browser_session` is null or absent — and the run-only
   `browser tools absent` line when `checks.e2e` is null and neither the Playwright nor the Chrome
   DevTools browser tools are available in this session. `checks.runner` null with a seam →
   `tier 2 skipped — checks.runner is null`. The run-only `browser session tool absent` line when
   `checks.e2e` is null, `app.browser_session` is a command and
   `mcp__playwright__browser_set_storage_state` is not available in this session.

   **Browser session wanted** holds when `checks.e2e` is null, `app.browser_session` is a command
   and `mcp__playwright__browser_set_storage_state` is available — bound once here, and read by §3
   and §4 step 3. Row 14's line for a round whose command fails is added by
   [dev-server.md](dev-server.md) §6.
5. **Something must be checkable.** No seam with a runner, no `checks.e2e`, and no browser tools →
   abort `characterize: aborted — no check can run: no seam, no e2e runner, no browser tools`.
6. **Scripts.** Write the wrappers and record their digests per [dev-server.md](dev-server.md) §1.
   Create `<run_dir>/screenshots/` and `<runs>/coverage/`.

---

## §3 Server for the QA role

[dev-server.md](dev-server.md) §2–§6 with round `agent-<k>` (`k` counting spawns from 1), with the
browser session when browser session wanted (§2 step 4), and no coverage env. A measurement round
(§6) never asks for the browser session, so login traffic never enters the measurement.

- A port-busy or not-ready stop writes the report with `characterize: needs-decision — <the
  line>`, the `## Options` of [dev-server.md](dev-server.md) §2 or §4, and the §0 `resume:` line
  naming `§3`.
- Seam auth that drops every seam re-applies §2 step 5 before the spawn.

---

## §4 Fence and brief

1. **Fence** — [fence.md](fence.md) §5 steps 1–4 with the `qa` set in characterize form
   (`<inventory><slug>/**` and `<run_dir>/**`), then its §6 probes for a characterize-mode QA spawn. A
   failed self-test aborts.
2. **Script digests** — hash the wrappers and the exclusion list, check the browser session
   path's type, and keep the result in context ([dev-server.md](dev-server.md) §1, Digests).
3. **Brief** — written with `Write` to `<runs>/qa-brief-<k>.md`, assembled from this list and
   nothing else:
   - `mode: characterize` and the pass — `first`, `repair` or `extension`;
   - `<WT>` as the project root, and that every command runs there;
   - the four pick fields (§2 step 2);
   - the glossary, or `none — derive the terms from route and schema names and mark the matrix
     derived`;
   - the profile's `app`, `seams`, `checks` and `paths` blocks as data, each seam's `auth` replaced
     by `<seam n: credential supplied by check.sh>` and `app.browser_session`, when a command, by
     `<browser session: written by browser-session.sh>`;
   - when `checks.e2e` is null, the browser session, in one of two forms:
     - `browser session: <runs>/browser-session.json` when [dev-server.md](dev-server.md) §6 left
       it live this round — load it with the browser storage-state tool by that path and never
       read it otherwise; once after a fixture's reset and seed, before the browser next loads the
       app, refresh it with
       `cd "<WT>" && bash "<runs>/browser-session.sh" "<runs>/browser-session.json"`, then load it
       again;
     - `browser session: none — <reason>`, the reason one of `not in the profile`,
       `the app needs no sign-in`, `the command failed this round` or
       `the storage-state tool is unavailable`;
   - `now: <now>` and `now-source: <now-source>`, the inventory's header lines as written;
   - each wrapper that exists, as an absolute path, how it is invoked
     (`cd "<WT>" && DEEPEN_CHECK_LOG=<file> bash <wrapper> <files>`), `app.url`, and the
     environment names of [inventory.md](inventory.md) §3;
   - the inventory directory `<WT>/<inventory><slug>/`, `<run_dir>`, and the `qa` set exactly as
     written into the fence file;
   - every `paths.specs` glob, as names no inventory file — check or helper — may match;
   - the exclusion list, as never-stage;
   - [inventory.md](inventory.md) §1–§6, verbatim;
   - [coverage.md](coverage.md) §1's row format for `<run_dir>/touched-functions.tsv`, and §3's
     trace format for `<run_dir>/estimate.md` — asked for on every pass, so an estimate is on disk
     whichever coverage path §7 takes;
   - the tier-1 form: `e2e` when `checks.e2e` is set, else `manual-browser`;
   - for a repair pass, the red check ids and each group's output tail from the round's `.out`
     files; for an extension pass, the uncovered functions as `<file>:<line> <name>`;
   - the reply and `<run_dir>/characterize.md` contract of the QA role's Outputs.
4. **Brief assertion** — `grep -F` over the brief file for each of `diff --git`, `@@ -`,
   `decision-record.md`, `3-decide.md`, `4-implement.md`, `5-verify.md`. Any hit aborts
   `characterize: aborted — the QA brief carries <match>`: the oracle's author must not know the
   change.

---

## §5 Spawn and assertions

Record `<prev>` = `git -C "<WT>" rev-parse HEAD`. Spawn one `deepen:qa-characterizer`, fresh, in
the foreground, whose prompt is the brief file's content.

After it returns:

1. [fence.md](fence.md) §7's characterize clause, with `<prev>` and the digests of §4 step 2.
2. **Inventory file names and layout.** Every path under `<WT>/<inventory><slug>/`, listed
   NUL-delimited with `find … -print0`, matches the `paths.inventory` class
   ([profile.md](../../setup/references/profile.md) §3: characters `[A-Za-z0-9._/-]`, no `..`
   segment) — these names are written into the check round's command lines, so a name outside the
   class is `fence-violation: qa-characterizer — inventory file name — <path>`. The seam helper
   under `tier2/lib/` is one of these paths.

   Over the same listing, every entry under `<WT>/<inventory><slug>/tier2/` that is not a
   directory (`! -type d`, so a symlink is tested like a file) takes one of two shapes, by its
   path relative to `tier2/` ([inventory.md](inventory.md) §6). Only a file ending `.pyc` whose
   parent directory is named `__pycache__` is set aside — the interpreter's bytecode cache,
   written when a check or the helper is imported, and removed before the commit (§8 step 1).
   - **a check** — its first segment matches `^F[0-9]{2,3}$` and its file name contains `check` in
     any letter case;
   - **the helper** — exactly `lib/<name>`, one segment under `lib/`, a file name containing no
     `check` in any letter case, and the only file under `tier2/lib/`.

   Any other entry — one directly under `tier2/`, a fixture-folder file whose name lacks `check`
   (a package marker, a hidden file), a non-`.pyc` file under a `__pycache__/` directory, a
   helper whose name carries `check`, or every `lib/` file after the first in the listing — is
   `fence-violation: qa-characterizer — inventory layout — <path>`. The test reads the path set
   only and never opens a file. A slug folder with no `tier2/` has nothing to test and passes; a
   path failing both tests reports the file-name line first.
3. **Inventory header.** `Read` `<WT>/<inventory><slug>/inventory.md` with `limit: 4` — the
   header lines [inventory.md](inventory.md) §6 fixes, never the whole oracle: its `now:` and
   `now-source:` lines equal `<now>` and `<now-source>`
   — else abort `characterize: aborted — inventory header now: <value> disagrees with the run's
   <now> (<now-source>)`, `<value>` being `missing` when the line or the file is absent. Every
   later replay takes the run's instant from this header, so a header written wrong would move
   every one of them.
4. Stop the server ([dev-server.md](dev-server.md) §7).

Any violation aborts, never retried. Then read `<run_dir>/characterize.md`. Zero statements →
abort `characterize: aborted — inventory: empty — <the QA role's reason>`.

---

## §6 Measurement round

**UI fixtures** — `app.seed` or `app.reset` null ([inventory.md](inventory.md) §5): this stage
makes no fixture-recreating spawn, so no group can be replayed and no measurement round runs. Every
check is recorded `qa-session` — green in the QA role's session, where a check it could not make
green is deleted — with the report line `checks not replayed by the run — UI fixtures (<fixture
count>)`, and §7 takes the estimate path. The rest of this section applies to seeded fixtures.

Round `m<r>`, `r` counting from 1:

1. [dev-server.md](dev-server.md) §2–§6 with the coverage env when `app.coverage_env` is set. A
   port-busy or not-ready stop is a needs-decision as in §3, its `resume:` line naming `§6`.
2. The check round, [inventory.md](inventory.md) §7.
3. Every `manual-browser` statement has both screenshots under `<run_dir>/screenshots/` — a
   missing one makes the statement red.
4. Red groups run once more on the same server; a group green on the rerun is recorded as flaky in
   the report.
5. Stop the server ([dev-server.md](dev-server.md) §7), then read its residue again
   ([dev-server.md](dev-server.md) §5).

Still red → one **repair pass**: §3, §4 and §5 with the repair brief, then this section again.
Red after the repair pass → abort `characterize: aborted — checks red on the untouched tree —
<check ids>`.

---

## §7 Coverage

1. Validate the touched-function list ([coverage.md](coverage.md) §1).
2. The measured path ([coverage.md](coverage.md) §2) when `app.coverage_env` is set, a
   measurement round ran, and its coverage directory is non-empty; otherwise, or on a non-zero
   exit, the estimate path ([coverage.md](coverage.md) §3) from `<run_dir>/estimate.md`.
3. The threshold ([coverage.md](coverage.md) §4). Below it, the first time → one **extension
   pass**: §3, §4 and §5 with the extension brief, then §6 and this section again. Below it after
   the extension → the gap line, and the stage continues.

---

## §8 Commit

1. **Bytecode cache out.** Remove every `__pycache__/` directory under the slug folder —
   `find "<WT>/<inventory><slug>" -type d -name __pycache__ -prune -exec rm -rf -- {} +` — so the
   cache the check rounds wrote never reaches the staged set, whatever the project ignores.
   Then pipe every file under `<WT>/<inventory><slug>/`, the seam helper under `tier2/lib/`
   included, through `"<plugin-root>/hooks/fence.sh"` as a `Write` payload with
   `agent_type: "deepen:spec-mover"`, after writing the fence file ([fence.md](fence.md) §5
   step 1). No spec glob may reach the inventory: any file allowed → abort
   `characterize: inventory files match paths.specs — <paths> — narrow paths.specs so no glob
   reaches <inventory> (run /deepen:setup)`.
2. **Stage.** `git -C "<WT>" add -A -- "<inventory><slug>/"`, then unstage every exclusion-list
   path ([worktree.md](worktree.md) §4). The staged set,
   `git -C "<WT>" diff --cached -z --name-only --no-renames`, is non-empty and lies wholly under
   `<inventory><slug>/`, the seam helper included — else abort naming the paths.
3. **Commit**, with no repository hook:

   ```bash
   git -C "<WT>" -c core.hooksPath=/dev/null commit -q --no-verify -m "deepen: behavior inventory — <candidate-id> <name>"
   ```

   Hooks are off because a hook the QA role planted in the common directory, which no status check
   sees, would otherwise run with the stage's authority, and a project hook (a formatter, a staged-file linter) could rewrite or refuse the
   inventory files after the staged set was asserted.
4. **Assert:**
   - the first line of `git -C "<WT>" rev-list --reverse "<BASE_SHA>..HEAD"` is `HEAD` — the
     inventory commit is the branch's first, and alone; `<INV_SHA>` is derived from the branch
     from here on, never stored;
   - every path of `git -C "<WT>" diff-tree -z --no-commit-id --name-only --no-renames -r HEAD`
     lies under `<inventory><slug>/` — the seam helper committed there with the checks — and
     none is on the exclusion list;
   - `git -C "<WT>" status --porcelain -z --no-renames --untracked-files=all` is empty, exclusion-list paths aside;
   - the committed inventory header still carries the run's instant — §5 step 3's check again,
     on the committed file: the measurement round's check code ran in `<WT>` after it;
   - `git -C "<CLONE>" rev-parse "refs/heads/<base>"` still equals `<BASE_SHA>` — nothing was
     committed to the loop clone's `base`.

   Any failure aborts naming the assertion and the paths.

The fence file is left as it is: the next fenced spawn rewrites it, and the abort and teardown
clear it.

---

## §9 Report

`<state_dir>/reports/<run-id>/2-characterize.md`, standing alone for a reader who did not watch:

1. The status line — `characterize: complete`, `characterize: aborted — <the line>`, or
   `characterize: needs-decision — <the line>` with `## Options` and the §0 `resume:` line.
2. Directly under it, the coverage gap line when §7 left one.
3. `## Degradations` — every line §2 step 4 and the dev-server procedure produced (readiness,
   `seam-auth-failed`, residue, coverage lost), §6's UI-fixture line, plus a skipped install and
   every `worktreeinclude: skipped` line ([worktree.md](worktree.md) §4).
4. `## Inventory summary` — what the decide stage reads, and the only part it reads: the statement
   lines verbatim, the fixture matrix with the fixture count and how each was created, the
   coverage line or lines, the uncovered list, the unverifiable list. No check code and no check
   paths, and plain lines only — no fenced block: the decide stage aborts on one
   ([stage-3-decide.md](stage-3-decide.md) §2).
5. `## Checks` — per check id: tier, fixture group, and its result in each round; flaky groups;
   `tier 2 wall time: <s>s`, and the over-two-minutes line when it applies.
6. `## Coverage` — the method, the numbers, the reason on an estimate, the browser sub-line, the
   touched-list rows dropped.
7. `## Commit` — `<INV_SHA>` and its path count.
8. `## Self-tests` — every fence probe with its path and result.
9. `## Exclusions` — the exclusion list with each path's remedy.
10. `## Refused writes` — as the QA role reported them; a refusal is the fence working.
11. `## Looked wrong` — from `characterize.md`, verbatim.
12. `## Decisions` — the run skill's.

The first `reset.sh` of the stage also writes the line `app.reset run — <the command>`, so a reset
aimed at the wrong data store is visible.
