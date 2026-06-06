---
name: sync
description: "Reconcile review/ tickets with their GitHub PR state — scan the review/ folder and, for each ticket, promote it to done/ if its PR merged, report it if the PR is still open, or flag it if the PR was closed unmerged. Runs manually or under /loop. Use when 'sync', 'sync tickets', 'reconcile review', 'check merged PRs', 'promote merged tickets', 'finalize merged reviews', 'run sync', '/loop sync'. NOT for building a ticket (use /feature:build), NOT for opening a PR (that's build's --pr flag), NOT a pipeline stage."
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Edit
  - TodoWrite
argument-hint: "[ticket-id]"
---

# Sync — reconcile review/ tickets with GitHub PR state

Scan the `review/` state folder and, for each ticket sitting there (`status: in-review`, its PR open), check the PR's merge state on GitHub. **Merged** → finalize the ticket to `done/` (Transition 6). **Open** → report it. **Closed-unmerged** → flag it for your attention. Report everything at the end.

**This skill runs in the main conversation, standalone** — a peer of `/feature:discover`, `/feature:explore`, and `/feature:debug`, **not a pipeline stage**. It spawns no subagents. Unlike the other standalone skills, sync *does* perform a state transition — but only the safe, terminal `review → done` move (Transition 6) on a confirmed-merged PR.

Run it **manually** to finalize merged reviews in one pass, or under **`/loop`** (e.g. `/loop 10m /feature:sync`) to reconcile continuously. Sync is **stateless** — each run is a fresh scan; `/loop` owns the cadence.

## Arguments

```
/feature:sync $ARGUMENTS
```

`$1` (optional) = a ticket ID to reconcile just that one ticket. Omit it to scan **all** of `review/`.

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

### 1. Enumerate review/ tickets

- **All (no arg)**: glob `claudedocs/tickets/review/*/01-spec.md` (solo tickets) and `claudedocs/tickets/review/*/tasks/*/01-spec.md` (epic children). Use the `Glob` tool — a no-match pattern (e.g. an epic-only `review/` has no *solo* `*/01-spec.md`) returns nothing, not an error; don't rely on raw shell globbing, which can abort on no-match.
- **Single (`$1` given)**: resolve the ID per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 1, and accept it if the resolved folder path contains a `review/` segment — solo (`review/<id>/`) **or** epic-child (`review/<EPIC>/tasks/<id>/`). Otherwise report "`<id>` is not in review/ — nothing to sync" and exit.
- For each, read `01-spec.md` frontmatter and keep only those with `status: in-review` (folder location is the fallback when frontmatter is missing/malformed). Record each ticket's `id`.

If nothing matches, report "No tickets in review/." and exit cleanly.

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

- **`MERGED`** → finalize via **Transition 6** (`review → done`) per [`../flow/references/state-transitions.md`](../flow/references/state-transitions.md) — invoke it, don't reimplement the move logic:
  - *Solo ticket*: move the folder first — `mv "claudedocs/tickets/review/<id>" "claudedocs/tickets/done/<id>"` — then `Edit` its `01-spec.md` frontmatter `status` → `done`.
  - *Epic child*: no child-folder move — `Edit` the child's `status` → `done`. **Defer** Transition 6's **all-children-done check** to once per affected epic at the end of the pass: collect the epics whose children you promoted this pass, then for each, if every sibling under `<epic-folder>/tasks/*/01-spec.md` is now `done`/`cancelled`/`partial-completion`, `mv` the whole epic subtree `review/<EPIC> → done/<EPIC>` and set `prd.md` `status` → `done`. (Running it per-child re-scans all siblings once per merged child, and only the last child's check can succeed. `<epic-folder>` = the deepest ancestor containing `prd.md`.)
  - Record `✓ promoted → done/` + the PR URL (and the epic move, if it fired).
- **`OPEN`** → record `… open` + the PR URL; change nothing.
- **`CLOSED`** (unmerged) → record `⚠ closed unmerged — needs your call`; change nothing. Do NOT auto-revert — reverting `review → backlog` is a judgment call (you may reopen or rework).

Atomicity (per `state-transitions.md`): always move the folder before editing frontmatter, so a move failure leaves the prior state recoverable.

### 4. Report

Print a grouped summary with counts; omit empty groups:

```
## Sync — <N> review/ ticket(s) checked

✓ Promoted to done/ (<n>):
  - <id> — PR <url>
… Still open (<n>):
  - <id> — PR <url>
⚠ Closed unmerged — needs attention (<n>):
  - <id> — PR <url>
? Couldn't check (<n>):
  - <id> — <reason>
```

If a promotion finalized an epic's last child, add a line noting the epic subtree moved to `done/`.

## Under /loop

Nothing special — sync is a normal invocable skill. Its idempotency (re-scan each pass, promote newly-merged, report the rest) is the loop-friendly shape; already-finalized tickets have left `review/`, so re-runs are safe. Exit cleanly and report state every pass so `/loop` can decide whether to continue. Pick a sensible interval — sync makes one `gh` call per `review/` ticket per pass, so don't loop aggressively with many tickets in review.

## Boundaries

**Will:**
- Scan `review/` (all tickets, or one when `$1` is given), find each PR by ticket ID, and report.
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
- Malformed frontmatter on a ticket → warn, treat folder location as authoritative for the scan set, skip the status edit if it can't be parsed safely.
