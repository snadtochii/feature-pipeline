# Build — server-native Storage Mechanics

Canonical logic for build's storage-touching steps in server-native storage mode. Read when the storage mode detected at the caller's start per [`../../flow/references/storage.md`](../../flow/references/storage.md) is server-native — an fs-native run never needs this file. Referenced by `build`, and by [`worktree.md`](worktree.md) / [`pr-creation.md`](pr-creation.md) on behalf of whichever skill runs them. Operations named below are defined in [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md); sections are numbered so the skill body cites `§N`.

## §1 Inputs

Every input is an artifact read, pulled into the session working copy at State setup (§3). Nothing is read from the repository tree.

## §2 Ticket metadata

Read ticket metadata reads the ticket row; bind `pr_url` alongside the shared fields. The row has no `repos` field: the worktree binding's eligibility check treats the ticket as single-repo, and `<repo-root>` is the current checkout.

## §3 Working copy

Pull `01-spec.md`, `02-plan.md`, and whichever of `03-implementation.md`/`04-review.md`/`05-tests.md`/`06-summary.md` exist (per the List artifacts operation) into a session-scratchpad directory — an ephemeral location outside the repository; nothing is ever materialized under `claudedocs/tickets/`, which is not a ticket store in this mode. `<ticket-folder>` denotes this working-copy directory: every `<ticket-folder>/0N-*.md` read/write site in the skill operates on the copies, with writes pushed per §4. All in-loop reading (including the per-step `Read` offset/limit re-read of the plan) works off these copies, and subagent spawn prompts reference scratchpad paths — subagents never touch the ticket store; the build skill is its only reader/writer in this loop. The copies are disposable: every run re-pulls from the server; a scratchpad tree left by a prior run is never trusted or reused.

## §4 Artifact writes

Every artifact write named in the skill is upserted to the server via the Write artifact operation the moment the producing step completes — `03-implementation.md` after each update (no `verdict`), `04-review.md`, `05-tests.md`, and `06-summary.md` each with the `verdict` rule in §6. Update the scratchpad copy and push in the same step; a crash then loses at most the in-flight checkpoint's output, and a re-run resumes from exactly what the server holds. The `## Worktree` record written into `03-implementation.md` follows the same rule.

## §5 Worktree binding

The worktree binding runs after §3 because both of its parts read and write `03-implementation.md`, and that copy does not exist until the pull runs. The existence check that gates re-binding a recorded worktree reads the artifact listing gathered in §3 — never an unguarded read: `pipeline_get_artifact` for an absent artifact is a failed operation under §Loud failure, and would stop every fresh build. [`worktree.md`](worktree.md) §3's "stays in the main checkout" column is moot in this mode — artifacts are rows and `<ticket-folder>` is the session scratchpad — but §2 step 6's config-presence assertion (§11) still applies.

## §6 Artifact verdicts

The Write artifact operation accepts `verdict` ∈ `pass | fail | partial`. Per write site:

- **`04-review.md`, triviality short-circuit** — `skipped` is outside the enum: write the artifact **without** `verdict`; the label stays in the body.
- **`04-review.md`, merged findings** — `verdict: pass` when all four reviewers returned (the checkpoint completed cleanly — findings are merged and the fix step applies them); a graceful partial-merge (1–3 reviewers failed) upserts `verdict: partial`, so the degraded-review signal lives on the row and not only in the body; the all-four-failed error entry is written with `verdict: fail`.
- **`05-tests.md`, ui-tester output** — `pass` when every acceptance criterion passed; `partial` when a `## Failed Criteria` section is present.
- **`05-tests.md`, skip artifact** — skip labels are outside the enum: write **without** `verdict`; the skip variant stays in the body.
- **`06-summary.md`** — `pass` → `pass`, `partial` → `partial`; `stuck` is outside the enum — omit `verdict` and keep the token in the body.

## §7 Blocker context for reviewers

