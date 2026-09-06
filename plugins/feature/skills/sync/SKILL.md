---
name: sync
description: "Reconcile every ticket in backlog, in-progress, and review with its GitHub PR state, promoting tickets with merged PRs to done and flagging PRs closed unmerged."
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - Edit
  - TodoWrite
  - pipeline_list_tickets
  - pipeline_get_ticket
  - pipeline_transition_ticket
  - pipeline_update_ticket
  - mcp__plugin_server-native_ps__pipeline_list_tickets
  - mcp__plugin_server-native_ps__pipeline_get_ticket
  - mcp__plugin_server-native_ps__pipeline_transition_ticket
  - mcp__plugin_server-native_ps__pipeline_update_ticket
argument-hint: "[ticket-id]"
---

# Sync — reconcile active-state tickets with GitHub PR state

Scan every ticket sitting in `backlog/`, `in-progress/`, or `review/` (solo tickets and epic children alike; `done/` is terminal and never scanned) and check each PR's merge state on GitHub. **Merged** → finalize the ticket to `done/` (Transition 6). **Open** → report it. **Closed-unmerged** → flag it for your attention. Report everything at the end. Scanning by folder rather than by frontmatter `status` catches a merged PR wherever it landed — a ship crash, a re-plan (`review → in-progress`), or a manually opened/merged PR can leave a merged PR attached to a ticket that never reached `review/`.

**Storage mode.** Detect it once per run per [`../flow/references/storage.md`](../flow/references/storage.md) §Mode detection, then read sync's storage file for that mode — [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) — **once here, in full**; every later `§N` cite in this skill refers to that already-loaded file. The scan breadth is the same in either mode: a merged PR can attach to a ticket parked at any non-terminal location (crash, re-plan, manual merge), and §1 reaches every such ticket.

