# Ship — fs-native Storage Mechanics

Canonical logic for ship's storage-touching steps in fs-native storage mode. Read when the storage mode detected at ship's SETUP per [`../../flow/references/storage.md`](../../flow/references/storage.md) is fs-native — a run in the other storage mode never needs this file. Referenced by `ship`, and by [`parallel-walk.md`](parallel-walk.md) / [`reviewer-prompt.md`](reviewer-prompt.md) / [`ui-verification.md`](ui-verification.md) on ship's behalf. Operations named below are defined in [`../../flow/references/storage-fs.md`](../../flow/references/storage-fs.md); sections are numbered so the skill body and its references cite `§N`. Subagent briefs inline the text §3 resolves — a subagent never reads this file.

## §1 Ticket metadata and roster

Read ticket metadata reads frontmatter: `kind` from an epic folder's `prd.md`; `parent` and `blocked_by` from a solo or child `01-spec.md`; and — under `--parallel` — `repos:` where present, the lane-partition input SETUP step 4 consumes. An **epic run's roster** is the materialized children: glob `<epic-folder>/tasks/*/01-spec.md` and ship the IDs that resolve to a real spec; skip any declared-but-unwritten child (a just-in-time epic declares its full `children:` roster upfront but authors child specs later, as the pipeline reaches each phase) and list the skipped IDs in the run report — never attempt to flow a child whose `01-spec.md` does not yet exist. A run whose tickets carry no `repos:` value is one lane.

## §2 Lessons store

The store is `claudedocs/tickets/_lessons.md`. Consume it per [`../../flow/references/lessons-log-fs.md`](../../flow/references/lessons-log-fs.md) §8 — grep by the subject keywords the shipped tickets touch, never full-load. A `--parallel` run's end-of-run lessons write applies that contract's §4–§5 (supersession scan, merge-in-place, prefer-newest) to the same file, one candidate at a time.

## §3 Ground truth in subagent briefs

Four placeholders in the brief templates resolve here; the orchestrator fills them before spawning.

- **`<TICKET_ARG_BLOCK>`** — the ticket's identity is its spec path, `claudedocs/tickets/<state>/<EPIC>/tasks/<ID>/01-spec.md` (or `<state>/<ID>/01-spec.md` for a solo ticket). Under `--parallel` the path is **absolute, into the main checkout**, and Step 1's `Skill feature:flow` invocation takes the **absolute ticket-folder path** as its ticket argument (the path form of ticket-resolution Step 1) — never the bare ID. ID-form resolution globs `claudedocs/tickets/…` relative to the worker's cwd — the worktree — and fails both ways there (check which with `git check-ignore -q claudedocs`, never assume): ignored → no ticket tree in the worktree, so an unattended worker stalls at resolution's "ask the user"; tracked → a stale fork-point copy, which the worker would resolve and mutate instead of the real ticket. The absolute path sidesteps both. Stage artifacts (`02-plan.md` … `06-summary.md`) land in that main-checkout ticket folder — per-ticket paths, so concurrent workers never collide. In a multi-repo workspace the ticket tree is workspace-level (`claudedocs/tickets/` sits at the workspace root, above every repo), so the absolute path points into the workspace checkout, not into any repo.
- **`<GROUND_TRUTH_BLOCK>`** — fill the reviewer template's placeholder with the text below, substituting `<SPEC_PATH>` with the spec path resolved above:
  ```
  GROUND TRUTH is the ticket spec at <SPEC_PATH> — read it and judge the diff against it.
  For carry-forward gotchas, grep claudedocs/tickets/_lessons.md by subject for the keywords
  this ticket touches (paths, tools, commands, areas) and read only the matching atomic
  entries — do not load the whole file.
  ```
- **`<AC_SOURCE_BLOCK>`** — the `ui-tester` brief names the spec path(s) whose acceptance criteria it verifies.
- **`<STATE_CLAUSE_BLOCK>`** (`--parallel` worker briefs) — "Do not perform ticket state transitions: no folder moves, no `status:` frontmatter edits in any `01-spec.md` or `prd.md`. Do not write to `claudedocs/tickets/_lessons.md`."

## §4 PR linkage

An epic run's integration-PR title reads the epic PRD via command substitution: `EPIC_TITLE=$(sed -n 's/^title: *//p' <epic-folder>/prd.md | head -1)`. Per-ticket PR linkage is complete once the close stage's finalizer has recorded the PR URL and branch in the ticket's `06-summary.md` at PR creation; the post-PR linkage step reads and records nothing further on the ticket.

## §5 In-review evidence and recovery

A ticket `flow --pr` built sits at status `in-review` in the `review/` folder (Transition 5). On recovery the ticket folders are the record: a ticket in `review/` is at the in-review stage; its open PR is found by the `<ID>:` title search. A `--parallel` recovery reconciles ticket state against the on-disk evidence as folders plus `status` frontmatter.

## §6 Parallel-walk state forms

Every shared mutation in a `--parallel` run is orchestrator-only, in the forms [`../../flow/references/state-transitions-fs.md`](../../flow/references/state-transitions-fs.md) prescribes — folder moves plus frontmatter edits:

- **Worker brief, state clause** — the `<STATE_CLAUSE_BLOCK>` (§3).
- **Transition 1, epic run** — the epic subtree's folder move plus `prd.md` status, before any dispatch; each child's `status` set to `in-progress` at its dispatch.
- **Transition 5** — multi-solo ticket: status `in-review`, folder → `review/`. Epic child: status `in-review`, plus T5's subtree location check — while any sibling is still `in-progress` the subtree stays put; once none is and at least one child is `in-review` (typically at the last child) the whole epic subtree moves to `review/` with `prd.md` status `in-review`.
- **Transition 4** (a failed worker's ticket) — the `status: partial-completion` frontmatter flip.

## §7 UI evidence home and hosting

Screenshots go to the evidence home declared in [the close stage's `storage-fs.md`](../../close-stage/references/storage-fs.md) §8 — its location, its epic form and its gitignore expectation live there — with the filenames fixed by [`ui-checks.md`](../../build/references/ui-checks.md) §3. Whether they are hostable is ship's decision: run `git check-ignore "<evidence-home>"` (mirror the pre-write guard in `debug` and build's `--pr` flow) and take the **Tracked** or **Ignored** outcome in `ui-verification.md` step 3 accordingly.

## §8 UI verification write-back

`ui-verification.md` step 4 invokes this section once per covered ticket, with that ticket's parsed tester result in hand. It rewrites two files in the ticket folder: `05-tests.md` as a whole, and one section of `06-summary.md`.

**Target folder.** Re-resolve the ticket folder immediately before writing — never reuse the path SETUP resolved for §3, because the run's own transitions moved the folder since. A solo or multi-solo ticket resolves by the search order in [`../../flow/references/ticket-resolution-fs.md`](../../flow/references/ticket-resolution-fs.md); an epic child by `Glob` `claudedocs/tickets/*/<EPIC>/tasks/<ID>/`, since the epic subtree moves as a unit and the child never leaves `tasks/`. The result is an absolute path. No match, or more than one → write nothing for that ticket and report it.

**`05-tests.md` body.** A whole-file overwrite; nothing of the skip body the close stage wrote under `--no-ui-testing` is kept.

```
Source: ship end-of-run UI verification — branch <assembled-branch> @ <sha>
verdict: <pass | partial>

## Acceptance Criteria
- [x] AC <n> — PASS — <tester's note>
- [ ] AC <n> — FAIL — <tester's note>

## Failed Criteria
<one entry per failed criterion or failed required UI check: what failed, where, the screenshot name; for an epic child, the epic-wide required-check failures too, each marked epic-wide>

## Observations
<the tester's non-failing notes; for an epic child, the epic-wide notes too, each marked epic-wide>
```

- `<sha>` is the commit under test: `git rev-parse HEAD` of the checked-out assembled branch at test time, or the Tracked outcome's `<pushed-sha>` when step 3 pushed screenshots on top of it.
- The provenance line is first and `verdict:` second on purpose. Routers read only `06-summary.md`'s first line, never this file's, and the provenance line is what tells a reader this result came from ship's pass rather than a close-stage checkpoint.
- One `## Acceptance Criteria` line per criterion of this ticket, numbered as its own spec numbers them.
- `## Failed Criteria` is present only when a criterion or a required UI check failed — a required-check failure the tester listed against the implicit `UI states (required check)` criterion counts, even with no numbered criterion to attach it to. `## Observations` holds only non-failing notes, never a failure.

**Verdict rule.** Every criterion and every required UI check passed → `pass`. `## Failed Criteria` present → `partial`. `fail` is never written.

**Write mechanics.** Ship holds Bash and no `Write`, so each file is written by one Bash call: a single-quoted heredoc redirected to the absolute target path, `cat > "<ticket-folder>/05-tests.md" <<'<nonce>'`. The delimiter is a fresh nonce per write, verified absent from every line of the body before the call is composed; regenerate it on a collision. The quoted delimiter disables all expansion, so backticks, `$()` and quotes in tester text land as file content. Tester text never appears on a command line and never passes through `eval` — the discipline of [`../../review/references/pr-comments.md`](../../review/references/pr-comments.md) §5 and §7.

**`06-summary.md` section.** `Read` the file, then compose its new whole body: the existing content with any prior `## UI verification` section removed, followed by

```
## UI verification
- verdict: <pass | partial> (ship end-of-run pass, branch <assembled-branch> @ <sha>)
- evidence: <URL of the PR the evidence was posted to>
- results: 05-tests.md
```

Write it with the same heredoc discipline. The first line — the close stage's verdict — and every other section stay as written; a rerun replaces the section rather than adding a second one. A ticket without `06-summary.md` gets no summary write, and the gap is reported.

**Order and scope.** `05-tests.md` is written before `06-summary.md`, so the summary is never older than it. Neither file is staged or committed — [`commit.md`](../../build/references/commit.md) §1 excludes `claudedocs/`, and the Tracked outcome stages only the evidence home. No `status:` frontmatter changes and no folder moves.

**Failure.** A write that fails is reported in the run report, naming the ticket and the artifact, and the run continues to its normal open/merge ending.

## §9 Close record

Hop verification reads the ticket's close record from its folder with `Read`: `06-summary.md`'s validation and test lines, and `04-review.md`'s `## Post-review validation` section. Step 2's provenance comment takes the review stage's result from the same `04-review.md`. Locate the folder as §8's **Target folder** does, immediately before the read — an epic child's subtree stays in `in-progress/` while a sibling is still in progress (§6), so the folder is never assumed to be in `review/`.
