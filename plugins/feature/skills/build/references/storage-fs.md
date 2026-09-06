# Build — fs-native Storage Mechanics

Canonical logic for build's storage-touching steps in fs-native storage mode. Read when the storage mode detected at the caller's start per [`../../flow/references/storage.md`](../../flow/references/storage.md) is fs-native — a run in the other storage mode never needs this file. Referenced by `build`, and by [`worktree.md`](worktree.md) / [`pr-creation.md`](pr-creation.md) on behalf of whichever skill runs them. Operations named below are defined in [`../../flow/references/storage-fs.md`](../../flow/references/storage-fs.md); sections are numbered so the skill body cites `§N`.

## §1 Inputs

Every input is a file under `<ticket-folder>`, read with `Read`.

## §2 Ticket metadata

Read ticket metadata reads the frontmatter of `01-spec.md`; `repos` is bound where present — the worktree binding's eligibility input.

## §3 Working copy

`<ticket-folder>` is the ticket's folder in the main checkout, rebound to its `in-progress/` location after Transition 1. Every `<ticket-folder>/0N-*.md` site reads and writes those files directly; subagent spawn prompts carry their absolute paths.

## §4 Artifact writes

Each artifact is a `Write` to `<ticket-folder>/0N-*.md` the moment its producing step completes, so a re-run resumes from what is on disk.

## §5 Worktree binding

The `03-implementation.md` existence check that gates re-binding a recorded worktree is a file-presence check (`Glob`), never an unguarded `Read`. [`worktree.md`](worktree.md) §3's "stays in the main checkout" column is `<ticket-folder>` and the lessons log, as written there.

## §6 Artifact verdicts

The verdict or skip label is the first line of the artifact body — `06-summary.md`, `04-review.md` (`verdict: skipped (trivial diff)` on the short-circuit), and `05-tests.md`'s skip variants per `skip-artifacts.md`; `## Failed Criteria` is a body section of `05-tests.md`. No artifact carries a field outside its body.

## §7 Blocker context for reviewers

Read each blocker's artifacts from its resolved folder; "missing" means the file is absent — check presence before reading.

## §8 Lessons

`claudedocs/tickets/_lessons.md`, per [`../../flow/references/lessons-log-fs.md`](../../flow/references/lessons-log-fs.md).

## §9 PR linkage

`id`/`title` come from the `sed` reads in [`pr-creation.md`](pr-creation.md) §4; `--body-file` is `<ticket-folder>/06-summary.md`; the opened PR's URL + branch are recorded in `06-summary.md`.

## §10 Resumption keying

The first row keys on the ticket folder being in `review/`; the merge predicate's branch is recovered from `06-summary.md` or the current checkout. An epic child flipped `in-review` in place under `in-progress/<EPIC>/` is not matched — it falls through to the `06-summary.md` verdict-`pass` row and exits as already complete. Artifact presence is file presence; the `04-review.md` recency rows compare file mtimes. Start fresh = the user deletes `03-implementation.md` (and downstream) from the folder; git is the version-history layer.

## §11 Config presence in a worktree

A missing `config.yaml` is valid — the file is optional, and its absence means the default storage mode with no `validate:`/`test:`/`git:`/`worktree:` config (per [`../../flow/references/storage.md`](../../flow/references/storage.md) §Mode detection). [`worktree.md`](worktree.md) §2 step 6's no-source case is therefore a no-op: copying a source that does not exist would strand a freshly-created worktree over a supported configuration.

## §12 Error handling

A failed write or folder move is an ordinary tool error; stop and report the last artifact written. The move-then-frontmatter ordering in [`../../flow/references/state-transitions-fs.md`](../../flow/references/state-transitions-fs.md) keeps the prior state recoverable.
