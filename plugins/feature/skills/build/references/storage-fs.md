# Build — fs-native Storage Mechanics

Canonical logic for build's storage-touching steps in fs-native storage mode. Read when the storage mode detected at the caller's start per [`../../flow/references/storage.md`](../../flow/references/storage.md) is fs-native — a run in the other storage mode never needs this file. Referenced by `build`, by [`implementation-handoff.md`](implementation-handoff.md) for §4, and by [`worktree.md`](worktree.md) for §2, §5 and §11 on behalf of whichever skill runs it. Operations named below are defined in [`../../flow/references/storage-fs.md`](../../flow/references/storage-fs.md); sections are numbered so the skill body cites `§N`.

## §1 Inputs

Every input is a file under `<ticket-folder>`, read with `Read`.

## §2 Ticket metadata

Read ticket metadata reads the frontmatter of `01-spec.md`; `repos` is bound where present — the worktree binding's eligibility input.

## §3 Working copy

`<ticket-folder>` is the ticket's folder in the main checkout, rebound to its `in-progress/` location after Transition 1. Every `<ticket-folder>/0N-*.md` site reads and writes those files directly; subagent spawn prompts carry their absolute paths.

## §4 Artifact writes

Each artifact is a `Write` to `<ticket-folder>/0N-*.md` the moment its producing step completes, so a re-run resumes from what is on disk. `03-implementation.md` is the exception: it is appended, never rewritten, by the mechanism in [`implementation-handoff.md`](implementation-handoff.md) §5, and that append is the write — it lands on disk in the call that validates the step, so no write costs a turn of its own.

## §5 Worktree binding

The `03-implementation.md` existence check that gates re-binding a recorded worktree is a file-presence check (`Glob`), never an unguarded `Read`. [`worktree.md`](worktree.md) §3's "stays in the main checkout" column is `<ticket-folder>` and the lessons log, as written there. The review and close stages re-bind `<wt-path>`, `<branch>` and `<repo-root>` from the same record; teardown runs in the close stage's finalizer, against those same absolute paths.

## §10 Resumption keying

The `review/` refusal keys on the ticket folder being in `review/`. Artifact presence is file presence; the already-complete check reads the first line of `06-summary.md`. The handoff's done signal and its `## Rationale` / `## Stuck` sections are read from the `03-implementation.md` body. Start fresh = the user deletes `03-implementation.md` (and downstream) from the folder; git is the version-history layer.

## §11 Config presence in a worktree

A missing `config.yaml` is valid — the file is optional, and its absence means the default storage mode with no `test:`/`git:`/`worktree:` config (per [`../../flow/references/storage.md`](../../flow/references/storage.md) §Mode detection). [`worktree.md`](worktree.md) §2 step 6's no-source case is therefore a no-op: copying a source that does not exist would strand a freshly-created worktree over a supported configuration.

## §12 Error handling

A failed write or folder move is an ordinary tool error; stop and report the last artifact written. The move-then-frontmatter ordering in [`../../flow/references/state-transitions-fs.md`](../../flow/references/state-transitions-fs.md) keeps the prior state recoverable.
