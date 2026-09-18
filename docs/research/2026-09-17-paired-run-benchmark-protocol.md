# Paired-run benchmark protocol and recorded baseline

Research date: 2026-09-17. Scope: the method by which epic FP-92's finalizer change is measured, and the recorded "before" arm of that measurement. The method is a **paired run on one real ticket** — personal-server `PS-153` ("Cmd/Ctrl+Enter submits forms and form dialogs in the web UI", complexity L), built once with the current plugin and once with the finalizer, from the same commit, spec and plan. Arm 1 is recorded here; arm 2 and the comparison belong to FP-95. Sources are the two `--json` reports named in §4, the plugin files on disk, and the `~/Projects/personal-server` working copy, which is read-only for this document. Claims marked `unverified` or *inference* are reasoning from the cited sources, not measured facts.

Repo paths below are relative to this repo's root; `build/SKILL.md` means `plugins/feature/skills/build/SKILL.md`. Paths in the consuming project are named explicitly as such.

## 1. Method and arms

### 1.1 Why a paired run on one ticket

The quantity under test is the post-gate phase's share of a build's re-read cost (§3.1). That share is a ratio whose denominator is the whole build, so it moves with the ticket: a long implement phase shrinks the tail's share without the tail getting cheaper. The only way to read the finalizer's effect off a single pair is to hold the ticket, its spec, its plan, its base commit, the model and the flag set fixed across both arms and change exactly one thing — the plugin version. One of the two resulting PRs is merged and the other discarded, so the measurement costs one extra build of one ticket.

One run per arm gives no spread (§3.3). The three builds of the FP-84 ship session serve as a second, free baseline and as a consistency check on arm 1 — see §4. Their tracked source is [`scripts/measure-session.expected.json`](../../scripts/measure-session.expected.json) (`builds[0..2]`), whose figures are also carried in the script's own anchor block ([`scripts/measure-session.py:96-105`](../../scripts/measure-session.py)); a local working file, `2026-09-16-build-review-checkpoint-context.md`, discusses the same session but is untracked and is deliberately not linked from here.

### 1.2 The fixed input

| Item | Value |
|---|---|
| Consuming project | `~/Projects/personal-server` |
| Ticket | `PS-153`, complexity L |
| Base commit | tag `bench/ps-153-base` |
| Snapshot | `claudedocs/bench/ps-153/` in that project — `ticket/{01-spec.md,02-plan.md,exploration.md}`, `_lessons.md` as it stood before arm 1, and `before/` holding arm 1's preserved transcript |
| Model | `claude-opus-5`, both arms |
| Permission mode | `auto`, both arms |
| Command line | `/feature:build PS-153 --pr --no-ui-testing`, standalone in a fresh session, both arms |
| Ticket state at invocation | `claudedocs/tickets/in-progress/PS-153/`, both arms |

The snapshot directory is gitignored in the consuming project and is never pushed. It is an input to this protocol, not a deliverable of it.

`in-progress/` is where a planned ticket sits when build is invoked, and it is where arm 1 started. Build's start-of-pipeline transition is idempotent from there, whereas a ticket seeded into `backlog/` would make build perform a folder move at the head of the run — a difference in the first turns of the window being measured.

The permission mode is pinned because its harness instruction shapes which tools a build uses — under `auto`, reads and edits go through Bash ([`2026-09-18-build-turn-anatomy.md`](2026-09-18-build-turn-anatomy.md) §2.6) — so a mode difference between the arms changes the call shape being measured.

### 1.3 Arm 1 — "before" (recorded)

- **Plugin**: `feature` 3.6.1, marketplace-installed.
- **Location**: the main checkout of the consuming project, at the commit tagged `bench/ps-153-base`.
- **Outcome**: verdict `pass`, PR opened, ticket reached `review/`. Figures and parity in §4.
- **Transcript**: preserved at `claudedocs/bench/ps-153/before/` in that project (root `.jsonl` plus its `subagents/` directory). The committed report derived from it is [`2026-09-17-paired-run-benchmark-evidence/before-feature-3.6.1-opus-5.json`](2026-09-17-paired-run-benchmark-evidence/before-feature-3.6.1-opus-5.json).

### 1.4 Arm 2 — "after" (FP-95)

- **Plugin**: the finalizer version, obtained by **marketplace update**, so both arms are invoked through the identical resolution path. Do not reach for `--plugin-dir`: it collides with the same-named marketplace plugin and needs a `--settings` override that disables it, which changes the session's settings and plugin-resolution path relative to arm 1 — a second changed variable in a design whose whole constraint is one variable.
- **Location**: a **manually created worktree** cut from the base tag:

  ```
  git -C <consuming-project> worktree add <wt-path> -b <distinct-branch> bench/ps-153-base
  ```

  A distinct branch name is required for the worktree itself. **It is not the branch the PR is opened from**: on every `--pr` run build works its own branch-decision matrix at the verdict gate and creates the convention branch `<type>/<TICKET-ID>-<slug>` ([`build/references/pr-creation.md:31-40`](../../plugins/feature/skills/build/references/pr-creation.md)). The matrix's worktree guard row fires only for a worktree **provisioned by the plugin** (`--worktree` or `ship --parallel`), which a hand-made worktree is not — so arm 2 falls through to the ordinary rows. §1.6 is the pre-flight that makes those rows safe, and it must be completed before the session starts.
- **Dependencies**: installed **before the session starts**, by running the project's declared `worktree.setup` inside the worktree — `pnpm install --frozen-lockfile`, from that project's `claudedocs/tickets/config.yaml`. Installing from inside the measured session would put an unrelated several-minute command inside the window being measured.
- **Seeding**: §2, exhaustively, before the session starts.

### 1.5 build's `--worktree` flag is not used

