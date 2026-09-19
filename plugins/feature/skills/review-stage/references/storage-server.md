# Review Stage — server-native Storage Mechanics

Canonical logic for the review stage's storage-touching steps in server-native storage mode. Read when the storage mode detected at the review stage's start per [`../../flow/references/storage.md`](../../flow/references/storage.md) is server-native — an fs-native run never needs this file. Referenced by `review-stage`. Operations named below are defined in [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md); sections are numbered so the skill body cites `§N`. Every `pipeline_*` call passes `project_id` verbatim from the `project:` UUID bound at the stage's start (the brief's `Storage mode:` line, or its own detection when standalone) — never resolved from a name ([`../../flow/references/storage-server.md`](../../flow/references/storage-server.md)).

## §1 Inputs and working copy

The working copy is the `01-spec.md`, `02-plan.md`, `03-implementation.md` and `04-review.md` bodies the preparation read's Read artifact calls return, held in a session-scratchpad directory outside the repository. `<ticket-folder>` denotes that working copy: every `<ticket-folder>/0N-*.md` read and write site in the skill operates on the copies, with writes pushed per §3. Reviewer spawn prompts inline the resolved text; reviewers never touch the ticket store. The copies are disposable: every run re-pulls from the server, and a scratchpad tree left by a prior run is never trusted or reused.

**The preparation read** (the skill's Entry step 3) is one message carrying every call in parallel: Read ticket metadata; List artifacts (the rows' presence and `updated_at` — §6's signals); Read artifact for each of `01-spec.md`, `02-plan.md`, `03-implementation.md` and `04-review.md`. The listing's result is consumed for those signals alone — never extracted or written to the scratchpad, and a listing that arrives persisted is read for its timestamps only; the bodies come from the gets. A get that fails for an artifact the listing does not show is that artifact's absence; one that fails for an artifact the listing shows is a §7 error. Nothing goes through a shell print — the artifacts arrive through Read artifact, per the runtime reference's tool-result rule. Blocker artifacts (§5) are a second message, issued only when `blocked_by` is non-empty. The pulled bodies are the working copies: each lands in the scratchpad with the first §3 write that touches it, and a body the stage never modifies is never materialized.

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

Blocker artifacts belong to *other* tickets, so they are outside this ticket's working-copy pull — §1's second message carries, for every blocker handle, List artifacts, for presence alone, beside a Read artifact of `01-spec.md` and `06-summary.md`. `02-plan.md` is the fallback only: its get goes out in one further message, issued only for the blockers whose listing lacks `06-summary.md`. "Missing" means absent from that blocker's listing — a get that fails for an artifact the listing does not show; a get that fails for a listed artifact is a §7 error. The bodies come from the gets, never from the listing.

## §6 Resumption keying

`04-review.md` presence comes from the artifact listing. Recency compares the `updated_at` of the `04-review.md` and `03-implementation.md` artifact rows. The fix-step state is the `fix-step:` line of the pulled body.

## §7 Error handling

A storage operation that fails stops the stage per [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md) §Loud failure: return `error` with `failed-step: storage` and a state report — which artifacts were pushed this run and which were not — so the caller knows exactly what the server holds.
