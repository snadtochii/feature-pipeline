# Build — server-native Storage Mechanics

Canonical logic for build's storage-touching steps in server-native storage mode. Read when the storage mode detected at the caller's start per [`../../flow/references/storage.md`](../../flow/references/storage.md) is server-native — an fs-native run never needs this file. Referenced by `build`, by [`implementation-handoff.md`](implementation-handoff.md) for §4, and by [`worktree.md`](worktree.md) for §2, §5 and §11 on behalf of whichever skill runs it. Operations named below are defined in [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md); sections are numbered so the skill body cites `§N`. Every `pipeline_*` call passes `project_id` verbatim from the `project:` UUID bound at the caller's start (the brief's `Storage mode:` line, or its own detection when standalone) — never resolved from a name ([`../../flow/references/storage-server.md`](../../flow/references/storage-server.md)).

## §1 Inputs

Every input is an artifact read, pulled into the session working copy at State setup (§3). Nothing is read from the repository tree.

## §2 Ticket metadata

Read ticket metadata reads the ticket row. The row has no `repos` field: the worktree binding's eligibility check treats the ticket as single-repo, and `<repo-root>` is the current checkout.

## §3 Working copy

Pull `01-spec.md`, `02-plan.md`, and whichever of `03-implementation.md`/`06-summary.md` exist (per the List artifacts operation) into a session-scratchpad directory — an ephemeral location outside the repository; nothing is ever materialized under `claudedocs/tickets/`, which is not a ticket store in this mode. `<ticket-folder>` denotes this working-copy directory: every `<ticket-folder>/0N-*.md` read/write site in the skill operates on the copies, with writes pushed per §4. All in-loop reading (including the per-step `Read` offset/limit re-read of the plan) works off these copies, and the stuck arbiter's prompt inlines resolved text — the build skill is the only reader/writer of the copies through the loop. The copies are disposable: every run re-pulls from the server; a scratchpad tree left by a prior run is never trusted or reused.

## §4 Artifact writes

Every artifact write named in the skill is upserted to the server via the Write artifact operation the moment the producing step completes. Update the scratchpad copy and push in the same step; a crash then loses at most the in-flight step's output, and a re-run resumes from exactly what the server holds. The `## Worktree` record written into `03-implementation.md` follows the same rule.

`03-implementation.md` (no `verdict`) is the exception to pushing in the same step. It is appended to the scratchpad copy by the mechanism in [`implementation-handoff.md`](implementation-handoff.md) §5. Its upsert carries the copy's current content and is issued as a parallel call alongside the next tool call, never as a turn of its own — still one upsert per step, so the recency signals the review and close stages read hold. With no validation commands documented, the append itself rides with the next step's first tool call, so its upsert rides with the call after that. The last step's upsert rides with the phase-end write, and the `## Stuck` record's with the stuck exit. A crash between an append and its upsert loses at most the entries not yet pushed, one step's worth.

## §5 Worktree binding

The worktree binding runs after §3 because both of its parts read and write `03-implementation.md`, and that copy does not exist until the pull runs. The review and close stages re-bind `<wt-path>`, `<branch>` and `<repo-root>` from the same record; teardown runs in the close stage's finalizer, against those same absolute paths. The existence check that gates re-binding a recorded worktree reads the artifact listing gathered in §3 — never an unguarded read: `pipeline_get_artifact` for an absent artifact is a failed operation under §Loud failure, and would stop every fresh build. [`worktree.md`](worktree.md) §3's "stays in the main checkout" column is moot in this mode — artifacts are rows and `<ticket-folder>` is the session scratchpad — but §2 step 6's config-presence assertion (§11) still applies.

## §10 Resumption keying

The routing signals map onto the ticket row plus `pipeline_list_artifacts`, read after State setup's metadata binding and working-copy pull:

- The in-review refusal keys on row status `in-review` — the row status is the only state signal in this mode.
- Artifact presence comes from the listing; the already-complete check reads the first line of the pulled `06-summary.md` body. The handoff's done signal and its `## Rationale` / `## Stuck` sections are read from the pulled `03-implementation.md` body.
- **Start fresh** — the user deletes `03-implementation.md` (and downstream) via the Delete artifact operation, a user-side action; build itself never deletes artifacts. Permanent: a deleted artifact body has no server-side history, so copy anything worth keeping before deleting.

## §11 Config presence in a worktree

[`worktree.md`](worktree.md) §2 step 6's no-source no-op ("no `config.yaml` anywhere and nothing to copy") never arises in this mode: a run reached that step *because* a `config.yaml` declared `mode: server-native`, so an unreachable marker is a hard stop. After the walk-up check, assert the resolved `config.yaml` declares both `mode: server-native` and a UUID-valued `project:` (the detection contract in [`../../flow/references/storage.md`](../../flow/references/storage.md) §Mode detection). Without them, detection resolves to the default mode and the work stalls at bare-ID ticket resolution — a silent misdetection where the storage doctrine prescribes a loud failure. Assertion fails → stop with an error naming the fix: list `claudedocs/tickets/config.yaml` in `.worktreeinclude` so step 4 carries a marked copy.

## §12 Error handling

A storage operation that fails mid-loop stops the skill per [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md) §Loud failure, with a state report — which artifacts were pushed this run and which step's output was not, so the user knows exactly what the server holds before re-running. A CAS conflict at Transition 1 follows the same file's §CAS conflict doctrine (re-read, re-evaluate, proceed or stop — never widen `from[]`).
