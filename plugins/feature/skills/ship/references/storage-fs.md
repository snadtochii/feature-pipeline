# Ship — fs-native Storage Mechanics

Canonical logic for ship's storage-touching steps in fs-native storage mode. Read when the storage mode detected at ship's SETUP per [`../../flow/references/storage.md`](../../flow/references/storage.md) is fs-native — a run in the other storage mode never needs this file. Referenced by `ship`, and by [`parallel-walk.md`](parallel-walk.md) / [`reviewer-prompt.md`](reviewer-prompt.md) / [`ui-verification.md`](ui-verification.md) on ship's behalf. Operations named below are defined in [`../../flow/references/storage-fs.md`](../../flow/references/storage-fs.md); sections are numbered so the skill body and its references cite `§N`. Subagent briefs inline the text §3 resolves — a subagent never reads this file.

## §1 Ticket metadata and roster

Read ticket metadata reads frontmatter: `kind` from an epic folder's `prd.md`; `status`, `parent` and `blocked_by` from a solo or child `01-spec.md`; and, on every run, `repos:` where present — from each selected ticket's `01-spec.md`, every child of an expanded epic included. `repos:` is the end-of-run UI pass's selection input ([`test-preflight.md`](../../close-stage/references/test-preflight.md) Entry selection, applied per [`ui-verification.md`](ui-verification.md) step 0), the skip rules' and the target rules' input at SETUP step 1, and the lane record's input. An **epic's roster** is the materialized children: glob `<epic-folder>/tasks/*/01-spec.md` and ship the IDs that resolve to a real spec; skip any declared-but-unwritten child (a just-in-time epic declares its full `children:` roster upfront but authors child specs later, as the pipeline reaches each phase) and list the skipped IDs in the run report — never attempt to flow a child whose `01-spec.md` does not yet exist.

**Not found or unreadable.** An ID resolves by the search order of [`ticket-resolution-fs.md`](../../flow/references/ticket-resolution-fs.md) Step 1, with no question to the user: no match is SETUP step 1's `ticket not found`, and a spec or `prd.md` whose frontmatter cannot be read is its `ticket unreadable`.

**Lane binding.** A `done` or `cancelled` ticket is not walked and binds no lane. One `repos:` entry binds that workspace child, which must pass the in-place repository check in [`ticket-resolution-fs.md`](../../flow/references/ticket-resolution-fs.md) Step 3; failing it leaves the ticket unbound. An `in-review` ticket naming 2+ tests only the entries that pass that check, and binds the entry whose `origin` names the `<owner>/<repo>` of the `pr:` line in its `06-summary.md`, read and checked as [`ticket-resolution-fs.md`](../../flow/references/ticket-resolution-fs.md) Step 6 reads it, and the run treats that entry as the ticket's whole `repos:` value, Entry selection included; no `pr:` line, or no match, leaves it unbound. No `repos:` binds the project root, once `git -C "<project-root>" rev-parse --is-inside-work-tree` confirms it is a repository.

**Merged test.** SETUP step 2 decides an unselected `in-review` sibling blocker with the merged-sibling commands of [`ticket-resolution-fs.md`](../../flow/references/ticket-resolution-fs.md) Step 6, as written there: the PR URL loaded from the `pr:` line of the blocker's `06-summary.md` and checked the same way, the lane's `<repo-path>` as `<build checkout>`, and `origin/<the branch SETUP step 2 names for the dependent>` in place of `HEAD`. Exit 0 is met; anything else fails closed.

## §2 Lessons store

The store is `claudedocs/tickets/_lessons.md`. Consume it per [`../../flow/references/lessons-log-fs.md`](../../flow/references/lessons-log-fs.md) §8 — grep by the subject keywords the shipped tickets touch, never full-load. Each ticket's lessons write applies that contract's §4–§5 (supersession scan, merge-in-place, prefer-newest) to the same file with `Edit`, one candidate at a time; a missing store is created first with its header by §8's nonce heredoc, and lesson text never enters that command. Before each candidate's §4 search and bounded `Read`, print the line count that section takes from its caller with `wc -l < claudedocs/tickets/_lessons.md`, run from the project root: a number, never the store's content.

## §3 Ground truth in subagent briefs

Four placeholders in the brief templates resolve here; the orchestrator fills them immediately before each spawn, because Transition 1 and Transition 5 move a solo ticket's folder.

