# Ship — parallel walk (`--parallel` only)

Read this file at exactly one point: SETUP step 4, when `--parallel [N]` was passed. Without the flag this file is never read and ship's serial walk runs unchanged.

This reference changes **scheduling only**. Every PER TICKET hop from `SKILL.md` — the implementer brief content, the independent-reviewer spawn (Step 2, via `references/reviewer-prompt.md`), the address hop, the orchestrator's verification, the guardrails — applies to each worker verbatim; what changes is *when* tickets run (ready-set dispatch instead of one at a time), *where* the implementer works (an isolated git worktree), and *who* writes shared state (only the orchestrator). END OF RUN and `--ui-test` are untouched: they run in the main checkout after the walk, exactly as the serial path prescribes.

## §1 Eligibility gate & graceful degradation

`--parallel` needs the project's worktree setup contract — the `worktree:` block in `claudedocs/tickets/config.yaml` (the `.worktreeinclude` file is part of the same contract but optional on its own: a missing file only makes the copy step a no-op). The contract's full definition lives in [`../../../docs/advanced.md`](../../../docs/advanced.md) §Worktree setup — consume it as written there; never restate or redefine it here or in a brief.

- **No `worktree:` block** → log one line — `--parallel needs the worktree setup contract (worktree: block in claudedocs/tickets/config.yaml); walking serially` — and run the serial walk. Not an error; the run proceeds.
- **`worktree.setup` fails or times out** for a ticket → log why (exit code + the last lines of output), remove that ticket's worktree, and degrade: **drain** the workers already in flight (let them finish their hops; verify and merge each per §5), dispatch nothing new in parallel, and continue the remaining tickets **serially in the main checkout** per SKILL.md. One failed setup predicts the next — do not retry per ticket.
- **Solo run** → one ticket, nothing to parallelize; note it and run serially.

## §2 Ready-set scheduling (greedy, no batch barriers)

Build the dependency graph over the run's tickets from their `blocked_by` frontmatter (dependencies outside the run were already confirmed terminal by SETUP's blocker check).