Arm 2 runs in a worktree, but the worktree is created by hand and build is invoked **without** `--worktree`. The flag is excluded, not merely discouraged, for two reasons that each change what is measured:

- Under the flag, build rebinds `<ticket-folder>` to an absolute path into the *main* checkout ([`build/SKILL.md:98`](../../plugins/feature/skills/build/SKILL.md)) and keeps that binding across every later transition. Arm 2 would therefore read the **main checkout's** ticket folder — which still holds arm 1's `03-`–`06-` artifacts — instead of the seeded copies in the worktree, and the resumption router would exit "build already complete" ([`build/SKILL.md:411`](../../plugins/feature/skills/build/SKILL.md)) rather than build anything.
- The flag writes a `## Worktree` record into `03-implementation.md` ([`build/SKILL.md:122`](../../plugins/feature/skills/build/SKILL.md)), and that record is re-bound **unconditionally on any later run, flag or no flag** ([`build/SKILL.md:114-116`](../../plugins/feature/skills/build/SKILL.md)). A surviving record is therefore a live input to a later run, which is exactly the contamination §2.2 exists to prevent.

The cost of excluding it is a longer manual checklist (§2) plus the branch pre-flight in §1.6. `--pr` and `--no-ui-testing` compose freely with each other and with the rest of build's flags; `--pr` and `--no-commit` are the only contradictory pair ([`build/SKILL.md:88,90`](../../plugins/feature/skills/build/SKILL.md)).

### 1.6 Branch pre-flight for arm 2 — required, before the session starts

Because the worktree is hand-made, build's branch-decision matrix treats arm 2 as an ordinary checkout ([`build/references/pr-creation.md:31-40`](../../plugins/feature/skills/build/references/pr-creation.md)). Two of its rows would otherwise break or stall an **unattended** `--pr` run, and both stall inside the window being measured. Clear both before starting the session:

1. **Free the convention branch name.** Build derives `<type>/PS-153-<slug>` from the same `01-spec.md` and `02-plan.md` in both arms, so it derives the *same* name arm 1 already created — and `git checkout -b` on an existing branch fails. Rename arm 1's local branch out of the way (`git -C <consuming-project> branch -m <arm-1-branch> <arm-1-branch>-arm1`); arm 1's PR lives on `origin` and is unaffected. Verify with `git -C <consuming-project> branch --list '<type>/PS-153-*'` returning nothing.
2. **Park the main checkout off the base branch.** Arm 2's worktree branch has no commits ahead of base, so the matrix takes the "no commits ahead" row, which runs `git stash -u` → `git checkout <base>` **inside the worktree**. Git refuses to check out a branch that is already checked out in another worktree, so this fails whenever the main checkout is sitting on `<base>`. Move the main checkout to any other branch first, and verify with `git -C <consuming-project> rev-parse --abbrev-ref HEAD` returning something other than `<base>`.

Both are operator obligations with no in-session remedy: an unattended run has nobody to answer the matrix's pause prompts, and a failed checkout aborts the PR step after the work is done.

Recheck both immediately before the session and record the two verification outputs beside the run, because a pre-flight that silently stopped being true is indistinguishable afterwards from a protocol that never needed it.

## 2. Seeding arm 2

### 2.1 What is seeded — exhaustive

"Seed the ticket" read loosely is the instruction that voids the comparison, so this list is exhaustive rather than illustrative. Into the fresh worktree, before the session starts.

From the snapshot:

| Source | Destination |
|---|---|
| `claudedocs/bench/ps-153/ticket/01-spec.md` | `<wt-path>/claudedocs/tickets/in-progress/PS-153/01-spec.md` |
| `claudedocs/bench/ps-153/ticket/02-plan.md` | `<wt-path>/claudedocs/tickets/in-progress/PS-153/02-plan.md` |
| `claudedocs/bench/ps-153/ticket/exploration.md` | `<wt-path>/claudedocs/tickets/in-progress/PS-153/exploration.md` |
| `claudedocs/bench/ps-153/_lessons.md` | `<wt-path>/claudedocs/tickets/_lessons.md` |

Plus every path the project's committed `.worktreeinclude` lists, copied from the main checkout preserving relative paths, per the worktree contract's copy-then-setup split ([`plugins/feature/docs/advanced.md:216-222`](../../plugins/feature/docs/advanced.md)). That file is two lines, and both are copied:

| Source (main checkout) | Destination |
|---|---|
| the repo-root environment file | the same relative path under `<wt-path>` |
| `claudedocs/tickets/config.yaml` | `<wt-path>/claudedocs/tickets/config.yaml` |

Plus one path that is neither in the snapshot nor in `.worktreeinclude`, and is copied for the reason in §3.3's fifth asymmetry:

| Source (main checkout) | Destination |
|---|---|
| `.claude/settings.local.json` | `<wt-path>/.claude/settings.local.json` |

It is not committed, so the worktree does not inherit it, and it carries the permission allow-rules. Without it, a `git push` or `gh pr create` that ran silently in arm 1 becomes a permission prompt in arm 2 — which an unattended `--pr` run has nobody to answer, and which stalls inside the measured window.

The environment file appears here only as a path in a checklist. Its contents are never reproduced in this document, in the committed reports, or in the ticket artifacts.

`claudedocs/` is gitignored in the consuming project, which is why the ticket folder and `_lessons.md` are not covered by `.worktreeinclude` and must be copied by hand: `.worktreeinclude` lists only the two paths above.

### 2.2 What is not seeded, and why

