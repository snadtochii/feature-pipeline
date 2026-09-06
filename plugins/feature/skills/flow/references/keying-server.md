# Flow — server-native Signal Keying

Canonical logic for how flow reads its ticket-store signals in server-native storage mode. Read when the storage mode detected per [`storage.md`](storage.md) at flow's SETUP is server-native — an fs-native run never needs this file. Referenced by `flow`, plus one same-mode pointer from build's resumption keying at §1's divergence note.

Every operation named below is the one defined in [`storage-server.md`](storage-server.md); this file states how flow composes them. Sections are numbered so the skill body cites `§N`.

## §1 Routing signals

The resumption routing table's signals are read from the server:

- The first row keys on the ticket row's status `in-review` — read via `pipeline_get_ticket`; the row status is the only state signal in this mode. **Deliberate mode divergence** for an epic child flipped `in-review` in place (per Transition 5, the epic row can still be `in-progress` while the child's own status is `in-review`): the other storage mode keys on a location signal and lets such a child fall through to the `06-summary.md` verdict-`pass` row, exiting as already complete; this mode keys on the row status, so the same child routes to build's merge-check pass-through. The row status is the native signal here, and the merge-check is the more useful outcome. Build's resumption keying shares this divergence.
- Artifact presence (`06-summary.md`, `02-plan.md`) comes from `pipeline_list_artifacts`; the `06-summary.md` verdict comes from that artifact row's `verdict` field, or from its body via `pipeline_get_artifact` when the field is unset.

## §2 Kind read

`kind` is the ticket row's `kind` field (Read ticket metadata) — `epic` selects epic mode.

## §3 Start-fresh and invalidation

- **The user's start-fresh signal** is deleting `02-plan.md` (and any downstream artifacts) with `pipeline_delete_artifact` — permanent, no server-side history; copy anything worth keeping first.
- **SETUP's downstream invalidation** checks the `pipeline_list_artifacts` listing for `03-implementation.md` / `04-review.md` / `05-tests.md` / `06-summary.md` when `02-plan.md` is absent, and deletes each present one with `pipeline_delete_artifact` — the one skill-side artifact deletion in the pipeline (the Delete artifact operation in [`storage-server.md`](storage-server.md)).
