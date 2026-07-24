# Ticket Resolution — Shared Logic

Canonical logic for resolving a ticket argument to a **ticket handle**, ensuring the spec is in place, locating the shared exploration, and validating that the ticket is actually pipelineable. Referenced by `flow`, `plan`, and `build`.

Every step here dispatches on the project's **storage mode** — detect it once per run per [`storage.md`](storage.md) §Mode detection. In **fs-native** mode the handle is a ticket folder and the procedures below read the tree directly; in **server-native** mode the handle is a ticket row and each step uses the corresponding [`storage.md`](storage.md) operation. Step semantics (search behavior, refusals, blocker rules) are identical in both modes.

`discover` does **not** use this reference — it handles the intake/creation variant with prefix logic inline.

---

## Layout context (fs-native)

In fs-native mode, a ticket folder has one of two shapes depending on whether it came from a single-ticket discovery or from a multi-sibling discovery (an epic with children). In server-native mode none of these folders exist — a solo ticket is a row, an epic is a row with `kind: epic` whose children are rows carrying `parent`, and every file shown below is an artifact row keyed by name on its ticket.

### Solo ticket (single-mode discover)

```
claudedocs/tickets/<state>/<id>/
├── 01-spec.md            ← THE spec (frontmatter + body — this IS the ticket)
├── exploration.md        ← discover output, optional
├── 02-plan.md            ← plan (includes Phase 1 synthesis: Codebase Context + Open Questions Resolved sections)
├── 03-implementation.md  ← build (live, updated per plan step)
├── 04-review.md          ← build (merged from 4 reviewer subagents)
├── 05-tests.md           ← build (UI test results, skip artifact, or Failed Criteria section)
└── 06-summary.md         ← build exit summary (always written; content varies per verdict)
```

### Epic with children (multi-mode discover)

```
claudedocs/tickets/<state>/<EPIC-ID>/
├── prd.md                ← parent epic — frontmatter (kind: epic, children: [...]) + PRD body
├── exploration.md        ← shared exploration, lives once for all siblings
└── tasks/
    ├── <CHILD-1-ID>/
    │   ├── 01-spec.md    ← child ticket — frontmatter (parent, epic, siblings, blocked_by) + body
    │   ├── 02-plan.md
    │   ├── 03-implementation.md
    │   ├── 04-review.md
    │   ├── 05-tests.md
    │   └── 06-summary.md
    ├── <CHILD-2-ID>/
    └── <CHILD-3-ID>/
```

`<state>` is one of `backlog`, `in-progress`, `review`, `done`. The whole epic subtree moves between state folders together; per-child progress is tracked in each child's frontmatter `status` field.

The variable `<ticket-folder>` used throughout stage skills resolves to:
- `claudedocs/tickets/<state>/<id>/` for solo tickets
- `claudedocs/tickets/<state>/<EPIC-ID>/tasks/<CHILD-ID>/` for child tickets

The variable `<epic-folder>` (used only when `<ticket-folder>` is a child) resolves to `claudedocs/tickets/<state>/<EPIC-ID>/` — the deepest ancestor containing `prd.md`.

In server-native mode, `<ticket-folder>` and `<epic-folder>` denote the ticket's and the parent epic's **handles** (their IDs), not paths — a stage that would read or write `<ticket-folder>/<artifact>` uses the Read/Write artifact operations in [`storage.md`](storage.md) against that handle instead.

---

## Step 1 — Resolve the ticket argument

This step is the **Resolve ticket** operation in [`storage.md`](storage.md).

**Server-native**: treat the argument as a ticket ID (for a path-shaped argument, the ID is the ticket-folder segment — the last directory segment, after dropping any trailing `01-spec.md`/`prd.md` filename) and call `pipeline_get_ticket`. Found → the row is the handle; `<ticket-id>` = the row's `id`. Not found → ask the user for the correct ID — do not guess. The fs search order below does not apply — there are no state folders to search.

**fs-native** — given the ticket argument (typically `$1`):

1. **If the argument contains `/` or `.md`**, treat it as a path:
   - If it ends in `01-spec.md`, the ticket folder is its parent directory.
   - If it ends in `prd.md`, the argument refers to an epic — see Step 4 (Validate kind) for handling.
   - If it's a directory under `claudedocs/tickets/<state>/`, that's the ticket folder.
   - Otherwise, parse out the ID and fall through to ID-based search.
