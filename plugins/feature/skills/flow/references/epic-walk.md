# Epic Walk — Flow's Epic-Mode Execution

Canonical logic for flow's epic mode. Read when flow's SETUP detects `kind: epic` on the resolved folder — a single-ticket run never needs this file. Referenced by `flow` only.

Flow walks the epic's children in `blocked_by` topological order, invoking `/feature:flow <CHILD-ID>` recursively for each child. Per-child state transitions (and the Epic-completion predicate that moves the epic subtree to `done/` once the last declared child is materialized and terminal) fire from each child's build invocation per [`state-transitions.md`](state-transitions.md) Transition 2 — flow's epic walker doesn't perform any state transitions itself.

Every read below goes through the project's storage mode (detected once per run per [`storage.md`](storage.md)): fs-native reads frontmatter from the tree; server-native reads ticket rows via the pipeline MCP tools. Walk semantics — ordering, skips, stops, completion — are identical in both modes.

## 1. Load epic context

a. Read the epic's metadata — fs-native: `<epic-folder>/prd.md` frontmatter (`id`, `children` list, `status`); server-native: the epic row via `pipeline_get_ticket` (`id`, `status`), with the children roster **derived** — `pipeline_list_tickets` for the project, filtered client-side to rows whose `parent_id` is the epic's ID (the row carries no `children` field; there is no server-side filter).

b. If `status: done` (epic already complete), print:
   ```
   Epic <EPIC-ID> already complete. Delete artifacts inside individual children or re-run a specific child via `/feature:flow <CHILD-ID>` to redo work.
   ```
   Exit cleanly.

c. If the children roster is empty or missing (fs-native: empty/absent `children` list; server-native: no rows with the epic's `parent_id`), print "Epic `<EPIC-ID>` has no children — nothing to walk." Exit cleanly.

d. For each child in the roster, read its metadata: `id`, `title`, `status`, `blocked_by` (defaults to `[]`) — fs-native: locate the child folder under `<epic-folder>/tasks/<CHILD-ID>/` and read its `01-spec.md` frontmatter; server-native: the fields are already on the rows returned by the roster listing.

   fs-native only: if a child folder is missing on disk for a `children` entry, warn the user and skip that child (continue with the others). The data is corrupted but the walk is still useful. Server-native has no declared-but-missing case — the roster *is* the set of existing rows; a row whose `01-spec.md` artifact is missing surfaces as corrupted state inside that child's own stage run (ticket-resolution Step 2).

## 2. Topological sort

a. Build a directed graph from `blocked_by`: an edge points from each blocker TO its dependent. So blockers come BEFORE dependents in topological order.

b. Sort the children roster topologically. Ties (children with the same dependency depth) break by roster order — fs-native: the order in `prd.md`'s `children` list (`discover` already chose a sensible order); server-native: ascending ticket ID (the server allocates IDs sequentially at creation, so ID order preserves discover's creation order).

c. **Cycle detection**: if the graph has a cycle, abort with an error listing the cycle's children and instruct the user to fix `blocked_by` in the offending specs. Cycles shouldn't occur because `discover` validates first-child-has-no-blockers + DAG shape, but defensive.

## 3. Print initial aggregate progress

```
## Epic <EPIC-ID> — <epic-slug> (<N>/<M> children complete)

  ✓ <CHILD-1-ID>: <title> (done)
  ◐ <CHILD-2-ID>: <title> (partial-completion)
  ► <CHILD-3-ID>: <title> (next — backlog)
    <CHILD-4-ID>: <title> (backlog)
    <CHILD-5-ID>: <title> (backlog, blocked_by: <CHILD-3-ID>)

Starting walk through remaining children in dependency order.
```

**Status icon mapping**:
- `done` → ✓
- `partial-completion` → ◐
- `cancelled` → ⨯
- `in-review` → ◓ (PR open, awaiting merge — non-terminal)
- `in-progress` → ► (rare on entry; expected only mid-walk or after a crash)
- `backlog` → (space)

