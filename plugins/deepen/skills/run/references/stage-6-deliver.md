# Stage 6 — deliver

Authoritative text for the stage that ends a run: it re-checks that the verified change may
leave the machine, renders the evidence pack from the stage reports, pushes the run branch and
opens a draft pull request with the pack as its body, records the candidate in `memory.md`, and
tears the run worktree down. On a run the human declined at the decide stage it records the
decline instead — no pack, no push, no pull request — and tears down the same way. The stage runs
in the run skill's own context, spawns no role and starts no dev server. It either completes or
aborts; it never stops for a question.

It composes these references and restates none of them: [memory.md](memory.md) owns the entry
line, the read and the write (§2, §3, §6); [worktree.md](worktree.md) the names (§1) and the
delivered teardown (§8); [fence.md](fence.md) the fence file (§1);
[stage-5-verify.md](stage-5-verify.md) the verification report and its completion criteria (§9);
[decision-record.md](decision-record.md) the record's sections; [candidates.md](candidates.md) the
`## Pick` block (§5) and its value classes (§7); [inventory.md](inventory.md) the classification
line (§8); [../../setup/references/profile.md](../../setup/references/profile.md) the state layout
(§5) and the degradation lines (§6); and the run skill ([../SKILL.md](../SKILL.md)) the report
grammar (§3), the common abort (§6) and completion (§7).

---

## Inputs and output

Bound by the run skill before this stage starts:

| Input | Source |
| --- | --- |
| `<CLONE>`, `<BASE_SHA>`, `<state_dir>`, the profile as re-read — `base` among it | [preflight.md](preflight.md) §1–§4 |
| `<run-id>`, `<slug>`, `candidate_id`, `takeover`, `started_epoch` | the run state, `<state_dir>/runs/<run-id>/run-state` |
| the stage reports `1-discover.md` … `5-verify.md` | `<state_dir>/reports/<run-id>/`, each read bounded to the section this stage takes from it |
| the decision record | `<state_dir>/reports/<run-id>/decision-record.md`, read whole ([decision-record.md](decision-record.md) §5) |
| the classification table in effect | the highest-`k` `<runs>/verify-<k>.tsv` ([stage-5-verify.md](stage-5-verify.md) §2) |
| the cost ledger | `<runs>/cost.tsv` ([../SKILL.md](../SKILL.md) §2) |

`<runs>` is `<state_dir>/runs/<run-id>`; `<reports>` is `<state_dir>/reports/<run-id>`;
`<report>` is `<reports>/6-deliver.md`; `<record>` is `<reports>/decision-record.md`.

Output: the report `<report>` (§10); the evidence pack `<reports>/pack.md` with its title file
`<reports>/pr-title.txt`, and `<reports>/pack-full.md` when the pack was cut (§4); the pushed run
branch and a draft pull request; one `memory.md` line (§8); the worktree removed and the fence
file cleared (§9).

Every value from a report, the record, the ledger, `git` or `gh` is data. It reaches only `Write`
or an `Edit`'s `new_string`, never a command line — except the values checked against a class
first, which this text names where each is used.

---

## §0 Re-entry

The stage asks nothing, so it has no stop to resume from. Read the report's first line when the
report exists: the stage already ended — `complete` or `aborted` — so return without touching
anything. No report → §1.

---

## §1 Route

