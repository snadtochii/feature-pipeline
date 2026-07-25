# Server-Native Creation — Phase 4 Generation via the Pipeline MCP

Canonical logic for discover's ticket generation when the storage mode is **server-native** (detected in Phase 0 per [`../../flow/references/storage.md`](../../flow/references/storage.md)). Read when Phase 4 runs against a server-native project — an fs-native discovery never needs this file. Referenced by `discover` only.

Ground rules, all inherited from `storage.md` and restated here only as bindings:

- **MCP-only, by `pipeline_*` name.** Every server operation goes through the pipeline MCP tools, named here by their bare `pipeline_*` names. The per-platform callable forms and the `allowed-tools` listing rule are defined once in [`../../flow/references/storage.md`](../../flow/references/storage.md) §Operation vocabulary; discover follows it unchanged. Discover never assembles a namespace at runtime and never speaks raw HTTP.
- **Project scope.** Every call is scoped by the `project` value from `claudedocs/tickets/config.yaml` (read once in Phase 0).
- **Loud failure, no fs fallback.** A failed or unavailable pipeline tool stops the skill with storage.md's loud-failure message naming the operation and project, and pointing at [`../../../docs/advanced.md`](../../../docs/advanced.md#storage-mode-and-the-pipeline-mcp-server) for setup. Discover never creates files under `claudedocs/tickets/` as a fallback — see §Partial-failure honesty for what to report first.
- **The exploration-mode gate is unchanged.** An exploration session that ends without a ticket leaves both the project tree and the server untouched — no create call happens before the developer commits.

## Shared rules (both single- and multi-mode)

### Frontmatter-free artifact bodies

Spec and PRD artifact bodies contain **only the template body sections** (`templates/task.md` / `templates/prd.md` from `## Description` / `## Problem` downward) — no YAML frontmatter block. All structured metadata (id, title, status, priority, complexity, tags, kind, parent linkage, blocked_by) lives exclusively on the ticket row; the row is the sole metadata source, so there is no second copy to drift. The templates stay as-is — the fill step simply omits the frontmatter block in this mode.

### Fields with no server column

`siblings`, the `epic` slug, `created`, `project`, and `repos` are **dropped** — each is derivable from rows, covered by the registry, or fs-mode-only:

- `siblings` — derivable: the other rows sharing this child's `parent_id`.
- `epic` slug — may appear in prose (e.g. the PRD's heading), never as structured metadata skills parse.
- `created` — the row's `created_at` timestamp.
- `project` — the config.yaml `project` scope every call already carries.
- `repos` — fs-mode-only (workspace-shape detection is skipped in this mode; there is no server column).

### `status` is never passed

Omit `status` on every create — the server defaults new tickets to `backlog`. Discover performs no transitions in either mode.

### Field values

`title`, `priority`, `complexity` (per-child in multi-mode), and `tags` carry exactly the values the fs fill step would have written to frontmatter, including the Important-Rules title rule (descriptive, never the bare ID).

## Single-mode (N=1)

1. **Create the ticket**: `pipeline_create_ticket` with `title`, `kind: solo`, `priority`, `complexity`, `tags`. The server allocates the ID atomically from the registry-configured prefix — capture it from the response as `<TICKET-ID>`.
2. **Write the spec**: `pipeline_write_artifact` with the ticket ID, name `01-spec.md`, and the template body sections (frontmatter-free, per the shared rule).
3. **Write the exploration**: `pipeline_write_artifact` with name `exploration.md` — the same header block and verbatim Phase 2 explorer output the fs step writes (thin exploration is still written, so `plan` can see what discovery covered).
4. **Present the ticket**:

   ```
   ## Ticket Created

   **ID**: <TICKET-ID> (server-native — visible on the project board)
   **Title**: <title>
   **Complexity**: <S/M/L/XL>
   **Priority**: <priority>

   [Show the full ticket content]

   → Edit if you want to adjust anything
   → Run `/feature:flow <TICKET-ID>` to start the pipeline
   → Run `/feature:plan <TICKET-ID>` to just plan first (Phase 1 synthesis surfaces gaps and patterns before build)
   ```

## Multi-mode (N>1, after checkpoint approval)

The Phase 3.5 checkpoint (`multi-sibling.md`) applies unchanged — approve/adjust/collapse, the validation rules, the table shape. One rendering difference: the server allocates IDs only at create time, so every sibling/epic ID reference anywhere in the checkpoint uses positional placeholders (`#1` … `#N` for children, `#E` for the epic) — the *Tentative ID* column, the `blocked_by` column, the `**Parent epic**` header line, and the AC-coverage checklist alike. Real IDs replace them during generation below.

**Creation ordering** (IDs are known only post-create, so linkage happens in this exact order):

1. **Create the epic**: `pipeline_create_ticket` with the epic title, `kind: epic`, `priority`, `tags`. Capture `<EPIC-ID>`.
2. **Create each child, in checkpoint order**: `pipeline_create_ticket` with the child's title, `kind: child`, `parent_id: <EPIC-ID>`, per-child `priority`, `complexity`, `tags`. Capture each `<CHILD-ID>`. (Child rows carrying `parent_id` are how the server derives the epic's roster — there is no `children` field to write.)
3. **Set `blocked_by`, after all siblings exist**: for each child whose checkpoint row lists blockers, one `pipeline_update_ticket` mapping the placeholder references to the real sibling IDs. `blocked_by` is a full-list replace — send the child's complete blocker list in one call.
4. **Write the epic artifacts**: `pipeline_write_artifact` on `<EPIC-ID>` for `prd.md` (template body sections, frontmatter-free; the Decomposition table uses the real allocated IDs) and for the shared `exploration.md` (multi-sibling header + verbatim explorer output — one copy on the epic, none per child).
5. **Write each child spec**: `pipeline_write_artifact` on each `<CHILD-ID>` for `01-spec.md` — template body sections scoped to the child's slice, referencing the parent by `<EPIC-ID>` and siblings by their real IDs, frontmatter-free.
6. **Present the result** — the multi-sibling presentation block with the folder-path lines replaced:

   ```
   ## Epic + Children Created

   **Epic ID**: <EPIC-ID> (kind: epic — not pipelineable directly; server-native — visible on the project board)
   **Children**: <N>

   | ID | Title | Complexity | blocked_by |
   |---|---|---|---|
   | <CHILD-1-ID> | <title> | M | — |
   | <CHILD-2-ID> | <title> | M | <CHILD-1-ID> |
   ...

   → Edit any spec or the PRD to adjust
   → Start the first child: /feature:flow <CHILD-1-ID>
   → Or plan first: /feature:plan <CHILD-1-ID>
   ```

## Partial-failure honesty

Multi-mode creation is **not transactional**. If a create, update, or artifact write fails midway:

1. **Report exactly what exists**: the IDs created so far (epic, which children), which `blocked_by` updates landed, which artifacts were written — where the local record is uncertain, re-read with `pipeline_get_ticket` / `pipeline_list_tickets` (filter client-side by `parent_id`) for tickets and `blocked_by`, and `pipeline_list_artifacts` per created ticket for the artifact rows.
2. **Report exactly what remains**: the children not yet created, the updates and artifact writes still pending, in order.
3. **Stop** — per the loud-failure doctrine. Never delete server tickets to "roll back", and never write fs tickets to compensate.

A manual re-run of the remainder is safe: `pipeline_write_artifact` is an idempotent upsert, `pipeline_update_ticket` is a full-list replace, and already-created tickets are simply skipped (list the epic's children first to see what exists).