- **`<TICKET_ARG_BLOCK>`** — the ticket's identity is its spec path, `claudedocs/tickets/<state>/<EPIC>/tasks/<ID>/01-spec.md` (or `<state>/<ID>/01-spec.md` for a solo ticket). The path is **absolute, into the main checkout**, and Step 1's `Skill feature:flow` invocation takes the **absolute ticket-folder path** as its ticket argument (the path form of ticket-resolution Step 1) — never the bare ID. ID-form resolution globs `claudedocs/tickets/…` relative to the worker's cwd — a worktree, on a worktree lane — and fails both ways there (check which with `git -C "<repo-path>" check-ignore -q claudedocs`, never assume): ignored → no ticket tree in the worktree, so an unattended worker stalls at resolution's "ask the user"; tracked → a stale fork-point copy, which the worker would resolve and mutate instead of the real ticket. The absolute path sidesteps both. Stage artifacts (`02-plan.md` … `06-summary.md`) land in that main-checkout ticket folder — per-ticket paths, so concurrent workers never collide. In a multi-repo workspace the ticket tree is workspace-level (`claudedocs/tickets/` sits at the workspace root, above every repo), so the absolute path points into the workspace checkout, not into any repo.
- **`<GROUND_TRUTH_BLOCK>`** — fill the reviewer template's placeholder with the text below, substituting `<SPEC_PATH>` with the spec path resolved above:
  ```
  GROUND TRUTH is the ticket spec at <SPEC_PATH> — read it and judge the diff against it.
  For carry-forward gotchas, grep claudedocs/tickets/_lessons.md by subject for the keywords
  this ticket touches (paths, tools, commands, areas) and read only the matching atomic
  entries — do not load the whole file.
  ```
- **`<AC_SOURCE_BLOCK>`** — the `ui-tester` brief names the spec path(s) whose acceptance criteria it verifies.
- **`<STATE_CLAUSE_BLOCK>`** (worker briefs) — "Do not perform ticket state transitions: no folder moves, no `status:` frontmatter edits in any `01-spec.md` or `prd.md`. Do not write to `claudedocs/tickets/_lessons.md`."

## §4 PR linkage

An integration PR's title reads the epic PRD via command substitution: `EPIC_TITLE=$(sed -n 's/^title: *//p' <epic-folder>/prd.md | head -1)`, with `<epic-folder>` located by `Glob` `claudedocs/tickets/*/<EPIC>/prd.md`, since a run that selected children may not have named the epic. Per-ticket PR linkage is complete once the close stage's finalizer has recorded the PR URL and branch in the ticket's `06-summary.md` at PR creation; the post-PR linkage step reads and records nothing further on the ticket. A reused integration PR adds nothing to record.

## §5 In-review evidence and recovery

