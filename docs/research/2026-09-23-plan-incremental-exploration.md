# What plan's incremental explorer adds

Measured on 2026-09-23 from six plan runs whose ticket carried a discover-written `exploration.md`. Everything below is counted from transcripts and ticket artifacts unless marked *estimate*. Evidence in [`2026-09-23-plan-incremental-exploration-evidence/`](2026-09-23-plan-incremental-exploration-evidence/): `explorer_reads.py` (the parser), `results.json` (its output), and a README with the re-run commands. Units and turns come from [`scripts/measure-session.py`](../../scripts/measure-session.py) `--json`, the maintained measurement; units are its weighted input-token equivalents.

The question: plan's Phase 1 Step 1.2 spawned `code-explorer` for *incremental* exploration whenever `exploration.md` existed, with an open-ended prompt. How much of what that explorer read did `exploration.md` already hold, what of its output reached `02-plan.md`, and when could the spawn have been skipped or bounded?

## 1. Corpus

| Ticket | Session | Explorer agent | `exploration.md` date | Explorer started | Shape |
|---|---|---|---|---|---|
| FP-109 | `9f881c61` | `af1913e1abdfd5f9b` | 2026-09-19 | 2026-09-19 09:01Z | solo, flow |
| FP-120 | `cf946ddc` | `a59b4bd0083d046cd` | 2026-09-23 | 2026-09-23 14:15Z | solo, flow |
| FP-116 | `13957db5` | `aa9255e14c044d662` | 2026-09-20 | 2026-09-22 11:41Z | solo, flow |
| FP-85 | `012fe8f0` | `a0fa15b939ef79321` | 2026-09-16 (epic FP-84) | 2026-09-16 19:58Z | epic child, ship |
| FP-86 | `012fe8f0` | `a51c498b7a8dd2c4e` | 2026-09-16 (epic FP-84) | 2026-09-17 05:57Z | epic child, ship |
| FP-87 | `012fe8f0` | `a502425adddd0aaa4` | 2026-09-16 (epic FP-84) | 2026-09-16 21:14Z | epic child, ship |

`012fe8f0` is the `measure-session.py` regression-anchor session; it held three incremental explorers, one per FP-84 child, so all three are in the corpus. Every explorer is matched by `agentType: feature:code-explorer`, a description naming the ticket, and a prompt carrying plan's incremental framing.

