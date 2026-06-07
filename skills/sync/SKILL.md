---
name: sync
description: "Reconcile in-review tickets with their GitHub PR state — scan every ticket whose status is in-review (by frontmatter, not just the review/ folder) and, for each, promote it to done/ if its PR merged, report it if the PR is still open, or flag it if the PR was closed unmerged. Runs manually or under /loop. Use when 'sync', 'sync tickets', 'reconcile review', 'check merged PRs', 'promote merged tickets', 'finalize merged reviews', 'run sync', '/loop sync'. NOT for building a ticket (use /feature:build), NOT for opening a PR (that's build's --pr flag), NOT a pipeline stage."
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Edit
  - TodoWrite
argument-hint: "[ticket-id]"
---

# Sync — reconcile in-review tickets with GitHub PR state

Scan every ticket whose `status` is `in-review` (by frontmatter — not just the ones sitting in `review/`, since an epic child can be `in-review` while its subtree is still in `in-progress/`) and check each PR's merge state on GitHub. **Merged** → finalize the ticket to `done/` (Transition 6). **Open** → report it. **Closed-unmerged** → flag it for your attention. Report everything at the end.

**This skill runs in the main conversation, standalone** — a peer of `/feature:discover`, `/feature:explore`, and `/feature:debug`, **not a pipeline stage**. It spawns no subagents. Unlike the other standalone skills, sync *does* perform a state transition — but only the safe, terminal merge finalization (Transition 6: a merged ticket's `in-review → done`) on a confirmed-merged PR.

Run it **manually** to finalize merged reviews in one pass, or under **`/loop`** (e.g. `/loop 10m /feature:sync`) to reconcile continuously. Sync is **stateless** — each run is a fresh scan; `/loop` owns the cadence.

## Arguments

```
/feature:sync $ARGUMENTS
```

`$1` (optional) = a ticket ID to reconcile just that one ticket. Omit it to scan **all** in-review tickets.

## When NOT to run
- To build/implement a ticket → `/feature:build`.
- To open a PR → that's build's `--pr` flag, not sync.
- To revert a rejected PR's ticket → sync only *flags* closed-unmerged PRs; reverting is your call.

## Preconditions (fail-closed)

Sync reads PR state from GitHub via `gh`. Before any work, check — in order; on the first failure, report "couldn't check (gh unavailable: `<reason>`)", change nothing, and exit cleanly (this is graceful degradation, not an error):

1. `command -v gh` — gh installed?
2. `gh auth status` exits 0 — authenticated?
3. `git remote get-url origin` matches `github.com` — GitHub origin?

## Process

### 1. Enumerate in-review tickets (by status)

Sync's scan set is every ticket whose frontmatter `status` is `in-review` — **not** every ticket sitting in `review/`. Solo tickets in `review/` and epic children whose subtree reached `review/` are both `in-review`, but an epic child can *also* be `in-review` while its subtree still sits in `in-progress/<EPIC>/` — a sibling is mid-build, so the precedence rule (`in-progress` ⊐ `review` ⊐ `done`) keeps the epic out of `review/`. A `review/`-only scan misses those children, so enumeration keys on the frontmatter `status` field, not the folder.

- **All (no arg)**: glob `claudedocs/tickets/*/*/01-spec.md` (solo tickets, any state) and `claudedocs/tickets/*/*/tasks/*/01-spec.md` (epic children, any state). Use the `Glob` tool — a no-match pattern returns nothing, not an error; don't rely on raw shell globbing, which can abort on no-match. The `*/tasks/*` depth is fixed at one level (epics nest exactly one level: parent → `tasks/<child>/`); do not use `**`.
- **Single (`$1` given)**: resolve the ID per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 1, then read its `01-spec.md` frontmatter. Accept it if `status` is `in-review`, regardless of which state folder it lives in; otherwise report "`<id>` is not in-review (status: `<actual>`) — nothing to sync" and exit.
- **Classify** every kept `in-review` ticket — from the no-arg glob (read each globbed `01-spec.md` frontmatter, keep only `status: in-review`) **or** the single-arg accept above — by where it sits. The single-arg path runs this *same* classification, so an accepted-but-inconsistent `$1` (e.g. stale `in-review` frontmatter in `done/`/`backlog/`) is bucketed inconsistent and is never PR-checked or moved, exactly as a globbed one would be:
  - **Actionable** — a solo ticket in `review/<id>/`, or an epic child in `review/<EPIC>/tasks/<id>/` **or** `in-progress/<EPIC>/tasks/<id>/`. These get the PR check in Step 2.
  - **Inconsistent** — any *other* location for an `in-review` ticket: a solo ticket outside `review/`, or any ticket under `done/`/`backlog/`. No transition can reach those states (Transition 5 sets `in-review` only in `review/` for solo, or in `review/`/`in-progress/` for a child), so the frontmatter is stale or hand-edited. Record these for an `⚠` report line (Step 4); never PR-check or move them.
- **Malformed/unparseable frontmatter**: a `review/` location is itself a positive `in-review` signal (solo and epic children both land there) — include + warn. An `in-progress/` location is **not** a positive signal — an unparseable child there can't be distinguished from an active sibling — so exclude + warn. Skip any status edit that can't be parsed safely.

If there are no `in-review` tickets at all (nothing actionable and nothing inconsistent), report "No in-review tickets." and exit cleanly. Otherwise proceed to Steps 2–4 — even if every actionable ticket later resolves to couldn't-check, the Step 4 report still prints (the `? Couldn't check` group surfaces them; every non-empty group always prints, regardless of whether any promotion occurred).

### 2. Find each ticket's PR (ID-keyed)

Find the PR by **ticket ID** — this is the **ID-keyed variant of the shared merge predicate** in [`../build/references/pr-creation.md`](../build/references/pr-creation.md). Sync can't use the branch-keyed form (the pushed branch isn't reliably recoverable — its slug is judgment-distilled, and the open-PR flow may reuse a non-convention branch). GitHub's title search is tokenized and AND-matches, so it can return PRs that merely *mention* the ID; **anchor on the `<TICKET-ID>:` title convention** and pick the newest:

```bash
gh pr list --search "<TICKET-ID> in:title" --state all \
  --json number,state,url,createdAt,title \
  --jq '[.[] | select(.title | startswith("<TICKET-ID>:"))] | sort_by(.createdAt) | last'
```
- Quote `"<TICKET-ID>"` (controlled `<PREFIX>-<N>` token, no raw free-text interpolation). The `startswith("<TICKET-ID>:")` post-filter rejects titles that merely mention the ID (e.g. a multi-ID title), so only the ticket's own PR survives.
- **Multiple survivors** (e.g. a reopened PR): `sort_by(.createdAt) | last` picks the newest; note that in the report.
- **No survivor**: record `couldn't-check (no PR found)`; change nothing.

### 3. Act on the PR state

Run Step 2's PR lookup only for the **actionable** tickets from Step 1. Inconsistent tickets skip straight to the Step 4 report — no PR check, no move.

- **`MERGED`** → finalize via **Transition 6** (`review → done`) per [`../flow/references/state-transitions.md`](../flow/references/state-transitions.md) — invoke it, don't reimplement the move logic:
  - *Solo ticket*: move the folder first — `mv "claudedocs/tickets/review/<id>" "claudedocs/tickets/done/<id>"` — then `Edit` its `01-spec.md` frontmatter `status` → `done`. A solo `in-review` ticket always lives in `review/` (Transition 5's solo path moves the folder before flipping the status), so this path stays `review/`-specific — do not unify it with the epic-child path below.
  - *Epic child*: no child-folder move — `Edit` the child's `status` → `done`. The child's subtree may be in `review/` **or** still in `in-progress/` (a sibling is mid-build); either way the child flips in place. **Defer** Transition 6's **all-children-done check** to once per affected epic at the end of the pass: collect the epics whose children you promoted this pass; for each, re-resolve `<epic-folder>` (the deepest ancestor containing `prd.md`, at its **current** location) and read every sibling under `<epic-folder>/tasks/*/01-spec.md` *after* all in-pass child flips are written. If every sibling is now `done`/`cancelled`/`partial-completion`, `mv` the whole epic subtree from its current folder — `<epic-folder> → done/<EPIC>` (source is wherever the epic currently sits, `in-progress/` or `review/`, **not** a hardcoded `review/<EPIC>`) — and set `prd.md` `status` → `done`. Otherwise leave the epic where it is: the child flip stands and the epic stays put under the precedence rule. (Deferring once per epic avoids re-scanning all siblings per merged child, where only the last child's check can succeed.)
  - Record `✓ promoted → done/` + the PR URL (and the epic move, if it fired).
- **`OPEN`** → record `… open` + the PR URL; change nothing.
- **`CLOSED`** (unmerged) → record `⚠ closed unmerged — needs your call`; change nothing. Do NOT auto-revert — reverting `review → backlog` is a judgment call (you may reopen or rework).
- **Inconsistent** (from Step 1, no PR lookup ran) → record `⚠ inconsistent (status: in-review, but in <folder>)`; change nothing. The status is unreachable for that location — surface it so the corruption isn't silently skipped, but don't guess a move.

Atomicity (per `state-transitions.md`): always move the folder before editing frontmatter, so a move failure leaves the prior state recoverable.

### 4. Report

Print a grouped summary with counts; omit empty groups:

```
## Sync — <N> in-review ticket(s) checked

✓ Promoted to done/ (<n>):
  - <id> — PR <url>
… Still open (<n>):
  - <id> — PR <url>
⚠ Needs attention (<n>):
  - <id> — closed unmerged — PR <url>
  - <id> — inconsistent (status: in-review, but in <folder>) — left as-is
? Couldn't check (<n>):
  - <id> — <reason>
```

The `⚠ Needs attention` group carries both closed-unmerged PRs and inconsistent-state tickets (Step 1's inconsistent bucket), each tagged inline — no separate section. If a promotion finalized an epic's last child, add a line noting the epic subtree moved to `done/`.

## Under /loop

Nothing special — sync is a normal invocable skill. Its idempotency (re-scan each pass, promote newly-merged, report the rest) is the loop-friendly shape; already-finalized tickets are no longer `status: in-review`, so re-runs skip them. Exit cleanly and report state every pass so `/loop` can decide whether to continue. Pick a sensible interval — sync makes one `gh` call per in-review ticket per pass, so don't loop aggressively with many tickets in review.

## Boundaries

**Will:**
- Scan in-review tickets (all, or one when `$1` is given), find each PR by ticket ID, and report.
- Promote `MERGED`-PR tickets to `done/` via Transition 6, including the epic all-children-done promotion.
- Degrade fail-closed when `gh`/auth/origin is unavailable — change nothing, report why.

**Will Not:**
- Push, create, or close PRs — sync is read-only on GitHub (that's the `--pr` flow's job).
- Auto-revert closed-unmerged tickets — flag only.
- Reimplement Transition 6 or the merge rule — it invokes Transition 6 and shares the `MERGED → done` rule.
- Manage `/loop` timers or cadence — `/loop` owns that; sync holds no state.

## Error Handling

- `gh` missing / unauthenticated / non-GitHub origin → "couldn't check (gh unavailable)", no changes, clean exit.
- `gh pr list` errors for one ticket → record `couldn't-check (<reason>)` for that ticket and continue with the rest (one bad ticket never aborts the scan).
- Folder-move failure mid-promotion → surface it, stop that ticket (frontmatter still reflects the prior state for recovery), continue with the rest.
- Malformed frontmatter on a ticket → warn; a `review/` location still counts as in-review for the scan set (solo and children both land there), but an `in-progress/` location does not (an unparseable child there can't be told from an active sibling) — exclude it. Skip the status edit if it can't be parsed safely.
