# State Transitions — Shared Logic

Canonical logic for moving ticket folders between state directories (`backlog/`, `in-progress/`, `review/`, `done/`) and updating frontmatter `status` fields. Referenced by `plan`, `build`, `flow`, and the standalone `sync` skill.

This file is the single source of truth for the ticket state machine. Stage skills do not duplicate the logic inline — they invoke the relevant transition from this reference.

---

## Layout context

A ticket has one of two shapes, established by `discover`:

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

For epics, the **entire subtree moves between state folders as a unit**. The epic's `<state>/` location follows the most-advanced child under the precedence `in-progress` ⊐ `review` ⊐ `done`: any child `in-progress` → epic in `in-progress/`; else any child `in-review` → epic in `review/`; else all children done-or-cancelled-or-partial → epic in `done/`.

Variables used throughout:
- `<ticket-folder>` — resolves to `claudedocs/tickets/<state>/<id>/` (solo) or `claudedocs/tickets/<state>/<EPIC>/tasks/<CHILD>/` (child).
- `<epic-folder>` (child only) — `claudedocs/tickets/<state>/<EPIC>/` (the deepest ancestor containing `prd.md`).

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

### Idempotency

If the ticket is already in `in-progress/` with the expected frontmatter, this transition is a no-op (no folder move, frontmatter overwrite is harmless). This is what lets plan and build both invoke Transition 1 without conflict — whichever runs first triggers the move; the second one is a no-op.

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

3. **All-children-done check** (load-bearing for epic-mode):
   - Scan every sibling under `<epic-folder>/tasks/*/01-spec.md`.
   - Read each sibling's frontmatter `status` field.
   - If **every** sibling is `done`, `cancelled`, or `partial-completion` (`in-review` is NOT terminal — a sibling with an open PR keeps the epic out of `done/`):
     - Move the **entire epic subtree** from `claudedocs/tickets/in-progress/<EPIC>/` to `claudedocs/tickets/done/<EPIC>/`.
     - Set `prd.md` frontmatter `status` to `done`.
   - Otherwise, the epic stays out of `done/` — its location follows the precedence `in-progress` ⊐ `review` ⊐ `done` (any sibling still `in-progress` → `in-progress/`; else any `in-review` → `review/`). The subtree only moves to `done/` on the final sibling's finalization.

### Folder-move-then-frontmatter atomicity

Always move the folder first, then update frontmatter. If the folder move fails (permission, disk error), the frontmatter still reflects the prior `in-progress` state, so a retry can detect the mismatch and recover. If the frontmatter update fails after a successful move, the folder location is the authoritative signal (the user can manually fix the frontmatter).

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

**`review/` is not a Transition 3 source.** A ticket whose PR is open lives in `review/`, and Transition 3 fires only from the `in-progress/` verdict gate. To back out a `review/` ticket, re-build it first (Transition 1 pulls `review/ → in-progress/`), then abort through the normal gate. Closed-unmerged-PR handling is out of scope here.

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

### Folder-move-then-frontmatter atomicity

Same rule as Transition 2: move the folder first, then update frontmatter. On a move failure the frontmatter still reflects the prior `in-progress` state, so a retry can recover.

---

## Transition 6 — Merge (review → done)