Ticket artifacts are under `claudedocs/tickets/done/` (FP-84's children under `claudedocs/tickets/done/FP-84/tasks/`), which is gitignored; they are cited here as paths only.

## 2. Per-run figures

| Ticket | Turns | Units | Share of run | Tool calls | Repo files read | …already cited by `exploration.md` | New files that reached `02-plan.md` | …of those, not named by the spec |
|---|---|---|---|---|---|---|---|---|
| FP-109 | 27 | 497k | 15.5% | 45 | 19 | 10 | 8 | 5 |
| FP-120 | 36 | 734k | 13.3% | 63 | 24 | 19 | 2 | 2 |
| FP-116 | 19 | 502k | 6.9% | 38 | 20 | 13 | 7 | 1 |
| FP-85 | 35 | 612k | — | 52 | 12 | 6 | 3 | 3 |
| FP-86 | 25 | 490k | — | 39 | 8 | 2 | 1 | 1 |
| FP-87 | 25 | 502k | — | 41 | 13 | 8 | 2 | 2 |
| **Total** | **167** | **3.34M** | | **278** | **96** | **58 (60%)** | **23** | **14** |

- *Share of run* is the explorer's units over the session's; the three FP-84 explorers together are 1.60M of the anchor session's 31.4M (5.1%), and a per-child session total does not exist.
- *Tool calls* are every call the explorer made (Read, Grep, Glob, WebFetch). FP-109's 45 matches the figure the ticket was opened on (27 turns, 45 read calls, 497k units).
- Of the 112 Read calls on repo files, 23 (21%) were on a new file that later appeared in `02-plan.md`. The other 89 re-read cited files or read files the plan never cited.
- Each explorer began from a first-turn floor of 26.7–27.6k (solo runs, plugin 3.9.x and later) or 47.7–48.9k (FP-84 children, plugin 3.6.0).

## 3. What `exploration.md` already covered

A spec-named path counts as covered when `exploration.md` cites it, by full path or by an unambiguous suffix such as `flow/SKILL.md:180`. Paths the ticket creates do not exist at plan time and are excluded (`to_create`). Items come from the spec's Description, Acceptance Criteria, Design Notes and Constraints.

| Ticket | Named existing paths | Uncovered by `exploration.md` | Uncovered by `exploration.md` + `AGENTS.md`/`CLAUDE.md` | `exploration.md`-covered paths changed between its Date and the run |
|---|---|---|---|---|
| FP-109 | 11 | 7 — both manifests, `advanced.md`, four `check-*.sh` | 0 | 0 |
| FP-120 | 27 | 1 — `check-mode-split.sh` | 0 | 0 |
| FP-116 | 14 | 6 — both manifests, four `check-*.sh` | 0 | 2 (`close-stage/SKILL.md`, `runtime-claude.md`) |
| FP-85 | 1 (+4 to create) | 0 | 0 | 0 |
| FP-86 | 1 (+2 to create) | 0 | 0 | 1 (`CLAUDE.md`) |
| FP-87 | 2 (+2 to create) | 0 | 0 | 0 |

Freshness is tested only on the paths `exploration.md` covers. A path covered by the instruction files is known from those files as they stand, so it cannot be stale in the sense that matters; testing it would bound every run after any release, since the manifests change with every PR.

Two things the numbers show:

1. **The uncovered items are the same boilerplate every time.** Every spec in this repo names the two `feature` manifests (the version bump) and the `scripts/check-*.sh` validators. No `exploration.md` cites them, because discover explores the feature, not the release routine — but `AGENTS.md` names every one of them, and plan has `AGENTS.md` loaded. A test on `exploration.md` citations alone would bound every run that names an existing file; counting the project instruction files as a coverage source is what makes a skip reachable at all.
2. **Staleness is real and cheap to detect.** FP-116's exploration was two days old and two of its covered paths had changed; FP-86 ran the morning after an FP-85 commit touched `CLAUDE.md`. One `git log --since="<Date> 00:00" --name-only` over the covered paths finds both. The explicit `00:00` matters: `--since=<YYYY-MM-DD>` alone takes the current time of day and silently drops that day's earlier commits.

## 4. What the plan used

The explorer's contribution to `02-plan.md` is small and specific: 23 new files across six runs, 1–8 per run. The files it re-read that `exploration.md` already cited contributed nothing new by construction — they were already in the explorer's own prompt.

Fourteen of the 23 were not named by the spec, so a scoped run would not have been told to look for them:

| Ticket | Plan-used files the explorer found outside the spec's named paths |
|---|---|
| FP-109 | `docs/contributing/validation.md`, `flow/references/state-transitions-fs.md`, `flow/references/ticket-resolution-fs.md`, `review/references/pr-comments.md`, `ship/references/storage-server.md` |
| FP-120 | `flow/references/storage.md`, `setup/references/storage-fs.md` |
| FP-116 | `docs/contributing/tool-budgets.md` |
| FP-85 | `build/references/test-preflight.md`, `review/references/pr-comments.md`, `scripts/check-tool-parity.sh` |
| FP-86 | `tidy-loop/checks/ts-vitest/exported-surface.mjs` |
| FP-87 | `tidy-loop/checks/CONTRACT.md`, `tidy-run/references/ledger.md` |

These are integration points — mode-pair siblings, references a covered file links to, lockstep docs. Whether plan's own design reads or the requirements analyst would have found them without the explorer is not measurable from these transcripts: both run after the explorer and receive its output. That counterfactual is what §6's replay tests.

## 5. Rule derivation

**Skip test outcome per run.** Applying the test — every existing named path covered by `exploration.md` or the project instruction files, and none changed since the exploration's Date:

| Ticket | Outcome | Scope when bounded |
|---|---|---|
| FP-109 | skip | — |
| FP-120 | skip | — |
| FP-116 | bounded | 2 stale paths |
| FP-85 | decided on named areas (only path named exists and is covered) | — |
| FP-86 | bounded | 1 stale path (`CLAUDE.md`) |
| FP-87 | decided on named areas | — |

The two skips are the two same-day explorations. The two runs whose exploration had aged past a commit are bounded. That is the split the rule is for.

**What a skip gives up.** On FP-109 and FP-120 the explorer supplied 7 plan-used files outside the spec's named paths (§4). A skip hands that search to the analyst and plan's design phase, which hold the same read tools. The rule keeps the skip, and records the decision line in `02-plan.md` so a missed integration point is traceable to it; §6 tests the FP-109 case directly.

**Read cap.** Per listed item, **6 Read/Grep/Glob calls**, as a soft cap the explorer approximates. Derivation: calls per plan-used new file were 45/8 = 5.6 (FP-109) and 38/7 = 5.4 (FP-116) on the two highest-yield runs, and 17–39 on the other four; the cap is the best observed yield rounded up, so a scoped run is budgeted at what the most productive runs actually spent per useful file. *Estimate* of the effect on the two bounded runs: FP-116's 2 items → 12 calls against 38 spent; FP-86's 1 item → 6 against 39.

**Stop condition.** Return once every listed item has a `file:line` answer; do not re-read a file `exploration.md` cites except at the cited lines; do not explore outside the listed items. The second clause targets the largest measured waste: 58 of the 96 repo files the explorers read (60%) were already cited in the prompt they were given.

**Epic children.** An epic's `exploration.md` is shared and written once, so its Date ages across the children. The Date test handles that with no special case: FP-86, run the morning after its sibling's commit, is bounded to the one changed path. On an integration branch, `git log` in the working checkout sees sibling commits, which is the intended signal. Paths a blocker creates exist in that checkout and are tested like any other.

## 6. Verification

A headless replay of FP-109's plan stage on the new rule (plugin 3.13.1), recorded in [`verification.json`](2026-09-23-plan-incremental-exploration-evidence/verification.json).

**Setup.** A detached git worktree at `db5f9e2`, the main-branch parent of FP-109's first commit, holding `claudedocs/tickets/config.yaml` and FP-109's `01-spec.md` (status reset to `backlog`) and `exploration.md` — the inputs the original plan stage had. The lessons log was left out, so no entry written after 2026-09-19 could reach the analyst. Run from the worktree:

```bash
claude -p "/feature:plan FP-109 --auto" \
  --plugin-dir <repo>/plugins/feature \
  --settings '{"enabledPlugins":{"feature@feature-pipeline":false}}' \
  --permission-mode auto --output-format json
```

This replays `plan`, not a whole `flow`: Step 1.2 behaves the same under both, and a headless `flow` would go on to build and close a ticket that already shipped. The plan ran standalone in the root session rather than as a flow stage subagent, so only the explorer's figures are compared, not the session totals.

**Decision.** `Incremental exploration: scoped to 1 item — ship's nonce-delimited quoted-heredoc discipline.` Every named path was covered and fresh, as §5 predicted for the paths; the one item left open was a named *area* — the spec asks for ship's nonce-heredoc discipline, which `exploration.md` does not cite — so the area half of the test turned the predicted skip into a one-item bounded run.

| | Turns | Units | Tool calls |
|---|---|---|---|
| Original explorer (open-ended) | 27 | 497k | 45 |
| Replay explorer (scoped, budget 6) | 8 | 111k | 10 |

The explorer cost fell by 78%. It overran its soft budget of 6 calls by 4, which is within what a prompt-level cap is expected to do.

**Plan comparison.** Read side by side, the two `02-plan.md` files make the same design: a §8 write-back section added to the ship storage pair in lockstep, a write-back step in `ship/references/ui-verification.md`, ship's tool budget and SKILL.md wiring, docs, version and validators — three steps each, with the same integration points (the storage pair, `pr-comments.md`'s nonce heredoc, `keying-fs.md`/`keying-server.md` routing, `state-transitions-fs.md` for where tickets sit at run end). By cited file, Codebase Context and Implementation Steps share 18 files. The original alone cites 6: `ui-tester.md`, close-stage's `storage-server.md`, `flow/SKILL.md` and `ticket-resolution-fs.md` (context only, their routing and search-order points covered in the replay through `keying-*.md` and `state-transitions-fs.md`), and two validator scripts, which the replay names in Critical Details instead. The replay alone cites `build/references/commit.md` and `flow/references/storage-server.md`.

**What the skip risk looked like in practice.** §4 counted 5 plan-used files that only the original explorer found. The replay plan cites 4 of them without that explorer; the fifth, `ticket-resolution-fs.md`, was a search-order citation the replay covered from another file. On this run the risk §5 names did not materialize, so the skip condition stays as written. One run is not a distribution: the decision line in every plan's Codebase Context is what lets a later miss be traced back to a skip.