A ticket ship built sits at status `in-review` (the orchestrator's Transition 5): a solo ticket in the `review/` folder, an epic child wherever §6 leaves its subtree. On recovery the `status` frontmatter and the folders are the record: a ticket at `in-review` is at the in-review stage; its open PR is found by the `<ID>:` title search against the lane's repository, or, for an `in-review` ticket naming 2+ repos, by the `pr:` line of its `06-summary.md`. **Pending Transition 5:** the ticket's own linkage is the evidence, never a title search, because anyone who can open a PR can match a title. An `in-progress` ticket died between the PR opening and the transition when the `pr:` line of its `06-summary.md`, read and checked as [`ticket-resolution-fs.md`](../../flow/references/ticket-resolution-fs.md) Step 6 reads it, names a PR in the lane's `<owner/repo>`, and `gh pr view "$PR_URL" --json state,isCrossRepository,headRefName,baseRefName` reports it `OPEN`, not cross-repository, with a head equal to that file's `branch:` line, loaded the same way. Apply `SKILL.md` Recovery's base check, fire Transition 5 and skip Step 1. Anything else leaves the ticket to Step 1. Recovery reconciles ticket state against the on-disk evidence as folders plus `status` frontmatter.

## §6 Orchestrator state forms

Every shared mutation in a run is orchestrator-only, in the forms [`../../flow/references/state-transitions-fs.md`](../../flow/references/state-transitions-fs.md) prescribes — folder moves with `Bash`, `status` frontmatter edits with `Edit`:

- **Worker brief, state clause** — the `<STATE_CLAUSE_BLOCK>` (§3).
- **Transition 1** — before the ticket's first worker: the transition's solo or child form, whichever fits the ticket. The child form carries the epic subtree's folder move and `prd.md` status.
- **Transition 5** — solo ticket: status `in-review`, folder → `review/`. Epic child: status `in-review`, plus T5's subtree location check — while any sibling is still `in-progress` or `backlog`, or a declared child is not yet materialized, the subtree stays put; once the Epic-review condition holds — every declared child `in-review` or terminal, at least one `in-review` (typically at the last child) — the whole epic subtree moves to `review/` with `prd.md` status `in-review`. While a child failed or was skipped in this run, the child flips only, with no subtree move and no `prd.md` flip.
- **Transition 4** (a failed ticket) — the `status: partial-completion` frontmatter flip.

## §7 UI evidence home and hosting

Screenshots go to the evidence home declared in [the close stage's `storage-fs.md`](../../close-stage/references/storage-fs.md) §8 — its location, its epic form and its gitignore expectation live there — with the filenames fixed by [`ui-checks.md`](../../build/references/ui-checks.md) §3. When an epic's pass has two or more selected entries ([`ui-verification.md`](ui-verification.md) step 0), each pass writes to `<home>/<repo>/` — `<home>` being that section's epic-level home and `<repo>` the pass's validated `test.repos` key — the close stage's per-repo form applied to it; with one selected entry the home is unchanged. A pass on an integration branch whose suffix is not every covered ticket's parent writes to `claudedocs/ui-evidence/<suffix>/`, as an absolute path under the project root, and the per-repo form applies to it as to an epic's home. Every other integration branch's pass keeps the epic-level home.

Whether they are hostable is ship's decision, made only with attaching enabled — with attaching off the post takes the **Ignored** outcome and nothing is probed or committed. Run `git -C "<project-root>" check-ignore -q "<evidence-home>"` (mirror the pre-write guard in `debug` and build's `--pr` flow). Exit 1 — the home is versioned — takes the **Tracked** outcome in `ui-verification.md` step 3, but only when the pass tested that same checkout: its tested path ([`ui-verification.md`](ui-verification.md) step 1) was the project root itself, never a linked worktree, and `git -C "<project-root>" branch --show-current` prints `<assembled-branch>` when the commit is made, so the commit lands on the assembled branch. Exit 0, any other exit (a project root that is not a git repository, as in a multi-repo workspace), a pass that tested another checkout, or another branch checked out at commit time takes the **Ignored** outcome. That decision is the fallback below the **Attached** outcome: Tracked is [`ui-attach.md`](../../build/references/ui-attach.md) §7's hosted-link tier, and Ignored its path manifest. Every outcome's post carries one `Full capture set:` line per covered ticket, its `<pointer>` the **Pointer** of [the close stage's `storage-fs.md`](../../close-stage/references/storage-fs.md) §8.

## §8 UI verification write-back

`ui-verification.md` step 4 invokes this section once per covered ticket, with that ticket's parsed tester result in hand. It rewrites two files in the ticket folder: `05-tests.md` as a whole, and one section of `06-summary.md`.

**Target folder.** Re-resolve the ticket folder immediately before writing — never reuse the path SETUP resolved for §3, because the run's own transitions moved the folder since. A solo ticket resolves by the search order in [`../../flow/references/ticket-resolution-fs.md`](../../flow/references/ticket-resolution-fs.md); an epic child by `Glob` `claudedocs/tickets/*/<EPIC>/tasks/<ID>/`, since the epic subtree moves as a unit and the child never leaves `tasks/`. The result is an absolute path. No match, or more than one → write nothing for that ticket and report it.

**`05-tests.md` body.** A whole-file overwrite; nothing of the `05-tests.md` the ticket's close stage wrote is kept — its `--no-ui-testing` skip body, or a driver ticket's own browser record or driver skip.

```
Source: ship end-of-run UI verification — branch <assembled-branch> @ <sha>
verdict: <pass | partial>

## Acceptance Criteria
- [x] AC <n> — PASS — <tester's note>
- [ ] AC <n> — FAIL — <tester's note>

## Failed Criteria
<one entry per failed criterion or failed required UI check: what failed, where, the screenshot name and its `**Viewport**: desktop | mobile | both` line; for an epic child, the epic-wide required-check failures too, each marked epic-wide>

## Observations
<the tester's non-failing notes; for an epic child, the epic-wide notes too, each marked epic-wide>

## Screenshots
<one entry per capture, or the empty-home line>
```

- `<sha>` is the commit under test: `git -C "<tested-path>" rev-parse HEAD` of the checked-out assembled branch at test time, `<tested-path>` being the checkout the pass tested ([`ui-verification.md`](ui-verification.md) step 1), or the Tracked outcome's `<pushed-sha>` when step 3 pushed screenshots on top of it.
- The provenance line is first and `verdict:` second on purpose. Routers read only `06-summary.md`'s first line, never this file's, and the provenance line is what tells a reader this result came from ship's pass rather than a close-stage checkpoint.
- One `## Acceptance Criteria` line per criterion of this ticket, numbered as its own spec numbers them.
- `## Failed Criteria` is present only when a criterion or a required UI check failed — a required-check failure the tester listed against the implicit `UI states (required check)` criterion counts, even with no numbered criterion to attach it to. `## Observations` holds only non-failing notes, never a failure.

**Verdict rule.** Every criterion and every required UI check passed → `pass`. `## Failed Criteria` present → `partial`. `fail` is never written.

**`## Screenshots` section.** Composed by the rules in [the close stage's `storage-fs.md`](../../close-stage/references/storage-fs.md) §8 — the same one `wc -c -- "<evidence-home>"/*.png` listing, the same order ([`ui-attach.md`](../../build/references/ui-attach.md) §3's **Artifact order**, under `### Desktop`, `### Mobile` and `### Other` subheadings), entry form, relative-path rule, unsafe-name demotion to plain text and empty-home line — issued before the body is composed, since its names and sizes are inputs to that body. An epic's passes share the epic-level evidence home (§7) — split into per-repo homes when §7 splits it — so that listing goes out **once** for the whole epic and every covered child's section is composed from the one result. Three rules arise only here:

- **Which home a child reads.** A pass covering an epic writes each child's artifact from the epic-level evidence home (§7), never from the child's own, so the epic-level-home case of that §8's relative-path rule is the one governing every entry in that child's section. A ticket covered by a pass on a home named for a branch's suffix (§7) reads it with `../../../ui-evidence/<suffix>/<name>.png` for a solo and `../../../../../ui-evidence/<suffix>/<name>.png` for a child.
- **Per-child filtering.** Each child lists only the captures whose names carry its own `<ticket-id>-` prefix ([`ui-checks.md`](../../build/references/ui-checks.md) §3), never a sibling's.
- **Per-repo homes.** Whenever §7 split the home — the epic's two or more selected entries, even when only one of those passes briefed the child — the section takes that §8's per-repo form: the one Bash call lists every per-repo home, one `wc -c -- "<home>/<repo>"/*.png` per repository joined by `;`, and the section holds one `### <repo>` block per pass that briefed the ticket, in pass order, with the Desktop/Mobile/Other groups as `####` subheadings and an empty home's block carrying `No captures were written.` Relative paths are `../../screenshots/<repo>/<name>.png` from the epic-level home. The `06-summary.md` `screenshots:` count totals every repository's block.

Two honest limits: a name reaches the body only after the capture-time grammar of [`ui-checks.md`](../../build/references/ui-checks.md) §3, and a name that fails [`ui-attach.md`](../../build/references/ui-attach.md) §3's safe-name regex takes the plain-text form, so no metacharacter and no heredoc-terminator collision can arrive through a link; and while the Tracked outcome (§7) commits the evidence home, `05-tests.md` itself stays out of every pipeline commit ([`commit.md`](../../build/references/commit.md) §1 excludes `claudedocs/`), so these links render on GitHub only where the consumer versions the ticket folder itself.

**Write mechanics.** Ship holds Bash and no `Write`, so each file is written by one Bash call: a single-quoted heredoc redirected to the absolute target path, `cat > "<ticket-folder>/05-tests.md" <<'<nonce>'`. The delimiter is a fresh nonce per write, verified absent from every line of the body before the call is composed; regenerate it on a collision. The quoted delimiter disables all expansion, so backticks, `$()` and quotes in tester text land as file content. Tester text never appears on a command line and never passes through `eval` — the discipline of [`../../review/references/pr-comments.md`](../../review/references/pr-comments.md) §5 and §7.

**`06-summary.md` section.** `Read` the file, then compose its new whole body: the existing content with any prior `## UI verification` section removed, followed by

```
## UI verification
- verdict: <pass | partial> (ship end-of-run pass, branch <assembled-branch> @ <sha>)
- evidence: <URL of the PR the evidence was posted to>
- results: 05-tests.md
- screenshots: <n> captures, listed in 05-tests.md
```

Write it with the same heredoc discipline. The first line — the close stage's verdict — and every other section stay as written; a rerun replaces the section rather than adding a second one. A ticket without `06-summary.md` gets no summary write, and the gap is reported.

**Order and scope.** `05-tests.md` is written before `06-summary.md`, so the summary is never older than it. Neither file is staged or committed — [`commit.md`](../../build/references/commit.md) §1 excludes `claudedocs/`, and the Tracked outcome stages only the evidence home. No `status:` frontmatter changes and no folder moves.

**Failure.** A write that fails is reported in the run report, naming the ticket and the artifact, and the run continues to its normal open/merge ending.

## §9 Close record

Hop verification reads the ticket's close record from its folder with `Read`: `06-summary.md`'s validation and test lines, and `04-review.md`'s `## Post-review validation` section. Step 2's provenance comment takes the review stage's result from the same `04-review.md`. Locate the folder as §8's **Target folder** does, immediately before the read — an epic child's subtree stays in `in-progress/` while a sibling is still in progress (§6), so the folder is never assumed to be in `review/`.