- **No `03-`, `04-`, `05-` or `06-` artifact.** Build's resumption router keys on exactly these: a surviving `06-summary.md` with verdict `pass` exits as "already complete", a surviving `04-review.md` re-enters at the review or test checkpoint, a partial `03-implementation.md` continues from the next un-implemented plan step ([`build/SKILL.md:406-416`](../../plugins/feature/skills/build/SKILL.md)). Any of them turns arm 2 into a resumed run rather than a build.
- **`03-implementation.md` in particular**, for the second reason in §1.5: a `## Worktree` record inside it is re-bound on a later run even without the flag ([`build/SKILL.md:114-116`](../../plugins/feature/skills/build/SKILL.md)), so a copied one would point arm 2 at arm 1's tree.
- **No PR link, and no reference to arm 1's branch or PR.** The second run must not see the first.
- **`_lessons.md` is restored from the snapshot, not carried over.** Arm 1 wrote a lesson at its verdict gate; leaving that in place changes arm 2's input.

### 2.3 Seeding gate — `git check-ignore`, stop-the-run

After copying and before the session starts, run, for every path copied in §2.1:

```
git -C <wt-path> check-ignore -q <path> || echo "NOT IGNORED: <path>"
```

Any path that is **not** ignored stops the run. Fix the cause and re-cut the worktree; do not proceed and do not delete the file mid-session.

The reason: a worktree cut from a **tag** evaluates `.gitignore` from that commit's committed copy, not from the main checkout's working tree, so a `.worktreeinclude`-copied file that is safely ignored in the main checkout can arrive unignored in the worktree. Arm 2 runs `--pr` unattended, and that path stages with `git add -A`, commits, pushes and opens a PR with no human in the loop — an unignored environment file would reach a pushed branch.

### 2.4 Preserving the transcript

A Claude Code session transcript lives at `~/.claude/projects/<cwd-slug>/<session-id>.jsonl`, with its child agents at `~/.claude/projects/<cwd-slug>/<session-id>/subagents/*.jsonl` and `*.meta.json`. Both the root file **and** the subagent directory must be copied out after the session and before the project's transcripts rotate. This is an **operator obligation, not something the script enforces**: the subagent directory is read under an `if sub_dir.is_dir()` guard ([`scripts/measure-session.py:505-513`](../../scripts/measure-session.py)), so a root `.jsonl` copied without it produces a valid report of the root agent alone — the reviewer roles vanish from `roles[]` and `reread_self_children` collapses onto `reread_self`, silently and with no error. Only an **unpaired** `.jsonl`/`.meta.json` *inside* an existing directory is a hard error ([`scripts/measure-session.py:435-450`](../../scripts/measure-session.py)). Verify the directory by hand: its file count should be even, and half of it should equal the number of subagents the run spawned.

They are preserved **outside this repository**, under `claudedocs/bench/ps-153/<arm>/` in the consuming project — `before/` for arm 1, a matching directory for arm 2. Transcripts are private and are never committed. Only the script's `--json` report is committed, and only after the string-by-string audit described in §4.1.

## 3. What is compared, and what voids the comparison

### 3.1 The compared quantities

**Primary — the post-gate phase, in the `self+children` column**, from each arm's `--json` report, the `builds[].phases[]` entry whose `name` is `post-gate`:

- `reread_self_children` — the absolute re-read cost of the phase **including any child it spawns**. Arm 1: **4,959,761**.
- `share_self_children_pct` — that cost's share of the build's total. Arm 1: **12.0 %**.
- `turns`, reported beside both, because a share alone moves with implement-phase length without the tail changing (§4.3).

**Why the `self+children` column and not `self`.** The finalizer moves the post-gate work into a child agent, and the script attributes a child's whole subtree to the phase holding its spawn turn, reaching the phase table through exactly this column ([`scripts/measure-session.py:145-162`](../../scripts/measure-session.py)). The build's own post-gate turns then shrink to roughly spawn → receive → final message, so `reread_self` and `share_self_pct` fall by construction **whatever the child costs** — a finalizer three times more expensive than the work it replaced would report the same improvement, and the real saving would sit in a column nobody compared. `reread_self` and `share_self_pct` stay in the report as secondary diagnostics; they are not the test.

**Secondary — the finalizer child's own window**, the `agents[]` entry for the finalizer. Read it by role `feature:finalizer`, not `finalize-child`: the child is a registered agent, and `_classify_role` applies `DEFAULT_ROLE_MAP`'s `"finalize-child": r"^Finalize "` pattern only to `general-purpose` children, using a registered type verbatim instead. This is a reading substitution, not a script change — the primary quantity and every `parity.*` field are unaffected, because `build_report` collects finalizers by the `^Finalize <TICKET-ID>` description alone. That description is codified literally in build's SKILL.md, which is what holds this up. The fields to read: `first_turn_floor`, `peak_window` and `turns`. This is where the effect the epic predicts actually lives — a fresh child starting near the general-purpose child floor (roughly 85–95k, `unverified` for this repo's consuming project) against arm 1's post-gate window of 260,833 → 281,817. Report it against that pair.

**The build's own `start_window` / `end_window` for the phase are reported but are not the test.** Under the finalizer the phase's first turn is still the spawn turn, at essentially the same context depth, so `start_window` barely moves and `end_window` falls only because the build takes a few turns instead of eighteen. Read alone, that pair both understates the effect and can be satisfied by a change that does nothing.

**`compare`'s phase table is the self column only** ([`scripts/measure-session.py:2004-2010,2049`](../../scripts/measure-session.py)), and the finalizer's role is present in one arm only, which `compare` lists as excluded rather than as a delta row. So the primary comparison above is read off the two `--json` reports directly, or `compare` is extended to emit both columns first.

**Not totals.** One run per arm gives no spread, so a difference in a total is not separable from ordinary run-to-run variation. The share-and-window quantities above are what this change is predicted to move.

**Parity fields** — a saving is unreadable without them:

| Field | Source | Label |
|---|---|---|
| verdict | `builds[].parity.verdict` | `exact` |
| findings by severity | `builds[].parity.findings` | `exact` |
| PR opened | `builds[].parity.pr`, with `commit` and `pushed` | `estimate` |
| check runs of Bash calls | `builds[].parity.check_runs` / `bash_calls` | `estimate` |
| ticket reached `review/` | **operator-observed** — the ticket folder path and PR URL, recorded per arm | **not machine-checked** |

