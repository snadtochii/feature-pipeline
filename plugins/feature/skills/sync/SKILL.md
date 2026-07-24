---
name: sync
description: "Reconcile every ticket in backlog, in-progress, and review with its GitHub PR state, promoting tickets with merged PRs to done and flagging PRs closed unmerged."
disable-model-invocation: true
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
argument-hint: "[ticket-id]"
---

# Sync — reconcile active-state tickets with GitHub PR state

Scan every ticket sitting in `backlog/`, `in-progress/`, or `review/` (solo tickets and epic children alike; `done/` is terminal and never scanned) and check each PR's merge state on GitHub. **Merged** → finalize the ticket to `done/` (Transition 6). **Open** → report it. **Closed-unmerged** → flag it for your attention. Report everything at the end. Scanning by folder rather than by frontmatter `status` catches a merged PR wherever it landed — a ship crash, a re-plan (`review → in-progress`), or a manually opened/merged PR can leave a merged PR attached to a ticket that never reached `review/`.

**Storage mode**: detect it once per run per [`../flow/references/storage.md`](../flow/references/storage.md) §Mode detection. The fs-native procedure is the text below as written; **server-native** branches are marked inline. Server-native has no state folders — the scan set derives from row status, and the folder/frontmatter divergence the fs folder-keyed scan guards against collapses into the single status column; a merged PR can still attach to a row parked at any non-terminal status (crash, re-plan, manual merge), so the scan breadth is the same. A pipeline MCP failure follows `storage.md` §Loud failure — stop with the failed operation named; never fall back to fs edits.

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

Sync reads PR state from GitHub via `gh`. Before any work, run the shared fail-closed check sequence in [`../review/references/gh-preconditions.md`](../review/references/gh-preconditions.md); sync's skip message is "couldn't check (gh unavailable: `<reason>`)". The check applies in both storage modes — PR state lives on GitHub either way.

## Process

### 1. Enumerate tickets

**fs-native (by state folder).** Sync's scan set is every ticket sitting in `backlog/`, `in-progress/`, or `review/` — the **folder** is the authoritative scan dimension; frontmatter `status` is a consistency signal, not a filter. `done/` is terminal and never scanned. Folder-keying reaches every ticket that could carry a merged PR, including a solo ticket parked in `backlog/`/`in-progress/` after a crash or re-plan, and an epic child that is `in-review` in place while its subtree still sits in `in-progress/<EPIC>/` (a sibling is mid-build, so the precedence rule `in-progress` ⊐ `review` ⊐ `done` keeps the epic out of `review/` — the `in-progress/` folder scan still reaches the child via the `*/tasks/*` glob).

- **All (no arg)**: glob `claudedocs/tickets/*/*/01-spec.md` (solo tickets) and `claudedocs/tickets/*/*/tasks/*/01-spec.md` (epic children). Use the `Glob` tool — a no-match pattern returns nothing, not an error; don't rely on raw shell globbing, which can abort on no-match. The `*/tasks/*` depth is fixed at one level (epics nest exactly one level: parent → `tasks/<child>/`); do not use `**`. **Keep by folder**: from each matched path, read the state-folder segment (the directory right under `claudedocs/tickets/`) and keep the ticket iff that segment is `backlog`, `in-progress`, or `review`; drop anything under `done/`.
- **Single (`$1` given)**: resolve the ID per [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) Step 1. Accept it if its resolved folder is under `backlog/`, `in-progress/`, or `review/`, regardless of frontmatter `status`; if it resolves under `done/`, report "`<id>` is already in done/ — nothing to sync" and exit.
- **Every kept ticket is PR-checked the same way** in Step 2 — folder membership alone determines the scan set. The ticket's current state folder is carried alongside it (it drives the Step 3 solo `mv` source and the Step 3/4 report shaping).
- **Terminal short-circuit**: skip the Step 2 PR check for any kept ticket whose frontmatter `status` is already `done` or `cancelled` (nothing to promote — a stale terminal status inside an active folder is a no-op for sync). Every other status — `backlog`, `in-progress`, `in-review`, `partial-completion` — is PR-checked. Skipped-terminal tickets are excluded from the PR-checked set and are **not** counted in the no-PR aggregate (they were never PR candidates).
- **Malformed/unparseable frontmatter** (fs-native only — a server row always has a readable status): the ticket is still PR-checked (folder membership, not status, put it in the scan set) — its status simply can't be compared for the mismatch note in Step 3. Skip any status edit that can't be parsed safely.

