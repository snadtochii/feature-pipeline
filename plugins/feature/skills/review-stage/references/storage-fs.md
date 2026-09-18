# Review Stage — fs-native Storage Mechanics

Canonical logic for the review stage's storage-touching steps in fs-native storage mode. Read when the storage mode detected at the review stage's start per [`../../flow/references/storage.md`](../../flow/references/storage.md) is fs-native — a run in the other storage mode never needs this file. Referenced by `review-stage`. Operations named below are defined in [`../../flow/references/storage-fs.md`](../../flow/references/storage-fs.md); sections are numbered so the skill body cites `§N`.

## §1 Inputs and working copy

`<ticket-folder>` is the resolved ticket folder in the main checkout, bound as an absolute path. With a worktree bound it still resolves there, never inside `<wt-path>`. Every input — `01-spec.md`, `02-plan.md`, `03-implementation.md`, and `04-review.md` when present — is a file under it, read with `Read` after a presence check (`Glob`). Reviewer spawn prompts inline the resolved text; reviewers never read the ticket folder.

## §2 Ticket metadata

Read ticket metadata reads the frontmatter of `01-spec.md`: bind `complexity`, `kind` and `blocked_by`.

## §3 Artifact writes

`04-review.md` is written twice, each time as a `Write` of the whole file: the **pending write** after the merge and the validation of every finding, before any code edit; and the **complete write** as the stage's last action. The `## Post-review` append to `03-implementation.md` follows [`../../build/references/implementation-handoff.md`](../../build/references/implementation-handoff.md) §5 and lands on disk in the call that runs the post-review validation — before the complete write, so `04-review.md` ends newer than `03-implementation.md`.

## §4 Artifact verdicts

The verdict or skip label is the first line of the `04-review.md` body; the `fix-step:` marker is the second. No field lives outside the body. Labels:

- `verdict: skipped (trivial diff)` — the triviality short-circuit.
- `verdict: skipped (no changes)` — the diff union is empty.
- `verdict: reviewed` — all four reviewers returned.
- `verdict: reviewed (partial — <N>/4 reviewers)` — one to three reviewers failed.
- `verdict: failed (all reviewers)` — all four reviewers failed.
- `verdict: stuck (<pattern>)` — the fix step stopped on a stuck pattern; remaining findings are `not attempted`.

## §5 Blocker context for reviewers

Read each blocker's artifacts from its resolved folder; "missing" means the file is absent — check presence before reading.

## §6 Resumption keying

`04-review.md` presence is file presence. Recency compares the file mtimes of `04-review.md` and `03-implementation.md`. The fix-step state is the `fix-step:` line of the read body.

## §7 Error handling

A failed write is an ordinary tool error: stop, return `error` with `failed-step: storage`, and report the last artifact written.
