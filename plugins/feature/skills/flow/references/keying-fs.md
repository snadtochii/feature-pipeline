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

## §4 Artifact layout

The folder trees in the Artifact Convention are the layout as it exists on disk: every artifact is a file inside the ticket folder, ticket metadata is the frontmatter of `01-spec.md` (per-child) or `prd.md` (epic), and the ticket folder — or the whole epic subtree, as a unit — moves between the state folders per [`state-transitions-fs.md`](state-transitions-fs.md) (Transitions 1, 2, and 3 each have epic-child variants).

## §5 Stage-brief values

The two mode-valued placeholders in [`stage-briefs.md`](stage-briefs.md) §3 resolve here; flow fills them before each spawn.

- **`<TICKET_ARG>`** is the **absolute ticket-folder path** — the path form of ticket-resolution Step 1 — never the bare ID: ID-form resolution globs `claudedocs/tickets/**/<id>/` relative to the stage subagent's cwd, and a stage running under a ship `--parallel` worker has a worktree as its cwd, where the ticket tree is absent or a stale fork-point copy. Resolve it **immediately before each spawn**: plan's start-of-run Transition 1 moves `backlog/<id>/` to `in-progress/<id>/`, so the path flow resolved at SETUP is stale by the time build spawns — re-run Step 1's ID search (`Glob` across `claudedocs/tickets/**/<id>/`) for the build spawn rather than reusing plan's path. The one case that forwards a received path unchanged is keyed on the overrides, not on the argument's shape: when the `## Stage overrides` block flow forwards skips Transition 1 (a ship `--parallel` worker), the folder never moves, so the absolute path flow received stays valid for both spawns. A path a user passed on the command line gets no such exemption — plan moves that folder, so the build spawn re-resolves by ID regardless of the argument's form. For an epic child the path is the `tasks/<CHILD>/` folder; in a multi-repo workspace it points into the workspace checkout, above every repo.
- **`<STORAGE_MODE>`** is the line `Storage mode: fs-native`.