**Server-native (by row status).**
- **All (no arg)**: enumerate via `pipeline_list_tickets` — it returns the project-wide list with no server-side status filter, so filter client-side: keep rows whose `status` is `backlog`, `in-progress`, `in-review`, or `partial-completion`; `done` and `cancelled` rows drop out here. This status filter **is** the terminal short-circuit's server form — a stale terminal status inside an active folder cannot exist when status is the only dimension. Epic children arrive as ordinary rows (`parent_id` set); epic rows themselves (`kind: epic`) are never PR-checked — their promotion happens only through the Epic-completion predicate in Step 3.
- **Single (`$1` given)**: resolve per ticket-resolution Step 1 (mode-aware — `pipeline_get_ticket`). Accept the row if its status is non-terminal; if `done` or `cancelled`, report "`<id>` is already done — nothing to sync" and exit.
- **Carry each kept row's status** alongside it — it stands in for the fs state folder (it drives Step 3's CAS `from` and the Step 3/4 report shaping).

If the scan set is empty (fs-native: no ticket in any of the three folders; server-native: no row at a non-terminal status), report "Nothing to sync — no tickets in `backlog/`, `in-progress/`, or `review/`." (server-native: "Nothing to sync — no tickets at a non-terminal status.") and exit cleanly. Otherwise proceed to Steps 2–4.

### 2. Find each ticket's PR

**Server-native — `pr_url` first.** The row's `pr_url` is the **primary key** into GitHub; the ID-keyed title search below is the fallback:

- **`pr_url` set**: **parse the PR number from the URL** — the trailing path segment (the value is a controlled row field; load it via command substitution and validate the tail is numeric, never paste it into a free-text command string) — and require the URL's `owner/repo` path to name the **current repository** (compare against `gh repo view --json owner,name`). Then query live, repo-scoped: `gh pr view "<number>" --json number,state,url,mergeCommit,baseRefName`. Number-scoping keeps the lookup inside this repo — a full-URL query would scope to the *URL's* repository, silently reconciling against a foreign PR. PR state is **never cached** server-side: `gh` is the live source every run, `pr_url` only names *which* PR to ask about.
- **`pr_url` unusable or the lookup hard-errors** (malformed URL with no numeric tail; a URL naming a different repository; `gh pr view` failing hard — deleted PR, renamed/transferred repo): fall back to the ID-keyed lookup below exactly as for a null `pr_url`; a survivor **back-fills** the corrected URL. No survivor → record `couldn't-check (pr_url unresolvable: <reason>)` — a loud per-ticket line in Step 4 whatever the row's status (a set-but-broken `pr_url` is an anomaly, unlike an ordinary no-PR ticket).
- **`pr_url` null** (a ticket that predates the field, or a manually opened PR): run the ID-keyed lookup below unchanged. On a survivor, **back-fill** the row via `pipeline_update_ticket` with the PR's URL so later passes go direct — a non-status field write, outside the CAS. No survivor → `no-PR-found`, exactly as below.

**fs-native (ID-keyed).** Find the PR by **ticket ID** — this is the **ID-keyed variant of the shared merge predicate** in [`../build/references/pr-creation.md`](../build/references/pr-creation.md). Sync can't use the branch-keyed form (the pushed branch isn't reliably recoverable — its slug is judgment-distilled, and the open-PR flow may reuse a non-convention branch). GitHub's title search is tokenized and AND-matches, so it can return PRs that merely *mention* the ID; **anchor on the `<TICKET-ID>:` title convention** and pick the newest:

```bash
gh pr list --search "<TICKET-ID> in:title" --state all \
  --json number,state,url,createdAt,title,mergeCommit,baseRefName \
  --jq '[.[] | select(.title | startswith("<TICKET-ID>:"))] | sort_by(.createdAt) | last'
```
- Quote `"<TICKET-ID>"` (controlled `<PREFIX>-<N>` token, no raw free-text interpolation). The `startswith("<TICKET-ID>:")` post-filter rejects titles that merely mention the ID (e.g. a multi-ID title), so only the ticket's own PR survives.
- `mergeCommit.oid` and `baseRefName` are carried for the **reachability gate** the shared predicate applies in Step 3 (a `MERGED` PR promotes only when its merge commit has reached `<base>`; the gate consumes the PR's own base as `PR_BASE`).
- **Multiple survivors** (e.g. a reopened PR): `sort_by(.createdAt) | last` picks the newest; note that in the report.
- **No survivor**: record `no-PR-found`; change nothing. Step 4 reports this per the ticket's current folder — a silent aggregate count for `backlog/`/`in-progress/` tickets (most active tickets legitimately have no PR), a loud per-ticket `? Couldn't check` line for `review/` tickets (no PR on a `review/` ticket is an anomaly).

### 3. Act on the PR state

Run Step 2's PR lookup for every kept ticket from Step 1 (except the terminal short-circuit — `done`/`cancelled` status tickets are never PR-checked). Each ticket carries its **current state folder** from Step 1 (server-native: its scanned row status); that drives the solo `mv` source (server-native: the CAS `from`) and the report shaping below.

- **`MERGED` and reachable from `<base>`** → the shared merge predicate's **reachability gate** decides this: after a `git fetch`, resolve `<base>` and require the PR's merge commit to be an ancestor of `origin/<base>` (`git merge-base --is-ancestor`) — the exact rule lives once in [`../build/references/pr-creation.md`](../build/references/pr-creation.md)'s Merge predicate; apply it, don't fork the gate here. Only a merge that has actually reached `<base>` promotes; finalize via **Transition 6** (current state folder → `done`) per [`../flow/references/state-transitions.md`](../flow/references/state-transitions.md) — invoke it, don't reimplement the move logic (the transition dispatches on the storage mode per [`../flow/references/storage.md`](../flow/references/storage.md); the `mv`/`Edit` mechanics elaborated below are its fs-native form):
  - *Solo ticket*: move the folder first from its **current** state folder — `mv "claudedocs/tickets/<current-state>/<id>" "claudedocs/tickets/done/<id>"`, where `<current-state>` is the `backlog`/`in-progress`/`review` folder the Step 1 scan matched (**not** a hardcoded `review/`) — then `Edit` its `01-spec.md` frontmatter `status` → `done`. Do not unify this solo path with the epic-child path below (a child flips in place without a folder move). **Mismatch note**: when the source folder is *not* `review/` — a merged PR reached a solo ticket that never went through the normal `review → done` path — add one `⚠` note line for it in Step 4 (e.g. `⚠ <id> promoted from <folder>/ — merged outside the review→done path`). A promotion from `review/` is the normal path and gets no note.
  - *Epic child*: no child-folder move — `Edit` the child's `status` → `done`. The child's subtree may be in `review/` **or** still in `in-progress/` (a sibling is mid-build); either way the child flips in place, and no mismatch note is emitted (an epic child's status/folder decoupling is by design, not an anomaly). **Defer** Transition 6's **Epic-completion predicate** to once per affected epic at the end of the pass: collect the epics whose children you promoted this pass; for each, re-resolve `<epic-folder>` (the deepest ancestor containing `prd.md`, at its **current** location) and apply the **Epic-completion predicate** (see [`../flow/references/state-transitions.md`](../flow/references/state-transitions.md)) *after* all in-pass child flips are written — invoke it, don't reimplement the roster/sibling scan. On `promote`, `mv` the whole epic subtree from its current folder — `<epic-folder> → done/<EPIC>` (source is wherever the epic currently sits, `in-progress/` or `review/`, **not** a hardcoded `review/<EPIC>`) — and set `prd.md` `status` → `done`. On `stay`, leave the epic where it is: the child flip stands and the epic stays put under the precedence rule. The predicate gates on the epic's **declared `children:` roster**, so a just-in-time epic whose later-phase children aren't materialized yet correctly stays put even when every authored child is terminal. Render any predicate warnings (roster-unknown when `children:` can't be read; roster-drift when a materialized child isn't in the roster) as `⚠ Needs attention` report lines (Step 4). (Deferring once per epic avoids re-applying the predicate per merged child, where only the last child's check can succeed.)
  - **Server-native mechanics** — the same Transition 6, in its CAS form (`state-transitions.md` §Transition 6, Server-native):
    - *Solo ticket*: `pipeline_transition_ticket` with `from: [<scanned status>]` (the row status Step 1 carried — the seam's full caller-dependent breadth is `[backlog, in-progress, in-review, partial-completion]`, but issue the CAS with the status actually scanned, not the whole set), `to: done`. A CAS failure follows `storage.md` §CAS conflict doctrine: re-read the row, re-evaluate T6 against the fresh status (still non-terminal, PR still merged-and-reachable?), then proceed with the corrected `from[]` or record the conflict as a `⚠ Needs attention` line and continue with the rest — never widen `from[]` to force it.
    - *Mismatch note*: fires when the pre-CAS status is not `in-review` (`⚠ <id> promoted from <status> — merged outside the review→done path`) — and, unlike fs, it applies to **epic children too**: the fs child exemption exists only because a child's folder and status decouple by design, and with no folders there is nothing to decouple.
    - *Epic child*: same CAS on the child row; no folder anywhere. Defer the Epic-completion predicate once per affected epic to the end of the pass exactly as above, applying its server variant (roster **derived** from the child rows via `parent_id` — List tickets / list children in `storage.md`); on `promote`, CAS the epic row `from: [in-progress, in-review]`, `to: done` (no `prd.md` — the row is the epic); on `stay`, the epic row keeps its status. Predicate warnings render as `⚠` report lines the same way.
  - Record `✓ promoted → done/` + the PR URL (and the epic move, if it fired).
- **`MERGED` but not yet reachable from `<base>`** (an epic child squash-merged only into `integration/<epic-id>`, or `git`/`gh` couldn't resolve the merge commit or base — e.g. offline) → the reachability gate treats it as **still pending**: record `… merged into integration, not yet on <base>` + the PR URL; change nothing. Never promote on an unverifiable merge. It promotes on a later pass once the integration PR lands on `<base>`.
- **`OPEN`** → record `… open` + the PR URL; change nothing. For a `backlog/` or `in-progress/` ticket, tag the ticket's folder in the report (`… open — ticket in <folder>/`) — sync is a merge-finalizer only and performs **no** Transition 5 (an open PR on an active ticket is reported, never promoted to `review/`).
- **`CLOSED`** (unmerged) → record `⚠ closed unmerged — needs your call`; change nothing. Do NOT auto-revert — reverting to `backlog` is a judgment call (you may reopen or rework).

Atomicity (per `state-transitions.md`, fs-native): always move the folder before editing frontmatter, so a move failure leaves the prior state recoverable. Server-native has no two-step to order — the transition is a single CAS call.

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
- **Server-native shaping**: wherever the template names a state folder, use the row's scanned status instead (`review/` ↔ `in-review`; the `<folder>/` tag reads `— ticket at <status>`). `partial-completion` rows group with `backlog`/`in-progress` for the no-PR silent-skip aggregate (an active row with no PR is equally legitimate); the "no PR found (in review/)" anomaly is a no-PR `in-review` row. The mismatch-note line reads `promoted from <status>` and covers children too (Step 3). Everything else — groups, counts, ordering — is identical.

## Boundaries

**Will Not:**
- Push, create, or close PRs — sync is read-only on GitHub (that's the `--pr` flow's job).

## Error Handling

- A per-ticket `gh` PR lookup errors — the ID-keyed `gh pr list`, or the server-native `gh pr view` on a parsed `pr_url` (which first degrades to the ID-keyed fallback per Step 2) → record `couldn't-check (<reason>)` for that ticket and continue with the rest (one bad ticket never aborts the scan).
- Folder-move failure mid-promotion (fs-native) → surface it, stop that ticket (frontmatter still reflects the prior state for recovery), continue with the rest.
- CAS transition conflict (server-native) → per `storage.md` §CAS conflict doctrine: re-read, re-evaluate, proceed with the corrected `from[]` or record the conflict as a `⚠ Needs attention` line — never widen `from[]` to force it. One conflicted ticket never aborts the scan.
- Pipeline MCP tools unavailable, or a call hard-errors (server-native) → stop per `storage.md` §Loud failure, naming the failed operation; report whatever the pass already promoted before stopping. Never fall back to fs edits.
