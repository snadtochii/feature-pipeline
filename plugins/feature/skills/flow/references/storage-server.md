# Storage — server-native Operations

Canonical logic for the storage operations in server-native storage mode: the loud-failure doctrine, the status values, the CAS conflict doctrine, the tool-name binding, and the operation vocabulary. Read when the storage mode detected per [`storage.md`](storage.md) is server-native — an fs-native run never needs this file. Referenced by [`ticket-resolution-server.md`](ticket-resolution-server.md), [`state-transitions-server.md`](state-transitions-server.md), [`lessons-log-server.md`](lessons-log-server.md), and the stage skills.

Tickets are authoritative rows on a personal server, spoken to only through the pipeline MCP tools; the `project` value from `config.yaml` is the project's identifier in the server's registry, and every `pipeline_*` call is scoped by it. Detection never consults the server registry — the `project` id is taken on trust; a wrong id surfaces later as a loud operation failure, not as a detection-time round-trip. `config.yaml`'s `prefix` plays no part in allocation — server IDs come from the registry-configured prefix. Artifact bodies are **frontmatter-free** — the row is the sole metadata source, so there is no second copy to drift.

---

## Loud failure — no fallback

When the pipeline MCP tools are unavailable (not exposed in the session) or a call fails, the skill **stops** with a clear message naming the personal server and the failed operation, e.g.:

```
Server-native storage operation failed: <operation> (pipeline_<tool>) against the personal server for project <server-project-id>. <error detail>. Stopping — fix the server/MCP connection and re-run. Setup: plugins/feature/docs/advanced.md, "Storage mode and the personal server".
```

It never creates or edits files under `claudedocs/tickets/` as a fallback — a server-native project has exactly one source of truth, and silently forking it into local files is worse than stopping.

---

## Status values

A ticket's status is one of six values — `backlog`, `in-progress`, `in-review`, `done`, `cancelled`, `partial-completion` — and the status column is the entire state. The transitions in [`state-transitions-server.md`](state-transitions-server.md) express the state machine over these values: `in-review` marks an open PR (non-terminal); `done`, `cancelled`, and `partial-completion` are terminal; an epic child's `in-review` is a plain row status with no effect on the parent row beyond the sibling scans the transitions describe.

Status is **writable only through `pipeline_transition_ticket`** (the CAS transition operation below). `pipeline_update_ticket` excludes status by design — there is no non-CAS status write.

---

## CAS conflict doctrine

`pipeline_transition_ticket` is compare-and-set: it takes `from[]` (the statuses the caller believes the ticket may currently be in) and `to`, and fails when the actual status is not in `from[]` — the row changed under the caller.

A failed CAS is **never forced**: do not retry with a widened `from[]` just to make the call succeed. Instead:

