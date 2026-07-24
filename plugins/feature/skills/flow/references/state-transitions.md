# State Transitions — Shared Logic

Canonical logic for moving tickets through the state machine. Referenced by `plan`, `build`, `flow`, and the standalone `sync` skill.

This file is the single source of truth for the ticket state machine. Stage skills do not duplicate the logic inline — they invoke the relevant transition from this reference.

Every transition dispatches on the project's **storage mode** — detect it once per run per [`storage.md`](storage.md) §Mode detection, and see its Transition status operation for the mechanism each mode uses:

- **fs-native**: folder moves between state directories (`backlog/`, `in-progress/`, `review/`, `done/`) plus frontmatter `status` edits — the per-transition mechanics below.
- **server-native**: one `pipeline_transition_ticket` CAS call per status change (`from[]` = the transition's valid source statuses, `to` = its target), under [`storage.md`](storage.md) §CAS conflict doctrine. There are no folders to move — the status column is the entire state; the fs↔server status correspondence is [`storage.md`](storage.md) §Status mapping. Where a transition also touches non-status fields, those go through `pipeline_update_ticket`. Each transition below carries a **Server-native** paragraph with its `from[]`/`to`.

---

## Layout context (fs-native)

In fs-native mode, a ticket has one of two shapes, established by `discover` (in server-native mode there are no state folders — a ticket is a row, an epic is a row whose children carry `parent`, and "the epic's location" is the epic row's own status):

### Solo ticket (single-mode discover)

```
claudedocs/tickets/<state>/<id>/
├── 01-spec.md
├── 02-plan.md / 03-implementation.md / 04-review.md / 05-tests.md / 06-summary.md
└── exploration.md (optional)
```

### Epic with children (multi-mode discover)

```
claudedocs/tickets/<state>/<EPIC-ID>/
├── prd.md                ← parent epic (kind: epic)
├── exploration.md        ← shared across siblings
└── tasks/
    ├── <CHILD-1-ID>/01-spec.md (+ stage artifacts)
    ├── <CHILD-2-ID>/...
    └── <CHILD-3-ID>/...
```

For epics, the **entire subtree moves between state folders as a unit**. The epic's `<state>/` location follows the most-advanced child under the precedence `in-progress` ⊐ `review` ⊐ `done`: any child `in-progress` → epic in `in-progress/`; else any child `in-review` → epic in `review/`; else every declared child materialized-and-terminal (the Epic-completion predicate) → epic in `done/`.

Variables used throughout:
- `<ticket-folder>` — resolves to `claudedocs/tickets/<state>/<id>/` (solo) or `claudedocs/tickets/<state>/<EPIC>/tasks/<CHILD>/` (child).
- `<epic-folder>` (child only) — `claudedocs/tickets/<state>/<EPIC>/` (the deepest ancestor containing `prd.md`).

---

## Epic-completion predicate (shared)

The single definition of "is this epic finished?" Both end-state transitions (Transition 2 §3 in-progress → done, Transition 6 §3 review → done), the read-only Status query, and the standalone `sync` skill invoke this predicate by name rather than restating the sibling scan. Changing the completion rule means editing **here** — there are no per-transition copies to keep in step.

**Inputs**: the epic's handle — in fs-native mode `<epic-folder>` (the epic's current location, under `in-progress/` or `review/`) and its `prd.md`; in server-native mode the epic row.

**Output**: a decision — `promote` or `stay` — plus zero or more warnings. The predicate reads only: it never moves folders, writes frontmatter, or issues transitions. The invoking transition performs the promotion (fs-native: the move, always from the epic's **current** folder, never a hardcoded source, plus the `prd.md` status edit; server-native: the epic row's CAS transition); the invoking caller renders the warnings in its own channel (`build` inline at the verdict gate, `sync` as `⚠` report lines).

**Definitions** (fs-native / server-native per line):
- `declared` = the set of child IDs the epic declares — `prd.md`'s `children:` field, or the epic row's `children` field. This is the **authoritative roster contract** for the epic.
- A child is **materialized** when its spec exists with readable status — fs-native: `<epic-folder>/tasks/<id>/01-spec.md` exists and has parseable `status` frontmatter (a bare `tasks/<id>/` folder with no readable spec is **not** materialized); server-native: a ticket row exists for the ID (row existence implies a readable status column).
- `materialized` = the set of child IDs with a materialized spec.
- A child is **terminal** when its `status` is `done`, `cancelled`, or `partial-completion`. `in-review` is **not** terminal — an open PR keeps the epic out of `done`.

**Decision — return `promote` iff all three hold**:
1. **(R) roster present** — `prd.md` has a parseable `children:` list.
2. **(C) coverage** — every ID in `declared` is in `materialized` (`declared ⊆ materialized`).
3. **(T) terminal** — every child in `materialized` is terminal.

Otherwise return `stay`: the epic is not promoted and remains at its precedence-derived location (`in-progress` ⊐ `review` ⊐ `done`).

Why coverage (C) matters: a **just-in-time / expanding epic** declares its full `children:` roster upfront but authors child specs later, as the pipeline reaches each phase. Without (C), the check sees only the materialized subset and promotes the epic to `done/` the moment those are terminal — while later-phase children remain unwritten. Reconciling against `declared` closes that hole; it reuses an already-populated signal, so no new frontmatter or lifecycle step is needed.

**Warnings** (surface them, but they block promotion only when they also break R/C/T):
- **roster-unknown** — `children:` is missing, has no key, or is unparseable → return `stay` + warn. Fail safe: never auto-promote an epic whose roster can't be read.
- **roster-drift** — a materialized child is **not** in `declared` → warn. The extra child still counts toward (T): it must itself be terminal for the epic to promote, but its presence alone does not block a fully-delivered epic.

A declared child with **no** materialized folder is the **expected** mid-flight state of a just-in-time epic. It fails (C) → `stay`, with no warning — that is normal, not an anomaly.

**Fail-safe composition**: a materialized child whose spec is present but whose `status` is missing or unparseable is treated as `backlog` (non-terminal) → fails (T) → `stay`. This preserves the existing malformed-sibling rule (worst-case assumption keeps the epic out of `done/`) and composes with the roster rules above rather than replacing it.

**Descope escape hatch**: a declared child that will never be built must be reflected in the roster, or it blocks (C) indefinitely. Two manual operator remediations:
- Remove the child's ID from `prd.md`'s `children:` (shrinks `declared`), **or**
- Materialize `tasks/<id>/01-spec.md` as a stub with `status: cancelled` (adds it to `materialized` as a terminal child).

Either satisfies the predicate. There is no automated roster mutation — descoping is a deliberate human edit.

---

## Transition 1 — Start-of-pipeline (backlog/review/done → in-progress)

**Invoked by**:
- `plan` at the start of a run, before Phase 1 synthesis.
- `build` at the start of a run, before the implement checkpoint (idempotent — if the folder is already in `in-progress/`, no folder move; only frontmatter is touched).

### Solo ticket

1. **Folder move**:
   - If `<ticket-folder>` is in `backlog/`, `review/`, or `done/` (re-run of a completed ticket, or re-plan/re-build of a ticket whose PR is open): move from `claudedocs/tickets/<state>/<id>/` to `claudedocs/tickets/in-progress/<id>/`.
   - If already in `in-progress/`: no folder move.

2. **Frontmatter update**: set `01-spec.md` frontmatter `status` to `in-progress` (overwrites any stale value).

3. **Variable rebinding**: `<ticket-folder>` resolves to the new location for the rest of the stage's run.

### Child of an epic

1. **Identify the epic folder**: walk up from `<ticket-folder>` to the deepest ancestor containing `prd.md`. That's `<epic-folder>`.

2. **Epic-subtree move**:
   - If `<epic-folder>` is in `backlog/`, `review/`, or `done/` (first child entering in-progress, or re-run of a completed/under-review epic): move the **entire epic subtree** from `claudedocs/tickets/<state>/<EPIC>/` to `claudedocs/tickets/in-progress/<EPIC>/`. Other children come along; their per-spec `status` fields are NOT touched.
   - If `<epic-folder>` is already in `in-progress/`: no folder move (a sibling triggered the move earlier).

3. **Frontmatter updates**:
   - Set `prd.md` frontmatter `status` to `in-progress`.
   - Set the child's `01-spec.md` frontmatter `status` to `in-progress`.

4. **Variable rebinding**: `<ticket-folder>` and `<epic-folder>` resolve to their new locations.

### Server-native

- **Solo ticket**: read the row's status first; already `in-progress` → no-op (no CAS call). Otherwise `pipeline_transition_ticket` with `from: [backlog, in-review, done, partial-completion, cancelled]`, `to: in-progress`.
- **Child of an epic**: the same CAS for the child row. Then the epic row (resolved from the child's `parent`): already `in-progress` → no-op; otherwise CAS `from: [backlog, in-review, done]`, `to: in-progress`. Sibling rows are not touched.
- A CAS failure follows [`storage.md`](storage.md) §CAS conflict doctrine.

### Idempotency

If the ticket is already in progress with the expected status — fs-native: folder in `in-progress/`; server-native: row status `in-progress` — this transition is a no-op (no folder move / no CAS call; the fs frontmatter overwrite is harmless). This is what lets plan and build both invoke Transition 1 without conflict — whichever runs first triggers the move; the second one is a no-op.

---

## Transition 2 — End-of-pipeline (in-progress → done)

**Invoked by**:
- `build` after the verdict gate, when the user's choice resolves to "finalize as done":
  - Verdict `pass` + commit decision (whether or not the user confirms the commit, the folder still moves).
  - Verdict `partial` or `stuck` + user choice `accept-as-partial`.

### Solo ticket

1. **Folder move**: move from `claudedocs/tickets/in-progress/<id>/` to `claudedocs/tickets/done/<id>/`. Folder moves as a unit; all artifacts come with it.

2. **Frontmatter update**:
   - On verdict `pass`: set `01-spec.md` frontmatter `status` to `done`.
   - On `accept-as-partial`: set `01-spec.md` frontmatter `status` to `partial-completion`.

### Child of an epic

1. **No child-folder move**: child stays inside the epic subtree (`tasks/<CHILD>/` does not move out of `tasks/`).

2. **Child frontmatter update**:
   - On verdict `pass`: set the child's `01-spec.md` frontmatter `status` to `done`.
   - On `accept-as-partial`: set the child's `01-spec.md` frontmatter `status` to `partial-completion`.

3. **Epic-completion check** (load-bearing for epic-mode): apply the **Epic-completion predicate** (above).
   - On `promote`: move the **entire epic subtree** from `claudedocs/tickets/in-progress/<EPIC>/` to `claudedocs/tickets/done/<EPIC>/`, and set `prd.md` frontmatter `status` to `done`.
   - On `stay`: the epic stays out of `done/` — its location follows the precedence `in-progress` ⊐ `review` ⊐ `done` (any sibling still `in-progress` → `in-progress/`; else any `in-review` → `review/`). The subtree only moves to `done/` once the predicate returns `promote` — i.e. the full declared `children:` roster is materialized and every materialized child is terminal.
   - Surface any predicate warnings (roster-unknown, roster-drift) inline at build's verdict gate.

### Server-native

- **Solo ticket, verdict `pass`**: `pipeline_transition_ticket` with `from: [in-progress, partial-completion]`, `to: done` (`partial-completion` is a valid source because a `continue-with-hint` loop that later passes arrives here from Transition 4's flag).
- **Solo ticket, `accept-as-partial`**: Transition 4 has already CAS-moved the row to `partial-completion` — a terminal status. The fs finalization move to `done/` has no server analog; no further transition fires.
- **Child of an epic**: the same per-verdict CAS for the child row. Then apply the **Epic-completion predicate** (above) over the rows: on `promote`, CAS the epic row `from: [in-progress, in-review]`, `to: done`; on `stay`, the epic row keeps its precedence-derived status. Surface predicate warnings the same way.
- A CAS failure follows [`storage.md`](storage.md) §CAS conflict doctrine.

### Folder-move-then-frontmatter atomicity (fs-native)

Always move the folder first, then update frontmatter. If the folder move fails (permission, disk error), the frontmatter still reflects the prior `in-progress` state, so a retry can detect the mismatch and recover. If the frontmatter update fails after a successful move, the folder location is the authoritative signal (the user can manually fix the frontmatter). Server-native has no two-step to order — the CAS transition is a single atomic call.

---

## Transition 3 — Abort (in-progress → backlog)

**Invoked by**:
- `build` after the verdict gate, when the user's choice on a `partial` or `stuck` verdict is `abort`.

### Solo ticket

1. **Folder move**: move from `claudedocs/tickets/in-progress/<id>/` to `claudedocs/tickets/backlog/<id>/`. All artifacts come with it (the user can keep them or delete manually).

2. **Frontmatter update**: reset `01-spec.md` frontmatter `status` to `backlog`.

### Child of an epic

1. **No subtree move (usually)**: the epic typically stays in `in-progress/` even after one child aborts — sibling work is presumably still active or in `backlog/`.

2. **Child frontmatter update**: reset the child's `01-spec.md` frontmatter `status` to `backlog`.

3. **Inverse all-children-done check**: scan siblings. If **every** sibling is now `backlog` or `cancelled` (the inverse of the done check), move the epic subtree back from `in-progress/<EPIC>/` to `backlog/<EPIC>/` and set `prd.md` frontmatter `status` to `backlog`. A sibling that is `done`, `in-progress`, or `in-review` blocks this revert. Rare in practice — typically a child abort doesn't trigger this — but the rule keeps the epic's folder location consistent with its children's aggregate state.

### Server-native

- **Solo ticket**: `pipeline_transition_ticket` with `from: [in-progress, partial-completion]`, `to: backlog` (`partial-completion` covers an abort after a `continue-with-hint` attempt).
- **Child of an epic**: the same CAS for the child row. Then the inverse all-children check over the sibling rows: if **every** sibling is now `backlog` or `cancelled`, CAS the epic row `from: [in-progress]`, `to: backlog`; otherwise the epic row is untouched.
- A CAS failure follows [`storage.md`](storage.md) §CAS conflict doctrine.

**`in-review` is not a Transition 3 source.** A ticket whose PR is open sits at `in-review` (fs-native: in `review/`), and Transition 3 fires only from the `in-progress` verdict gate. To back out an `in-review` ticket, re-build it first (Transition 1 pulls it back to `in-progress`), then abort through the normal gate. Closed-unmerged-PR handling is out of scope here.

---

## Transition 4 — Partial-completion (frontmatter only, no folder move)

**Invoked by**:
- `build` when verdict is `partial` or `stuck` AND user choice is `continue-with-hint`. Build then re-enters the loop in-process; status flag captures that the prior attempt didn't fully succeed.
- `build` immediately before invoking Transition 2 when user choice is `accept-as-partial` (sets `partial-completion` status first, then Transition 2 moves the folder to `done/` preserving that status).

### Solo ticket

1. **No folder move**: ticket stays in `in-progress/`.

2. **Frontmatter update**: set `01-spec.md` frontmatter `status` to `partial-completion`.

### Child of an epic

1. **No folder move**: child stays inside the epic subtree, which stays in `in-progress/`.

2. **Frontmatter update**: set the child's `01-spec.md` frontmatter `status` to `partial-completion`.

### Server-native

- Solo or child alike: read the row's status first; already `partial-completion` (a repeat `continue-with-hint` round) → no-op, matching the harmless fs frontmatter overwrite. Otherwise `pipeline_transition_ticket` with `from: [in-progress]`, `to: partial-completion`. The epic row is untouched (`partial-completion` is terminal for aggregation but the sibling scan happens in the transitions that read it).
- A CAS failure follows [`storage.md`](storage.md) §CAS conflict doctrine.

---

## Transition 5 — Open-PR (in-progress → review)

**Invoked by**:
- `build` at the verdict gate on verdict `pass` with `--pr`, after a pull request has been opened for the work (the branch/push and the `gh pr create` call live in build's `pr-creation.md` reference). This transition owns the folder move + status flag.

Ticket lands here when its PR is open but not yet merged — a **non-terminal** state. The work is finished from the build loop's perspective, but "done" would misrepresent it: an open PR can be reworked or closed.

### Solo ticket

1. **Folder move**: move from `claudedocs/tickets/in-progress/<id>/` to `claudedocs/tickets/review/<id>/` (create `review/` if absent). Folder moves as a unit; all artifacts come with it.

2. **Frontmatter update**: set `01-spec.md` frontmatter `status` to `in-review`.

### Child of an epic

1. **No child-folder move**: the child stays inside the epic subtree (`tasks/<CHILD>/`).

2. **Child frontmatter update**: set the child's `01-spec.md` frontmatter `status` to `in-review`.

3. **Epic-subtree location check** (precedence `in-progress` ⊐ `review` ⊐ `done`):
   - Scan every sibling under `<epic-folder>/tasks/*/01-spec.md`.
   - If **no** sibling is `in-progress` AND **at least one** is `in-review` (the rest done/cancelled/partial-completion): move the **entire epic subtree** from `claudedocs/tickets/in-progress/<EPIC>/` to `claudedocs/tickets/review/<EPIC>/` and set `prd.md` frontmatter `status` to `in-review`.
   - If any sibling is still `in-progress`: the epic stays in `in-progress/` — `in-progress` outranks `review`.

### Server-native

- **Solo ticket**: `pipeline_transition_ticket` with `from: [in-progress, partial-completion]`, `to: in-review` (`partial-completion` covers a `continue-with-hint` loop that then passes with `--pr`).
- **Child of an epic**: the same CAS for the child row. Then the sibling scan over the child rows (List tickets / list children in [`storage.md`](storage.md)): if **no** sibling is `in-progress` and at least one is `in-review`, CAS the epic row `from: [in-progress]`, `to: in-review`; if any sibling is still `in-progress`, the epic row is untouched — `in-progress` outranks `in-review`.
- When the invoking flow has the opened PR's URL, record it on the row via `pipeline_update_ticket` (`pr_url`) — a non-status field, outside the CAS.
- A CAS failure follows [`storage.md`](storage.md) §CAS conflict doctrine.

### Folder-move-then-frontmatter atomicity (fs-native)

Same rule as Transition 2: move the folder first, then update frontmatter. On a move failure the frontmatter still reflects the prior `in-progress` state, so a retry can recover.

---

## Transition 6 — Merge (current state folder → done)

**Invoked by**:
- `build` (or `flow` delegating to `build`) when re-invoked on a `review/` ticket, **or** the standalone `sync` skill scanning tickets across `backlog/`, `in-progress/`, and `review/` in batch, when the ticket's PR is detected merged **and reachable from `<base>`** via the shared merge predicate in build's `pr-creation.md` reference (`state == MERGED` **and** the PR's merge commit is an ancestor of `origin/<base>` — a merge only into an `integration/<epic-id>` branch does not qualify until it reaches `<base>`; build uses the branch-keyed lookup, sync the ID-keyed one). Transition 6 is Transition 2's body re-pointed at the ticket's **current** state folder as the source. For the **build** caller a solo source is always `review/` (or an epic whose subtree reached `review/`), and an epic child can be `in-progress/`. For the **sync** caller a solo source is whichever of `backlog/`, `in-progress/`, or `review/` its folder-keyed scan found the ticket in — a merged PR can attach to a solo ticket parked outside `review/` after a crash, re-plan, or manual merge — and an epic child that `sync` promotes while a sibling is still mid-build flips `in-review → done` in place (see the child path below).

### Solo ticket

1. **Folder move**: move from the ticket's **current** state folder — `claudedocs/tickets/<state>/<id>/` — to `claudedocs/tickets/done/<id>/`. The source is caller-dependent. For **build**, a solo ticket reaches `in-review` only via Transition 5's solo path, which moves the folder to `review/` *before* flipping the status — so build's solo source is always `review/`. For **sync**, the folder-keyed scan can find a solo ticket with a merged-and-reachable PR sitting in `backlog/`, `in-progress/`, or `review/` (a crash, re-plan, or manual merge parks it outside `review/`), so `sync` sources the `mv` from whichever of those three folders the scan matched. Keep this solo path distinct from the epic-child path below — do not unify them (a child's subtree can still be in `in-progress/` while its status is `in-review`).

2. **Frontmatter update**: set `01-spec.md` frontmatter `status` to `done`.

### Child of an epic

1. **No child-folder move**: child stays inside the epic subtree. The subtree may be in `review/` or still in `in-progress/` (a sibling is mid-build) — the child's status flips in place either way.

2. **Child frontmatter update**: set the child's `01-spec.md` frontmatter `status` to `done`.

3. **Epic-completion check**: apply the **Epic-completion predicate** (above). On `promote`, move the epic subtree to `done/` — from its **current** folder (`in-progress/<EPIC>` or `review/<EPIC>`, whichever it sits in under the precedence rule, **not** a hardcoded `review/` source) — and set `prd.md` `status` to `done`. On `stay`, the epic stays under the precedence rule (`in-progress/` or `review/`). When `sync` promotes a merged child whose epic still has a non-terminal sibling, an unmaterialized declared child, or an unreadable roster, the predicate returns `stay`: the child's `in-review → done` flip stands, and the epic stays put. Surface predicate warnings (roster-unknown, roster-drift) in the caller's channel (`sync` as `⚠` report lines).

### Server-native

- **Solo ticket**: `pipeline_transition_ticket` with `from: [backlog, in-progress, in-review, partial-completion]`, `to: done` — the same caller-dependent breadth as the fs sources: build arrives from `in-review`; `sync`'s scan can find a merged PR on a row parked at `backlog`, `in-progress`, or `partial-completion` after a crash, re-plan, or manual merge (`sync` PR-checks every non-`done`/`cancelled` status).
- **Child of an epic**: the same CAS for the child row (a child flips to `done` while a sibling is still mid-build — no epic-level precondition). Then apply the **Epic-completion predicate** over the rows: on `promote`, CAS the epic row `from: [in-progress, in-review]`, `to: done`; on `stay`, the epic row keeps its current status. Surface predicate warnings in the caller's channel.
- A CAS failure follows [`storage.md`](storage.md) §CAS conflict doctrine.

### Folder-move-then-frontmatter atomicity (fs-native)

Same as Transition 2.

---

## Decision table — verdict + user choice → transition(s)

This is the canonical mapping build uses at the verdict gate. The decision table is the load-bearing contract for future epic-walker work: an epic-walker reads the verdict from each child's `06-summary.md` and predicts which transitions fired based on this table.

The table's Effect column describes the fs-native mechanics; in server-native mode the same transitions fire as their **Server-native** CAS forms (folder → `done/` reads as status → `done`, etc.). The verdict → transition mapping is mode-independent.

| Verdict | User choice            | Transitions               | Effect                                                                  |
|---------|------------------------|---------------------------|-------------------------------------------------------------------------|
| `pass` (no `--pr`) | commit confirmed | T2               | Folder → `done/`; status `done`; standard git commit workflow runs.     |
| `pass` (no `--pr`) | commit declined  | T2               | Folder → `done/`; status `done`; no git commit. Same folder/frontmatter result as above. |
| `pass` + `--pr` | non-interactive ship | T5             | Folder → `review/`; status `in-review`; branch pushed + PR opened. The `--pr` flag and the push/`gh pr create` live in build's `pr-creation.md` reference; T5 owns the folder move + status. |
| in `review/` | re-invocation, PR merged + reachable | T6 | Folder → `done/`; status `done`. Merge detection (`gh pr view`) runs in build's `review/` resumption check; a `MERGED` result **reachable from `<base>`** fires T6 (a merge only into an integration branch does not). |
| `partial` | `accept-as-partial`  | T4, then T2               | Status flips to `partial-completion`; then folder → `done/`, preserving that status. |
| `partial` | `continue-with-hint` | T4                        | Status flips to `partial-completion`; folder stays in `in-progress/`; build loop continues with hint in context. |
| `partial` | `abort`              | T3                        | Folder → `backlog/`; status `backlog`. Epic subtree may move back (inverse all-children check). |
| `stuck`   | `accept-as-partial`  | T4, then T2               | Same as `partial → accept-as-partial`.                                  |
| `stuck`   | `continue-with-hint` | T4                        | Same as `partial → continue-with-hint`.                                 |
| `stuck`   | `abort`              | T3                        | Same as `partial → abort`.                                              |

---

## Status query — read-only inspection (for future epic-walker)

Used by future tooling (notably the epic-mode flow walker) to inspect aggregate state without performing transitions. Documents read-only contracts; no folder moves or frontmatter writes.

### Per-ticket status

Read the ticket's `status` — fs-native: `<ticket-folder>/01-spec.md` frontmatter; server-native: the row field via `pipeline_get_ticket`. Possible values:
- `backlog` — not yet started.
- `in-progress` — currently in the pipeline.
- `in-review` — build passed with `--pr`; PR open, awaiting merge. A **solo** ticket lives in `review/`; an **epic child** can be `in-review` while its subtree is still in `in-progress/` (a sibling is mid-build, so the precedence rule keeps the epic out of `review/`). So `in-review` is found by frontmatter `status`, not by folder location alone. **Non-terminal**: excluded from every done-equivalent / terminal set (epic aggregation, blocker-unblocking), but included in every folder search and resumption path.
- `done` — completed cleanly.
- `partial-completion` — finalized but with un-fixable failures (treated as terminal for aggregate calculations).
- `cancelled` — abandoned (lives in `done/` per the discover convention; treated as terminal).

Frontmatter is authoritative; folder location is a fallback when frontmatter is missing or malformed. Server-native has one source: the status column.

### Epic aggregate status

For an epic (fs-native: `prd.md` present; server-native: row with `kind: epic`):
- Read the epic's own `status` — `prd.md` frontmatter (it tracks the state-folder location), or the epic row.
- Iterate every child — `<epic-folder>/tasks/*/01-spec.md`, or the child rows (List tickets / list children in [`storage.md`](storage.md)) — and read each child's `status`.
- Derived states:
  - **Epic-completion predicate returns `promote`** (the full declared `children:` roster is materialized and every materialized child is terminal): epic should be in `done/` (Transition 2 / Transition 6 moves it there on the last child's finalization). A roster that outruns the materialized set — some declared child not yet authored — does NOT qualify; the epic stays under the precedence rule below.
  - **Any child in-progress**: epic should be in `in-progress/`.
  - **Any child in-review, none in-progress**: epic should be in `review/` (precedence `in-progress` ⊐ `review` ⊐ `done`).
  - **All children backlog or cancelled**: epic should be in `backlog/`.

An epic-walker uses this query to:
1. Pick the next child to run (topologically sort by `blocked_by`, filter to `backlog` status).
2. Report aggregate progress ("3/5 children done, 1 partial-completion, 1 in-progress").
3. Detect inconsistencies (epic folder location doesn't match aggregate child state — surface as a warning).

This subsection is the read-side contract for epic-mode; the write-side contract is the four transitions above.

---

## Error handling

- **Folder move fails (permission, disk error)** (fs-native): surface the failure to the user immediately; leave frontmatter at its previous value (move first, frontmatter second — never optimistic). The user can investigate and either retry or fix manually.
- **CAS transition fails (stale `from[]`)** (server-native): follow [`storage.md`](storage.md) §CAS conflict doctrine — re-read the row, re-evaluate against the invoking transition and the decision table, proceed with the corrected source status or stop and report. Never widen `from[]` just to force the call through.
- **Pipeline MCP tools unavailable or a call errors** (server-native): stop per [`storage.md`](storage.md) §Loud failure — never perform the fs mechanics as a fallback.
- **Frontmatter parse error during status update**: warn the user; do not silently corrupt the file. Ask before retrying.
- **Epic-completion predicate finds a malformed materialized sibling spec** (missing or unparseable `status` frontmatter): treat as `backlog` (worst-case assumption — non-terminal, so the epic stays in `in-progress/` rather than prematurely promoting to `done/`).
- **Epic-completion predicate can't read the roster** (`prd.md` `children:` missing, keyless, or unparseable): return `stay` + a roster-unknown warning — never auto-promote an epic whose declared roster can't be read. Same conservative instinct as the malformed-sibling rule.
- **Epic-completion predicate finds a declared child with no materialized folder**: return `stay` (fails the coverage check). This is the expected mid-flight state of a just-in-time epic and is **not** warned — only the unreadable-roster and drift cases warn.
- **Epic-completion predicate finds a materialized child absent from `children:`**: emit a roster-drift warning. The extra child still must be terminal to satisfy the terminal check, but its presence alone does not block a fully-delivered epic.
- **Epic-folder identification fails** (no ancestor with `prd.md` when one is expected): treat as a solo ticket and warn — the layout is corrupt but the per-ticket transition is still safe.
- **Inverse all-children-done check (Transition 3) finds a `done`, `in-progress`, or `in-review` sibling**: epic subtree stays in `in-progress/`/`review/` per the precedence rule (correct behavior — only the aborted child reverts).
