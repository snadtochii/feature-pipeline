# Where a build's API turns go

Measured on the eight build transcripts on disk (2026-09-18). Everything below is counted from transcripts unless marked *estimate*. Scripts in [`2026-09-18-build-turn-anatomy-evidence/`](2026-09-18-build-turn-anatomy-evidence/): `turns.py` (tool, error and retry counts), `timeline.py` (per-turn dump, output composition, check inventory), `checks2.py` (check-run recount with heredoc bodies stripped), `steps.py` (per-plan-step accounting and the batched floor).

## 1. Corpus

| Build | Plugin | Site | Turns | Window |
|---|---|---|---|---|
| FP-86 | 3.6.0 | build stage under `ship` | 116 | 89k → 400k |
| FP-85 | 3.6.0 | build stage under `ship` | 109 | 87k → 325k |
| FP-87 | 3.6.0 | build stage under `ship` | 68 | 87k → 287k |
| PS-153 arm 1 | 3.6.1 | standalone root | 182 | 94k → 281k |
| PS-153 arm 2 | 3.8.0 | standalone root | 95 | 98k → 300k |
| RC-52 arm 1 | 3.8.1 | standalone root | 45 | 92k → 228k |
| RC-52 arm 2 | 3.9.0 | standalone root (implement only; stages are children) | 39 | 81k → 188k |
| RC-52 arm 3 | 3.9.1 | standalone root (implement only) | 49 | 81k → 192k |

Transcripts: the FP-84 ship session under `~/.claude/projects/-Users-serhiinadtochii-Projects-feature-pipeline/012fe8f0-…/subagents/`, `personal-server/claudedocs/bench/ps-153/{before,after}/`, `recipio-app/claudedocs/bench/rc-52/{before,after,after-3.9.1}/`. All eight ran in permission mode `auto`.

## 2. Findings

### 2.1 One tool call per API turn — the structural driver

| Build | Turns | Tool calls | Calls per turn | Turns with 2+ calls | Text-only turns |
|---|---|---|---|---|---|
| FP-86 | 116 | 135 | 1.16 | 20 (17%) | 1 |
| FP-85 | 109 | 112 | 1.03 | 6 (6%) | 5 |
| FP-87 | 68 | 86 | 1.26 | 21 (31%) | 7 |
| PS-153 arm 1 | 182 | 177 | 0.97 | 0 (0%) | 5 |
| PS-153 arm 2 | 95 | 105 | 1.11 | 10 (11%) | 5 |
| RC-52 arm 1 | 45 | 45 | 1.00 | 3 (7%) | 5 |
| RC-52 arm 2 | 39 | 40 | 1.03 | 2 (5%) | 1 |
| RC-52 arm 3 | 49 | 49 | 1.00 | 1 (2%) | 1 |

The implement loop runs as read → edit → read → edit, one call per message. The 182-turn build issued zero messages with more than one call. A turn is the unit of cost (the whole window is re-read per turn), so the turn count is set by the number of *serial* calls, not by the amount of work.

The per-plan-step view (PS-153 arm 1, `steps.py`):

| Step | Turns | Distinct files read | Distinct files edited | Check runs |
|---|---|---|---|---|
| T4 (`SubmitButton` + `FormDialog` adoption) | 23 | 8 | 1 | 6 |
| T7 (spec rollout) | 22 | 5 | 0 | 10 |
| T10 (review wait, post-review fixes) | 40 | 10 | 3 | 7 |
| T5 | 17 | 6 | 5 | 1 |

Step T5 touched five files in seventeen turns: each file cost a slice read, a heredoc edit, and sometimes a second slice. Nothing in those seventeen calls depended on the previous call's result except the edit on its own read.