The labels are the script's own, not this document's. Ticket state has no `parity{}` field: it is recorded in prose per arm and is explicitly not machine-checked. Adding such a field to the script is out of scope here.

### 3.2 The two units, which are never comparable

Phase tables are in **re-read sum**: the sum of the per-turn window over a phase's turns, where a turn's window is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. Role and ticket tables are in **weighted units**. The two are never comparable to each other ([`scripts/measure-session.py:70-74`](../../scripts/measure-session.py)). Every column header in §4 carries its unit.

### 3.3 Known asymmetries

These are differences the design does not remove. They bound what the pair can claim.

- **Main checkout versus worktree.** Arm 1 ran in the main checkout, arm 2 in a worktree. The trees are identical at the base commit and dependencies are installed in both, but this is a real difference between the arms, accepted in exchange for not disturbing arm 1's open PR.
- **One run per arm.** No spread, no confidence interval. A small difference is not a result.
- **Arm 1's `site` is a standalone root session** (`root session (standalone /feature:build)`), so its transcript also carries the invoking conversation's own turns, unlike the FP-84 baseline's three stage subagents (`stage subagent (under flow)`). This is a difference between arm 1 and the *free baseline*, not between the paired arms — both arms are standalone root sessions.
- **The FP-84 free baseline ran plugin 3.6.0**, against arm 1's 3.6.1. Again a baseline-to-arm-1 difference, not an arm-to-arm one.
- **Session state keyed on the working directory, not on the repository.** A worktree is a different path, so it is a different project key: `~/.claude/projects/<cwd-slug>/memory/` does not follow it, and the project auto-memory injected into the system prompt differs between the arms. §2.1 copies `.claude/settings.local.json` to close the permission half of this, but the memory half cannot be copied without changing what arm 2's session sees relative to arm 1. A uniform per-turn floor difference Δ moves the post-gate share as a pure artifact — at arm 1's figures, a Δ of −10k tokens moves 14.47 % to 14.73 %, about +0.26 pp on a measurement read at the tenth of a point. Record each arm's post-gate `start_window` and the build agent's `first_turn_floor` (arm 1: **94,929**) so the size of the artifact is visible rather than assumed; this is why §3.1's primary quantities are absolute as well as share-based.

### 3.4 Void conditions

Any of the following makes the pair uncomparable. The run is discarded rather than reported with a caveat.

1. **A different model** in either arm.
2. **A different flag set** — anything other than `--pr --no-ui-testing`, or a run under `flow` rather than standalone.
3. **A different plan** — `02-plan.md` must be the snapshot's, byte for byte.
4. **A different lessons log** — `_lessons.md` must be the snapshot's at the start of each arm.
5. **A `schema_version` change** in the report format between the two runs. `compare` hard-exits 1 on a mismatch, so this voids the pair mechanically rather than silently.
6. **A `site` value other than `root session (standalone /feature:build)`** in either arm's `builds[]`. A run under `flow` lands the build in a stage subagent with a different window profile — the very axis that separates arm 1 from the FP-84 baseline (§3.3).
7. **Arm 2's post-gate `reread_self_children` equal to its `reread_self`.** That equality means no child was attributed to the phase, i.e. the finalizer was **not recognised** — its recognition contract is `parentAgentId` = the build agent's id **and** a description matching `^Finalize <TICKET-ID>\b` ([`scripts/measure-session.py:145-162`](../../scripts/measure-session.py)). An unrecognised finalizer reads as a near-total saving rather than as a measurement failure, so this voids the pair instead of being reported.
8. **A missing post-gate boundary in either arm.** The phase boundaries and every parity field are read from the **build's own** tool calls, so the build must keep authoring its own `06-summary.md` write ([`scripts/measure-session.py:159-166`](../../scripts/measure-session.py)). Were that write to move into the finalizer, `verdict`, `findings`, `commit` and `pr` would all degrade to `unknown` — correctly, but the measurement would stop answering the question.
9. **A different permission mode** in either arm — anything other than `auto`, per §1.2.

## 4. The recorded baseline

Figures below are regenerated from the two JSON reports named in §4.1; none is copied from a prose source. Phase figures are **re-read sum** and phase shares are that sum over the build's total; role figures elsewhere in the script's output are weighted units, and the two units are never comparable (§3.2).

### 4.1 Provenance of the two reports

**Arm 1 — the "before" run.** [`2026-09-17-paired-run-benchmark-evidence/before-feature-3.6.1-opus-5.json`](2026-09-17-paired-run-benchmark-evidence/before-feature-3.6.1-opus-5.json), committed in this repo. Plugin version and model are carried in the **file name**, because the report format has no plugin-version key — `generator` names the script and `schema_version` the format, while the model appears as a runtime model ID inside `models[]`. Regenerated on 2026-09-17 from the preserved transcript with the merged script, invoked through the absolute `/usr/bin/python3` (3.9.6); the result is **byte-identical** to the copy held in the consuming project's bench folder. Audited string by string before staging: zero `/Users/` occurrences, zero home-directory occurrences, no filesystem path in any string value, and the only description strings are `Architecture review PS-153`, `Correctness review PS-153`, `Performance review PS-153`, `Security review PS-153` and the root session's empty string.

