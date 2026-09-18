# Close Stage — server-native Storage Mechanics

Canonical logic for the close stage's storage-touching steps in server-native storage mode. Read when the storage mode detected at the close stage's start per [`../../flow/references/storage.md`](../../flow/references/storage.md) is server-native — an fs-native run never needs this file. Referenced by `close-stage`, and by [`pr-creation.md`](../../build/references/pr-creation.md) for PR linkage and the merge predicate's PR lookup. Ship's same-mode storage file points at §8 for the UI evidence home. Operations named below are defined in [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md); sections are numbered so the skill body cites `§N`.

## §1 Inputs and working copy

Pull `01-spec.md`, `02-plan.md`, `03-implementation.md`, and whichever of `04-review.md`/`05-tests.md`/`06-summary.md` exist (per the List artifacts operation) into a session-scratchpad directory — an ephemeral location outside the repository; nothing is ever materialized under `claudedocs/tickets/`, which is not a ticket store in this mode. `<ticket-folder>` denotes this working-copy directory: every `<ticket-folder>/0N-*.md` read/write site in the skill operates on the copies, with writes pushed per §3. The `ui-tester` spawn prompt references scratchpad paths or inlines resolved text; the tester never touches the ticket store. The post-gate finalizer is the one carve-out: it writes the ticket store directly, and the close stage inlines the absolute scratchpad paths into its prompt so the child pulls nothing of its own. The copies are disposable: every run re-pulls from the server; a scratchpad tree left by a prior run is never trusted or reused.

## §2 Ticket metadata

Read ticket metadata reads the ticket row: bind `status`, `kind`, `epic`, `parent` and `pr_url`. For an epic child, the epic's declared `children:` roster — carried into the finalizer prompt — is read from the epic's row.

## §3 Artifact writes

Every artifact write named in the skill is upserted to the server via the Write artifact operation the moment the producing step completes — `05-tests.md` and `06-summary.md` each with the `verdict` rule in §4. Update the scratchpad copy and push in the same step; a crash then loses at most the in-flight step's output, and a re-run resumes from exactly what the server holds. `05-tests.md` is upserted as soon as the `ui-tester` returns, before any fix, and again after each fix iteration. The `## Post-test` append goes to the scratchpad copy of `03-implementation.md` by the mechanism in [`../../build/references/implementation-handoff.md`](../../build/references/implementation-handoff.md) §5; its upsert (no `verdict`) completes before the `06-summary.md` upsert, never in parallel with it, so the rows' `updated_at` ordering matches the write order.

## §4 Artifact verdicts

The Write artifact operation accepts `verdict` ∈ `pass | fail | partial`. Per write site:

- **`05-tests.md`, ui-tester output** — `pass` when every acceptance criterion passed; `partial` when a `## Failed Criteria` section is present.
- **`05-tests.md`, skip artifact** — skip labels are outside the enum: write **without** `verdict`; the skip variant stays in the body, as the skill's test checkpoint (step c) inlines it.
- **`06-summary.md`** — `pass` → `pass`, `partial` → `partial`; `stuck` is outside the enum — omit `verdict` and keep the token in the body.

## §5 Lessons

The cross-ticket lessons log is the lesson tools, per [`../../flow/references/lessons-log-server.md`](../../flow/references/lessons-log-server.md).

## §6 PR linkage

Performed by the finalizer, which receives the ticket handle and every scratchpad path below as resolved values in its spawn prompt.

- **Ticket id and title for the PR** — there is no `01-spec.md` file to `sed`; the ticket's `id` and `title` are row fields (Read ticket metadata). The injection discipline of [`pr-creation.md`](../../build/references/pr-creation.md) §4 is preserved by changing the source, not the mechanism: write each value to a session-scratchpad file with the Write tool, then load it with the same command substitution (`TICKET_ID=$(cat "<scratchpad id file>")`, likewise the title) — never paste row text into a `"…"` literal. The `--body-file` path is the session working copy of `06-summary.md` (pulled per §1, pushed per §3).
- **Recording the opened PR** — re-upsert `06-summary.md` with the URL + branch appended (its body is otherwise left as the close stage authored it), and additionally record the URL on the ticket row via Update ticket fields (`pipeline_update_ticket` `pr_url`) — the non-status field write named in [`../../flow/references/state-transitions-server.md`](../../flow/references/state-transitions-server.md) Transition 5.