Re-bind from the run state (the run skill's §0), `takeover` and `started_epoch` with the rest;
`started_epoch` must match `^[0-9]+$`, else the wall time is `not measured` (§5).

Read the first two lines of `<reports>/3-decide.md`:

- **`decide: complete — declined`** → the reason is the second line with its `declined: ` prefix
  removed; a second line without that prefix → the reason `no reason`. The **decline path**: §3
  bind, §7, §5, §9, §10. No gate, no pack, no push.
- **Otherwise** → the **verify path**: §2, §3, §5, §4, §6 (with §8 at its step 4), §9, §10 —
  §5 before §4, because the run cost is the pack's last section.

---

## §2 Gate

Stage 5's completion criteria ([stage-5-verify.md](stage-5-verify.md) §9, Completion),
re-checked against disk before anything leaves the machine, with stage 5's own wording:

1. **The verify report.** The first line of `<reports>/5-verify.md` is `verify: complete`. Else
   `deliver: aborted — no complete verify report`.
2. **The table.** `Glob` `<runs>/verify-*.tsv` and take the file with the highest `k`, read as an
   integer — a round that re-ran took the next `k`, so the highest is the round in effect. One
   `Grep` with count over it for the classification line of [inventory.md](inventory.md) §8,
   `^S[0-9]{2,3} \| (preserved|changed|unverifiable) \| `. No file, or a count of 0 →
   `deliver: aborted — verification table empty`.
3. **The coverage line.** One `Grep` for `^touched-function coverage: ` over `5-verify.md`. No
   match → `deliver: aborted — coverage line missing from 2-characterize.md`.

Each check's result is a `## Gate` line. A failure writes the report (§10) and returns
`aborted`: the run skill's common abort then performs [worktree.md](worktree.md) §7 — the branch
diff stashed to `abort.patch`, the evidence to `abort.md`, the worktree removed, the fence file
cleared — and nothing is pushed.

---

## §3 Bind

1. **The candidate id** matches `^[0-9a-f]{6}$`. Else `deliver: aborted — candidate id out of
   class`: it reaches a `Grep` pattern and the memory line.
2. **Name `<WT>` and `<branch>`** per [worktree.md](worktree.md) §1.
3. **Present, read-only.** `git -C "<CLONE>" worktree list --porcelain` lists `<WT>` on
   `refs/heads/<branch>`. Else `deliver: aborted — worktree absent at deliver`. The stage never
   re-attaches it ([worktree.md](worktree.md) §3): a delivered branch is the one the verify stage
   judged, and a re-attached tree would be one nobody checked.
4. **Clean.** `git --no-optional-locks -C "<WT>" status --porcelain -z --no-renames` is empty, the
   paths on `<runs>/exclusions` aside ([worktree.md](worktree.md) §4). Else
   `deliver: aborted — uncommitted changes in <WT>: <paths>`.

On the decline path only steps 1–3 run, and step 3 finding no worktree is not an abort: the line
`worktree: none` goes under `## Teardown` and §9 skips the worktree's part. A decline pushes
nothing, so a dirty tree there is §9's predicate to judge, not a reason to stop.

---

## §4 The pack

`Write` `<runs>/pack.md` — standing alone for a reviewer who did not watch the run. The stage
writes one paragraph of it itself (section 1); every other line is copied from a report, the
record or the ledger. Each report gets one `Grep -n` `^## ` — its heading map, reused for every
section taken from it — and a section is one bounded `Read` from its heading to the line before
the next; sections that sit next to each other, as `5-verify.md`'s `## Degradations` through
`## Fix round` do, are one `Read`. Never a whole report, except the record.

**Copy rules.**

- A skip or degradation line is carried verbatim and never rewritten as a pass.
- A source section that is missing, or holds `pending`, renders
  `not available — <report> <section> missing` — never an empty section, never a guess.
- Copied text is cleaned of control characters; nothing else in it is changed.
- A `[security]` finding whose outcome is not `applied` — dismissed, deferred, `fix-failed` or
  not attempted — is never copied: the pull request body outlives the pull request, and an
  unpatched vulnerability with its location does not belong in it. Section 4 carries their count
  instead, as `security: <n> findings not applied — see <reports>/5-verify.md ## Reviewers`, and
  the full text stays in that local report.

**The lead**, above section 1, one line each:

1. `deepen run <run-id> · candidate <candidate_id> · branch <branch> · base <base>@<the first 12 characters of BASE_SHA>`.
2. The coverage gap line — the second line of `2-characterize.md` when it starts
   `coverage gap: ` ([coverage.md](coverage.md) §4): below-threshold coverage leads the pack
   ([profile.md](../../setup/references/profile.md) §2, `coverage_threshold`).
3. The run state's `takeover` line when it is not `none` ([preflight.md](preflight.md) §2).
4. Every override line — `Grep` `overridden by the human` over `3-decide.md` and `5-verify.md`,
   each match under its report's name.

**Seven sections**, in this order:

1. **`## Candidate`** — one paragraph the stage writes from the record's `## Candidate` (the
   pick's `name`, `category` and `files`) and its sections 2 and 3: what moves behind which
   interface, in the record's own terms. Then `Named next change: <record section 11>`, and the
   record's `- slice: <k> of <N> — <title>` line when present.
2. **`## Verification`** — `5-verify.md`'s `## Verification`, verbatim: the round, the count per
   class, the full `changed` list with each statement's `before`, `after` and `matched`,
   `accepted` or `unpredicted`, and the lines after it. Then its `## Accepted changes`.
3. **`## Coverage and mutation`** — `5-verify.md`'s `## Coverage`, verbatim; then the uncovered
   list from `2-characterize.md`'s `## Inventory summary`, its lines verbatim, or
   `uncovered: none`; then, from the same section, the fixture count line verbatim — the pack is
   where [profile.md](../../setup/references/profile.md) §6 row 5's UI-fixture line says the count
   is recorded — or `not available — 2-characterize.md fixture count missing`; then
   `5-verify.md`'s `## Mutation`, verbatim — which holds
   `mutation pass skipped — no mutation runner` when the profile has none
   ([profile.md](../../setup/references/profile.md) §6, row 10).
4. **`## Review of the diff`** — `5-verify.md`'s `## Architect verdict`, question by question;
   then its `## Reviewers` — every finding with its decision and outcome, a `[security]` one not
   applied counted rather than copied (the copy rules), or
   `reviewer pass skipped — feature plugin reviewer agents not installed`; then its
   `## Fix round`.
5. **`## Decision record`** — from the record: section 2 (the interface shape), section 6 (the
   `rename_map:` block, as a fenced block), section 8 (the `targets:` line and its `CONTEXT.md` and
   ADR diffs, each as a fenced `diff` block, or `targets: none`); section 5's `delete` lines, and
   its `rewrite` lines under `deleted — a human rewrites these on the pull request`
   ([decision-record.md](decision-record.md) §5); and the record's absolute path.
6. **`## Degradations`** — every line under `## Degradations` in `1-discover.md`,
   `2-characterize.md`, `3-decide.md` and `5-verify.md`, and `4-implement.md`'s degradation lines
   — its report has no such heading, so one `Grep` over it for
   `gate skipped — no runner|spec probes skipped — |install: skipped` — in stage order. Each
   line's own leading `stage <n>: `, when it has one, is removed first; lines are deduplicated on
   that bare text, and each is written once, on its own line, prefixed `stage <n>: ` with the
   first stage that reported it — the verify stage re-derives the characterize stage's lines, so
   those appear once, under stage 2. `none` when there are none.
7. **`## Run cost`** — §5's lines.

**The title.** The pick's `name`, from the record's `## Candidate`, must match
`^[a-z0-9][a-z0-9-]*$` ([candidates.md](candidates.md) §7) — else
`deliver: aborted — pick name out of class`. `Write` `<runs>/pr-title.txt` with
`deepen: <name>`, plus ` — slice <k> of <N>` when the record carries a slice line.

**The size.** GitHub refuses a pull request body over 65,536 characters.
`wc -c < "<runs>/pack.md"` above 65000 → `cp "<runs>/pack.md" "<runs>/pack-full.md"`, then
choose the cuts once, in this order, until the bytes they remove bring the pack under 65000:
section 5's diff blocks, then the longest remaining lists in sections 2 and 4 — each cut replaced
by the line `truncated — full text in <reports>/pack-full.md`. Rewrite `<runs>/pack.md` with one
`Write` carrying every chosen cut, and measure it once more. The lead and sections 1, 3, 6 and 7
are never cut. The report's `## Pack` names each cut. Still above 65000 with every cut taken →
the pack cannot be a pull request body: §6 runs steps 1 and 2, skips the `gh pr create` call, and
takes its failure row with the reason `pack over the body limit after every cut`.

---

## §5 Run cost

On both paths. `Read` `<runs>/cost.tsv`; no ledger → the one line `run cost: ledger missing`.

- **Per agent type** — one line: `<agent type>: <spawns> spawns · <summed tokens> tokens · <summed duration>`,
  with ` + <n> not reported` after a sum that skipped any `not reported` value. A header-only
  ledger → `roles: none spawned`.
- `orchestrator (main conversation): not measured` — the run's own context cannot observe its
  usage, so the pack says so rather than printing zero.
- **Wall time** — `$(( $(date +%s) - <started_epoch> ))` seconds, rendered `<h>h <m>m`;
  `wall time: not measured` when `started_epoch` failed its class (§1).
- **Retries** — from `4-implement.md`: one `Grep` for `attempt` over it, and the lines stating the
  attempts used of the budget and the elapsed wall time, verbatim — the first pass's and every
  re-entry's. No report → `implement: not reached`.

The same lines go into the pack's section 7 and the report's `## Run cost`.

---

## §6 Delivery

Five steps, in this order. The order is what keeps every failure recoverable: the pack is on
disk before anything is pushed, the branch is pushed before a pull request is asked for, and the
memory line is written only for a pull request that exists.

1. **The pack and the title are on disk** (§4).
2. **Push.**

   ```bash
   git -C "<WT>" push -u origin "<branch>"
   ```

3. **The draft.** First the `gh` preconditions, in order, the first failure ending the step:
   `command -v gh`; `gh auth status` exits 0; `git -C "<CLONE>" remote get-url origin` names
   `github.com`, in its `git@github.com:` or `https://github.com/` form. Then, from inside the
   worktree:

   ```bash
   cd "<WT>" && gh pr create --draft --base "<base>" --head "<branch>" \
     --title "$(cat "<runs>/pr-title.txt")" --body-file "<runs>/pack.md"
   ```

   `<base>` is the profile's `base`, class-checked by preflight; `<branch>` passed
   [worktree.md](worktree.md) §1's check. The title goes through a file because a shell literal
   would evaluate backticks and `$(…)` inside it, while the result of a command substitution is
   not evaluated again; the body is only ever `--body-file`. The first line of stdout, trimmed,
   is the URL: it must match
   `^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+$` — the class
   [memory.md](memory.md) §4 reconciles — else step 3 failed.
4. **Memory** — the `opened` line, its note the URL (§8).
5. **Delivered.** Move the pack out of the working files, which the run skill removes at
   completion:

   ```bash
   mv "<runs>/pack.md" "<runs>/pr-title.txt" "<reports>/"
   ```

   with `<runs>/pack-full.md` in the same `mv` when §4 wrote it. The report's `pr:` line is
   `pr: <url>`.

**Draft, always.** Never `gh pr merge`, never auto-merge, never a retry without `--draft`. The
run opens; a human merges or closes.

**When a step fails.** After step 2 began, nothing aborts: the verified change is on its branch,
and an abort would force-remove the worktree that holds it. Every row below still performs step
5's move, so completion cannot delete the pack, and the stage ends `deliver: complete` with the
row's `pr:` line:

| Failed | `pr:` line | Then |
| --- | --- | --- |
| 2 — push | `pr: not opened — push failed: <reason> — branch <branch> (local only) — pack <reports>/pack.md` | steps 3 and 4 skipped |
| 3 — a `gh` precondition | `pr: not opened — gh <not installed \| not authenticated \| origin not on GitHub> — branch <branch> (pushed) — pack <reports>/pack.md — title <reports>/pr-title.txt` | step 4 skipped |
| 3 — `gh pr create`, or its URL out of class | `pr: not opened — gh pr create failed: <reason> — branch <branch> (pushed) — pack <reports>/pack.md — title <reports>/pr-title.txt` | step 4 skipped: with no URL there is nothing to reconcile, so no memory line |
| 4 — memory | `pr: <url>` | the pull request stays open; `## Memory` carries [memory.md](memory.md) §6's line and `memory: add by hand — <the entry>` |

`<reason>` is the command's first stderr line — its first stdout line when stderr is empty —
cleaned: control characters stripped, `|` written `/`, at most 200 characters. A pull request
already open for `<branch>` — a retry by hand, then a re-run — fails `gh pr create` and takes its
row; the by-hand steps below finish it.

---

## §7 Decline

1. **Memory** — the `declined` line, its note §1's reason (§8). `no reason` is recorded as
   `no reason`.
2. **A suggested ADR**, at most one, text only. A reason that states a rule about a class of
   change is a decision the project has made and not written down; drafting it lets the human
   adopt it with one copy.
   - **The cue words**, matched case-insensitively: `always`, `never`, `we don't`, `any `,
     `as a rule`, `by design`, `policy`, `in this repo`. A cue is necessary and not sufficient:
     the reason must read as a rule about a class of change, not about this one candidate. "We
     never put fetch calls behind the store" qualifies; "never mind, not this sprint" does not,
     though both contain `never`. The report names the cue and why the reason reads as a class
     rule — or says `adr: none — <no cue word | about this candidate only>`. `no reason` drafts
     nothing.
   - **The format** mirrors the headings of the newest ADR at `<CLONE>`: `Glob` `docs/adr/*.md`,
     take the highest-numbered file, and one `Grep -n` for `^#` over it — its headings, never its
     body. No ADR → the minimal Nygard shape — Title, `Status: proposed`, Context, Decision,
     Consequences — with the line `no ADR house format found`.
   - **Skip** with `adr: <path> already covers this` when an existing ADR's file name or first
     heading plainly covers the subject.
   - The draft goes under the report's `## Suggested ADR`. Nothing is written to any tree.
3. **No gate, no pack, no push, no pull request.** The report's `pr:` line is
   `pr: none — declined`.

---

## §8 Memory write

[memory.md](memory.md) §6's write, with the entry

```
<candidate_id> | <date +%F> | opened | <url>
<candidate_id> | <date +%F> | declined | <reason>
```

— the first on the verify path, the second on the decline path. The id passed §3's class and
the URL §6 step 3's; the reason is prepared per [memory.md](memory.md) §2. The entry reaches the
file only as an `Edit`'s `new_string`. The report's `## Memory` records the line written and every
report line [memory.md](memory.md) §6 printed — the missing file, an `opened` line replaced.

---

## §9 Teardown

Step 2 of the run skill's exit sequence, in its delivered form ([../SKILL.md](../SKILL.md) §6,
§7), performed here so this report records the outcome — on both paths:

1. **The worktree** — [worktree.md](worktree.md) §8: its predicate (the status empty, the
   exclusion list aside; `refs/heads/<branch>` resolves), then `worktree remove` — with
   `--force` when the status listed exclusion-list paths, and only then — and `worktree prune`.
   The predicate failing → leave it: `worktree: left at <WT> — <the half that failed>`. The
   `remove` exiting non-zero → `worktree: left at <WT> — remove failed: <reason>`, `<reason>`
   cleaned as §6 cleans it; the tree may still hold an exclusion-list copy, so the line is never
   dropped. §3 found none on a decline → `worktree: none`.
2. **The fence file** — remove `<common-dir>/deepen-fence.json` ([fence.md](fence.md) §1), in
   either case; `<common-dir>` is
   `git -C "<CLONE>" rev-parse --path-format=absolute --git-common-dir`.
3. **`## Teardown`** — `worktree: removed`, the left line or `worktree: none`;
   `branch: <branch> kept (pushed | local)`; `fence: cleared`.

The run branch is kept on every path — pushed on delivery, local on a decline or a failed push.
The clone check, the scratch files, `runs/<run-id>/` and the lock, last, belong to the run
skill's completion (§7), after this stage returns.

---

## §10 Report

`<report>`, standing alone for a reader who did not watch, written with one `Write` when the
stage reaches its status:

1. The status line ([../SKILL.md](../SKILL.md) §3's grammar) — `deliver: complete`, or
   `deliver: aborted — <the line>`.
2. The `pr:` line — `pr: <url>`, a §6 failure row's line, or `pr: none — declined`.
3. `## Gate` — §2's three results, or `skipped — declined`.
4. `## Pack` — `<reports>/pack.md` and its size in bytes, and each cut §4 made; or
   `none — declined`.
5. `## Memory` — §8.
6. `## Suggested ADR` — §7's draft or its `adr:` line; `none` on the verify path.
7. `## Run cost` — §5.
8. `## Teardown` — §9.
9. `## Decisions` — `none`: the grammar keeps the heading, and this stage asks nothing.

An abort (§2, §3, §4) writes the status line, `## Gate` and every section it reached, the rest
holding `pending`, and returns: the run skill's common abort takes it from there.

### By hand

A `pr: not opened` line, or a session that died after the push, leaves what a human needs to
finish: the branch, the pack and the title. Run from `<CLONE>`, with an explicit `--head` —
`<CLONE>` sits on `base`, so `gh` would otherwise take `base` as the head:

```bash
gh pr create --draft --base "<base>" --head "<branch>" \
  --title "$(cat "<reports>/pr-title.txt")" --body-file "<reports>/pack.md"
```

A session that died before step 5 left the pack and the title under `<runs>/` instead; push
first — `git -C "<CLONE>" push -u origin "<branch>"` — when the push never happened. Then add the
`opened` line to `<state_dir>/memory.md` in [memory.md](memory.md) §2's form. A dead session also
held the lock: it goes stale after 24 hours, or the run skill's §5 remedy releases it now.
