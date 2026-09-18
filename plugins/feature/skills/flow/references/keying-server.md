# Flow — server-native Signal Keying

Canonical logic for how flow reads its ticket-store signals in server-native storage mode. Read when the storage mode detected per [`storage.md`](storage.md) at flow's SETUP is server-native — an fs-native run never needs this file. Referenced by `flow`, by standalone `build`'s closed-ticket check and stage chain (§1, §5), and by one same-mode pointer from the close stage's resumption keying at §1's divergence note.

Every operation named below is the one defined in [`storage-server.md`](storage-server.md); this file states how flow composes them. Sections are numbered so the skill body cites `§N`.

## §1 Routing signals

The resumption routing table's signals are read from the server:

- The first row keys on the ticket row's status `in-review` — read via `pipeline_get_ticket`; the row status is the only state signal in this mode. **Deliberate mode divergence** for an epic child flipped `in-review` in place (per Transition 5, the epic row can still be `in-progress` while the child's own status is `in-review`): the other storage mode keys on a location signal and lets such a child fall through to the `06-summary.md` verdict-`pass` row, exiting as already complete; this mode keys on the row status, so the same child enters at the close stage's merge check. The row status is the native signal here, and the merge check is the more useful outcome. The close stage's merge-check keying shares this divergence.
- Artifact presence (`02-plan.md`, `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md`) comes from `pipeline_list_artifacts`; the `06-summary.md` verdict comes from that artifact row's `verdict` field, or from its body via `pipeline_get_artifact` when the field is unset.
- The ticket's own status is the row's `status` field, read via `pipeline_get_ticket`.
- Recency ("current", "newer", "older") compares the artifact rows' `updated_at` from the same `pipeline_list_artifacts` call: `06-summary.md` is current when its `updated_at` is not earlier than that of any of `02-plan.md`, `03-implementation.md`, `04-review.md` and `05-tests.md` that exist.
- The handoff's sections are its `## ` headings, read from one `pipeline_get_artifact` of `03-implementation.md`; the current pass is the one with the highest ` (pass K)` suffix (an unsuffixed heading is pass 1), and the routing rows ask whether that pass has a `## Rationale`, `## Stuck` or `## Post-test` heading.
- `04-review.md`'s `fix-step:` marker is the second line of its body, read with `pipeline_get_artifact` when that artifact exists.

## §2 Kind read

`kind` is the ticket row's `kind` field (Read ticket metadata) — `epic` selects epic mode.

## §3 Start-fresh and invalidation

- **The user's start-fresh signal** is deleting `02-plan.md` (and any downstream artifacts) with `pipeline_delete_artifact` — permanent, no server-side history; copy anything worth keeping first.
- **SETUP's downstream invalidation** checks the `pipeline_list_artifacts` listing for `03-implementation.md` / `04-review.md` / `05-tests.md` / `06-summary.md` when `02-plan.md` is absent, and deletes each present one with `pipeline_delete_artifact` — the one skill-side artifact deletion in the pipeline (the Delete artifact operation in [`storage-server.md`](storage-server.md)).

## §4 Artifact layout

The artifact names in the Artifact Convention key artifact rows on the ticket (Write artifact / List artifacts); artifact bodies are frontmatter-free, and every piece of ticket metadata — `status`, `kind`, `parent_id`, `blocked_by` — is a row field. An epic's children are rows with `parent_id` set; the epic "advancing" with its children is the epic row's own `status`, flipped by the CAS transitions in [`state-transitions-server.md`](state-transitions-server.md) (Transitions 1, 2, and 3 each have epic-child variants), never a relocation of anything.

## §5 Stage-brief values

The two mode-valued placeholders in [`stage-briefs.md`](stage-briefs.md) §3 resolve here; the sequencer — flow, or standalone build's stage chain — fills them before each spawn.

- **`<TICKET_ARG>`** is the **bare ticket ID** — the row's `id` from Step 1's `pipeline_get_ticket`. Rows never relocate, so the value resolved at SETUP stays valid for every spawn — re-reading it immediately before each spawn is a no-op; a path-shaped argument flow received (a `--parallel` worker's brief) is reduced to its ID the way Step 1 does. Resolution is cwd-independent here — a stage running under a ship `--parallel` worker, whose cwd is a worktree, resolves the same row.
- **`<STORAGE_MODE>`** is the line `Storage mode: server-native (project <id>)`, with the `project` value from `claudedocs/tickets/config.yaml` — so the stage's own detection, which reads the same file, agrees with flow's.