## §7 Resumption keying

The router's signals map onto the ticket row plus `pipeline_list_artifacts` (artifact rows carrying `created_at`/`updated_at`), read after Entry's metadata binding and working-copy pull:

- **Merge check** — keys on row status `in-review`; the row status is the only state signal in this mode. For the merge predicate, the row's `pr_url` (when set) identifies the PR directly (`gh pr view <url>` accepts a URL) and takes precedence over branch recovery; otherwise the pushed branch is recovered from the `06-summary.md` artifact body or the current checkout. For an epic child flipped `in-review` in place this keying deliberately diverges from the location-keyed reading of the other mode — the divergence note in [`../../flow/references/keying-server.md`](../../flow/references/keying-server.md) §1 applies here identically.
- **Already closed** — keyed on `06-summary.md` being present in the listing with verdict `partial` or `stuck` (its row `verdict`, or the body's first line when the field is unset), the row status being neither `in-progress` nor `in-review`, and its `updated_at` not being earlier than that of any of `02-plan.md`, `03-implementation.md`, `04-review.md` and `05-tests.md`. An aborted ticket (`backlog`), an accepted partial, and a `continue-with-hint` whose implement round has not started all match here. A tail interrupted between `accept-as-partial`'s two operations — `partial-completion` set, terminal status not yet landed — also matches; the finalizer's `transition` error already reported what remains.
- **Incomplete tail** — the finalizer never ran, or returned an error — keyed on `06-summary.md` being present in the listing while the row status is still `in-progress`, and its `updated_at` is not earlier than that of any of `02-plan.md`, `03-implementation.md`, `04-review.md` and `05-tests.md`. `partial-completion` is not a tail signal: implement's Transition 1 resets a hint round to `in-progress` before any code. A summary older than any of those four belongs to an earlier close run that a later plan, implement or review pass has since superseded, so a fresh close owns the ticket. The gate's decisions are conversational state and are deliberately not persisted, so nothing else about the tail is recoverable from the store.
- **Test ownership** — `05-tests.md` with an `updated_at` later than `04-review.md`'s is this stage's own output, and its `## Failed Criteria` section routes to the fix loop. The router never compares `03-implementation.md` with `05-tests.md`: the stage's own `## Post-test` append makes `03-implementation.md` the newer row.
- **Review currency** — Entry's readiness compares the `updated_at` of the `04-review.md` and `03-implementation.md` artifact rows, and reads the current pass's `## Post-test` heading from the pulled handoff body.
- Artifact presence comes from the listing; the verdict and `## Failed Criteria` checks read the pulled artifact bodies.
- **Start fresh** — the user deletes `05-tests.md` and `06-summary.md` via the Delete artifact operation, a user-side action; the close stage itself never deletes artifacts. Permanent: a deleted artifact body has no server-side history, so copy anything worth keeping before deleting.

## §8 UI evidence home

Every `ui-tester` capture — the close stage's test checkpoint and ship's end-of-run pass alike — is written to one declared directory, named per [`ui-checks.md`](../../build/references/ui-checks.md) §3:

- **Ticket pass**: `claudedocs/ui-evidence/<id>/` under the main checkout's root, as an absolute path — inside the workspace root, where the Playwright MCP is allowed to write. With a worktree bound it still resolves in the main checkout, never inside `<wt-path>`.
- **A pass covering an epic**: `claudedocs/ui-evidence/<epic-id>/`.

The spawn prompt carries the resolved absolute path, never a link to this section. Fixed filenames overwrite a prior run's captures.

**Gitignore expectation — stated once, here.** Screenshots are binary run evidence, not an artifact row: they are never pushed to the server and never enter a commit — [`commit.md`](../../build/references/commit.md) §1 excludes `claudedocs/` from the finalizer's commits.

## §9 Error handling

A storage operation that fails stops the stage per [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md) §Loud failure: return `error` with `failed-step: storage` and a state report — which artifacts were pushed this run and which were not — so the caller knows exactly what the server holds before re-running. A CAS conflict at the verdict gate follows the same file's §CAS conflict doctrine (re-read, re-evaluate, proceed or stop — never widen `from[]`).