**This skill runs in the main conversation, standalone** — **not a pipeline stage**. It spawns no subagents. Unlike the other standalone skills, sync *does* perform a state transition — but only the safe, terminal merge finalization (Transition 6: a merged ticket's promotion to `done/`) on a confirmed-merged PR.

Run it **manually** to finalize merged reviews in one pass. Sync is **stateless** — each run is a fresh scan.

## Arguments

```
/feature:sync $ARGUMENTS
```

`$1` (optional) = a ticket ID to reconcile just that one ticket. Omit it to scan **every** ticket in `backlog/`, `in-progress/`, and `review/`.

## When NOT to run
- To build/implement a ticket → `/feature:build`.
- To open a PR → that's build's `--pr` flag, not sync.
- To revert a rejected PR's ticket → sync only *flags* closed-unmerged PRs; reverting is your call.

## Preconditions (fail-closed)

Sync reads PR state from GitHub via `gh`. Before any work, run the shared fail-closed check sequence in [`../review/references/gh-preconditions.md`](../review/references/gh-preconditions.md); sync's skip message is "couldn't check (gh unavailable: `<reason>`)". The check applies whatever the storage mode — PR state lives on GitHub either way.

## Process

### 1. Enumerate tickets

The scan set is every ticket at a non-terminal location, resolved per §1 — all of them when no arg is given, the single resolved ticket when `$1` is (exiting with §1's already-terminal line when it is). Every kept ticket is PR-checked the same way in Step 2 — location membership alone determines the scan set. The ticket's **scanned location** is carried alongside it (it drives the Step 3 Transition 6 source and the Step 3/4 report shaping).

- **Terminal short-circuit**: a kept ticket whose status is already `done` or `cancelled` is never PR-checked (nothing to promote). Every other status — `backlog`, `in-progress`, `in-review`, `partial-completion` — is PR-checked. Skipped-terminal tickets are excluded from the PR-checked set and are **not** counted in the no-PR aggregate (they were never PR candidates). §1 states how the filter is applied.

If the scan set is empty, report §1's empty-set line and exit cleanly. Otherwise proceed to Steps 2–4.

### 2. Find each ticket's PR

The lookup key is resolved per §2 — it names the primary key, any fallback, and the per-ticket record-keeping around it (back-fill, `couldn't-check`). Every path ends at the **ID-keyed lookup** below when nothing more specific resolves a PR:

**ID-keyed lookup.** Find the PR by **ticket ID** — this is the **ID-keyed variant of the shared merge predicate** in [`../build/references/pr-creation.md`](../build/references/pr-creation.md). Sync can't use the branch-keyed form (the pushed branch isn't reliably recoverable — its slug is judgment-distilled, and the open-PR flow may reuse a non-convention branch). GitHub's title search is tokenized and AND-matches, so it can return PRs that merely *mention* the ID; **anchor on the `<TICKET-ID>:` title convention** and pick the newest:

```bash
gh pr list --search "<TICKET-ID> in:title" --state all \
  --json number,state,url,createdAt,title,mergeCommit,baseRefName \
  --jq '[.[] | select(.title | startswith("<TICKET-ID>:"))] | sort_by(.createdAt) | last'
```
- Quote `"<TICKET-ID>"` (controlled `<PREFIX>-<N>` token, no raw free-text interpolation). The `startswith("<TICKET-ID>:")` post-filter rejects titles that merely mention the ID (e.g. a multi-ID title), so only the ticket's own PR survives.
- `mergeCommit.oid` and `baseRefName` are carried for the **reachability gate** the shared predicate applies in Step 3 (a `MERGED` PR promotes only when its merge commit has reached `<base>`; the gate consumes the PR's own base as `PR_BASE`).
- **Multiple survivors** (e.g. a reopened PR): `sort_by(.createdAt) | last` picks the newest; note that in the report.
- **No survivor**: record `no-PR-found`; change nothing. Step 4 shapes it by the scanned location per §4.

### 3. Act on the PR state

Run Step 2's PR lookup for every kept ticket from Step 1 (except the terminal short-circuit — `done`/`cancelled` status tickets are never PR-checked). Each ticket carries its **scanned location** from Step 1; that drives the Transition 6 source and the report shaping below.

- **`MERGED` and reachable from `<base>`** → the shared merge predicate's **reachability gate** decides this: after a `git fetch`, resolve `<base>` and require the PR's merge commit to be an ancestor of `origin/<base>` (`git merge-base --is-ancestor`) — the exact rule lives once in [`../build/references/pr-creation.md`](../build/references/pr-creation.md)'s Merge predicate; apply it, don't fork the gate here. Only a merge that has actually reached `<base>` promotes; finalize via **Transition 6** (scanned location → `done`) per [`state-transitions-fs.md`](../flow/references/state-transitions-fs.md) / [`state-transitions-server.md`](../flow/references/state-transitions-server.md) — invoke it, don't reimplement the move logic. Its mechanics for sync's two ticket shapes — solo (with the **mismatch note** for a promotion off the normal `review → done` path) and epic child (with the **Epic-completion predicate deferred** to once per affected epic at the end of the pass, its warnings rendered as `⚠ Needs attention` lines) — are §3.
  - Record `✓ promoted → done/` + the PR URL (and the epic move, if it fired).
- **`MERGED` but not yet reachable from `<base>`** (an epic child squash-merged only into `integration/<epic-id>`, or `git`/`gh` couldn't resolve the merge commit or base — e.g. offline) → the reachability gate treats it as **still pending**: record `… merged into integration, not yet on <base>` + the PR URL; change nothing. Never promote on an unverifiable merge. It promotes on a later pass once the integration PR lands on `<base>`.
- **`OPEN`** → record `… open` + the PR URL; change nothing. For a `backlog/` or `in-progress/` ticket, tag the ticket's folder in the report (`… open — ticket in <folder>/`) — sync is a merge-finalizer only and performs **no** Transition 5 (an open PR on an active ticket is reported, never promoted to `review/`).
- **`CLOSED`** (unmerged) → record `⚠ closed unmerged — needs your call`; change nothing. Do NOT auto-revert — reverting to `backlog` is a judgment call (you may reopen or rework).

### 4. Report

Print a grouped summary with counts; omit empty groups:

```
## Sync — <N> ticket(s) checked

✓ Promoted to done/ (<n>):
  - <id> — PR <url>
… Still open (<n>):
  - <id> — PR <url> — ticket in <folder>/   (folder tag on backlog/in-progress; a review/ ticket shows a bare `… open`)
⚠ Needs attention (<n>):
  - <id> — promoted from <folder>/ — merged outside the review→done path
  - <id> — closed unmerged — PR <url>
? Couldn't check (<n>):
  - <id> — no PR found (in review/)
  - <id> — couldn't-check (<reason>)   (gh error, any folder)
```

- **Header** counts every PR-checked ticket (terminal short-circuits from Step 1 are excluded — they were never PR candidates).
- The `⚠ Needs attention` group carries closed-unmerged PRs, the solo-promotion mismatch notes (a merged ticket promoted from a non-`review/` folder), and any Epic-completion-predicate warnings (roster-unknown / roster-drift) raised while finalizing an epic, each tagged inline — no separate section. If a promotion finalized an epic's last child, add a line noting the epic subtree moved to `done/`.
- The `? Couldn't check` group lists `review/` tickets with **no PR found** (an anomaly worth surfacing loudly) plus any ticket — of any folder — whose PR lookup errored (per Error Handling below); the reachability check being unresolvable (offline / merge-into-integration) is reported in its own line via Step 3, not here. No-PR `backlog/` and `in-progress/` tickets are silently skipped — most active tickets legitimately have no PR — and collapse into a single aggregate line: `<n> backlog/in-progress ticket(s) had no PR (silently skipped).`
- **No-op run**: when nothing was promoted, open, or flagged and every PR-checked ticket was a no-PR silent-skip, print one quiet line instead of the empty groups: `Nothing to sync — <N> ticket(s) had no PR.`
- **Location tokens** in the template render per §4.

## Boundaries

**Will Not:**
- Push, create, or close PRs — sync is read-only on GitHub (that's the `--pr` flow's job).

## Error Handling

- A per-ticket `gh` PR lookup errors — whichever key §2 resolved for the ticket (a more specific key first degrades to the ID-keyed fallback per §2) → record `couldn't-check (<reason>)` for that ticket and continue with the rest (one bad ticket never aborts the scan).
- A storage operation fails mid-promotion → §5 says what stops (that ticket, or the pass) and what the report carries; what was already promoted is always reported.