The "next" child gets a ► marker on the line that's about to start. `<M>` = total children; `<N>` = count of children with terminal status (`done`, `partial-completion`, or `cancelled`).

## 4. Walk children

For each child in topologically-sorted order:

a. **Skip if already terminal.** If the child's `status` is `done`, `partial-completion`, or `cancelled`, skip silently to the next child. (Auto-resumption of an in-flight epic relies on this — completed children are passed over.)

b. **Print the running message**:
   ```
   → Running <CHILD-ID>: <title>
   ```

c. **Invoke `Skill flow <CHILD-ID>`** (recursive). The inner flow detects `kind: epic` is NOT set on the child, falls into single-ticket mode, and runs plan + build per the existing logic. Propagate `--pr` and `--no-ui-testing` if the epic-level invocation had them (a `--pr` epic run opens one PR per child; `--no-ui-testing` skips the browser checkpoint for every child).

d. **Re-read the child's metadata** after the recursive flow returns — fs-native: its `01-spec.md` frontmatter; server-native: the row via `pipeline_get_ticket`. Build's verdict gate (inside the child's flow run) already applied the state transition per `state-transitions.md` (fs-native: folder move + `status`; server-native: the CAS status write). The new status determines the walker's next move:

   - `done` or `partial-completion` → child completed cleanly (build verdict `pass` + commit confirmed/declined, or verdict `partial`/`stuck` + user choice `accept-as-partial`). Continue walker silently.
   - `in-review` → child's PR was opened (build ran with `--pr`); the PR is open, awaiting merge. Non-terminal but an expected outcome — the child is "advanced enough." Continue the walker; the child finalizes to `done/` on a future walk once its PR merges (build's `review/` pass-through fires Transition 6).
   - `backlog` → user chose `abort` at the child's verdict gate. The child has been reverted. Stop the walker. Print:
     ```
     Child <CHILD-ID> aborted (reverted to backlog/). Stopping epic walk.
     Run /feature:flow <EPIC-ID> again to resume.
     ```
     Exit cleanly.
   - `in-progress` → shouldn't happen (build always finalizes). Treat as anomaly: warn the user, stop the walker. Print:
     ```
     Child <CHILD-ID> is unexpectedly still in-progress after flow returned. Stopping epic walk for safety. Inspect the child's artifacts and re-run when state is consistent.
     ```
     Exit cleanly.

e. **Print updated aggregate progress** (same format as Step 3, with the just-completed child now marked terminal).

## 5. Completion

After the loop exits successfully (all children walked, no aborts):

a. The Epic-completion predicate inside the **last child's** build verdict gate (Transition 2's epic variant in [`state-transitions.md`](state-transitions.md)) already finalized the epic — fs-native: moved the subtree from `in-progress/<EPIC>/` to `done/<EPIC>/` and updated `prd.md`'s `status`; server-native: the epic row's status flipped to `done` via CAS — in epic-mode the walker runs every declared child, so by the final child the predicate's roster check is satisfied. Flow does NOT repeat this — it has already happened.

b. Print (the artifacts line in fs-native mode; in server-native mode replace it with `All artifacts on the ticket rows — pipeline_list_artifacts per child.`):
   ```
   ## Epic <EPIC-ID> — done (<M>/<M> children complete)

   All artifacts: claudedocs/tickets/done/<EPIC-ID>/
   ```

c. Exit cleanly.

## Error handling (epic-mode specific)

- **Recursive flow crashes on a child**: surface to the user, list which child failed, ask whether to continue with remaining children or abort the walk.
- **Topological sort detects a cycle**: abort with the cycle listed; user must fix the `blocked_by` chain manually.
- **Epic spec malformed or missing** (fs-native: `prd.md`; server-native: the epic row's `prd.md` artifact): defer to [`ticket-resolution.md`](ticket-resolution.md)'s error handling.
- **Child folder missing for a `children` entry** (fs-native only): warn, skip that child, continue with the others.
- **Server-native storage call fails mid-walk**: stop per [`storage.md`](storage.md) §Loud failure and report which children completed (the aggregate-progress printout after each child is the record) — never continue the walk against a store that stopped answering.
