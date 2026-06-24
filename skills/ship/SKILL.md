---
name: ship
description: "User-initiated (never auto-invoked) autonomous loop that builds, independently reviews, and merges a ticket or a dependency chain. For each ticket it spawns an implementer subagent running /feature:flow --pr, spawns an independent reviewer subagent (given only the spec + PR diff, never the implementer's rationale), validates the findings, fixes the real ones, and squash-merges. For a chain or epic it merges each per-ticket PR into an integration branch and opens — but never merges — a final integration→main PR for human review; a solo ticket goes straight to main. Invoke explicitly with /feature:ship; not a plan-only or build-only run."
disable-model-invocation: true
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - TodoWrite
  - Task
argument-hint: "[ticket-id ...] [--chain epic-id] [--base branch]"
---

# Ship — autonomous build → independent review → merge loop

`ship` is the autonomy layer **on top of** `/feature:flow`. Flow builds one ticket and (with `--pr`) opens a PR. `ship` wraps that in four things flow does not do:

1. **An independent, bias-isolated reviewer** — a separate subagent that reviews the PR against the spec + diff *only*, never the implementer's own narrative of why the code is correct, and posts findings to GitHub.
2. **Self-validation + self-merge** — the implementer fetches the posted review, judges each finding against reality (reviewers can be wrong), fixes the real ones, and squash-merges. **No per-ticket human gate** (the epic-level gate is the integration→main PR, item 4).
3. **A sequential loop over a dependency chain** — after each merge the orchestrator pulls the base branch (so the next ticket plans against merged code) and advances. Load-bearing for `blocked_by` chains: ticket N+1 must see ticket N merged before it plans.
4. **An epic-level human gate (integration branch)** — for a chain/epic, per-ticket PRs merge into an `integration/<epic-id>` branch (cut from `main`), not `main` directly; at the end `ship` opens — but never merges — a single integration→main PR for you to review. A solo ticket (or `--base main`) skips the integration branch and lands straight on `main`.

> **Autonomy with a final gate.** `ship` runs each ticket end to end without a per-ticket human gate — it decides and merges on its own, stopping only on a *genuine* blocker (see Guardrails). For a chain/epic the human gate is at the **end**: per-ticket PRs land on an integration branch and `ship` opens (never merges) the integration→main PR for you. If you want to gate every ticket instead, use `/feature:flow --pr` directly and merge by hand. This skill is **user-initiated only** (`disable-model-invocation: true`) — Claude will not auto-run it; invoke `/feature:ship` deliberately.

## Topology

The orchestrator (this skill, in the main conversation) drives the **outer loop**: it resolves the chain, spawns subagents, and independently verifies each merge. It never edits ticket code itself.

**Environment requirement (applies to all of `ship`).** The orchestrator delegates building to an **implementer subagent**, and that implementer runs `feature:flow → build`, which itself spawns build's four reviewer subagents from within. So `ship` needs a harness where a **subagent can spawn subagents** and you can observe async agents — it was developed and proven in such a harness. In a vanilla single-level-subagent setup (a subagent has no `Task`), you can't delegate build to a subagent: run `/feature:flow <id> --pr` yourself in the main conversation and merge by hand instead of using `ship`.

Given that requirement, `ship`'s own independent-reviewer hop has two arrangements.

**Flat (recommended).** The orchestrator spawns each role directly — implementer, then the independent reviewer as its sibling, then an implementer to address + merge. One fewer level of nesting, and the orchestrator can observe and recover each hop. Per ticket, in `blocked_by` order:

```
orchestrator (main)
  ├─ chain/epic: create integration/<epic-id> off main (base for every per-ticket PR)
  └─ per ticket, in blocked_by order:
       1. implementer subagent → Skill feature:flow <id> --pr --no-ui-testing   (plan → build → open PR, base = the integration branch; only build's UI-test checkpoint is skipped — lint/typecheck + unit tests still run and gate)
       2. reviewer subagent     → spec + diff only → posts PR review
       3. implementer subagent → read posted review → validate → fix → push → gh pr merge --squash (into the base)
  ├─ orchestrator: git pull <base> → verify (typecheck + tests green, PR merged) → next ticket
  └─ after all tickets: open integration→main PR (do NOT merge — human gate)
```

**Nested.** The Step 1 implementer also spawns the independent reviewer itself (`Task → reviewer`) and merges in one continuous brief — one fewer orchestrator round-trip, at the cost of a deeper tree and a stall risk in flow's parallel-review phase (see Fragility & recovery). This is the shape `ship` was first developed in.