Blocker artifacts belong to *other* tickets, so they are outside this ticket's working-copy pull — check what each blocker has via List artifacts on the blocker's handle, then Read artifact for each; "missing" means absent from that blocker's artifact listing, never a failed read.

## §8 Lessons

The cross-ticket lessons log is the lesson tools, per [`../../flow/references/lessons-log-server.md`](../../flow/references/lessons-log-server.md).

## §9 PR linkage

- **Ticket id and title for the PR** — there is no `01-spec.md` file to `sed`; the ticket's `id` and `title` are row fields (Read ticket metadata). The injection discipline of [`pr-creation.md`](pr-creation.md) §4 is preserved by changing the source, not the mechanism: write each value to a session-scratchpad file with the Write tool, then load it with the same command substitution (`TICKET_ID=$(cat "<scratchpad id file>")`, likewise the title) — never paste row text into a `"…"` literal. The `--body-file` path is the session working copy of `06-summary.md` (pulled per §3, pushed per §4).
- **Recording the opened PR** — re-upsert `06-summary.md` with the URL + branch, and additionally record the URL on the ticket row via Update ticket fields (`pipeline_update_ticket` `pr_url`) — the non-status field write named in [`../../flow/references/state-transitions-server.md`](../../flow/references/state-transitions-server.md) Transition 5.

## §10 Resumption keying

The routing table's signals map onto the ticket row plus `pipeline_list_artifacts` (artifact rows carrying `created_at`/`updated_at`), read after State setup's metadata binding and working-copy pull:

- The first row keys on row status `in-review` — the row status is the only state signal in this mode. For the merge predicate, the row's `pr_url` (when set) identifies the PR directly (`gh pr view <url>` accepts a URL) and takes precedence over branch recovery; otherwise the pushed branch is recovered from the `06-summary.md` artifact body or the current checkout. For an epic child flipped `in-review` in place this keying deliberately diverges from the folder-keyed reading of the other mode — the divergence note in [`../../flow/references/keying-server.md`](../../flow/references/keying-server.md) §1 applies here identically.
- Artifact presence comes from the listing; verdict and `## Failed Criteria` checks read the pulled artifact bodies.
- The two `04-review.md` recency rows compare `04-review.md`'s `updated_at` against `03-implementation.md`'s — `03-implementation.md` is re-upserted after every implement update and after review fixes, so it carries the "implementation diverged after review" signal. `04-review.md` newer → apply pending fixes; `03-implementation.md` newer → re-enter the review checkpoint.
- **Start fresh** — the user deletes `03-implementation.md` (and downstream) via the Delete artifact operation, a user-side action; build itself never deletes artifacts. Permanent: a deleted artifact body has no server-side history, so copy anything worth keeping before deleting.

## §11 Config presence in a worktree

[`worktree.md`](worktree.md) §2 step 6's no-source no-op ("no `config.yaml` anywhere and nothing to copy") never arises in this mode: a run reached that step *because* a `config.yaml` declared `mode: server-native`, so an unreachable marker is a hard stop. After the walk-up check, assert the resolved `config.yaml` declares both `mode: server-native` and `project:` (the detection contract in [`../../flow/references/storage.md`](../../flow/references/storage.md) §Mode detection). Without them, detection resolves to the default mode and the work stalls at bare-ID ticket resolution — a silent misdetection where the storage doctrine prescribes a loud failure. Assertion fails → stop with an error naming the fix: list `claudedocs/tickets/config.yaml` in `.worktreeinclude` so step 4 carries a marked copy.

## §12 Error handling

A storage operation that fails mid-loop stops the skill per [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md) §Loud failure, with a state report — which artifacts were pushed this run and which checkpoint's output was not, so the user knows exactly what the server holds before re-running. A CAS conflict at the verdict gate follows the same file's §CAS conflict doctrine (re-read, re-evaluate, proceed or stop — never widen `from[]`).