**Batched floor** (*estimate*, `steps.py`): per plan step, one message of reads, one message of edits (one call per file), then one validation call, plus one turn per extra check run (a red run's fix iteration). This is a floor, because reads reveal further reads.

| Build | Actual turns | Batched floor |
|---|---|---|
| PS-153 arm 1 | 182 | ~75 |
| FP-86 | 116 | ~50 |
| FP-87 | 68 | ~24 |
| RC-52 arm 3 | 49 | ~20 |

The realistic target is between the two. Halving the serial calls is a 30–50% turn cut on the implement phase, which is above the protocol's ~30% detectability threshold.

### 2.2 Errors — 4–14% of turns, most of them the loop working

| Build | Error turns | Red check runs | Other |
|---|---|---|---|
| FP-86 | 12 (10%) | 10 | 1 oversized plan read (41KB), 1 `python3 -c "import yaml"` with no PyYAML |
| FP-85 | 4 (4%) | 3 | 1 oversized result |
| FP-87 | 0 | 0 | — |
| PS-153 arm 1 | 15 (8%) | 14 | 1 `sleep 45` blocked by the wait hook |
| PS-153 arm 2 | 10 (11%) | 10 | — |
| RC-52 arm 1 | 5 (11%) | 1 | 3 bash errors, 1 oversized |
| RC-52 arm 2 | 4 (10%) | 2 | 1 bash error, 1 oversized |
| RC-52 arm 3 | 7 (14%) | 4 | 1 hook block, 1 preparation `cat` chain exit 1, 1 red test |

Identical Bash command re-issued within four turns: zero in every build. A red check run is the fix iteration the loop is for. The non-productive errors and what they cost:

- **Hook block on incidental text** (RC-52 arm 3, turn 29): a `python3` heredoc edit whose new test content mentioned the env file's name was refused by the secrets hook. Recovery took seven turns (29–35): write the edit as a script file, run it, syntax error, retry. That single block is 14% of that build.
- **Auto-mode classifier denial** (RC-52 arm 3 finalizer, turn 7): `git stash drop` by ref refused as "Irreversible Local Destruction"; the root cleaned the stash in two turns at 190k. PR #120's `stash pop` removes the drop.
- **`sleep` polls blocked** by the wait hook (PS-153 arm 1). Polls are gone in the three-stage shape (§2.4).
- **Oversized reads persisted to disk** (one per build in five of eight): `cat` of a 40KB+ artifact returns a path, then a `Read` of that path. Two turns and the tokens twice. PR #120 covers the stage preparation reads; the build's own plan read at turn 3–4 still does this.

Errors are a second-order lever: at most ~15% of one build, ~0 in the best, and two of the four causes are already fixed in flight.

### 2.3 Check runs — corrected count

The handoff's 23–44 check runs per build came from a pattern that also matched `vitest`/`node` inside heredoc bodies (a spec file written with `cat > x.spec.ts <<EOF` imports vitest). With heredoc bodies stripped (`checks2.py`):

| Build | Handoff figure | Corrected |
|---|---|---|
| FP-86 | 35 | 9 |
| FP-85 | 35 | 13 |
| PS-153 arm 1 | 44 | 24 |
| PS-153 arm 2 | 23 | 24 |
| RC-52 arm 3 | 14 | 11 |

`scripts/measure-session.py`'s `DEFAULT_CHECK_PATTERN` has the same over-match (its `parity.check_runs` reports 44 for PS-153 arm 1). Stripping heredoc bodies before matching changes the anchor's parity figure, so it is a script fix with a re-anchor, not a doc note. The `PostToolUse` validation hook is a silent no-op in all three consuming projects (none declares a `validate:` block), so the skill-body runs are the only validation — there is no duplication to remove. At 1–3 check runs per plan step the count is already close to "once per step"; the lever here is small.

### 2.4 Waits and setup

- **Reviewer waits, pre-split**: FP-86 spent turns 69–74 on `ToolSearch`, `sleep 150`, an output read, an `until` loop and a `seq 70` poll loop at 276k–298k; PS-153 arm 1 had one blocked sleep plus four text-only turns as each reviewer result arrived. In the three-stage shape the review-stage child spawns all four reviewers in one message and receives them in the next turn; the root blocks on each stage child. Zero wait turns in RC-52 arms 2 and 3. Done.
- **Setup before the first plan step**: 6–13 turns per build (references, config, spec, plan, package scripts), one call each. RC-52 arm 3's root spent turns 1–7 on `runtime.md`, `ticket-resolution-fs.md`, `storage-fs.md`, spec + plan, `stage-briefs.md`, `package.json`. PR #120 makes the stage children's preparation one parallel message; the standalone build root's own entry is not covered.

### 2.5 Output tokens and thinking

Terminal-record `output_tokens` per build versus what the transcript shows (tool arguments + text, chars/4):

| Build | Output tokens | Visible (args + text) | Not in transcript |
|---|---|---|---|
| FP-86 | 147k | 62k | ~85k |
| PS-153 arm 1 | 89k | 40k | ~48k |
| FP-87 | 80k | 38k | ~42k |
| RC-52 arm 3 | 38k | 19k | ~19k |

Thinking blocks are not persisted in the `.jsonl` (0 chars in every transcript), so roughly half of the output is thinking, and window growth is only 40–56% explained by transcript content (FP-86: 181k of 311k unexplained; PS-153: 82k of 187k). Output is weighted 5× in units and stays in the window across tool-use turns. This is a re-read cost, not a turn-count driver; a lower session effort is the experiment, unchanged from the handoff.

### 2.6 The auto-mode confound

Every measured build ran in permission mode `auto`, whose harness instruction tells the session to work through Bash (`cat`, `sed -n`, heredocs) instead of `Read`/`Edit`/`Write`. Effects visible in the transcripts:

- PS-153 arm 1: 171 of 177 calls are Bash; 45 edits as `python3 - <<'PY'` string replacements, 10 of them with no assertion on the match (a silent no-op if `old` drifted); 52 `sed -n 'a,bp'` slices over 16 files.
- Slices and heredoc edits come one per message; `Edit` calls were batched two per turn when used (FP-86 turns 12–18).
- The two hook blocks above are Bash-only failure modes: incidental text inside a heredoc, and `sleep` in a command.

The plugin cannot override a harness instruction. The paired-run protocol does not pin permission mode (§3.4 lists model, flags, plan, lessons, schema, site, and two boundary conditions); a pair with one arm in `auto` and one in `acceptEdits` would be void by intent but not by rule.

## 3. Proposal

Ranked by measured size. Each is one paired run to confirm.

1. **Batch independent calls in the implement loop** (`build/SKILL.md` §1c). Per plan step: one message with every read the step needs (`Read` per file, or one Bash for a listing); one message with every edit, one call per file, `Edit`/`Write` per file; then the existing single validation-plus-handoff call. Rule of thumb for the body: a call goes in the same message as the previous one unless it needs that call's result. Expected: implement turns −30–50% (§2.1). Quality guards: one call per file per message (parallel edits on one file conflict); `Edit` fails loudly on a stale `old_string` where an unasserted heredoc replace does not; validation still runs once per step, so `parity.check_runs` should not fall.
2. **Pin permission mode in the protocol** (§1.2 fixed input, §3.4 void condition). Then, separately from 1, one pair `auto` vs `acceptEdits` on the same ticket to size the Bash-heredoc tax (§2.6). Two variables in one pair would be unreadable.
3. **Standalone build entry as one parallel message** — the same shape PR #120 gave the stage children. 6–13 turns → ~3 (§2.4). Small, mechanical.
4. **Fix `DEFAULT_CHECK_PATTERN`** to ignore heredoc bodies, regenerate `measure-session.expected.json`, re-assert. Corrects `parity.check_runs` (§2.3).
5. **Plan read under the cap**: the build's turn 3–4 `cat 02-plan.md` exceeds 20KB on L tickets and is persisted then re-read. `Read` the artifact directly, as PR #120 does for the stages.

Not a lever: errors (§2.2), check-run count (§2.3), waits (§2.4, already gone).

## 4. Measurement design for proposal 1

Same protocol (§1–§3), one pair on **PS-153** (L, 7 steps, ~25 files touched — the size where the effect is largest and above the 30% threshold):

- Arm A: plugin 3.9.2 (after PR #120), unchanged loop. This arm also serves handoff step 2 (re-measure the three-stage split on a typical-size ticket).
- Arm B: 3.9.2 plus the batching text in `build/SKILL.md` §1c, nothing else changed.
- Both: `/feature:build PS-153 --pr --no-ui-testing`, standalone, fresh worktree from `bench/ps-153-base`, seeded per §2, permission mode pinned to whichever the user runs in production (record it), same model.
- Compare, implement phase only: turns, calls per turn, share of turns with 2+ calls, re-read sum. Parity: verdict, findings by severity, corrected check runs, PR opened, files touched.
- Void if arm B's batching shows up as `MultiEdit` on a single file or as one Bash that writes several files — that is a different change.
