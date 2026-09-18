# Review Stage — server-native Storage Mechanics

Canonical logic for the review stage's storage-touching steps in server-native storage mode. Read when the storage mode detected at the review stage's start per [`../../flow/references/storage.md`](../../flow/references/storage.md) is server-native — an fs-native run never needs this file. Referenced by `review-stage`. Operations named below are defined in [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md); sections are numbered so the skill body cites `§N`.

## §1 Inputs and working copy

Pull `01-spec.md`, `02-plan.md`, `03-implementation.md` and `04-review.md` — whichever exist, per the List artifacts operation — into a session-scratchpad directory outside the repository. `<ticket-folder>` denotes that working copy: every `<ticket-folder>/0N-*.md` read and write site in the skill operates on the copies, with writes pushed per §3. Reviewer spawn prompts inline the resolved text; reviewers never touch the ticket store. The copies are disposable: every run re-pulls from the server, and a scratchpad tree left by a prior run is never trusted or reused.

**The preparation read** (the skill's Entry step 3) is one message carrying every call in parallel: Read ticket metadata; List artifacts (the rows' `updated_at` — §6's signals); Read artifact for each of `01-spec.md`, `02-plan.md`, `03-implementation.md` and `04-review.md` — a read of an artifact the ticket does not have fails, and that failure is its absence, not a §7 error. Nothing goes through a shell print — the artifacts arrive through Read artifact, per the runtime reference's tool-result rule. Blocker artifacts (§5) are a second message, issued only when `blocked_by` is non-empty. The pulled bodies are the working copies: each lands in the scratchpad with the first §3 write that touches it, and a body the stage never modifies is never materialized.

## §2 Ticket metadata

Read ticket metadata reads the ticket row: bind `complexity`, `kind` and `blocked_by`.

## §3 Artifact writes

`04-review.md` is written twice, each time by updating the scratchpad copy and upserting it via the Write artifact operation with the §4 verdict in the same step: the **pending write** after the merge and the validation of every finding, before any code edit; and the **complete write** as the stage's last action. The `## Post-review` append goes to the scratchpad copy of `03-implementation.md` by the mechanism in [`../../build/references/implementation-handoff.md`](../../build/references/implementation-handoff.md) §5; its upsert (no `verdict`) must **complete before** the final `04-review.md` upsert — issue it in the call before, never in parallel with it — so the rows' `updated_at` ordering matches the write order and `04-review.md` ends newer.

## §4 Artifact verdicts

The Write artifact operation accepts `verdict` ∈ `pass | fail | partial`. The body's first line carries the label and its second line the `fix-step:` marker in every case:

- **Skips and stuck** (`skipped (trivial diff)`, `skipped (no changes)`, `stuck (<pattern>)`) — outside the enum: write the artifact **without** `verdict`; the label stays in the body.
- **All four reviewers returned** (`reviewed`) — `verdict: pass`.
- **One to three reviewers failed** (`reviewed (partial — <N>/4 reviewers)`) — `verdict: partial`, so the degraded-review signal lives on the row and not only in the body.
- **All four reviewers failed** (`failed (all reviewers)`) — `verdict: fail`.

## §5 Blocker context for reviewers

Blocker artifacts belong to *other* tickets, so they are outside this ticket's working-copy pull — check what each blocker has via List artifacts on the blocker's handle, then Read artifact for each; "missing" means absent from that blocker's artifact listing, never a failed read.

## §6 Resumption keying

`04-review.md` presence comes from the artifact listing. Recency compares the `updated_at` of the `04-review.md` and `03-implementation.md` artifact rows. The fix-step state is the `fix-step:` line of the pulled body.

## §7 Error handling

A storage operation that fails stops the stage per [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md) §Loud failure: return `error` with `failed-step: storage` and a state report — which artifacts were pushed this run and which were not — so the caller knows exactly what the server holds.