Roles stay separated in both shapes: the implementer owns build + fix + merge authority; the reviewer is independent and adversarial. The orchestrator **independently verifies every merge** — do not trust the implementer's self-report; pull the base branch and run the checks yourself.

## Arguments

```
/feature:ship $ARGUMENTS
```

- `$1 …` = one or more ticket IDs to ship, in the order given (e.g. `PB-14 PB-15`).
- `--chain <epic-id>` = resolve the chain automatically: walk the epic's children in `blocked_by` topological order, skipping any already `done`, and ship the rest.
- `--base <branch>` = the base every per-ticket PR targets.
  - **Default for a chain/epic:** an auto-created `integration/<epic-id>` branch cut from `main`. Per-ticket PRs merge there, and the loop ends by opening (not merging) an integration→main PR.
  - **Default for a solo ticket:** `main` (no integration branch — there's nothing to integrate).
  - **`--base main`** on a chain: send every per-ticket PR straight to `main` and self-merge each — no integration branch, no final gate.
  - **`--base <other>`**: target an existing branch.

### Examples
```
/feature:ship PB-13                       # solo → straight to main, self-merge
/feature:ship PB-14 PB-15                 # chain → integration/PB-14, then an integration→main PR to review
/feature:ship --chain PB-11               # whole epic in dependency order → integration/PB-11, then one PR to main
/feature:ship --chain PB-11 --base main   # epic, but self-merge each ticket straight to main (no gate)
```

### Flags ship does not take
- **`--pr` is implicit.** `ship` always builds with `flow --pr` — autonomy needs a PR to review and merge — so you never pass it.
- **`--no-ui-testing` is implicit.** `ship` runs fully autonomously, with no human present to grant browser-MCP permission or drive a UI test, so it always builds with `flow … --no-ui-testing` — the browser/`ui-tester` checkpoint is skipped while lint + typecheck still run and still gate each build's verdict. Browser-level acceptance-criteria verification is deferred to the human at the integration→main PR (chain/epic); a solo `--base main` ticket merges without it, so its UI is verified post-merge. You never pass it.
- **`--ignore-blockers` is not exposed.** `ship` orders chains so dependencies merge first and validates `blocked_by` in SETUP rather than bypassing it. To ship a genuinely-blocked ticket, run `/feature:flow <id> --pr --ignore-blockers` by hand.

## Procedure

### SETUP
1. Resolve the ticket list (explicit IDs, or chain order from the epic's `blocked_by` graph). **For `--chain`, ship only *materialized* children** — glob `<epic-folder>/tasks/*/01-spec.md` and ship the IDs that resolve to a real spec, in `blocked_by` order. Skip any declared-but-unwritten child (a just-in-time epic declares its full `children:` roster upfront but authors child specs later, as the pipeline reaches each phase) and list the skipped IDs in the run report — do not attempt to flow a child whose `01-spec.md` does not yet exist. Confirm each shipped ticket's `blocked_by` deps are already `done`/merged; if not and you're shipping the chain, order them so deps merge first.
2. Pre-flight: `git checkout main && git pull --ff-only`, confirm a clean tree and `gh auth status` is logged in. Read the repo's CLAUDE.md and `claudedocs/tickets/_lessons.md` so the per-ticket brief carries the project's load-bearing constraints and carry-forward lessons.
3. **Resolve the base branch.** A **solo ticket** → base is `main` (unless `--base` overrides). A **chain/epic** (more than one ticket, or `--chain`) → unless `--base` is given, create an integration branch off `main` and use it as the base for every per-ticket PR. Name it `integration/<epic-id>` (or `integration/<first-ticket-id>` for an ad-hoc multi-ticket list). Create it once and push it: `git checkout main && git pull --ff-only && git checkout -b integration/<epic-id> && git push -u origin integration/<epic-id>`. If it already exists (resume), reuse it. With `--base main` on a chain, skip the integration branch and self-merge each ticket to `main`.
4. TodoWrite one item per ticket.

### PER TICKET (loop)
Each ticket runs three roles — **implementer → independent reviewer → implementer (address + merge)**. In the **flat (recommended)** arrangement the orchestrator spawns each as its own `Task` (implementer for Step 1, reviewer for Step 2, implementer for Step 3); in the **nested** arrangement one implementer subagent runs Steps 1–3 and spawns the reviewer itself at Step 2. Either way, spawn full-tool subagents (implementer subagent_type e.g. `claude`; reviewer `general-purpose`) with **self-contained briefs** — subagents do **not** share your context. Every brief must carry:

- **Role + full autonomy** (no per-ticket human gate; decide and record reasoning).
- **Repo path + ticket identity**, including whether it's an epic child and its spec path (`claudedocs/tickets/<state>/<EPIC>/tasks/<ID>/01-spec.md`).
- **Base branch** = `<BASE_BRANCH>` (the integration branch for a chain, else `main`). Cut the feature branch from `<BASE_BRANCH>`, and target the PR at it.
- **Project conventions that override harness defaults** — for feature-pipeline repos: commit subject `<ID>: <imperative>`, **no `Co-Authored-By` trailer**, one concern per commit; plus any boundary rules from CLAUDE.md (e.g. this app's server/client `node:*` boundary).
- **Step 1 — Build:** invoke `Skill feature:flow` with args `<ID> --pr --no-ui-testing`. Ensure the PR's base is `<BASE_BRANCH>` — if `flow --pr` opened it against `main`, retarget with `gh pr edit <n> --base <BASE_BRANCH>`. Then independently run `npm run typecheck` and the spec's verification tests; fix anything red.
- **Step 2 — Independent review:** spawn ONE reviewer subagent (`general-purpose`) using the reviewer prompt below, with the real PR number — the orchestrator spawns it in flat mode, the implementer spawns it in nested mode. The reviewer gets the spec path + PR diff + neutral instructions only — **never** the implementer's justifications.
- **Step 3 — Address + merge:** read the actually-posted review (`gh pr view <n> --comments`), validate each finding (ACCEPT real / DISMISS wrong, one-line reason each), fix accepted ones per conventions, push, re-run typecheck + tests (must be green), `gh pr merge <n> --squash --delete-branch` (merges into `<BASE_BRANCH>`). The squash-merge lands **code only** — the ticket folder stays in `review/` (status `in-review`); finalizing it to `done/` is `sync`'s job (see Ticket-state finalization under END OF RUN).
- **Step 4 — Report** the structured sections: ticket, branch, base, pr, built, checks, review_findings, addressed, merge SHA, **ui_verification** (state plainly that browser ACs were **not** verified in-loop — `--no-ui-testing` is always on — and that real-browser verification is deferred to the human at the integration→main PR, or post-merge for a solo `--base main` ticket), blockers, and **finalization** (ticket left in `review/` — run `/feature:sync` to promote to `done/`).
- **Guardrails:** spawn exactly one reviewer per ticket; never weaken/skip tests to go green; on a genuine blocker (merge protection, irreconcilable finding, unfixable test) STOP and report it instead of forcing/faking.

For a **UI ticket**, browser verification is **not** run during the loop — the build's `ui-tester` checkpoint is skipped by `--no-ui-testing`, so the implementer relies on lint, typecheck, and unit/SSR checks. Real-browser verification of the acceptance criteria falls to the human at the integration→main PR (or post-merge for a solo `--base main` ticket). The independent reviewer still reasons about user-visible behavior from the diff.

### AFTER EACH IMPLEMENTER RETURNS (orchestrator verifies)
`git checkout <base> && git pull --ff-only` (the base branch — the integration branch for a chain, else `main`), then **independently**: confirm the merge commit is on the base, `gh pr view <n>` shows `MERGED`, no stray open PR remains, `npm run typecheck` is clean, and the test suite is green. Only then mark the todo done and advance. If verification fails, treat it as a blocker — do not start the next ticket on a broken base.

### END OF RUN (chain/epic with an integration branch)
After every ticket has merged into the integration branch and verified green:
1. Confirm the integration branch is green as a whole: `git checkout integration/<epic-id> && git pull --ff-only`, then `npm run typecheck`, the test suite, and `npm run build`.
2. Open — but do **NOT** merge — a single integration→main PR: `gh pr create --base main --head integration/<epic-id> --title "<EPIC-ID>: <epic title>" --body "<summary: the N tickets shipped, each per-ticket PR #, and the per-ticket review outcomes>"`. This is the human gate. Report the PR URL and **stop** — never merge integration→main yourself.

For a solo ticket or `--base main`, there is no integration branch and no final PR — the per-ticket merge already landed on `main`.

### Ticket-state finalization (all paths)
A squash-merge lands **code, not ticket state**: every ticket `flow --pr` built is sitting in `review/` with `status: in-review` (Transition 5), and `ship` does **not** perform the `review/ → done/` move (Transition 6) — `sync` owns that single transition, so `ship` does not reimplement it. Close the loop by running **`/feature:sync`**, which scans `in-review` tickets, detects each merged PR, moves the ticket to `done/`, and fires the Epic-completion predicate for epic children. For the integration-branch path, run `sync` *after* the integration→main PR merges (the children only reach `main` then). Surface "merged tickets remain in `review/` — run `/feature:sync` to finalize" as the final line of the run report so the next step is explicit.

### REVIEWER PROMPT TEMPLATE (bias isolation is the crux)
```
You are an independent, skeptical code reviewer. Review GitHub PR #<N> in <REPO_PATH>.
Assume nothing is correct until you verify it against the spec and the actual code.

Get the change: `gh pr diff <N>`, `gh pr view <N> --json title,body,headRefName,baseRefName,files`,
and read the surrounding source/tests as needed.

GROUND TRUTH is the ticket spec at <SPEC_PATH> — read it and judge the diff against it.
Also read any carry-forward checklist in claudedocs/tickets/_lessons.md.

Review in priority order: (1) correctness vs each acceptance criterion; (2) bugs / edge cases /
concurrency / the carry-forward checklist; (3) project boundary or architecture violations;
(4) convention violations (commit subject, no Co-Authored-By, file placement);
(5) test-coverage gaps vs the spec's Verification; (6) security & performance.
For UI tickets, verify the user-visible behavior, not just the code.

Be specific. Per finding: severity (blocking|major|minor|nit), file:line, what's wrong, why.
If nothing is blocking, say so explicitly.

POST the review to GitHub: `gh pr review <N> --comment --body "<structured findings>"` (if GitHub blocks self-review because the PR author == your `gh` identity, fall back to `gh pr comment <N> --body "<structured findings>"`),
then return the same findings as your final message.
```

## Fragility & recovery (observed in an async-agent harness)

- **A spawned implementer can stall mid-build and not auto-resume.** `feature:build`'s internal **parallel** review phase makes the implementer spawn async children (the four reviewers), yield, and park. In this harness a parked subagent is NOT woken when its children finish (the *orchestrator* gets the "came to rest" notification), and there may be no `SendMessage` to wake it. Single-child spawning (one reviewer) resumes fine; the multi-child parallel phase is the risk.
- **Recovery protocol** when an implementer notifies "came to rest" with a non-final report: do NOT trust it's done. Inspect on-disk state yourself (`git status`, `git log` on the feature branch, which `NN-*.md` artifacts exist, `gh pr list`, leftover dev servers via `lsof`). Kill orphan dev servers. Then re-spawn a FRESH implementer with the *exact* state (branch, last commit, artifacts present, any identified-but-unapplied fix) and instruct it to finish **without** re-entering `feature:build`'s parallel-review phase — apply remaining fixes, run lint + typecheck directly, create the PR, spawn the single independent reviewer, validate, merge. Stop the zombie task + its monitor (`TaskStop`) so it can't double-write the shared tree.
- **To reduce stall risk up front:** tell the implementer not to set up a self-`Monitor` to resume itself after spawning subagents; keep subagent waits inline; and expect build's parallel review phase to be the fragile part.
- **GitHub self-review is blocked** when the PR author and the reviewer's `gh` identity are the same user — the reviewer must fall back from `gh pr review` to `gh pr comment` (handled in the template above). A single-identity setup means findings are *comments*, not a formal approve/request-changes review.
- **Posting under the user's identity gets a security-heuristic flag.** It's expected here (the user authorized the reviewer-posts-to-GitHub hop), but the orchestrator should still glance at what was published (`gh api repos/{o}/{r}/issues/<N>/comments`) to confirm it's appropriate review content before relying on the merge.

## When NOT to run
- You want to review/approve **every ticket** before it merges → use `/feature:flow --pr` per ticket and merge manually (ship only gates at the integration→main step).
- A single stage only → `/feature:plan` or `/feature:build`.
- Reconciling already-open PRs with merged state → `/feature:sync`.

## Notes / provenance
First proven on pipeline-board PB-13 (epic child of PB-11): the loop built the dry-run server functions, the independent reviewer surfaced 2 nits (0 blocking), the implementer accepted 1 (added boundary tests) and dismissed 1 with reason, and squash-merged as a clean PR with green checks on main. The independent reviewer is the load-bearing addition over plain flow — on PB-12 it was an independent review agent, not the implementer's own internal review, that caught a real concurrency bug.

The **integration-branch gate** and **`--base` handling** are designed but **not yet exercised end-to-end** — PB-13/14/15 predate them and went straight to `main`. Treat the first chain run with an integration branch as the shakedown, and verify the per-ticket PR retargeting (`gh pr edit --base`) behaves as expected against your `flow --pr` version.