**Invoked by**:
- `build` (or `flow` delegating to `build`) when re-invoked on a `review/` ticket, **or** the standalone `sync` skill scanning in-review tickets in batch, when the ticket's PR is detected merged via the shared merge predicate in build's `pr-creation.md` reference (`state == MERGED`; build uses the branch-keyed lookup, sync the ID-keyed one). Transition 6 is Transition 2's body re-pointed at the ticket's **current** state folder as the source — `review/` for a solo ticket or an epic whose subtree reached `review/`, but `in-progress/` for an epic child that `sync` promotes while a sibling is still mid-build (that child's `in-review → done` flip happens in place; see the child path below).

### Solo ticket

1. **Folder move**: move from `claudedocs/tickets/review/<id>/` to `claudedocs/tickets/done/<id>/`. A solo ticket reaches `in-review` only via Transition 5's solo path, which moves the folder to `review/` *before* flipping the status — so a solo `in-review` ticket is always in `review/`, and this source stays `review/`-specific (unlike the epic-child path, where the subtree can still be in `in-progress/`).

2. **Frontmatter update**: set `01-spec.md` frontmatter `status` to `done`.

### Child of an epic

1. **No child-folder move**: child stays inside the epic subtree. The subtree may be in `review/` or still in `in-progress/` (a sibling is mid-build) — the child's status flips in place either way.

2. **Child frontmatter update**: set the child's `01-spec.md` frontmatter `status` to `done`.

3. **All-children-done check**: identical to Transition 2's check — if **every** sibling is now `done`, `cancelled`, or `partial-completion` (`in-review` is NOT in this set), move the epic subtree to `done/` — from its **current** folder (`in-progress/<EPIC>` or `review/<EPIC>`, whichever it sits in under the precedence rule, **not** a hardcoded `review/` source) — and set `prd.md` `status` to `done`. Otherwise the epic stays under the precedence rule (`in-progress/` or `review/`). When `sync` promotes a merged child whose epic is still in `in-progress/`, this check finds the non-terminal sibling and does not fire: the child's `in-review → done` flip stands, and the epic stays put.

### Folder-move-then-frontmatter atomicity

Same as Transition 2.

---

## Decision table — verdict + user choice → transition(s)

This is the canonical mapping build uses at the verdict gate. The decision table is the load-bearing contract for future epic-walker work: an epic-walker reads the verdict from each child's `06-summary.md` and predicts which transitions fired based on this table.

| Verdict | User choice            | Transitions               | Effect                                                                  |
|---------|------------------------|---------------------------|-------------------------------------------------------------------------|
| `pass` (no `--pr`) | commit confirmed | T2               | Folder → `done/`; status `done`; standard git commit workflow runs.     |
| `pass` (no `--pr`) | commit declined  | T2               | Folder → `done/`; status `done`; no git commit. Same folder/frontmatter result as above. |
| `pass` + `--pr` | non-interactive ship | T5             | Folder → `review/`; status `in-review`; branch pushed + PR opened. The `--pr` flag and the push/`gh pr create` live in build's `pr-creation.md` reference; T5 owns the folder move + status. |
| in `review/` | re-invocation, PR detected merged | T6 | Folder → `done/`; status `done`. Merge detection (`gh pr view`) runs in build's `review/` resumption check; a `MERGED` result fires T6. |
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

Read `<ticket-folder>/01-spec.md` frontmatter `status` field. Possible values:
- `backlog` — not yet started.
- `in-progress` — currently in the pipeline.
- `in-review` — build passed with `--pr`; PR open, awaiting merge. A **solo** ticket lives in `review/`; an **epic child** can be `in-review` while its subtree is still in `in-progress/` (a sibling is mid-build, so the precedence rule keeps the epic out of `review/`). So `in-review` is found by frontmatter `status`, not by folder location alone. **Non-terminal**: excluded from every done-equivalent / terminal set (epic aggregation, blocker-unblocking), but included in every folder search and resumption path.
- `done` — completed cleanly.
- `partial-completion` — finalized but with un-fixable failures (treated as terminal for aggregate calculations).
- `cancelled` — abandoned (lives in `done/` per the discover convention; treated as terminal).

Frontmatter is authoritative; folder location is a fallback when frontmatter is missing or malformed.

### Epic aggregate status

For an epic (`prd.md` present):
- Read `prd.md` frontmatter `status` field for the epic's own state-folder location.
- Iterate every child under `<epic-folder>/tasks/*/01-spec.md` and read each child's `status`.
- Derived states:
  - **All children done-equivalent** (`done`, `cancelled`, or `partial-completion`): epic should be in `done/` (Transition 2 / Transition 6 moves it there on the last child's finalization).
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

- **Folder move fails (permission, disk error)**: surface the failure to the user immediately; leave frontmatter at its previous value (move first, frontmatter second — never optimistic). The user can investigate and either retry or fix manually.
- **Frontmatter parse error during status update**: warn the user; do not silently corrupt the file. Ask before retrying.
- **All-children-done check finds a malformed sibling spec** (missing or unparseable `status` frontmatter): treat as `backlog` (worst-case assumption — keeps the epic in `in-progress/` rather than prematurely promoting to `done/`).
- **Epic-folder identification fails** (no ancestor with `prd.md` when one is expected): treat as a solo ticket and warn — the layout is corrupt but the per-ticket transition is still safe.
- **Inverse all-children-done check (Transition 3) finds a `done`, `in-progress`, or `in-review` sibling**: epic subtree stays in `in-progress/`/`review/` per the precedence rule (correct behavior — only the aborted child reverts).
