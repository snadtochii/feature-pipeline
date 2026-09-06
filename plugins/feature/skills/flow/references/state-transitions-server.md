# State Transitions — server-native

Canonical logic for moving tickets through the state machine in server-native storage mode. Read when the storage mode detected per [`storage.md`](storage.md) is server-native — an fs-native run never needs this file. Referenced by `plan`, `build`, `flow`, and the standalone `sync` skill.

This file is the single source of truth for the ticket state machine. Stage skills do not duplicate the logic inline — they invoke the relevant transition from this reference.

Every transition is one `pipeline_transition_ticket` CAS call per status change (`from[]` = the transition's valid source statuses, `to` = its target) — the Transition status operation in [`storage-server.md`](storage-server.md), under its §CAS conflict doctrine. The status column is the entire state; its values are `storage-server.md` §Status values. Where a transition also touches non-status fields, those go through `pipeline_update_ticket`. Each transition below states its `from[]`/`to`.

---

## Layout context

A ticket is a row. An epic is a row with `kind: epic` whose children are rows carrying `parent_id`; "the epic's location" is the epic row's own status. Every stage artifact is an artifact row keyed by name on its ticket.

For epics, the epic row's status follows the most-advanced child under the precedence `in-progress` ⊐ `in-review` ⊐ `done`: any child `in-progress` → epic `in-progress`; else any child `in-review` → epic `in-review`; else every child terminal (the Epic-completion predicate) → epic `done`.

Variables used throughout:
- `<ticket-folder>` — the ticket's handle: its row (ID + fields).
- `<epic-folder>` (child only) — the parent epic's handle, resolved from the child row's `parent_id`.

---

## Epic-completion predicate (shared)

The single definition of "is this epic finished?" Both end-state transitions (Transition 2 §3 in-progress → done, Transition 6 §3 in-review → done), the read-only Status query, and the standalone `sync` skill invoke this predicate by name rather than restating the sibling scan. Changing the completion rule means editing **here** — there are no per-transition copies to keep in step.

**Inputs**: the epic's handle — the epic row plus its child listing (List tickets / list children in [`storage-server.md`](storage-server.md)).

**Output**: a decision — `promote` or `stay` — plus zero or more warnings. The predicate reads only: it never writes fields or issues transitions. The invoking transition performs the promotion (the epic row's CAS transition); the invoking caller renders the warnings in its own channel (`build` inline at the verdict gate, `sync` as `⚠` report lines).

**Definitions**:
- `declared` = the epic's child roster: the set of IDs of the rows whose `parent_id` is the epic's ID (the epic row carries no roster field — the roster is **derived** from the child rows). This is the authoritative roster contract for the epic.
- A child is **materialized** when a ticket row exists for the ID (row existence implies a readable status column).
- `materialized` = the set of child IDs with a materialized row.
- A child is **terminal** when its `status` is `done`, `cancelled`, or `partial-completion`. `in-review` is **not** terminal — an open PR keeps the epic out of `done`.

**Decision — return `promote` iff all three hold**:
1. **(R) roster present** — the child listing succeeded and returned at least one row (a failed listing already stopped the run per `storage-server.md`'s loud-failure doctrine; an epic with zero child rows fails (R) — see roster-unknown below).
2. **(C) coverage** — every ID in `declared` is in `materialized` (`declared ⊆ materialized`).
3. **(T) terminal** — every child in `materialized` is terminal.

Otherwise return `stay`: the epic is not promoted and remains at its precedence-derived status (`in-progress` ⊐ `in-review` ⊐ `done`).

Why coverage (C) is stated: with the roster derived from child rows, `declared` = `materialized` by construction, so (C) is trivially satisfied — a just-in-time / expanding epic's yet-uncreated children are invisible to the predicate, and only the zero-row guard in (R) holds an empty epic back. (C) gains teeth only once every planned child's row exists; until then, an epic whose remaining children are not yet created promotes as soon as the created ones are terminal.

**Warnings** (surface them, but they block promotion only when they also break R/C/T):
- **roster-unknown** — the epic has zero child rows → return `stay` + warn. Fail safe: never auto-promote an epic whose roster is empty.
- **roster-drift** — a materialized child is **not** in `declared` → warn. With a derived roster this cannot arise (every child row is in `declared`); the warning is kept so the predicate's vocabulary is complete. The extra child still counts toward (T): it must itself be terminal for the epic to promote, but its presence alone does not block a fully-delivered epic.

**Fail-safe composition**: a child row whose `status` is empty or outside the six values is treated as `backlog` (non-terminal) → fails (T) → `stay`. This preserves the malformed-sibling rule (worst-case assumption keeps the epic out of `done`) and composes with the roster rules above rather than replacing it.

**Descope escape hatch**: a declared child that will never be built must be reflected in the roster, or it blocks the predicate indefinitely (an existing non-terminal row blocks (T)). Manual operator remediation: transition the child's row to `cancelled` — it becomes terminal. There is no roster list to edit; the roster is the rows. There is no automated roster mutation — descoping is a deliberate human edit.

---

## Transition 1 — Start-of-pipeline (backlog/in-review/done → in-progress)

**Invoked by**:
- `plan` at the start of a run, before Phase 1 synthesis.
- `build` at the start of a run, before the implement checkpoint (idempotent — a row already at `in-progress` is left alone).

### Solo ticket

Read the row's status first; already `in-progress` → no-op (no CAS call). Otherwise `pipeline_transition_ticket` with `from: [backlog, in-review, done, partial-completion, cancelled]`, `to: in-progress`. Re-running a completed ticket, or re-planning/re-building a ticket whose PR is open, both arrive here.

### Child of an epic

1. The same CAS for the child row.
2. Then the epic row (resolved from the child's `parent_id`): already `in-progress` → no-op; otherwise CAS `from: [backlog, in-review, done]`, `to: in-progress`. Sibling rows are not touched.

A CAS failure follows [`storage-server.md`](storage-server.md) §CAS conflict doctrine.

### Idempotency

If the row status is already `in-progress`, this transition is a no-op (no CAS call). This is what lets plan and build both invoke Transition 1 without conflict — whichever runs first triggers the write; the second one is a no-op.

---

## Transition 2 — End-of-pipeline (in-progress → done)

**Invoked by**:
- `build` after the verdict gate, when the user's choice resolves to "finalize as done":
  - Verdict `pass` + any commit outcome (prompt-confirmed, prompt-declined, `git.commit: always`/`never`, or `--no-commit` — whether or not a commit is made, the ticket still finalizes).
  - Verdict `partial` or `stuck` + user choice `accept-as-partial`.

### Solo ticket

- **Verdict `pass`**: `pipeline_transition_ticket` with `from: [in-progress, partial-completion]`, `to: done` (`partial-completion` is a valid source because a `continue-with-hint` loop that later passes arrives here from Transition 4's flag).
- **`accept-as-partial`**: Transition 4 has already CAS-moved the row to `partial-completion` — a terminal status. No further transition fires.

### Child of an epic

1. The same per-verdict CAS for the child row.
2. **Epic-completion check** (load-bearing for epic-mode): apply the **Epic-completion predicate** (above) over the rows. On `promote`, CAS the epic row `from: [in-progress, in-review]`, `to: done`; on `stay`, the epic row keeps its precedence-derived status (any sibling still `in-progress` → `in-progress`; else any `in-review` → `in-review`). The epic row reaches `done` only once the predicate returns `promote` — i.e. every child row is terminal.
3. Surface any predicate warnings (roster-unknown, roster-drift) inline at build's verdict gate.

A CAS failure follows [`storage-server.md`](storage-server.md) §CAS conflict doctrine. The CAS transition is a single atomic call — there is no two-step to order.

---

## Transition 3 — Abort (in-progress → backlog)

**Invoked by**:
- `build` after the verdict gate, when the user's choice on a `partial` or `stuck` verdict is `abort`.

### Solo ticket

`pipeline_transition_ticket` with `from: [in-progress, partial-completion]`, `to: backlog` (`partial-completion` covers an abort after a `continue-with-hint` attempt). Artifacts stay on the row (the user can keep them or delete manually).

### Child of an epic

1. The same CAS for the child row.
2. **Inverse all-children-done check**: scan the sibling rows. If **every** sibling is now `backlog` or `cancelled` (the inverse of the done check), CAS the epic row `from: [in-progress]`, `to: backlog`; otherwise the epic row is untouched. A sibling that is `done`, `in-progress`, or `in-review` blocks this revert. Rare in practice — typically a child abort doesn't trigger this — but the rule keeps the epic row consistent with its children's aggregate state.

A CAS failure follows [`storage-server.md`](storage-server.md) §CAS conflict doctrine.

**`in-review` is not a Transition 3 source.** A ticket whose PR is open sits at `in-review`, and Transition 3 fires only from the `in-progress` verdict gate. To back out an `in-review` ticket, re-build it first (Transition 1 pulls it back to `in-progress`), then abort through the normal gate. Closed-unmerged-PR handling is out of scope here.

---

## Transition 4 — Partial-completion (status only)

**Invoked by**:
- `build` when verdict is `partial` or `stuck` AND user choice is `continue-with-hint`. Build then re-enters the loop in-process; the status captures that the prior attempt didn't fully succeed.
- `build` immediately before invoking Transition 2 when user choice is `accept-as-partial` (sets `partial-completion` status first; Transition 2 then finalizes preserving that status).

### Solo ticket or child of an epic

Solo or child alike: read the row's status first; already `partial-completion` (a repeat `continue-with-hint` round) → no-op. Otherwise `pipeline_transition_ticket` with `from: [in-progress]`, `to: partial-completion`. The epic row is untouched (`partial-completion` is terminal for aggregation, but the sibling scan happens in the transitions that read it).

A CAS failure follows [`storage-server.md`](storage-server.md) §CAS conflict doctrine.

---

## Transition 5 — Open-PR (in-progress → in-review)

**Invoked by**:
- `build` at the verdict gate on verdict `pass` with `--pr`, after a pull request has been opened for the work (the branch/push and the `gh pr create` call live in build's `pr-creation.md` reference). This transition owns the status flip.

Ticket lands here when its PR is open but not yet merged — a **non-terminal** state. The work is finished from the build loop's perspective, but "done" would misrepresent it: an open PR can be reworked or closed.

### Solo ticket

`pipeline_transition_ticket` with `from: [in-progress, partial-completion]`, `to: in-review` (`partial-completion` covers a `continue-with-hint` loop that then passes with `--pr`).

### Child of an epic

1. The same CAS for the child row. An epic child's `in-review` is a plain row status — the child row is the signal, and consumers that key on `in-review` (flow's and build's resumption routing) read the child row's status directly, whatever the epic row says.
2. **Epic status check** (precedence `in-progress` ⊐ `in-review` ⊐ `done`): scan the sibling rows (List tickets / list children in [`storage-server.md`](storage-server.md)). If **no** sibling is `in-progress` and at least one is `in-review` (the rest done/cancelled/partial-completion), CAS the epic row `from: [in-progress]`, `to: in-review`; if any sibling is still `in-progress`, the epic row is untouched — `in-progress` outranks `in-review`.

When the invoking flow has the opened PR's URL, record it on the row via `pipeline_update_ticket` (`pr_url`) — a non-status field, outside the CAS.

A CAS failure follows [`storage-server.md`](storage-server.md) §CAS conflict doctrine.

---

## Transition 6 — Merge (current status → done)

**Invoked by**:
- `build` (or `flow` delegating to `build`) when re-invoked on an `in-review` ticket, **or** the standalone `sync` skill scanning every non-terminal row (`backlog`, `in-progress`, `in-review`, `partial-completion`) in batch, when the ticket's PR is detected merged **and reachable from `<base>`** via the shared merge predicate in build's `pr-creation.md` reference (`state == MERGED` **and** the PR's merge commit is an ancestor of `origin/<base>` — a merge only into an `integration/<epic-id>` branch does not qualify until it reaches `<base>`; build uses the branch-keyed lookup, sync the ID-keyed one — both prefer the row's `pr_url` when set). Transition 6 is Transition 2's body re-pointed at the ticket's **current** status as the source. For the **build** caller a solo source is always `in-review`. For the **sync** caller a solo source is whichever non-terminal status its scan found the row at — a merged PR can attach to a row parked at `backlog`, `in-progress`, or `partial-completion` after a crash, re-plan, or manual merge — and an epic child that `sync` promotes while a sibling is still mid-build flips `in-review → done` with no epic-level precondition (see the child path below).

### Solo ticket

`pipeline_transition_ticket` with `from: [backlog, in-progress, in-review, partial-completion]`, `to: done` — the caller-dependent breadth above: build arrives from `in-review`; `sync`'s scan can find a merged PR on a row parked at `backlog`, `in-progress`, or `partial-completion` (`sync` PR-checks every non-`done`/`cancelled` status). Keep this solo path distinct from the epic-child path below — do not unify them (a child flips while its epic row can still be `in-progress`).

### Child of an epic

1. The same CAS for the child row (a child flips to `done` while a sibling is still mid-build — no epic-level precondition).
2. **Epic-completion check**: apply the **Epic-completion predicate** (above) over the rows. On `promote`, CAS the epic row `from: [in-progress, in-review]`, `to: done`; on `stay`, the epic row keeps its current status. When `sync` promotes a merged child whose epic still has a non-terminal sibling or an empty roster, the predicate returns `stay`: the child's `in-review → done` flip stands, and the epic row stays put. Surface predicate warnings (roster-unknown, roster-drift) in the caller's channel (`sync` as `⚠` report lines).

A CAS failure follows [`storage-server.md`](storage-server.md) §CAS conflict doctrine.

---

## Decision table — verdict + user choice → transition(s)

This is the canonical mapping build uses at the verdict gate. The decision table is the load-bearing contract for future epic-walker work: an epic-walker reads the verdict from each child's `06-summary.md` and predicts which transitions fired based on this table.

| Verdict | User choice            | Transitions               | Effect                                                                  |
|---------|------------------------|---------------------------|-------------------------------------------------------------------------|
| `pass` (no `--pr`) | commit made (prompt confirmed, or `git.commit: always`) | T2               | Status → `done`; the commit runs per build's `commit.md` reference.     |
| `pass` (no `--pr`) | no commit (prompt declined, `git.commit: never`, or `--no-commit`)  | T2               | Status → `done`; no git commit. Same row result as above. |
| `pass` + `--pr` | non-interactive ship | T5             | Status → `in-review`; branch pushed + PR opened; `pr_url` recorded on the row. The `--pr` flag and the push/`gh pr create` live in build's `pr-creation.md` reference; T5 owns the status flip. |
| at `in-review` | re-invocation, PR merged + reachable | T6 | Status → `done`. Merge detection (`gh pr view`) runs in build's `in-review` resumption check; a `MERGED` result **reachable from `<base>`** fires T6 (a merge only into an integration branch does not). |
| `partial` | `accept-as-partial`  | T4, then T2               | Status flips to `partial-completion` (terminal); T2 then has nothing further to write. |
| `partial` | `continue-with-hint` | T4                        | Status flips to `partial-completion`; build loop continues with hint in context. |
| `partial` | `abort`              | T3                        | Status → `backlog`. Epic row may revert (inverse all-children check). |
| `stuck`   | `accept-as-partial`  | T4, then T2               | Same as `partial → accept-as-partial`.                                  |
| `stuck`   | `continue-with-hint` | T4                        | Same as `partial → continue-with-hint`.                                 |
| `stuck`   | `abort`              | T3                        | Same as `partial → abort`.                                              |

---

## Status query — read-only inspection (for future epic-walker)

Used by future tooling (notably the epic-mode flow walker) to inspect aggregate state without performing transitions. Documents read-only contracts; no writes.

### Per-ticket status

Read the ticket's `status` — the row field via `pipeline_get_ticket`. Possible values:
- `backlog` — not yet started.
- `in-progress` — currently in the pipeline.
- `in-review` — build passed with `--pr`; PR open, awaiting merge. An **epic child** can be `in-review` while its epic row is still `in-progress` (a sibling is mid-build, so the precedence rule keeps the epic row at `in-progress`) — the child row's status is the signal. **Non-terminal**: excluded from every done-equivalent / terminal set (epic aggregation, blocker-unblocking), but included in every resolution and resumption path.
- `done` — completed cleanly.
- `partial-completion` — finalized but with un-fixable failures (treated as terminal for aggregate calculations).
- `cancelled` — abandoned (treated as terminal).

The status column is the single source.

### Epic aggregate status

For an epic (row with `kind: epic`):
- Read the epic row's own `status`.
- Iterate every child row (List tickets / list children in [`storage-server.md`](storage-server.md)) and read each child's `status`.
- Derived states:
  - **Epic-completion predicate returns `promote`** (every child row is terminal): epic row should be `done` (Transition 2 / Transition 6 writes it on the last child's finalization). An epic whose planned children are not all created yet still promotes once the existing ones are terminal — see the predicate's coverage note.
  - **Any child in-progress**: epic row should be `in-progress`.
  - **Any child in-review, none in-progress**: epic row should be `in-review` (precedence `in-progress` ⊐ `in-review` ⊐ `done`).
  - **All children backlog or cancelled**: epic row should be `backlog`.

An epic-walker uses this query to:
1. Pick the next child to run (topologically sort by `blocked_by`, filter to `backlog` status).
2. Report aggregate progress ("3/5 children done, 1 partial-completion, 1 in-progress").
3. Detect inconsistencies (epic row status doesn't match aggregate child state — surface as a warning).

This subsection is the read-side contract for epic-mode; the write-side contract is the transitions above.

---

## Error handling

- **CAS transition fails (stale `from[]`)**: follow [`storage-server.md`](storage-server.md) §CAS conflict doctrine — re-read the row, re-evaluate against the invoking transition and the decision table, proceed with the corrected source status or stop and report. Never widen `from[]` just to force the call through.
- **Pipeline MCP tools unavailable or a call errors**: stop per [`storage-server.md`](storage-server.md) §Loud failure — never perform any local write as a fallback.
- **Epic-completion predicate finds a child row with an empty or unrecognized `status`**: treat as `backlog` (worst-case assumption — non-terminal, so the epic row stays at `in-progress` rather than prematurely promoting to `done`).
- **Epic-completion predicate finds an empty roster** (zero child rows): return `stay` + a roster-unknown warning — never auto-promote an epic with no children. Same conservative instinct as the unrecognized-status rule.
- **Epic-completion predicate finds a materialized child absent from `declared`**: emit a roster-drift warning. The extra child still must be terminal to satisfy the terminal check, but its presence alone does not block a fully-delivered epic.
- **Parent resolution fails** (the child row's `parent_id` names no row when one is expected): treat as a solo ticket and warn — the linkage is corrupt but the per-ticket transition is still safe.
- **Inverse all-children-done check (Transition 3) finds a `done`, `in-progress`, or `in-review` sibling**: the epic row stays at `in-progress`/`in-review` per the precedence rule (correct behavior — only the aborted child reverts).
