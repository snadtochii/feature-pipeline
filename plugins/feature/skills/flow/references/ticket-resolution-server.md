# Ticket Resolution — server-native

Canonical logic for resolving a ticket argument to a **ticket row**, ensuring the spec is in place, locating the shared exploration, and validating that the ticket is actually pipelineable — in server-native storage mode. Read when the storage mode detected per [`storage.md`](storage.md) is server-native — an fs-native run never needs this file. Referenced by `flow`, `plan`, and `build`.

The handle is a ticket row, and each step below uses the corresponding operation in [`storage-server.md`](storage-server.md).

`discover` does **not** use this reference — it handles the intake/creation variant inline.

---

## Layout context

A solo ticket is a row. An epic is a row with `kind: epic` whose children are rows carrying `parent_id`. Every stage artifact — `01-spec.md` (the spec: this IS the ticket's body), `exploration.md` (discover output, optional), `02-plan.md`, `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md`, and `prd.md` for an epic — is an artifact row keyed by name on its ticket. Artifact bodies are frontmatter-free; every structured field (`id`, `status`, `kind`, `parent_id`, `blocked_by`, `title`, `priority`, `complexity`, `tags`, `pr_url`) lives on the row.

An epic's `exploration.md` lives once, on the epic row, shared across all its children. Per-child progress is each child row's `status`.

The variable `<ticket-folder>` used throughout stage skills denotes the ticket's **handle** — its ID — not a path. The variable `<epic-folder>` (used only when the ticket is a child) denotes the parent epic's handle, resolved from the child row's `parent_id`. A stage that would read or write `<ticket-folder>/<artifact>` uses the Read/Write artifact operations in [`storage-server.md`](storage-server.md) against that handle instead.

---

## Step 1 — Resolve the ticket argument

This step is the **Resolve ticket** operation in [`storage-server.md`](storage-server.md).

Treat the argument as a ticket ID — for a path-shaped argument, the ID is the last directory segment, after dropping any trailing `01-spec.md`/`prd.md` filename — and call `pipeline_get_ticket`. Found → the row is the handle; `<ticket-id>` = the row's `id`. Not found → ask the user for the correct ID — do not guess.

The resolved handle becomes `<ticket-folder>` for downstream stages.

## Step 2 — Ensure the spec exists

Read the spec body via the Read artifact operation: `01-spec.md` for a solo/child ticket, `prd.md` for an epic (the row's `kind` says which — see Step 4). Artifact bodies are frontmatter-free; every structured field comes from the row (Read ticket metadata in [`storage-server.md`](storage-server.md)). A row whose spec artifact is missing is corrupted state — ask the user before proceeding. Other stage artifacts relevant to the current stage — `02-plan.md`, `03-implementation.md`, etc., and `exploration.md` if the stage uses it (see Step 5) — are read the same way, by name.

## Step 3 — Determine project root

Needed for codebase operations during the stage.

1. Determine the project name: the workspace containing `claudedocs/tickets/config.yaml` (the mode marker) is the project — its `project:` key names the server-side project the tickets belong to.
2. Locate the project directory:
   - If the current working directory matches the project, use it
   - Otherwise check common paths — ask the user if ambiguous
3. If the project root can't be determined, ask the user before proceeding.

## Step 4 — Validate kind (per-consumer behavior)

Check the row's `kind` field (Read ticket metadata in [`storage-server.md`](storage-server.md)). Behavior depends on the consumer:

- **`plan` and `build`** — refuse if `kind: epic`. Epics don't go through plan or build themselves; only their children are pipelineable. Abort with this message:
  ```
  <ID> is an epic (kind: epic), not a pipelineable ticket. Epics group siblings — they hold the PRD, the shared exploration, and the decomposition table, but they don't go through plan/build themselves.

  Run the pipeline against one of its children instead:
  <list the child IDs from the derived roster per the List tickets / list children operation in storage-server.md>
  ```

- **`flow`** — branches to **epic-mode** when `kind: epic` is present. The epic walker iterates over the epic's children roster in `blocked_by` topological order and recursively invokes `Skill flow <CHILD-ID>` per child. See [`epic-walk-server.md`](epic-walk-server.md). Flow does NOT refuse on epics.

- If `kind` is absent or has any other value, the ticket is pipelineable for all consumers. Proceed normally.

This is the centralized epic-handling rule. Stage skills inherit the refusal behavior via this reference; flow's epic-mode branch point lives in its SKILL.md and the walker in [`epic-walk-server.md`](epic-walk-server.md).

## Step 5 — Locate exploration (when the stage needs it)

`plan`'s Phase 1 synthesis reads `exploration.md` as a seed for incremental codebase exploration. Other stages may also reference it. Where it lives depends on the ticket shape:

- **Solo ticket**: the ticket's own `exploration.md` artifact.
- **Child of an epic**: the **epic's** `exploration.md` artifact, shared across siblings — read from the parent epic's handle (resolved from the child row's `parent_id`).

If `exploration.md` is missing entirely (solo ticket created outside `discover`, or an epic that never ran exploration), proceed without a seed — `plan`'s Phase 1 falls back to a full ticket-scoped codebase exploration in that case.

## Step 6 — Validate blockers

Check the row's `blocked_by` field. If it's missing or empty, skip this step. Otherwise, for each blocker ID:

1. **Locate the blocker**: `pipeline_get_ticket` on the blocker ID.
2. **Determine completion**: a blocker is "done" if its row `status` is `done` or `cancelled`.

   **`in-review` is NOT done.** A blocker whose PR is open has `status: in-review` — the lookup in step 1 finds it, but the completion test above deliberately *excludes* it: an open, unmerged PR does not unblock dependents. Do not add `in-review` to the done clause — the found-but-not-done-equivalent asymmetry is intentional.

The stage's behavior depends on which stage is running:

- **`plan`** — does NOT refuse on unfinished blockers. Auto-loads each blocker's available artifacts (`01-spec.md`, `02-plan.md` — whichever exist per List artifacts on the blocker's handle) and uses them as **Blocker Context** during Phase 1 synthesis and plan design, so the plan reasons against the planned dependency rather than a blind codebase. Print a one-line note per blocker:
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
  - <blocker-id> (status: <status>)
  - ...

  Either complete the blockers first, or edit this ticket's blocked_by field if the dependency is wrong.
  ```

This rule is centralized here so stage skills inherit it via reference and don't duplicate the check.

---

## Error handling

- Ticket not found (no row) → ask the user
- Spec missing (the row's spec artifact absent) → corrupted state; ask the user
- Row fields missing or malformed → warn and ask
- Storage call fails or the pipeline MCP tools are unavailable → stop per [`storage-server.md`](storage-server.md) §Loud failure — never fall back to local reads or writes
- Project root can't be determined → ask the user
- Resolved item is an epic (`kind: epic`) → abort with the message in Step 4; do not silently fan out to children
- Blocker can't be located → warn and treat as not-done (worst-case assumption); the user can investigate or edit this ticket's `blocked_by` field
