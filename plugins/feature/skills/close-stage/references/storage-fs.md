# Close Stage — fs-native Storage Mechanics

Canonical logic for the close stage's storage-touching steps in fs-native storage mode. Read when the storage mode detected at the close stage's start per [`../../flow/references/storage.md`](../../flow/references/storage.md) is fs-native — a run in the other storage mode never needs this file. Referenced by `close-stage`, and by [`pr-creation.md`](../../build/references/pr-creation.md) for PR linkage and the merge predicate's branch recovery. Ship's same-mode storage file points at §8 for the UI evidence home. Operations named below are defined in [`../../flow/references/storage-fs.md`](../../flow/references/storage-fs.md); sections are numbered so the skill body cites `§N`.

## §1 Inputs and working copy

`<ticket-folder>` is the resolved ticket folder in the main checkout, bound as an absolute path. With a worktree bound it still resolves there, never inside `<wt-path>`. Every input — `01-spec.md`, `02-plan.md`, `03-implementation.md`, and `04-review.md`, `05-tests.md` and `06-summary.md` when present — is a file under it, read with `Read` after a presence check (`Glob`). Subagent spawn prompts carry absolute paths or inline the resolved text; the `ui-tester` never reads the ticket folder.

## §2 Ticket metadata

Read ticket metadata reads the frontmatter of `01-spec.md`: bind `status`, `kind`, `epic` and `parent`. For an epic child, the epic's declared `children:` roster — carried into the finalizer prompt — is read from the epic's `prd.md` frontmatter.

## §3 Artifact writes

`05-tests.md` and `06-summary.md` are each a `Write` of the whole file to `<ticket-folder>/0N-*.md` the moment the producing step completes, so a re-run resumes from what is on disk. `05-tests.md` is written as soon as the `ui-tester` returns, before any fix, and rewritten after each fix iteration. The `## Post-test` append to `03-implementation.md` follows [`../../build/references/implementation-handoff.md`](../../build/references/implementation-handoff.md) §5 and lands on disk in the call that runs the post-test validation.

## §4 Artifact verdicts

The verdict or skip label is the first line of the artifact body — `06-summary.md` and `05-tests.md`'s skip variants per [`skip-artifacts.md`](skip-artifacts.md); `## Failed Criteria` is a body section of `05-tests.md`. No artifact carries a field outside its body.

## §5 Lessons

`claudedocs/tickets/_lessons.md`, per [`../../flow/references/lessons-log-fs.md`](../../flow/references/lessons-log-fs.md).

## §6 PR linkage

Performed by the finalizer, which receives every path below as an absolute value in its spawn prompt. `id`/`title` come from the `sed` reads in [`pr-creation.md`](../../build/references/pr-creation.md) §4 against `<ticket-folder>/01-spec.md`; `--body-file` is `<ticket-folder>/06-summary.md`; the opened PR's URL + branch are appended to `06-summary.md`, whose body is otherwise left as the close stage authored it.

## §7 Resumption keying

- **Merge check** — keys on the ticket folder being in `review/`; the merge predicate's branch is recovered from `06-summary.md` or the current checkout. An epic child flipped `in-review` in place under `in-progress/<EPIC>/` is not matched — it falls through to the `06-summary.md` verdict-`pass` row and returns as already complete.
- **Incomplete tail** — the finalizer never ran, or returned an error — keyed on `06-summary.md` being present while the ticket's own `01-spec.md` `status` is still `in-progress` or `partial-completion`, and `06-summary.md`'s mtime is not older than any of `03-implementation.md`, `04-review.md` and `05-tests.md`. The signal is the status, never the folder: a finished epic child keeps its folder inside the epic's `tasks/`, an aborted ticket's summary sits in `backlog/` until a later run moves it back, and `accept-as-partial` writes the status before the folder moves — folder location separates none of those from an unfinished tail. A summary older than any of those three belongs to an earlier close run that a later implement or review pass has since superseded, so a fresh close owns the ticket. The gate's decisions are conversational state and are deliberately not persisted, so nothing else about the tail is recoverable from the folder.
- **Test ownership** — `05-tests.md` with an mtime newer than `04-review.md` is this stage's own output, and its `## Failed Criteria` section routes to the fix loop. The router never compares `03-implementation.md` with `05-tests.md`: the stage's own `## Post-test` append makes `03-implementation.md` the newer file.
- **Review currency** — Entry's readiness compares the mtimes of `04-review.md` and `03-implementation.md`, and reads the current pass's `## Post-test` heading from the handoff body.
- Artifact presence is file presence; the verdict and `## Failed Criteria` checks read the file bodies.
- **Start fresh** — the user deletes `05-tests.md` and `06-summary.md` from the folder; git is the version-history layer.

## §8 UI evidence home

Every `ui-tester` capture — the close stage's test checkpoint and ship's end-of-run pass alike — is written to one declared directory, named per [`ui-checks.md`](../../build/references/ui-checks.md) §3:

- **Ticket pass**: `<ticket-folder>/screenshots/`, the absolute path in the main checkout — with a worktree bound it still resolves there, never inside `<wt-path>`, so the evidence stays with the ticket's other artifacts.
- **A pass covering an epic**: `<epic-folder>/screenshots/`.

The spawn prompt carries the resolved absolute path, never a link to this section. Fixed filenames overwrite a prior run's captures.

**Gitignore expectation — stated once, here.** The evidence home lives inside the ticket store, so screenshots enter version control only when the project tracks `claudedocs/tickets/` by its own choice. [`commit.md`](../../build/references/commit.md) §1 excludes `claudedocs/` from the finalizer's commits either way.

## §9 Error handling

A failed write or folder move is an ordinary tool error: stop, return `error` with `failed-step: storage`, and report the last artifact written. The move-then-frontmatter ordering in [`../../flow/references/state-transitions-fs.md`](../../flow/references/state-transitions-fs.md) keeps the prior state recoverable.