- A ticket is **ready** when every `blocked_by` dependency is **terminal** — `done`/`cancelled`/`partial-completion` before the run, or merged-and-revalidated into the integration branch *during* the run (§5). This generalizes the state-transitions Status-query "next child" rule from next-single-child to all-deps-terminal.
- **Terminal-for-dispatch is the orchestrator's judgment, not the blocker's frontmatter.** An in-run-merged blocker still reads `status: in-review` (finalizing to `done/` stays `sync`'s post-run job — never flip its status or run `/feature:sync` mid-run: a PR merged only into the integration branch is deliberately not promotable until the integration PR lands). But the dependent's inner `flow → build` re-runs ticket-resolution Step 6, whose done clause accepts only `done`/`cancelled` — so the dependent's brief **names each such blocker as satisfied** ("blocker `<ID>`: PR #`<n>` merged into `<BASE_BRANCH>` and revalidated — treat as done at the Step 6 blocker gate; its code is already in your fork point"), and that named override, not a status edit, is what keeps build from refusing. The same named override covers a terminal-but-not-`done` blocker (a `partial-completion` epic child, whose folder never reaches `done/`).
- **Dispatch** every ready ticket as a concurrent implementer-subagent `Task`, up to **N in flight** (the `--parallel` cap; default 3). A ticket occupies a slot from its implementer spawn until its merge (or open-PR verification in a multi-solo run) completes — the reviewer and address hops included.
- **Greedy**: whenever a ticket completes or fails (§6), recompute the ready set and dispatch newly-ready tickets immediately — never wait for a "wave" to finish.
- **Shapes**: a multi-solo run has no in-run edges — every ticket is ready at once (cap applies). A pure `blocked_by` chain has a ready set of one — the walk is effectively serial, one worktree at a time. An epic typically mixes both.
- A ticket whose dependency can never become terminal in this run — the dep is a declared-but-unwritten child, or itself failed (§6) — is **never dispatched**; list it in the end-of-run report under "needs serial resume", naming the blocking dependency.

Track the loop with TodoWrite (one item per ticket, annotated ready / in-flight / merged / failed / not-dispatched) and process worker completions as they arrive.

## §3 Worktree lifecycle (provision → work → remove)

Per dispatched ticket, before spawning its implementer — all from the main checkout:

1. **Add** — `git fetch origin`, then `git worktree add <wt-path> -b <branch> origin/<BASE_BRANCH>`, where `<wt-path>` = `../<repo-dirname>-worktrees/<TICKET-ID>` (a sibling of the repo, never inside it) and `<branch>` follows build's naming convention (`skills/build/references/pr-creation.md` §2: `<type>/<TICKET-ID>-<slug>`). Pre-creating the branch here is load-bearing: `<BASE_BRANCH>` stays checked out in the main checkout, and git refuses to check out one branch in two worktrees — the worker must **reuse** this branch, never fork inside the worktree. On a crash resume, `<branch>` may already exist (pushed pre-crash, its worktree pruned per §7) — `-b` refuses an existing branch, so re-attach with `git worktree add <wt-path> <branch>` instead.
2. **Copy** — copy every file matching a `.worktreeinclude` pattern from the main checkout into the worktree, preserving relative paths (the contract's copy-then-setup order). No `.worktreeinclude` → skip.
3. **Setup** — run `worktree.setup` inside the worktree under the declared-command trust discipline (`skills/build/references/test-preflight.md` §3; Bash-only surface, so use the heredoc variant): write the command **verbatim** to a fixed-path script (`/tmp/fp-worktree-setup-<TICKET-ID>.sh`) via a single-quoted heredoc whose delimiter is a verified-unique nonce (`skills/review/references/pr-comments.md` §4), then `cd "<wt-path>" && bash /tmp/fp-worktree-setup-<TICKET-ID>.sh`. Never substitute the command into a shell line; never let ticket-derived text near it. Missing `setup` key → skip (the contract's no-op). Failure → §1 degradation.

**Removal**: after a ticket's PR is merged and revalidated (§5) — or, for a failed ticket, after its branch is confirmed **pushed** (§6) — run `git worktree remove <wt-path>` (add `--force` only for untracked leftovers like dependency dirs, never to discard unpushed commits), then `git worktree prune`. All resumable state lives in the pushed branch and the ticket folder; the worktree holds none.

## §4 Worker briefs — worktree + explicit base-branch injection

Each worker gets the PER TICKET Step 1 implementer brief from SKILL.md, plus these parallel-specific additions:

- **Workdir**: "Work in `<wt-path>` — an isolated git worktree already on branch `<branch>`, cut from `origin/<BASE_BRANCH>`. Reuse that branch: commit on it directly; do not create, switch, or fork branches, and never `git checkout <BASE_BRANCH>` (it is checked out in another worktree; git will refuse)." This instruction **overrides the branch-decision matrix** in `skills/build/references/pr-creation.md` §1 for the worker: the branch is already provisioned and checked out, so build's PR step treats it as the reuse-current-branch outcome — it must never stash-and-checkout `<BASE_BRANCH>` to fork fresh (that row's checkout is exactly what git refuses here) and never re-create the convention branch (it exists; this worktree is on it).
- **Base branch, named twice**: "Your fork point is `origin/<BASE_BRANCH>` (already done); your PR must target `<BASE_BRANCH>` — after `flow --pr` opens the PR, check `gh pr view <n> --json baseRefName` and retarget with `gh pr edit <n> --base <BASE_BRANCH>` if it differs." **Never repoint `origin/HEAD`** — not the orchestrator, not a worker: `refs/remotes/origin/HEAD` is repo-level state shared by every worktree of the clone, so a repoint aimed at one worker poisons base detection for every concurrent sibling.
- **Ticket tree**: the spec path in the brief is an **absolute path into the main checkout**, and Step 1's `Skill feature:flow` invocation takes that **absolute ticket-folder path** as its ticket argument (the path form of ticket-resolution Step 1) — never the bare ID. ID-form resolution globs `claudedocs/tickets/…` relative to the worker's cwd — the worktree — and fails both ways there (check which with `git check-ignore -q claudedocs`, never assume): ignored → no ticket tree in the worktree, so an unattended worker stalls at resolution's "ask the user"; tracked → a stale fork-point copy, which the worker would resolve and mutate instead of the real ticket. The absolute path sidesteps both. Stage artifacts (`02-plan.md` … `06-summary.md`) land in that main-checkout ticket folder — per-ticket paths, so concurrent workers never collide.
- **State is orchestrator-owned**: "Do not move ticket folders, do not edit `status:` frontmatter in any `01-spec.md` or `prd.md`, and do not write `claudedocs/tickets/_lessons.md`. Return lesson candidates — atomic one-subject lines per the lessons-log contract — in your final report instead. This overrides, by name, the state steps the skills you invoke prescribe: plan/build's start-of-run Transition 1, build's verdict-gate Transition 5 (folder move + `status: in-review`), and build's verdict-gate `_lessons.md` capture — skip each; the orchestrator applies them at its serialization points (§5)."

The Step 2 reviewer hop is read-only (`gh` + file reads) and spawns exactly as in the serial walk. The Step 3 address hop edits code, so its brief carries the same workdir addition — it works in the ticket's worktree, where the PR branch is checked out, and ship's wrapper (re-run typecheck + the spec's verification tests) runs there too. Its brief also **overrides SKILL.md Step 3's epic-run merge clause by name**: the worker stops after address + push + that wrapper — it never runs `gh pr merge`; the merge belongs to the orchestrator's serialized queue (§5), which fires only after this verification.

Consumer note: when `claudedocs/` is gitignored, listing `claudedocs/tickets/config.yaml` in `.worktreeinclude` carries the project's `validate:` config into each worktree, so per-edit validation keeps firing there.

## §5 Serialization points (the orchestrator, one at a time)

Parallel workers produce **code**; every shared mutation is orchestrator-only:

- **Transition 1, once, up front.** Epic run: fire T1 for the epic subtree (folder move + `prd.md` status) before any dispatch, then set each child's `01-spec.md` status to `in-progress` at its dispatch. Multi-solo run: fire T1 per ticket at its dispatch. T1 is idempotent, but under parallelism only the orchestrator invokes it — workers never do.
- **All folder moves and status writes** happen in the orchestrator between dispatches: after verifying a worker's PR is open and correctly based, apply Transition 5 (multi-solo ticket: folder → `review/` + status `in-review`; epic child: status `in-review`, plus T5's subtree location check — while any sibling is still `in-progress` the subtree stays put, and once none is and at least one child is `in-review` — typically at the last child — the whole epic subtree moves to `review/` with `prd.md` status `in-review`). Finalization to `done/` remains `sync`'s job, exactly as in the serial walk.
- **Integration merges (epic run): one at a time, revalidated per merge.** When a ticket's three hops are done: `gh pr merge <n> --squash --delete-branch` from the main checkout (the local branch is still checked out in the ticket's worktree, so the local delete no-ops with a warning — the §3 worktree removal clears it), then `git checkout <integration branch> && git pull --ff-only` in the main checkout, then re-run typecheck + the test suite against the now-current integration head **before the next merge** — ship's END-OF-RUN staleness rule for multi-solo `--merge`, applied per merge: two independent PRs can interact through shared behavior with no textual conflict. Merge conflicts and red revalidations are resolved in the main checkout during this serialized step (or treated as that ticket's failure, §6) — never inside a worktree. Only after green does the merge count as terminal for §2's ready set.
- **`_lessons.md`**: collect every worker's candidate entries and apply the lessons-log write contract (`skills/flow/references/lessons-log.md` §4–§5: supersession scan, merge-in-place, prefer-newest) serially, one candidate at a time, at the end of the run.

