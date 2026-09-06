# Flow — fs-native Signal Keying

Canonical logic for how flow reads its ticket-store signals in fs-native storage mode. Read when the storage mode detected per [`storage.md`](storage.md) at flow's SETUP is fs-native — a run in the other storage mode never needs this file. Referenced by `flow` only.

Every operation named below is the one defined in [`storage-fs.md`](storage-fs.md); this file states how flow composes them. Sections are numbered so the skill body cites `§N`.

## §1 Routing signals

The resumption routing table's signals are read from the ticket folder:

- The first row keys on the ticket folder being in `review/` (status `in-review`). An epic child flipped `in-review` in place while its subtree still sits in `in-progress/<EPIC>/` (per Transition 5, a sibling mid-build keeps the epic out of `review/`) is not matched by this row — keying is folder-based, so such a child falls through to the `06-summary.md` verdict-`pass` row and exits as already complete. Build's resumption keying reads the folder the same way.
- Artifact presence (`06-summary.md`, `02-plan.md`) is file presence in the folder (`Glob`); the `06-summary.md` verdict is the first line of its body.

## §2 Kind read

`kind` is read from the frontmatter of `prd.md` if the folder holds one (an epic), else from `01-spec.md` (Read ticket metadata) — `epic` selects epic mode.

## §3 Start-fresh and invalidation

- **The user's start-fresh signal** is deleting `02-plan.md` (and any downstream `03-`/`04-`/`05-`/`06-` files) from the ticket folder; git is the version-history layer if a backup is wanted.
- **SETUP's downstream invalidation** checks the folder for `03-implementation.md` / `04-review.md` / `05-tests.md` / `06-summary.md` when `02-plan.md` is absent, and deletes each present file — the one skill-side artifact deletion in the pipeline (the Delete artifact operation in [`storage-fs.md`](storage-fs.md)).
