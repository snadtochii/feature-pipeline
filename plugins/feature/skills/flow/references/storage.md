# Storage — Shared Adapter Seam

Canonical definition of how pipeline skills touch ticket storage. A project runs in exactly one of two **storage modes** — **fs-native** (tickets are files under `claudedocs/tickets/`, read and written entirely offline) or **server-native** (tickets are authoritative rows on a personal server, spoken to only through the pipeline MCP tools). This file owns the mode-detection contract, the failure doctrine, the status mapping, the CAS conflict doctrine, and the storage operation vocabulary with an fs procedure and a server-native procedure per operation.

Referenced by [`ticket-resolution.md`](ticket-resolution.md), [`state-transitions.md`](state-transitions.md), and [`lessons-log.md`](lessons-log.md) — the per-concern references express their steps in terms of these operations and doctrines rather than restating them. Skills inherit the mode switch through those references.

---

## Mode detection

Detect the mode **once per skill run**, locally, from `claudedocs/tickets/config.yaml` (model-read with the `Read` tool — never `yq`/`jq`):

- `mode: server-native` **and** `project: <server-project-id>` both present → **server-native**. The `project` value is the project's identifier in the server's registry; every `pipeline_*` call is scoped by it.
- Missing file, missing `mode` key, or `mode: fs-native` → **fs-native**.
- `mode: server-native` with no `project` key → **config error**: stop with a message naming the missing key. Never proceed in either mode on a half-declared server project.
- Any other `mode` value → stop and ask the user. Never guess a storage backend.

Detection rules:

- **Zero network in fs-native mode.** An fs-native run performs no server call of any kind — detection itself included. The personal server lives in a separate `server-native` connector plugin that a fs-native machine simply does not install, so there is no server to connect to and nothing to opt out of; see [`../../../docs/advanced.md`](../../../docs/advanced.md#storage-mode-and-the-personal-server).
- **Detection never consults the server registry.** The `project` id is taken on trust; a wrong id surfaces later as a loud operation failure, not as a detection-time round-trip.
- The detected mode applies to **every storage operation** in the run. There is no per-operation mode mixing and no mid-run re-detection.

`config.yaml` itself — and `hooks/validate.sh`, which parses only its `validate:` block — stays a **local file in both modes**. It is project execution config (`validate:`, `test:`, `worktree:`) plus the mode marker, not ticket data. In a server-native project, the state folders (`backlog/`, `in-progress/`, `review/`, `done/`) do not exist; `prefix` is meaningful only for fs allocation (server IDs come from the registry-configured prefix).

---

## Loud failure — no fallback

In server-native mode, when the pipeline MCP tools are unavailable (not exposed in the session) or a call fails, the skill **stops** with a clear message naming the personal server and the failed operation, e.g.:

```
Server-native storage operation failed: <operation> (pipeline_<tool>) against the personal server for project <server-project-id>. <error detail>. Stopping — fix the server/MCP connection and re-run. Setup: plugins/feature/docs/advanced.md, "Storage mode and the personal server".
```

It never creates or edits files under `claudedocs/tickets/` as a fallback — a server-native project has exactly one source of truth, and silently forking it into local files is worse than stopping. The inverse holds too: an fs-native run never "upgrades" itself to server calls.

---

## Status mapping

Canonical mapping between fs state (folder + frontmatter) and the server's six-value ticket status. Both modes express the same state machine; this table is the translation:

| fs representation | Server status |
|---|---|
| `backlog/` folder, frontmatter `status: backlog` | `backlog` |
| `in-progress/` folder, frontmatter `status: in-progress` | `in-progress` |
| `review/` folder + frontmatter `status: in-review` (solo); epic child: frontmatter `in-review` flipped in place, folder follows the epic subtree | `in-review` |
| `done/` folder, frontmatter `status: done` | `done` |
| `done/` folder, frontmatter `status: cancelled` | `cancelled` |
| Partial-completion frontmatter flag (folder per its transition — `in-progress/` mid-loop, `done/` when finalized as partial) | `partial-completion` |

Server-side, **status is writable only through `pipeline_transition_ticket`** (the CAS transition operation below). `pipeline_update_ticket` excludes status by design — there is no non-CAS status write.

---

## CAS conflict doctrine

`pipeline_transition_ticket` is compare-and-set: it takes `from[]` (the statuses the caller believes the ticket may currently be in) and `to`, and fails when the actual status is not in `from[]` — the row changed under the caller.

A failed CAS is **never forced**: do not retry with a widened `from[]` just to make the call succeed. Instead:

1. **Re-read** the ticket (Read ticket metadata, below) to learn its actual current status.
2. **Re-evaluate** the intended move against the invoking transition's decision logic in [`state-transitions.md`](state-transitions.md) — is this transition still the right one from the actual status?
3. Either **proceed** with the corrected source status (the transition is still valid — re-issue the CAS with the actual status in `from[]`), or **stop and report** the conflict (the transition no longer applies — another session moved the ticket somewhere this transition doesn't source from).

Defined once here; the transition procedures in `state-transitions.md` cite this doctrine rather than restating it.

---

## Operation vocabulary

Each operation names its fs procedure and its server-native procedure. Every reference in this plugin **names** the MCP tools by their bare `pipeline_*` names — that is the vocabulary, here and in every other reference file. The **runtime binding** differs per platform:

- **Claude Code** — the separate `server-native` connector plugin declares the server, so the callable name is derived: `mcp__plugin_` + the connector's plugin name `server-native` + `_` + its `mcpServers` key `ps` (personal server) + `__` + the tool, giving `mcp__plugin_server-native_ps__pipeline_*`. **This derivation is the canonical one**; every scoped literal elsewhere in this plugin is an instance of it, so changing the connector's plugin name or server key changes all of them. The connector is a separate install precisely so a project that never runs server-native has no server declared at all.
- **Codex** — the server comes from the user's own MCP config, and the callable name is `mcp__<server>__pipeline_*`, where `<server>` is whatever key that user chose. There is no server key for the plugin to derive from, which is why none is hardcoded.

Each skill's `allowed-tools` therefore lists two entries per tool: the Claude-scoped name, which is the grant the harness matches on that platform, and the bare name, which is how this plugin's prose refers to the tool and stands in for the user-keyed Codex form. A skill never assembles a namespace at runtime and never speaks raw HTTP: it calls a tool the harness has granted, or it stops per Loud failure above. Setup for both platforms: [`../../../docs/advanced.md`](../../../docs/advanced.md#storage-mode-and-the-personal-server).

### Resolve ticket (argument → handle)

Turn a ticket argument (ID or path) into a working handle.

- **fs**: the search order and nested-child lookup in [`ticket-resolution.md`](ticket-resolution.md) Step 1 — the handle is the resolved `<ticket-folder>` path.
- **server-native**: `pipeline_get_ticket` with the ID — the handle is the ticket row (ID + fields). A path-shaped argument has no meaning server-side; treat the last path segment as the ID. Not found → ask the user, same as fs.

### Read ticket metadata

Read the ticket's structured fields. The two stores name them differently — use each mode's own names:

- **fs**: YAML frontmatter of `01-spec.md` (solo/child) or `prd.md` (epic) — `status`, `kind`, `parent`, `children`, `blocked_by`, `title`, `priority`, `complexity`, `tags`.
- **server-native**: the row fields returned by `pipeline_get_ticket` — `status`, `kind`, `parent_id`, `blocked_by`, `title`, `priority`, `complexity`, `tags`, `pr_url`. The child-linkage field is `parent_id` (the fs frontmatter's `parent`); the row has **no `children` field** — an epic's roster is derived from its child rows (List tickets / list children, below). Artifact bodies are **frontmatter-free** in server-native mode — the row is the sole metadata source, so there is no second copy to drift.

### Read artifact

- **fs**: `Read` `<ticket-folder>/<name>` (e.g. `01-spec.md`, `02-plan.md`).
- **server-native**: `pipeline_get_artifact` with the ticket ID and artifact name.

### Write artifact

- **fs**: `Write`/`Edit` `<ticket-folder>/<name>`.
- **server-native**: `pipeline_write_artifact` with the ticket ID, artifact name, and body — upsert by name, idempotent (a re-run overwrites safely). Pass the optional `verdict` (`pass | fail | partial`) when the artifact carries one (e.g. a build summary). Artifact names are whitelisted server-side: `01-…` through `07-…` numbered artifacts (`0N-<name>.md`), `exploration.md`, `prd.md`.

### Delete artifact

The start-fresh reset. User-side for build's signal (delete `03-implementation.md` onward before re-invoking); skill-side in exactly one place — flow's SETUP downstream-artifact invalidation, which removes build artifacts when `02-plan.md` is absent. No other pipeline skill deletes artifacts.

- **fs**: delete `<ticket-folder>/<name>`; git history retains the body if a backup is wanted.
- **server-native**: `pipeline_delete_artifact` with the ticket ID and artifact name — permanent; a deleted body has no server-side history, so copy anything worth keeping before deleting.

### List artifacts (names + timestamps)

- **fs**: `Glob` the ticket folder; recency comes from file mtimes.
- **server-native**: `pipeline_list_artifacts` for the ticket — returns artifact rows including `created_at`/`updated_at`, which stand in wherever a procedure compares mtimes.

### Transition status

Move the ticket through the state machine. The per-transition semantics (sources, targets, epic-child variants, epic-completion predicate) live in [`state-transitions.md`](state-transitions.md); this operation is the mechanism each transition dispatches on:

- **fs**: folder `mv` between state directories + frontmatter `status` `Edit`, exactly as each transition specifies.
- **server-native**: `pipeline_transition_ticket` with `from[]` = the transition's valid source statuses and `to` = its target status, under the CAS conflict doctrine above. Folder moves have no server analog — the status column is the entire state.

### Update ticket fields

Write non-status fields — `title`, `priority`, `complexity`, `tags`, `blocked_by`, and (server-native only) `pr_url`.

- **fs**: frontmatter `Edit` on `01-spec.md` / `prd.md`. `pr_url` has no fs frontmatter slot — build records the PR URL in `06-summary.md`, and `sync` rediscovers PRs by title search.
- **server-native**: `pipeline_update_ticket`. Status is excluded (CAS-only, above).

### List tickets / list children

- **fs**: `Glob` the state folders (`claudedocs/tickets/*/*/01-spec.md`, `claudedocs/tickets/*/*/tasks/*/01-spec.md`); an epic's children live under `<epic-folder>/tasks/*/`.
- **server-native**: `pipeline_list_tickets` for the project — it returns the project-wide list with no server-side status filter, so filter by status (or any field) client-side. An epic's children are the rows whose `parent_id` is the epic's ID — the server-side roster is **derived** from the child rows; the epic row itself carries no `children` field.

### Create ticket

- **fs**: `discover`'s inline intake variant — prefix/ID allocation and folder creation live in the `discover` skill, not here.
- **server-native**: `pipeline_create_ticket` — the server allocates IDs atomically from the registry-configured prefix. The full creation procedure (solo vs epic + children) is owned by `discover`.

### Lessons produce / consume

Dual-mode contract lives in [`lessons-log.md`](lessons-log.md) — fs appends to `claudedocs/tickets/_lessons.md`; server-native goes through the lesson tools (`pipeline_add_lesson`, `pipeline_list_lessons`, `pipeline_update_lesson`). This vocabulary entry exists so lessons are reached through the same seam; the format, supersession, and grep-scoping rules are owned there.