2. **Otherwise treat it as a ticket ID** and search in this order:
   - `claudedocs/tickets/backlog/<id>/`
   - `claudedocs/tickets/in-progress/<id>/`
   - `claudedocs/tickets/review/<id>/`
   - `claudedocs/tickets/done/<id>/`
   - **Nested children**: glob `claudedocs/tickets/**/tasks/<id>/` to catch children of an epic
   - Case-insensitive glob: `claudedocs/tickets/**/<id>/`
3. **If not found**, ask the user for the ticket path — do not guess.
4. **Read the spec/PRD** from the resolved folder:
   - If the folder contains `01-spec.md`, this is a solo or child ticket — read it.
   - If the folder contains `prd.md` (and no `01-spec.md`), this is an epic — see Step 4 (Validate kind) below.
5. **Determine `<ticket-id>`** = the frontmatter `id` field, or the folder name if no `id` is set.

The resolved path becomes `<ticket-folder>` for downstream stages.

## Step 2 — Ensure the spec exists

**fs-native** — the ticket folder should always contain `01-spec.md` — that file is the ticket. Edge cases:

1. **Folder exists with `01-spec.md`** — read it. Done.
2. **Folder exists with `prd.md` but no `01-spec.md`** — this is an epic folder, not a child ticket. See Step 4.
3. **Folder exists, neither `01-spec.md` nor `prd.md`** — corrupted state. Ask the user before proceeding.
4. **Read other existing artifacts** relevant to the current stage — `02-plan.md`, `03-implementation.md`, etc., and `exploration.md` if the stage uses it (see Step 5).

