# Epic Walk — Flow's Epic-Mode Execution (fs-native)

Canonical logic for flow's epic mode in fs-native storage mode. Read when flow's SETUP detects `kind: epic` on the resolved folder and the storage mode detected per [`storage.md`](storage.md) is fs-native — a single-ticket run, or a run in the other storage mode, never needs this file. Referenced by `flow` only.

Flow walks the epic's children in `blocked_by` topological order, invoking `/feature:flow <CHILD-ID>` recursively for each child. Per-child state transitions (and the Epic-completion predicate that moves the epic subtree to `done/` once the last declared child is materialized and terminal) fire from each child's build invocation per [`state-transitions-fs.md`](state-transitions-fs.md) Transition 2 — flow's epic walker doesn't perform any state transitions itself.

Every read below is a frontmatter read from the tree (the operations in [`storage-fs.md`](storage-fs.md)).

## 1. Load epic context

a. Read the epic's metadata from `<epic-folder>/prd.md` frontmatter (`id`, `children` list, `status`).

b. If `status: done` (epic already complete), print:
   ```
   Epic <EPIC-ID> already complete. Delete artifacts inside individual children or re-run a specific child via `/feature:flow <CHILD-ID>` to redo work.
   ```
   Exit cleanly.

c. If the `children` list is empty or absent, print "Epic `<EPIC-ID>` has no children — nothing to walk." Exit cleanly.

d. For each child in the roster, read its metadata: `id`, `title`, `status`, `blocked_by` (defaults to `[]`) — locate the child folder under `<epic-folder>/tasks/<CHILD-ID>/` and read its `01-spec.md` frontmatter.

   If a child folder is missing on disk for a `children` entry, warn the user and skip that child (continue with the others). The data is corrupted but the walk is still useful.

## 2. Topological sort

a. Build a directed graph from `blocked_by`: an edge points from each blocker TO its dependent. So blockers come BEFORE dependents in topological order.

b. Sort the children roster topologically. Ties (children with the same dependency depth) break by roster order — the order in `prd.md`'s `children` list (`discover` already chose a sensible order).

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

c. **Invoke `Skill flow <CHILD-ID>`** (recursive). The inner flow detects `kind: epic` is NOT set on the child, falls into single-ticket mode, and runs plan + build per the existing logic. Propagate `--pr`, `--no-commit`, `--no-ui-testing`, `--worktree`, `--plan-model`, and `--build-model` if the epic-level invocation had them (a `--pr` epic run opens one PR per child; `--plan-model`/`--build-model` spawn every child's stage subagents with the same override; `--no-commit` leaves every child's passing changes uncommitted; `--no-ui-testing` skips the browser checkpoint for every child; `--worktree` gives every child its own worktree, with build deciding per child whether one is eligible — a child whose `blocked_by` sibling finished without `--pr` has its code on a local branch that the base does not carry, so build degrades that child to an in-place build with a notice). `--hint` is not forwarded — a hint names one ticket's situation; drop it once, at the walk's start, with the notice `--hint ignored in epic mode`.

d. **Re-read the child's `01-spec.md` frontmatter** after the recursive flow returns. Build's verdict gate (inside the child's flow run) already applied the state transition per `state-transitions-fs.md` (folder move + `status`). The new status determines the walker's next move:

   - `done` or `partial-completion` → child completed cleanly (build verdict `pass` — with or without a commit, per the gate's commit-mode dispatch — or verdict `partial`/`stuck` + user choice `accept-as-partial`). Continue walker silently.
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

a. The Epic-completion predicate inside the **last child's** build verdict gate (Transition 2's epic variant in [`state-transitions-fs.md`](state-transitions-fs.md)) already finalized the epic — moved the subtree from `in-progress/<EPIC>/` to `done/<EPIC>/` and updated `prd.md`'s `status` — in epic-mode the walker runs every declared child, so by the final child the predicate's roster check is satisfied. Flow does NOT repeat this — it has already happened.

b. Print:
   ```
   ## Epic <EPIC-ID> — done (<M>/<M> children complete)

   All artifacts: claudedocs/tickets/done/<EPIC-ID>/
   ```

c. Exit cleanly.

## Error handling (epic-mode specific)

- **Recursive flow crashes on a child**: surface to the user, list which child failed, ask whether to continue with remaining children or abort the walk.
- **Topological sort detects a cycle**: abort with the cycle listed; user must fix the `blocked_by` chain manually.
- **Epic spec (`prd.md`) malformed or missing**: defer to [`ticket-resolution-fs.md`](ticket-resolution-fs.md)'s error handling.
- **Child folder missing for a `children` entry**: warn, skip that child, continue with the others.
