# Flow — fs-native Signal Keying

Canonical logic for how flow reads its ticket-store signals in fs-native storage mode. Read when the storage mode detected per [`storage.md`](storage.md) at flow's SETUP is fs-native — a run in the other storage mode never needs this file. Referenced by `flow`, and by standalone `build`'s closed-ticket check and stage chain (§1, §5).

Every operation named below is the one defined in [`storage-fs.md`](storage-fs.md); this file states how flow composes them. Sections are numbered so the skill body cites `§N`.

## §1 Routing signals

The resumption routing table's signals are read from the ticket folder:

- The first row keys on the ticket folder being in `review/` (status `in-review`). An epic child flipped `in-review` in place while its subtree still sits in `in-progress/<EPIC>/` (per Transition 5, a sibling mid-build keeps the epic out of `review/`) is not matched by this row — keying is folder-based, so such a child falls through to the `06-summary.md` verdict-`pass` row and exits as already complete. The close stage's merge-check keying reads the folder the same way.
- Artifact presence (`02-plan.md`, `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md`) is file presence in the folder (`Glob`); the `06-summary.md` verdict is the first line of its body.
- The ticket's own status is the `status` field of `01-spec.md`'s frontmatter (Read ticket metadata) — never the folder, since an epic child never leaves its epic's `tasks/`.
- Recency ("current", "newer", "older") compares file mtimes from the same `Glob` over the ticket folder (List artifacts): `06-summary.md` is current when its mtime is not older than any of `02-plan.md`, `03-implementation.md`, `04-review.md` and `05-tests.md` that exist.
- The handoff's sections are its `^## ` headings, read with one `Grep` of `03-implementation.md`; the current pass is the one with the highest ` (pass K)` suffix (an unsuffixed heading is pass 1), and the routing rows ask whether that pass has a `## Rationale`, `## Stuck` or `## Post-test` heading.
- `04-review.md`'s `fix-step:` marker is its second line, read with a `Grep` for `^fix-step:` when that file exists.

## §2 Kind read

`kind` is read from the frontmatter of `prd.md` if the folder holds one (an epic), else from `01-spec.md` (Read ticket metadata) — `epic` selects epic mode.

## §3 Start-fresh and invalidation

- **The user's start-fresh signal** is deleting `02-plan.md` (and any downstream `03-`/`04-`/`05-`/`06-` files) from the ticket folder; git is the version-history layer if a backup is wanted.
- **SETUP's downstream invalidation** checks the folder for `03-implementation.md` / `04-review.md` / `05-tests.md` / `06-summary.md` when `02-plan.md` is absent, and deletes each present file — the one skill-side artifact deletion in the pipeline (the Delete artifact operation in [`storage-fs.md`](storage-fs.md)).

## §4 Artifact layout

The folder trees in the Artifact Convention are the layout as it exists on disk: every artifact is a file inside the ticket folder, ticket metadata is the frontmatter of `01-spec.md` (per-child) or `prd.md` (epic), and the ticket folder — or the whole epic subtree, as a unit — moves between the state folders per [`state-transitions-fs.md`](state-transitions-fs.md) (Transitions 1, 2, and 3 each have epic-child variants).

## §5 Stage-brief values

The two mode-valued placeholders in [`stage-briefs.md`](stage-briefs.md) §3 resolve here; the sequencer — flow, or standalone build's stage chain — fills them before each spawn.

- **`<TICKET_ARG>`** is the **absolute ticket-folder path** — the path form of ticket-resolution Step 1 — never the bare ID: ID-form resolution globs `claudedocs/tickets/**/<id>/` relative to the stage subagent's cwd, and a stage running under a ship `--parallel` worker has a worktree as its cwd, where the ticket tree is absent or a stale fork-point copy. Resolve it **immediately before each spawn**: plan's and implement's start-of-run Transition 1 moves `backlog/<id>/` to `in-progress/<id>/`, and the close stage's finalizer moves the folder again, so a path resolved for an earlier spawn can be stale — re-run Step 1's ID search (`Glob` across `claudedocs/tickets/**/<id>/`) before every spawn rather than reusing an earlier path. The one case that forwards a received path unchanged is keyed on the overrides, not on the argument's shape: when the `## Stage overrides` block the sequencer forwards skips the transitions (a ship `--parallel` worker), the folder never moves, so the absolute path the sequencer received stays valid for every spawn. A path a user passed on the command line gets no such exemption — the stages move that folder, so every later spawn re-resolves by ID regardless of the argument's form. For an epic child the path is the `tasks/<CHILD>/` folder; in a multi-repo workspace it points into the workspace checkout, above every repo.
- **`<STORAGE_MODE>`** is the line `Storage mode: fs-native`.