**The FP-84 arm — referenced, not duplicated.** The three FP-84 builds are `builds[0..2]` of [`scripts/measure-session.expected.json`](../../scripts/measure-session.expected.json), which is already a committed, script-generated `--json` report of that session and is the script's **regression anchor**. It is referenced at that path rather than copied under `docs/research/`, so the anchor stays single-valued: two byte-identical copies of a file whose entire purpose is byte-stability is a drift hazard with no offsetting benefit. In place of a copy, the anchor was **re-asserted** on 2026-09-17 — the raw FP-84 session transcript was regenerated to a temp file and compared with `compare scripts/measure-session.expected.json <fresh> --assert`, which exited **0** ("every compared figure is within tolerance"). A reader looking for the FP-84 reports under this directory will not find them; they are at the `scripts/` path above, by this decision.

**Transparency note.** The before report carries one `notes` entry — `record type(s) this script does not classify were ignored: file-history-delta` — a transcript record type the FP-84 session did not contain. It affects no figure below.

### 4.2 Per-phase figures

Re-read sum in tokens; share is that phase's re-read sum over its build's total. Windows in tokens.

| run | site | build turns | phase | turns | turn range | start window | end window | re-read sum (self) | share (self) | re-read (self+children) | share (self+children) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| PS-153 "before" | root session (standalone `/feature:build`) | 182 | implement | 122 | 1–122 | 94,929 | 210,079 | 19,497,205 | 56.9 % | 19,497,205 | 47.3 % |
| | | | review | 37 | 123–159 | 210,579 | 254,537 | 8,525,106 | 24.9 % | 15,496,134 | 37.6 % |
| | | | post-review | 5 | 160–164 | 256,292 | 259,106 | 1,288,189 | 3.8 % | 1,288,189 | 3.1 % |
| | | | **post-gate** | **18** | **165–182** | **260,833** | **281,817** | **4,959,761** | **14.5 %** | **4,959,761** | **12.0 %** |
| FP-85 | stage subagent (under flow) | 109 | implement | 54 | 1–54 | 87,254 | 216,875 | 9,249,270 | 37.7 % | 9,249,270 | 30.8 % |
| | | | review | 32 | 55–86 | 217,378 | 283,440 | 8,132,512 | 33.2 % | 13,636,446 | 45.4 % |
| | | | post-review | 5 | 87–91 | 287,838 | 301,317 | 1,461,816 | 6.0 % | 1,461,816 | 4.9 % |
| | | | **post-gate** | **18** | **92–109** | **305,682** | **325,209** | **5,677,694** | **23.2 %** | **5,677,694** | **18.9 %** |
| FP-87 | stage subagent (under flow) | 68 | implement | 23 | 1–23 | 87,713 | 193,151 | 3,648,162 | 25.1 % | 3,648,162 | 18.5 % |
| | | | review | 28 | 24–51 | 194,511 | 244,089 | 6,256,539 | 43.0 % | 11,421,402 | 58.0 % |
| | | | post-review | 7 | 52–58 | 248,639 | 274,542 | 1,823,631 | 12.5 % | 1,823,631 | 9.3 % |
| | | | **post-gate** | **10** | **59–68** | **277,122** | **287,922** | **2,812,294** | **19.3 %** | **2,812,294** | **14.3 %** |
| FP-86 | stage subagent (under flow) | 116 | implement | 65 | 1–65 | 89,307 | 260,957 | 13,243,726 | 43.4 % | 13,243,726 | 34.6 % |
| | | | review | 27 | 66–92 | 261,857 | 340,798 | 8,240,100 | 27.0 % | 16,061,621 | 41.9 % |
| | | | post-review | 8 | 93–100 | 345,579 | 367,300 | 2,841,614 | 9.3 % | 2,841,614 | 7.4 % |
| | | | **post-gate** | **16** | **101–116** | **369,570** | **400,243** | **6,178,872** | **20.3 %** | **6,178,872** | **16.1 %** |

### 4.3 Denominator-independent post-gate figures

The share in §4.2 has the whole build in its denominator. These three columns do not.

| run | post-gate turns ÷ build turns | post-gate re-read sum (tokens) | mean post-gate window (tokens/turn) |
|---|---|---|---|
| PS-153 "before" | 9.9 % (18/182) | 4,959,761 | 275,542 |
| FP-85 | 16.5 % (18/109) | 5,677,694 | 315,427 |
| FP-87 | 14.7 % (10/68) | 2,812,294 | 281,229 |
| FP-86 | 13.8 % (16/116) | 6,178,872 | 386,180 |

### 4.4 Parity

Labels are the script's own (§3.1). `C`/`I`/`S` are CRITICAL / IMPORTANT / SUGGESTION findings.

| run | verdict (`exact`) | findings (`exact`) | check runs of Bash calls (`estimate`) | commit / pushed / pr (`estimate`) |
|---|---|---|---|---|
| PS-153 "before" | pass | C0 I1 S2 | 44 of 171 | true / true / true |
| FP-85 | pass | C0 I4 S4 | 39 of 78 | true / true / true |
| FP-87 | pass | C0 I8 S2 | 4 of 23 | true / true / true |
| FP-86 | pass | C0 I4 S10 | 32 of 84 | true / true / true |

**Operator-observed, not machine-checked** (§3.1): the "before" run left `PS-153` in `claudedocs/tickets/review/PS-153/` in the consuming project with its PR open. The PR URL is recorded with the run in the consuming project's bench folder and is not reproduced here.

### 4.5 Is the "before" run consistent with the FP-84 range?

**No.** The "before" run's post-gate share is **14.5 %**, outside the FP-84 builds' **19.3–23.2 %** range, and below it.

***Inference*** **— the cause is build length, not a cheap tail.** This is a single-pair causal attribution read off one run against three, not a measured fact; the figures it rests on (§4.2, §4.3) are measured. The denominator-independent figures in §4.3 separate the two readings:

- The tail's **absolute** cost, 4,959,761 tokens of re-read, sits inside the FP-84 family (2.8M–6.2M), and its **mean window**, 275,542 tokens/turn, is the closest of the four to FP-87's 281,229 — below FP-85's 315,427 and well below FP-86's 386,180. By both denominator-free measures the tail behaves like the baseline family's.
- Stronger still, in *relative* terms the tail is not cheap at all. Decomposing the share as (post-gate turn fraction × post-gate mean window ÷ build mean window) gives PS-153 0.0989 × 1.463 = 14.5 %, FP-85 0.1651 × 1.402 = 23.2 %, FP-87 0.1471 × 1.315 = 19.3 %, FP-86 0.1379 × 1.469 = 20.3 %. PS-153's window ratio, **1.463**, is the second highest of the four — so the entire gap is carried by the turn fraction, not by the tail running at a relatively cheaper window.
- What differs is the denominator. Post-gate turns are **9.9 %** of the "before" run's build turns against **13.8–16.5 %** in the FP-84 builds, because a **122-turn implement phase** on a complexity-L ticket enlarges the build. The post-gate phase itself is 18 turns — the same count as FP-85's.

This is not a defect in the "before" run, and it is not evidence that the tail is already cheap. It is the ratio responding to a longer build.

**Consequence for FP-95, stated before its run is spent.** The headroom on this ticket is about **12–14.5 points** of the build's re-read cost, not about 20 — the range the FP-84 builds would have suggested. Per §3.1 the comparison basis is the `self+children` column, so FP-95 is judged against:

| quantity | arm 1 value | column |
|---|---|---|
| post-gate `reread_self_children` | **4,959,761** | primary |
| post-gate `share_self_children_pct` | **12.0 %** | primary |
| finalizer child `first_turn_floor` / `peak_window` | compared against **260,833 → 281,817** | secondary |
| post-gate `reread_self` / `share_self_pct` | 4,959,761 / 14.5 % | diagnostic only |

In arm 1 the two columns coincide, because its post-gate phase spawned no child — which is exactly why arm 2's must be read in the `self+children` column, where the finalizer's own consumption lands. Absolute re-read and mean window (275,542) are reported **beside** the shares, so a longer or shorter implement phase in arm 2 cannot move the verdict by itself.

## 5. Deferred — the replay design for review-quality changes

Recorded as **deferred**, not adopted, so a later change of a different shape has the design ready.

A change that can affect **what reviewers find** cannot be evaluated by the paired run above, because that design has one run per arm and no way to separate a findings difference from run-to-run variation. The design for such a change is a **replay**:

- Take a **finished ticket with known reviewer findings** — one whose `04-review.md` records what the four reviewers reported.
- Rebuild it from the **parent of its squash commit**, in a **throwaway clone**, so neither the original repository nor its history is touched.
- Run **at least two runs per arm**, so a findings difference has a spread to be read against.
- Identified candidate: **podushka `PD-23`**.

Deferred for this epic with the epic's own reason: the finalizer runs **after** the review checkpoint has completed and its artifact is written, so it cannot change what reviewers find. The replay's extra strength buys nothing for this change, at several times the cost. Executing the replay is out of scope for FP-92 entirely.

## 6. Arm 2 — result (added 2026-09-18)

Arm 2 ran on 2026-09-18 with `feature` 3.8.0 obtained by marketplace update, in the hand-made worktree, after the §1.6 pre-flight and the §2 seeding (all seven copied paths passed the `check-ignore` gate; dependencies installed before the session). Report: [`2026-09-17-paired-run-benchmark-evidence/after-feature-3.8.0-opus-5.json`](2026-09-17-paired-run-benchmark-evidence/after-feature-3.8.0-opus-5.json); compare output: [`compare-before-after.txt`](2026-09-17-paired-run-benchmark-evidence/compare-before-after.txt). Every figure below is `exact` unless marked.

### 6.1 The post-gate phase

| | Arm 1 (3.6.1) | Arm 2 (3.8.0) |
|---|---|---|
| Root turns in post-gate | 18 | 5 |
| Root window during post-gate | 260,833 → 281,817 | 289,888 → 300,664 |
| Root re-read, post-gate | 4,959,761 | 1,475,682 |
| Finalizer children | — | 2 (17 turns and 11 turns) |
| Finalizer first-turn floor / peak | — | 26,098 / 50,602 and 25,909 / 56,569 |
| Children re-read | — | 1,239,022 |
| **Post-gate re-read, self + children** | **4,959,761** | **2,714,704 (−45%)** |
| Post-gate share of build, self + children | 12.0% | 11.7% |

The post-gate mechanics moved out of the ~290k root window into children that start at about 26k and peak at 51k–57k. The child floor is well below the protocol's `unverified` 85–95k guess in §1: the finalizer is a registered, restricted-tool agent, not a `general-purpose` child, and this consuming project's instruction files are small.

