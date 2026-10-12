# Ticket Resolution — server-native

Canonical logic for resolving a ticket argument to a **ticket row**, ensuring the spec is in place, locating the shared exploration, and validating that the ticket is actually pipelineable — in server-native storage mode. Read when the storage mode detected per [`storage.md`](storage.md) is server-native — an fs-native run never needs this file. Referenced by `flow`, `plan`, `build`, `review-stage`, and `close-stage`.

The handle is a ticket row, and each step below uses the corresponding operation in [`storage-server.md`](storage-server.md).

`discover` does **not** use this reference — it handles the intake/creation variant inline.

---

## Layout context

A solo ticket is a row. An epic is a row with `kind: epic` whose children are rows carrying `parent_id`. Every stage artifact — `01-spec.md` (the spec: this IS the ticket's body), `exploration.md` (discover output, optional), `02-plan.md`, `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md`, and `prd.md` for an epic — is an artifact row keyed by name on its ticket. Artifact bodies are frontmatter-free; every structured field (`id`, `status`, `kind`, `parent_id`, `blocked_by`, `title`, `priority`, `complexity`, `tags`, `pr_url`) lives on the row.

An epic's `exploration.md` lives once, on the epic row, shared across all its children. Per-child progress is each child row's `status`.

The variable `<ticket-folder>` used throughout stage skills denotes the ticket's **handle** — its ID — not a path. The variable `<epic-folder>` (used only when the ticket is a child) denotes the parent epic's handle, resolved from the child row's `parent_id`. A stage that would read or write `<ticket-folder>/<artifact>` uses the Read/Write artifact operations in [`storage-server.md`](storage-server.md) against that handle instead.

---

## Step 1 — Resolve the ticket argument

This step is the **Resolve ticket** operation in [`storage-server.md`](storage-server.md).

Treat the argument as a ticket ID — for a path-shaped argument, the ID is the last directory segment, after dropping any trailing `01-spec.md`/`prd.md` filename — and call `pipeline_get_ticket`. Found → the row is the handle; `<ticket-id>` = the row's `id`. Not found → ask the user for the correct ID — do not guess.

The resolved handle becomes `<ticket-folder>` for downstream stages.

## Step 2 — Ensure the spec exists

Read the spec body via the Read artifact operation: `01-spec.md` for a solo/child ticket, `prd.md` for an epic (the row's `kind` says which — see Step 4). Artifact bodies are frontmatter-free; every structured field comes from the row (Read ticket metadata in [`storage-server.md`](storage-server.md)). A row whose spec artifact is missing is corrupted state — ask the user before proceeding. Other stage artifacts relevant to the current stage — `02-plan.md`, `03-implementation.md`, etc., and `exploration.md` if the stage uses it (see Step 5) — are read the same way, by name.

## Step 3 — Determine project root

Needed for codebase operations during the stage.

1. Determine the project: the workspace containing `claudedocs/tickets/config.yaml` (the mode marker) is the project. Its `project:` value is the server scope — the UUID every `pipeline_*` call takes as `project_id` — and plays no part in locating a directory.
2. Locate the project directory:
   - If the current working directory matches the project, use it
   - Otherwise check common paths — ask the user if ambiguous
3. If the project root can't be determined, ask the user before proceeding.

A non-interactive consumer (`review-stage`) never asks: wherever this reference would ask the user — here or in Steps 1–2 — it returns an error instead.

## Step 4 — Validate kind (per-consumer behavior)

Check the row's `kind` field (Read ticket metadata in [`storage-server.md`](storage-server.md)). Behavior depends on the consumer:

- **`plan`, `build`, `review-stage` and `close-stage`** — refuse if `kind: epic`. Epics don't go through plan or build themselves; only their children are pipelineable. Abort with this message:
  ```
  <ID> is an epic (kind: epic), not a pipelineable ticket. Epics group siblings — they hold the PRD, the shared exploration, and the decomposition table, but they don't go through plan/build themselves.

  Run the pipeline against one of its children instead:
  <list the child IDs from the derived roster per the List tickets / list children operation in storage-server.md>
  ```

- **`flow`** — branches to **epic-mode** when `kind: epic` is present. The epic walker iterates over the epic's children roster in `blocked_by` topological order and recursively invokes `Skill flow <CHILD-ID>` per child. See [`epic-walk-server.md`](epic-walk-server.md). Flow does NOT refuse on epics.

- If `kind` is absent or has any other value, the ticket is pipelineable for all consumers. Proceed normally.

This is the centralized epic-handling rule. Stage skills inherit the refusal behavior via this reference; flow's epic-mode branch point lives in its SKILL.md and the walker in [`epic-walk-server.md`](epic-walk-server.md).

## Step 5 — Locate exploration (when the stage needs it)

`plan`'s Phase 1 synthesis reads `exploration.md` as a seed: it tests the exploration's coverage and freshness and explores only what it leaves open. Other stages may also reference it. Where it lives depends on the ticket shape:

- **Solo ticket**: the ticket's own `exploration.md` artifact.
- **Child of an epic**: the **epic's** `exploration.md` artifact, shared across siblings — read from the parent epic's handle (resolved from the child row's `parent_id`).

If `exploration.md` is missing entirely (solo ticket created outside `discover`, or an epic that never ran exploration), proceed without a seed — `plan`'s Phase 1 falls back to a full ticket-scoped codebase exploration in that case.

## Step 6 — Validate blockers

Check the row's `blocked_by` field. If it's missing or empty, skip this step. Otherwise, for each blocker ID:

1. **Locate the blocker**: `pipeline_get_ticket` on the blocker ID.
2. **Determine completion**: a blocker is "done" if its row `status` is `done` or `cancelled`.

   **`in-review` is NOT done.** A blocker whose PR is open has `status: in-review` — the lookup in step 1 finds it, but the completion test above deliberately *excludes* it: an open, unmerged PR does not unblock dependents. Do not add `in-review` to the done clause — the found-but-not-done-equivalent asymmetry is intentional. The merged-sibling clause (item 3) is the one exception, and it tests the PR and the checkout, never the status.
3. **Merged-sibling clause (`build` only)**: an `in-review` blocker whose `parent_id` equals this ticket's `parent_id` is **merged-in** when its PR is merged and its merge commit is already in the checkout build starts from. This is how an epic chain advances under `ship`: each child's PR squash-merges into `integration/<epic-id>`, the child stays `in-review` until that branch reaches `<base>` ([`state-transitions-server.md`](state-transitions-server.md) Transition 6), and the next sibling builds on a checkout that already carries the merge.

   The PR URL is the blocker row's `pr_url`. It is never pasted into a command: write it with the Write tool to a temp file whose absolute path a prior Bash call printed, then load it as data and check it before use. Run from the build's working directory:

   ```bash
   PR_URL=$(head -1 "<pr_url temp file>")
   case "$PR_URL" in
     *[!A-Za-z0-9:/._-]*) PR_URL= ;;                    # not a plain URL → unmet
     https://github.com/*/*/pull/*[!0-9]*) PR_URL= ;;   # PR number not all digits → unmet
     https://github.com/*/*/pull/[0-9]*) ;;
     *) PR_URL= ;;
   esac
   read -r PR_STATE MERGE_SHA <<<"$([ -n "$PR_URL" ] && gh pr view "$PR_URL" --json state,mergeCommit --jq '.state + " " + (.mergeCommit.oid // "")')"
   case "$MERGE_SHA" in
     ''|*[!0-9a-f]*) false ;;   # no merge commit, or not a plain SHA → unmet
     *) [ "$PR_STATE" = MERGED ] && git merge-base --is-ancestor "$MERGE_SHA" HEAD ;;
   esac
   ```

   Exit 0 → merged-in; record `MERGE_SHA` per blocker, which build's worktree eligibility reads. Anything else fails closed and leaves the blocker unmet: the PR open or closed unmerged, `gh` missing or failing, no `pr_url`, or a merge commit `HEAD` does not contain (the PR merged into a branch this checkout has not pulled). The test reads `HEAD` rather than a named base because build takes no base argument, and the question is whether the tree it builds on holds the blocker's code — on ship's walk, the integration head pulled after the merge or a feature branch cut from it.

The stage's behavior depends on which stage is running:

- **`plan`** — does NOT refuse on unfinished blockers. Auto-loads each blocker's available artifacts (`01-spec.md`, `02-plan.md` — whichever exist per List artifacts on the blocker's handle) and uses them as **Blocker Context** during Phase 1 synthesis and plan design, so the plan reasons against the planned dependency rather than a blind codebase. Print a one-line note per blocker:
  ```
  Loaded blocker context from <blocker-id> (status: <status>, artifacts: <comma-separated list>).
  ```
  The Blocker Context section format passed to subagents during Phase 1 synthesis or read inline during plan design:
  ```
  ## Blocker Context
  This ticket is blocked by <blocker-id> (status: <status>).
  <blocker-id>'s spec: <full content of blocker's 01-spec.md>
  <blocker-id>'s plan: <full content of blocker's 02-plan.md, if present>

  Factor this into your <analysis|plan> — assume the blocker will deliver what its plan/spec describes; do NOT flag as gaps things the blocker is already designed to provide.
  ```

- **`build`** (and `flow`'s SETUP pre-check, which applies the same test) — REFUSE if any blocker is neither done (or cancelled) nor merged-in under the merged-sibling clause. Abort with this message:
  ```
  Cannot run build on <ticket-id>. Blockers not yet done:
  - <blocker-id> (status: <status>)
  - ...

  Either complete the blockers first, or edit this ticket's blocked_by field if the dependency is wrong.
  ```
  When a listed blocker is an `in-review` sibling, append one line: `An in-review sibling counts once its PR is merged and this checkout contains the merge commit — pull the branch it merged into and re-run.`

- **`review-stage`** — does NOT refuse on unfinished blockers. It locates each blocker to compose the reviewers' blocker context from the blocker's artifacts.

- **`close-stage`** — does NOT check blockers. Build refused on them before any code was written.

This rule is centralized here so stage skills inherit it via reference and don't duplicate the check.

---

## Error handling

- Ticket not found (no row) → ask the user
- Spec missing (the row's spec artifact absent) → corrupted state; ask the user
- Row fields missing or malformed → warn and ask
- Storage call fails or the pipeline MCP tools are unavailable → stop per [`storage-server.md`](storage-server.md) §Loud failure — never fall back to local reads or writes
- Project root can't be determined → ask the user
- Resolved item is an epic (`kind: epic`) → abort with the message in Step 4; do not silently fan out to children
- Blocker can't be located → warn and treat as not-done (worst-case assumption); the user can investigate or edit this ticket's `blocked_by` field