**Server-native** — read the spec body via the Read artifact operation: `01-spec.md` for a solo/child ticket, `prd.md` for an epic (the row's `kind` says which — see Step 4). Artifact bodies are frontmatter-free; every structured field comes from the row (Read ticket metadata in [`storage.md`](storage.md)). A row whose spec artifact is missing is the corrupted-state analog — ask the user before proceeding. Other stage artifacts are read the same way, by name.

## Step 3 — Determine project root

Needed for codebase operations during the stage.

1. Determine the project name:
   - **fs-native**: read the `project` field from `01-spec.md`'s frontmatter.
   - **server-native**: the workspace containing `claudedocs/tickets/config.yaml` (the mode marker) is the project — its `project:` key names the server-side project the tickets belong to.
2. Locate the project directory:
   - If the current working directory matches the project, use it
   - Otherwise check common paths — ask the user if ambiguous
3. If the project root can't be determined, ask the user before proceeding.

## Step 4 — Validate kind (per-consumer behavior)

Check the `kind` field — frontmatter in fs-native mode, the row field (Read ticket metadata) in server-native mode. Behavior depends on the consumer:

- **`plan` and `build`** — refuse if `kind: epic`. Epics don't go through plan or build themselves; only their children are pipelineable. Abort with this message:
  ```
  <ID> is an epic (kind: epic), not a pipelineable ticket. Epics group siblings — they hold the PRD, the shared exploration, and the decomposition table, but they don't go through plan/build themselves.

  Run the pipeline against one of its children instead:
  <list the child IDs from the epic's roster — fs-native: the `children:` frontmatter field; server-native: the derived roster per the List tickets / list children operation in [`storage.md`](storage.md)>
  ```

- **`flow`** — branches to **epic-mode** when `kind: epic` is present. The epic walker iterates over the epic's children roster in `blocked_by` topological order and recursively invokes `Skill flow <CHILD-ID>` per child. See [`epic-walk.md`](epic-walk.md). Flow does NOT refuse on epics.

- If `kind` is absent or has any other value, the ticket is pipelineable for all consumers. Proceed normally.

This is the centralized epic-handling rule. Stage skills inherit the refusal behavior via this reference; flow's epic-mode branch point lives in its SKILL.md and the walker in [`epic-walk.md`](epic-walk.md).

## Step 5 — Locate exploration (when the stage needs it)

`plan`'s Phase 1 synthesis reads `exploration.md` as a seed for incremental codebase exploration. Other stages may also reference it. Where it lives depends on the ticket shape:

- **Solo ticket**: the ticket's own `exploration.md` — at `<ticket-folder>/exploration.md` (fs-native), or the ticket's `exploration.md` artifact (server-native).
- **Child of an epic**: the **epic's** `exploration.md`, shared across siblings — at `<epic-folder>/exploration.md` (fs-native, where `<epic-folder>` is `<ticket-folder>/../..`, the deepest ancestor containing `prd.md`), or the parent epic's `exploration.md` artifact (server-native, parent resolved from the child row's `parent` field).

If `exploration.md` is missing entirely (solo ticket created outside `discover`, or an epic that never ran exploration), proceed without a seed — `plan`'s Phase 1 falls back to a full ticket-scoped codebase exploration in that case.

## Step 6 — Validate blockers

Check the `blocked_by` field — frontmatter in fs-native mode, the row field in server-native mode. If it's missing or empty, skip this step. Otherwise, for each blocker ID:

1. **Locate the blocker** using the same Step 1 logic (fs-native: search `backlog/`, `in-progress/`, `review/`, `done/`, including nested children under `tasks/`; server-native: `pipeline_get_ticket` on the blocker ID).
2. **Determine completion**: a blocker is "done" if its `status` is `done` or `cancelled` — read from frontmatter (fs-native, authoritative; folder under `claudedocs/tickets/done/` is the fallback when frontmatter is missing) or from the row (server-native).

   **`review/` / `in-review` is NOT done.** A blocker whose PR is open lives in `review/` with `status: in-review` — the search in step 1 *includes* `review/` so the blocker is findable, but the completion test above deliberately *excludes* it: an open, unmerged PR does not unblock dependents. Do not add `review/` or `in-review` to the done clause — the searched-but-not-done-equivalent asymmetry is intentional.

The stage's behavior depends on which stage is running:

- **`plan`** — does NOT refuse on unfinished blockers. Auto-loads each blocker's available artifacts (`01-spec.md`, `02-plan.md` — whichever exist) and uses them as **Blocker Context** during Phase 1 synthesis and plan design, so the plan reasons against the planned dependency rather than a blind codebase. Print a one-line note per blocker:
  ```
  Loaded blocker context from <blocker-id> (status: <status>, artifacts: <comma-separated list>).
  ```
  The Blocker Context section format passed to subagents during Phase 1 synthesis or read inline during plan design:
  ```
  ## Blocker Context
  This ticket is blocked by <blocker-id> (status: <status>).
  <blocker-id>'s spec: <full content of blocker's 01-spec.md>
  <blocker-id>'s plan: <full content of blocker's 02-plan.md, if present>

  Factor this into your <analysis|plan> — assume the blocker will deliver what its plan/spec describes; do NOT flag as gaps things the blocker is already designed to provide.
  ```

- **`build`** — REFUSE if any blocker is not done (or cancelled). Abort with this message:
  ```
  Cannot run build on <ticket-id>. Blockers not yet done:
  - <blocker-id> (status: <status>, location: claudedocs/tickets/<state>/.../<blocker-id>/)
  - ...

  Either complete the blockers first, or edit this ticket's blocked_by frontmatter if the dependency is wrong.
  ```

This rule is centralized here so stage skills inherit it via reference and don't duplicate the check.

---

## Error handling

- Ticket not found (no folder in fs-native mode; no row in server-native mode) → ask the user
- Spec missing (fs-native: neither `01-spec.md` nor `prd.md` inside the resolved folder; server-native: the row's spec artifact absent) → corrupted state; ask the user
- Metadata missing or malformed (frontmatter in fs-native mode; row fields in server-native mode) → warn and ask
- Server-native storage call fails or the pipeline MCP tools are unavailable → stop per [`storage.md`](storage.md) §Loud failure — never fall back to fs reads or writes
- Project root can't be determined → ask the user
- Resolved item is an epic (`kind: epic`) → abort with the message in Step 4; do not silently fan out to children
- Blocker can't be located → warn and treat as not-done (worst-case assumption); the user can investigate or edit this ticket's `blocked_by` frontmatter