1. **Re-read** the ticket (Read ticket metadata, below) to learn its actual current status.
2. **Re-evaluate** the intended move against the invoking transition's decision logic in [`state-transitions-server.md`](state-transitions-server.md) — is this transition still the right one from the actual status?
3. Either **proceed** with the corrected source status (the transition is still valid — re-issue the CAS with the actual status in `from[]`), or **stop and report** the conflict (the transition no longer applies — another session moved the ticket somewhere this transition doesn't source from).

Defined once here; the transition procedures in `state-transitions-server.md` cite this doctrine rather than restating it.

---

## Operation vocabulary

Every reference in this plugin **names** the MCP tools by their bare `pipeline_*` names — that is the vocabulary, here and in every other reference file. The **runtime binding** differs per platform:

- **Claude Code** — the separate `server-native` connector plugin declares the server, so the callable name is derived: `mcp__plugin_` + the connector's plugin name `server-native` + `_` + its `mcpServers` key `ps` (personal server) + `__` + the tool, giving `mcp__plugin_server-native_ps__pipeline_*`. **This derivation is the canonical one**; every scoped literal elsewhere in this plugin is an instance of it, so changing the connector's plugin name or server key changes all of them. The connector is a separate install precisely so a project that never runs server-native has no server declared at all.
- **Codex** — the server comes from the user's own MCP config, and the callable name is `mcp__<server>__pipeline_*`, where `<server>` is whatever key that user chose. There is no server key for the plugin to derive from, which is why none is hardcoded.

Each skill's `allowed-tools` therefore lists two entries per tool: the Claude-scoped name, which is the grant the harness matches on that platform, and the bare name, which is how this plugin's prose refers to the tool and stands in for the user-keyed Codex form. A skill never assembles a namespace at runtime and never speaks raw HTTP: it calls a tool the harness has granted, or it stops per Loud failure above. Setup for both platforms: [`../../../docs/advanced.md`](../../../docs/advanced.md#storage-mode-and-the-personal-server).

The per-concern references express their steps in terms of these operations rather than restating them.

### Resolve ticket (argument → handle)

Turn a ticket argument (ID or path) into a working handle: `pipeline_get_ticket` with the ID — the handle is the ticket row (ID + fields). A path-shaped argument has no meaning here; treat the last path segment as the ID. Not found → ask the user.

### Read ticket metadata

Read the ticket's structured fields: the row fields returned by `pipeline_get_ticket` — `status`, `kind`, `parent_id`, `blocked_by`, `title`, `priority`, `complexity`, `tags`, `pr_url`. The child-linkage field is `parent_id`; the row has **no `children` field** — an epic's roster is derived from its child rows (List tickets / list children, below).

### Read artifact

`pipeline_get_artifact` with the ticket ID and artifact name. For an optional artifact, check the listing first (List artifacts, below) — `pipeline_get_artifact` on an absent artifact is a failed operation under §Loud failure, not a signal.

### Write artifact

`pipeline_write_artifact` with the ticket ID, artifact name, and body — upsert by name, idempotent (a re-run overwrites safely). Pass the optional `verdict` (`pass | fail | partial`) when the artifact carries one (e.g. a build summary). Artifact names are whitelisted server-side: `01-…` through `07-…` numbered artifacts (`0N-<name>.md`), `exploration.md`, `prd.md`.

### Delete artifact

The start-fresh reset. User-side for build's signal (delete `03-implementation.md` onward before re-invoking); skill-side in exactly one place — flow's SETUP downstream-artifact invalidation, which removes build artifacts when `02-plan.md` is absent. No other pipeline skill deletes artifacts.

`pipeline_delete_artifact` with the ticket ID and artifact name — permanent; a deleted body has no server-side history, so copy anything worth keeping before deleting.

### List artifacts (names + timestamps)

`pipeline_list_artifacts` for the ticket — returns artifact rows including `created_at`/`updated_at`, which stand in wherever a procedure compares recency.

### Transition status

Move the ticket through the state machine. The per-transition semantics (sources, targets, epic-child variants, epic-completion predicate) live in [`state-transitions-server.md`](state-transitions-server.md); the mechanism each transition dispatches on is `pipeline_transition_ticket` with `from[]` = the transition's valid source statuses and `to` = its target status, under the CAS conflict doctrine above.

### Update ticket fields

Write non-status fields — `title`, `priority`, `complexity`, `tags`, `blocked_by`, and `pr_url` — via `pipeline_update_ticket`. Status is excluded (CAS-only, above).

### List tickets / list children

`pipeline_list_tickets` for the project — it returns the project-wide list with no server-side status filter, so filter by status (or any field) client-side. An epic's children are the rows whose `parent_id` is the epic's ID — the roster is **derived** from the child rows; the epic row itself carries no `children` field.

### Create ticket

`pipeline_create_ticket` — the server allocates IDs atomically from the registry-configured prefix. The full creation procedure (solo vs epic + children) is owned by `discover`.

### Lessons produce / consume

The contract lives in [`lessons-log-server.md`](lessons-log-server.md) — lessons go through the lesson tools (`pipeline_add_lesson`, `pipeline_list_lessons`, `pipeline_update_lesson`, `pipeline_delete_lesson`). This vocabulary entry exists so lessons are reached through the same seam; the format, supersession, and grep-scoping rules are owned there.