The absolute re-read fell by 45% even though arm 2 spent **two** finalizer spawns (§6.3). Excluding the first spawn and the two root turns that relayed its result, the post-gate re-read would be about 1.4M — roughly −72% (*inference*: the second spawn's 497,696 plus the three remaining root turns at ~295k each).

The **share** barely moved (12.0% → 11.7%) because the denominator moved too: arm 2's whole build was shorter (95 root turns against 182; implement 77 turns against 122). That is run-to-run variance in the implement phase, not an effect of the finalizer, and it is exactly why §3.1 names the denominator-independent figures — turns, windows and absolute re-read of the post-gate phase — as the primary reading.

### 6.2 Parity

| | Arm 1 | Arm 2 |
|---|---|---|
| Verdict | pass | pass |
| PR opened | yes (#192) | yes (#193) |
| Ticket state | `review/`, `in-review` | `review/`, `in-review` |
| Findings (C / I / S) | 0 / 1 / 2 | 0 / 0 / 1 |
| Check runs (estimate) | 44 | 23 |

Verdict, PR and ticket state match. The findings differ; the review checkpoint runs before the finalizer and is untouched by the change, so this is reviewer variance on a different implementation of the same plan, not a parity failure. The commit was verified by hand: 36 files, all under `apps/web/`.

### 6.3 Protocol finding — the second run saw the first

The first finalizer spawn returned a `needs-decision` result without changing anything: its branch-decision step ran `gh pr list --search "PS-153 in:title"` and found arm 1's open PR #192 for the same ticket, a case its instruction set did not cover. Build relayed the result to the operator, who chose to proceed on the new branch; the second spawn committed, pushed, opened PR #193 and applied Transition 5.

The finalizer behaved as specified (FP-95 AC 4: never asks, returns a structured result). The gap is in this protocol: §1.6 frees the local branch name and parks the main checkout, but arm 1's PR stays visible on `origin` under the ticket's title, and §2.2's "the second run must not see the first" did not cover it. A future paired run should close arm 1's PR (or retitle it without the ticket ID) before arm 2 starts, and reopen it afterwards. The cost here was one extra child spawn, two root turns, and one operator pause inside the measured window — all counted in §6.1's arm-2 figures.

### 6.4 Conclusion

The finalizer child does what epic FP-92 predicted: the closing mechanics run in a fresh window near the child floor instead of at the build's largest window. On this ticket that is 2.2M fewer tokens re-read (−45% of the post-gate phase, −72% *inference* without the protocol-induced retry), with verdict, PR and ticket state at parity. Measured on one pair; the share figure is not the reading to quote.

## 7. Second pair — the implement / review / close split (added 2026-09-18)

Ticket: recipio-app `RC-52` ("/api/chat observability: PII-safe structured logging", complexity M, no UI). Base tag `bench/rc-52-base`; plan written once on 3.8.1; both arms `/feature:build RC-52 --pr --no-ui-testing`, standalone, `claude-opus-5`. Arm 1 on `feature` 3.8.1, in the main checkout; arm 1's PR retitled without the ticket ID before arm 2 (§6.3). Arm 2 on 3.9.0 (the three-stage build), in a hand-made worktree cut from the tag, seeded per §2 minus the local settings file, which this project does not have. Reports: [`rc52-before-feature-3.8.1-opus-5.json`](2026-09-17-paired-run-benchmark-evidence/rc52-before-feature-3.8.1-opus-5.json), [`rc52-after-feature-3.9.0-opus-5.json`](2026-09-17-paired-run-benchmark-evidence/rc52-after-feature-3.9.0-opus-5.json). Figures are `exact` from API usage unless marked.

### 7.1 Shape of arm 2

Standalone build now implements in the root session and spawns the review stage and the close stage as children; each stage spawns its own leaf roles. Tree: root (implement, 39 turns) → `RC-52 review stage` (14 turns) → four reviewers; root → `RC-52 close stage` (14 turns) → finalizer. The measurement script does not yet recognise this shape: it reports the review-stage child as a build with implement/review phases and finds no post-gate boundary in the root. The per-agent table is correct; the phase table is not, and the figures below were assembled from the per-agent table by hand.

### 7.2 Structural comparison (re-read tokens = per-turn window summed)

| Part | Arm 1 (3.8.1) | Arm 2 (3.9.0) | Delta |
|---|---|---|---|
| Review wrapper: spawn, merge, validate, fix | 13 root turns at 186k–222k: **2.68M** | review stage, 14 turns at 56k–134k: **1.46M** | −46% |
| Four reviewers (children) | 0.99M | 2.24M | +126% (*variance* — the correctness reviewer ran 21 turns against 8) |
| Close: test skip, verdict, summary, lessons, gate | 3 root turns at 224k–228k: 0.68M | close stage, 14 turns at 56k–122k: 1.42M | +109% |
| Finalizer child | 0.31M | 0.47M | +52% |
| Implement | 29 root turns, 93k→185k: 4.45M | 36 root turns, 81k→184k: ~5.1M (*estimate*: root minus its two spawn turns) | *variance* |
| Root spawn/relay turns | — | 2 turns at ~185k: ~0.37M | new |
| **Total re-read, all agents** | **9.1M** | **11.3M** | +24% |

Weighted units, all agents: 1,734k → 2,267k (+31%).

### 7.3 Reading

- **The predicted effect is real and the size predicted.** The review wrapper moved from a ~200k window to a stage that starts at 56k and peaks at 134k, and its re-read fell by 46% at the same turn count.
- **The close stage is a net loss on a ticket this size.** In arm 1 the tail after review was three root turns, because build already held everything. The close stage re-derives it from disk in 14 turns from a fresh window and costs twice as much. Its floor (56k) times its turns is most of that.
- **On a small ticket the split does not pay.** The review saving (−1.2M) is cancelled by the close overhead (+0.9M) and the two spawn turns. What made the total +24% is variance in implement and in one reviewer, which the split cannot influence; but the structural saving alone is within noise here.
- **Where it should pay** (*inference* from §4): a build like PS-153, whose review wrapper ran 37 turns at 210k–254k (8.5M), would save roughly 4M on review against a close overhead of about 1M. The split's value grows with the implement window; it is negative below roughly 20 review-wrapper turns at 200k.
- **Parity.** Both arms: verdict pass, PR opened (#89, #90), ticket to `review/`. Findings differ in kind — arm 1 applied 2 important findings; arm 2's review stage recorded 6 suggestions and dismissed several with reasons citing the plan and the handoff's rationale — which is the validate-then-fix behaviour FP-99 asked for, and it is the first evidence that the handoff carries the implementer's reasons across the boundary. Whether the dismissals were right needs a human read of PR #90.

### 7.4 Follow-ups

1. `scripts/measure-session.py` parses the post-split shape from feature 3.9.1 on: a standalone root as the implement agent, `review stage` / `close stage` children as its phases, the sequencer's own turns credited to the stage they relay. Re-measured with it, arm 2 reads: implement 36 turns 5.13M; review 15 turns (14 in the stage plus one sequencer turn) 1.64M, the four reviewers adding 2.24M; post-review 10 turns 1.02M; post-gate 6 turns 0.78M plus the finalizer 0.47M — the §7.2 hand assembly within rounding. Phase rows are not like-for-like across the two shapes: in the single-agent shape `review` ends at the first `04-review.md` write and `post-review` runs on to the summary, so compare `review + post-review` between arms (2.68M vs 2.66M here), never row by row. Both RC-52 reports in the evidence folder are regenerated with that parsing.
2. The close stage's 14 turns are the next thing to shrink: on a skip it should be a handful of turns. Read its transcript for what it re-derives (it re-read the runtime reference, the plugin root and the storage files before doing anything). Feature 3.9.1 binds the runtime and storage mode from the brief and collapses the stage's reads into one preparation read; unmeasured until the next pair.
3. Re-run the pair on a larger ticket before deciding whether the split stays; RC-52 is below the size where it can pay.

## 8. Third arm — RC-52 on feature 3.9.1 (added 2026-09-18, evening)

Same input as §7 (tag `bench/rc-52-base`, the same ticket snapshot and `_lessons.md`), a fresh hand-made worktree, `/feature:build RC-52 --pr --no-ui-testing`, `claude-opus-5`. Plugin 3.9.1: the close and review stages bind runtime and storage mode from the brief, number Entry as the call sequence, and fetch their inputs in one preparation read. Pre-flight per §1.6 and §6.3, plus one step §6.3 did not name: both arm PRs' *remote branches* were deleted before the run (closing PR #89 and PR #90 unmerged), because build derives the branch name from the same spec and plan in every arm and a colliding remote branch turns the push into a §4 degradation. Report: `2026-09-17-paired-run-benchmark-evidence/rc52-arm3-feature-3.9.1-opus-5.json`.

### 8.1 Per-stage comparison (re-read tokens; both arms parsed by the script's three-stage reading)

| Agent | Arm 2 (3.9.0) | Arm 3 (3.9.1) | Delta |
|---|---|---|---|
| Close stage | 14 turns, 56k→122k, **1.42M** | 11 turns, 56k→125k, **1.11M** | −22% |
| Review stage | 14 turns, 56k→134k, **1.46M** | 11 turns, 56k→105k, **0.99M** | −32% |
| Four reviewers | 4/6/21/9 turns, 2.24M | 5/7/10/6 turns, 1.29M | *variance* |
| Finalizer | 13 turns, 0.47M | 12 turns, 0.52M | +11% |
| Root: implement | 36 turns, 5.13M | 44 turns, 6.29M | *variance* |
| Root: sequencer turns | 3 (0.55M) | 5 (0.94M) | +2 turns — see 8.2 (4) |
| **All agents** | **11.28M**, 2,266k units | **11.15M**, 2,204k units | −1% / −3% |

Parity: both pass, PR opened (#90, #91), ticket → `review/`. Arm 3's review round recorded zero findings against arm 2's six suggestions; check runs 14 vs 6.

### 8.2 Reading

The two stages lost three turns each and a quarter to a third of their re-read, and the review stage's peak fell 134k → 105k — the trim's direct effect. The close stage still ran 11 calls against the five its skill budgets, and the transcript names four causes, none of them the skill's numbered steps:

1. **The preparation read overflowed the tool-result cap.** One Bash call printed the config, spec frontmatter, the whole handoff, the review, the listing, the lessons contract and the lessons headings — 47.6KB. Claude Code persists a Bash result that large to a `tool-results/` file and shows a 2KB preview; the stage then `Read` the file back (49KB into the window) and re-read the spec and handoff headings in a further call. Net: +2 calls and the read's tokens paid twice. A reviewer child's 22.9KB `Grep` result was persisted the same way, so the cap sits somewhere below 20KB. `Read` results of the same size arrive inline.
2. **The runtime block orders a read the skill forbids.** Every stage brief opens with `runtime.md`'s block, whose text says "Read that runtime reference before acting"; both stages read `runtime-claude.md` at turn 1 — at the 56k floor, cheap, but a call the skill's budget did not count.
3. **The finalizer prompt needs the transition mechanics.** The stage grepped `state-transitions-fs.md` for Transitions 2 and 5 to fill the prompt's "resolved transition" block; the preparation-read list does not include it, so it was a call of its own at 118k.
4. **The finalizer left a stash.** Its branch decision ran `git stash push -m <tag>` → `checkout main` → `checkout -b` → `stash apply` → drop-by-ref, and the drop failed; it reported the leftover in `notes`, and the root spent two turns at ~190k locating and dropping it — 0.38M, more than the close stage saved.

The totals are again a wash: implement ran 44 turns against 36 (same plan, same spec), and the reviewers' 2.24M → 1.29M swing is one reviewer running 21 turns in arm 2. On a ticket this size the stages are ~20% of the run; a stage-level saving of a third moves the total by single digits, inside run-to-run noise. The per-stage rows are the measurement; the totals are not.

### 8.3 Follow-ups

1. Preparation read as one *message* of parallel tool calls — a small Bash print plus one `Read` per artifact — so no single result crosses the persistence cap; state the cap in the storage files.
2. Move the transition lookup out of the close stage: name `state-transitions-<mode>.md`'s transition sections in the finalizer's reference list and pass only the transition numbers and the resolved paths the stage already holds.
3. Decide the runtime block's "Read that runtime reference" line for stage briefs: keep (one ~56k read per stage, and the stage learns the spawn operation) or inline the spawn/wait operations into the block.
4. Finalizer: `git stash pop`, as pr-creation §1 prescribes, instead of `apply` + drop-by-ref.
5. A fourth arm after those; then the larger-ticket pair (§7.4 item 3) still stands.