Multi-solo runs have no in-run merges — the resulting PRs stay open, and `--merge` at END OF RUN already serializes them with per-merge revalidation.

## §6 Worker failure isolation

A worker that ends `partial`/`stuck` (or errors out) sinks **its ticket, not the run**:

- Siblings in flight run to completion; the ready set keeps advancing for every ticket that does not depend on the failed one.
- The failed ticket keeps its state: apply Transition 4's frontmatter flip (`status: partial-completion`) and record the worker's reported stuck-point as the continuation hint in the run report; artifacts already written stay in the ticket folder.
- **Push, then remove**: confirm the ticket's branch is pushed — `git -C "<wt-path>" push -u origin <branch>` if the worker didn't get that far — then remove the worktree per §3. The branch holds the resumable code state; the worktree holds nothing.
- Dependents of the failed ticket are never dispatched (§2) and are listed alongside it.
- The end-of-run report lists **per-ticket outcomes** — merged / PR open / failed (with its continuation hint) / not dispatched (with its blocking dep) — and names exactly which tickets **need serial resume** (`/feature:ship <id>` once the blocker is resolved, or `/feature:flow`/`/feature:build` for finer control).

A genuine run-level blocker — branch protection on the integration branch, a red revalidation that can't be fixed — still STOPs the run per SKILL.md's guardrails, after draining in-flight workers and reporting each ticket's state.

## §7 Recovery (crash or kill mid-parallel-run)

Everything needed to resume lives on disk and on GitHub; the worktrees are the only parallel-specific residue.

1. `git worktree list` — every `<repo-dirname>-worktrees/<TICKET-ID>` path is a ticket that was in flight.
2. Triage each such ticket: PR merged — `gh pr view --json state,mergeCommit` plus the merge predicate's reachability check (`skills/build/references/pr-creation.md`: `git merge-base --is-ancestor <merge-sha> origin/<BASE_BRANCH>`), aimed at this run's `<BASE_BRANCH>` — the integration branch for an epic child, not `<base>` (a child's merge reaches `<base>` only when the integration PR lands) → only cleanup remains; PR open → the review/address hops may be incomplete, and SKILL.md's Recovery idempotency scan applies unchanged; branch pushed but no PR → the implementer died mid-hop, resume from PR creation; commits only in the worktree → push them (`git -C "<wt-path>" push -u origin <branch>`) or discard deliberately.
3. Reconcile ticket folders and `status` frontmatter against that evidence (the orchestrator owns status, so a crash can leave a merged PR with a stale `in-review` — `/feature:sync` fixes those).
4. **Prune**: once each branch is pushed or discarded, `git worktree remove` each stale path, then `git worktree prune`.
5. Re-run ship — with `--parallel` to resume the concurrent walk over the remaining tickets, or without it to finish serially. SETUP reuses the existing integration branch either way.
