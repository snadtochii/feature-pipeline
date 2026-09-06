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

An epic run's integration-PR title reads the epic PRD via command substitution: `EPIC_TITLE=$(sed -n 's/^title: *//p' <epic-folder>/prd.md | head -1)`. Per-ticket PR linkage is complete once build has recorded the PR URL and branch in the ticket's `06-summary.md` at PR creation; the post-PR linkage step reads and records nothing further on the ticket.

## §5 In-review evidence and recovery

A ticket `flow --pr` built sits at status `in-review` in the `review/` folder (Transition 5). On recovery the ticket folders are the record: a ticket in `review/` is at the in-review stage; its open PR is found by the `<ID>:` title search. A `--parallel` recovery reconciles ticket state against the on-disk evidence as folders plus `status` frontmatter.

## §6 Parallel-walk state forms

Every shared mutation in a `--parallel` run is orchestrator-only, in the forms [`../../flow/references/state-transitions-fs.md`](../../flow/references/state-transitions-fs.md) prescribes — folder moves plus frontmatter edits:

- **Worker brief, state clause** — the `<STATE_CLAUSE_BLOCK>` (§3).
- **Transition 1, epic run** — the epic subtree's folder move plus `prd.md` status, before any dispatch; each child's `status` set to `in-progress` at its dispatch.
- **Transition 5** — multi-solo ticket: status `in-review`, folder → `review/`. Epic child: status `in-review`, plus T5's subtree location check — while any sibling is still `in-progress` the subtree stays put; once none is and at least one child is `in-review` (typically at the last child) the whole epic subtree moves to `review/` with `prd.md` status `in-review`.
- **Transition 4** (a failed worker's ticket) — the `status: partial-completion` frontmatter flip.

## §7 UI evidence home and hosting

Screenshots go to `<ticket-folder>/screenshots/<AC>.png` — the same per-ticket home as `03-implementation.md`; for an epic pass, the epic folder `<epic-folder>/screenshots/`. Storing them with the ticket makes them the ticket's durable UI-test evidence. Whether they are hostable depends on the consumer's `.gitignore` (a repo may track or ignore `claudedocs/tickets/`): run `git check-ignore "<ticket-folder>/screenshots"` (mirror the pre-write guard in `debug` and build's `--pr` flow) and take the **Tracked** or **Ignored** outcome in `ui-verification.md` step 3 accordingly.
