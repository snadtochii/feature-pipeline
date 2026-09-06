# Sync — server-native Storage Mechanics

Canonical logic for sync's storage-touching steps in server-native storage mode. Read when the storage mode detected at sync's start per [`../../flow/references/storage.md`](../../flow/references/storage.md) is server-native — an fs-native run never needs this file. Referenced by `sync` only. Operations named below are defined in [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md); sections are numbered so the skill body cites `§N`.

## §1 Scan set

The scan set derives from row status — the single dimension a ticket has in this mode. A merged PR can still attach to a row parked at any non-terminal status (crash, re-plan, manual merge), so every non-terminal row is scanned.

- **All (no arg)**: enumerate via `pipeline_list_tickets` — it returns the project-wide list with no server-side status filter, so filter client-side: keep rows whose `status` is `backlog`, `in-progress`, `in-review`, or `partial-completion`; `done` and `cancelled` rows drop out here. This status filter **is** the terminal short-circuit in this mode — status is the only dimension, so a stale terminal status cannot sit anywhere else. Epic children arrive as ordinary rows (`parent_id` set); epic rows themselves (`kind: epic`) are never PR-checked — their promotion happens only through the Epic-completion predicate in Step 3.
- **Single (`$1` given)**: resolve per [`../../flow/references/ticket-resolution-server.md`](../../flow/references/ticket-resolution-server.md) Step 1 (`pipeline_get_ticket`). Accept the row if its status is non-terminal; if `done` or `cancelled`, report "`<id>` is already done — nothing to sync" and exit.
- **Scanned location**: each kept row's status, carried alongside it — it is the location the later steps consume (Step 3's CAS `from` and the Step 3/4 report shaping).
- **Empty set**: no row at a non-terminal status → report "Nothing to sync — no tickets at a non-terminal status." and exit cleanly.

## §2 PR lookup key

The row's `pr_url` is the **primary key** into GitHub; the ID-keyed lookup in the skill body is the fallback:

- **`pr_url` set**: **parse the PR number from the URL** — the trailing path segment (the value is a controlled row field; load it via command substitution and validate the tail is numeric, never paste it into a free-text command string) — and require the URL's `owner/repo` path to name the **current repository** (compare against `gh repo view --json owner,name`). Then query live, repo-scoped: `gh pr view "<number>" --json number,state,url,mergeCommit,baseRefName`. Number-scoping keeps the lookup inside this repo — a full-URL query would scope to the *URL's* repository, silently reconciling against a foreign PR. PR state is **never cached** server-side: `gh` is the live source every run, `pr_url` only names *which* PR to ask about.
- **`pr_url` unusable or the lookup hard-errors** (malformed URL with no numeric tail; a URL naming a different repository; `gh pr view` failing hard — deleted PR, renamed/transferred repo): fall back to the ID-keyed lookup exactly as for a null `pr_url`; a survivor **back-fills** the corrected URL. No survivor → record `couldn't-check (pr_url unresolvable: <reason>)` — a loud per-ticket line in Step 4 whatever the row's status (a set-but-broken `pr_url` is an anomaly, unlike an ordinary no-PR ticket).
- **`pr_url` null** (a ticket that predates the field, or a manually opened PR): run the ID-keyed lookup unchanged. On a survivor, **back-fill** the row via `pipeline_update_ticket` with the PR's URL so later passes go direct — a non-status field write, outside the CAS. No survivor → `no-PR-found`; shaping per §4.

## §3 Transition 6 mechanics

Transition 6 is invoked per [`../../flow/references/state-transitions-server.md`](../../flow/references/state-transitions-server.md) §Transition 6, in its CAS form; the calls below are its shape for sync's two ticket shapes.

- *Solo ticket*: `pipeline_transition_ticket` with `from: [<scanned status>]` (the row status §1 carried — the seam's full caller-dependent breadth is `[backlog, in-progress, in-review, partial-completion]`, but issue the CAS with the status actually scanned, not the whole set), `to: done`. A CAS failure follows [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md) §CAS conflict doctrine: re-read the row, re-evaluate T6 against the fresh status (still non-terminal, PR still merged-and-reachable?), then proceed with the corrected `from[]` or record the conflict as a `⚠ Needs attention` line and continue with the rest — never widen `from[]` to force it.
- *Mismatch note*: fires when the pre-CAS status is not `in-review` (`⚠ <id> promoted from <status> — merged outside the review→done path`) — and it applies to **epic children too**: status is a child's only location, so a child at any other status was promoted off the normal path like any solo ticket.
- *Epic child*: the same CAS on the child row. **Defer** Transition 6's **Epic-completion predicate** to once per affected epic at the end of the pass: collect the epics whose children you promoted this pass; for each, apply the predicate's server variant (roster **derived** from the child rows via `parent_id` — List tickets / list children in `storage-server.md`) *after* all in-pass child flips are written — invoke it, don't reimplement the roster scan. On `promote`, CAS the epic row `from: [in-progress, in-review]`, `to: done` (the row is the epic). On `stay`, the epic row keeps its status. The predicate gates on the derived roster, so it reads the children as they exist on the server. Render any predicate warnings as `⚠ Needs attention` report lines (Step 4). (Deferring once per epic avoids re-applying the predicate per merged child, where only the last child's check can succeed.)
- **Atomicity**: the transition is a single CAS call — there is no ordering to get right.

## §4 Report shaping

Wherever the Step 4 template names a location, render the row's scanned status instead: `in-review` where the template shows the in-review location; the location tag reads `— ticket at <status>`; the promotion line names the terminal status. A `no-PR-found` row is shaped by its scanned status — a silent aggregate line for `backlog`, `in-progress`, and `partial-completion` rows (an active row with no PR is legitimate), a loud per-ticket `? Couldn't check` line for an `in-review` row (no PR at in-review is an anomaly). The mismatch-note line reads `promoted from <status>` and covers children too (§3). Everything else — groups, counts, ordering — is identical to the template.

## §5 Error handling

- CAS transition conflict → per [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md) §CAS conflict doctrine: re-read, re-evaluate, proceed with the corrected `from[]` or record the conflict as a `⚠ Needs attention` line — never widen `from[]` to force it. One conflicted ticket never aborts the scan.
- Pipeline MCP tools unavailable, or a call hard-errors → stop per [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md) §Loud failure, naming the failed operation; report whatever the pass already promoted before stopping. Never fall back to local edits.
