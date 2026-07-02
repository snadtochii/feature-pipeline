---
name: ship
description: "User-initiated (never auto-invoked) autonomous loop that builds, independently reviews, and addresses a ticket or a dependency chain, ending at an open pull request. For each ticket it spawns an implementer subagent that runs /feature:flow to build the ticket and open its PR (headless — browser/UI testing is skipped), spawns an independent reviewer subagent (given only the spec + PR diff, never the implementer's rationale), validates the findings, and fixes the real ones. A solo ticket ends at its own open single-ticket PR; a chain or epic squash-merges each per-ticket PR into an integration branch and ends at an open integration PR. The resulting PR is left open for human review by default — pass --merge to have ship land it on the base branch. Invoke explicitly with /feature:ship; not a plan-only or build-only run."
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - TodoWrite
  - Task
argument-hint: "[ticket-id ...] [--chain epic-id] [--base branch] [--merge]"
---

# Ship — autonomous build → independent review → resulting PR

`ship` is the autonomy layer **on top of** `/feature:flow`. Flow builds one ticket and (with `--pr`) opens a PR. `ship` wraps that in four things flow does not do:

1. **An independent, bias-isolated reviewer** — a separate subagent that reviews the PR against the spec + diff *only*, never the implementer's own narrative of why the code is correct, and posts findings to GitHub.
2. **Self-validation + address** — the implementer fetches the posted review, judges each finding against reality (reviewers can be wrong), and fixes the real ones. **No per-ticket human gate** — on a chain it then squash-merges the per-ticket PR into the integration branch; the human gate is the resulting PR (item 4).
3. **A sequential loop over a dependency chain** — after each per-ticket merge the orchestrator pulls the integration branch (so the next ticket plans against merged code) and advances. Load-bearing for `blocked_by` chains: ticket N+1 must see ticket N merged before it plans.
4. **A resulting PR as the human gate (open by default)** — every run ends at one open PR targeting the base branch (`--base`, default `main`): a solo ticket's own single-ticket PR, or — for a chain/epic — an integration→`<base>` PR collecting the per-ticket PRs that merged into `integration/<epic-id>` (cut from `<base>`). `ship` leaves that resulting PR open for you to review; pass `--merge` to have ship merge it (solo: squash; integration: merge commit, preserving the per-ticket squashed commits). If branch protection blocks a `--merge`, ship stops and reports.

> **Autonomy with a final gate.** `ship` runs each ticket end to end without a per-ticket human gate — it decides, fixes, and (on a chain) merges per-ticket PRs into the integration branch on its own, stopping only on a *genuine* blocker (see Guardrails). The human gate is the **resulting PR**: ship opens it and leaves it open unless you passed `--merge`. If you want to gate every ticket's merge into the integration branch instead, use `/feature:flow --pr` directly and merge by hand. This skill is **user-initiated only** (`disable-model-invocation: true`) — Claude will not auto-run it; invoke `/feature:ship` deliberately.

## Topology

The orchestrator (this skill, in the main conversation) drives the **outer loop**: it resolves the chain, spawns subagents, and independently verifies each hop. It never edits ticket code itself.

**Environment requirement (applies to all of `ship`).** The orchestrator delegates building to an **implementer subagent**, and that implementer runs `feature:flow → build`, which itself spawns build's four reviewer subagents from within. So `ship` needs a harness where a **subagent can spawn subagents** and you can observe async agents — it was developed and proven in such a harness. In a vanilla single-level-subagent setup (a subagent has no `Task`), you can't delegate build to a subagent: run `/feature:flow <id> --pr` yourself in the main conversation and merge by hand instead of using `ship`.

Given that requirement, the orchestrator spawns each role directly — implementer, then the independent reviewer as its sibling, then an implementer to address the review. The tree stays shallow and the orchestrator can observe and recover each hop. Per ticket, in `blocked_by` order:

```
orchestrator (main)
  ├─ chain/epic (--chain or 2+ IDs): create integration/<epic-id> off <base> (base for every per-ticket PR)
  ├─ solo (one ID): no integration branch — the ticket's PR below IS the resulting PR, targeting <base>
  └─ per ticket, in blocked_by order:
       1. implementer subagent → Skill feature:flow <id> --pr --no-ui-testing   (plan → build → open PR against <BASE_BRANCH>; only build's UI-test checkpoint is skipped — lint/typecheck still run and gate)
       2. reviewer subagent     → spec + diff only → posts PR review
       3. implementer subagent → read posted review → validate → fix → push → chain: gh pr merge --squash into the integration branch; solo: leave the PR open
  ├─ orchestrator: verify the hop (chain: merge landed + checks green; solo: PR open + checks green) → next ticket
  └─ end of run: the resulting PR — chain: open integration→<base> PR; solo: the already-open ticket PR. Left open unless --merge.
```

Roles stay separated: the implementer owns build + fix authority (and per-ticket merge authority on a chain); the reviewer is independent and adversarial. The orchestrator **independently verifies every hop** — do not trust the implementer's self-report; check the branch and PR state and run the checks yourself.

## Arguments

```
/feature:ship $ARGUMENTS
```

- `$1 …` = one or more ticket IDs to ship, in the order given (e.g. `PB-14 PB-15`).
- `--chain <epic-id>` = resolve the chain automatically: walk the epic's children in `blocked_by` topological order, skipping any already `done`, and ship the rest.
- `--base <branch>` = the trunk of the run (default `main`): the branch the feature/integration branch is cut from and the branch the **resulting PR** targets. It does not change the branch strategy — a solo ticket's feature branch forks from `<base>` and its PR targets `<base>`; a chain's `integration/<epic-id>` branch forks from `<base>` and the final integration PR targets `<base>`.
- `--merge` = merge the **resulting PR** into `<base>` at the end of the run instead of leaving it open. Solo single-ticket PR: `gh pr merge --squash`; integration→`<base>` PR: `gh pr merge --merge` (a merge commit, so the per-ticket squashed commits survive on `<base>`). Per-ticket merges into the integration branch happen regardless of this flag — the chain needs them to build on merged code. If branch protection (required reviews, status checks) blocks the merge, ship STOPs and reports; it never forces.

### Examples
```
/feature:ship PB-13                       # solo → open single-ticket PR into main
/feature:ship PB-13 --merge               # solo → squash-merge that PR into main once green
/feature:ship PB-14 PB-15                 # chain → integration/PB-14; integration→main PR left open to review
/feature:ship --chain PB-11               # whole epic in dependency order → integration/PB-11 → open integration→main PR
/feature:ship --chain PB-11 --merge       # epic → same, then ship merges the integration→main PR (merge commit)
```

### Flags ship does not take
- **`--pr` is implicit.** `ship` always builds with `flow --pr` — autonomy needs a PR to review and address — so you never pass it.
- **`--no-ui-testing` is implicit.** `ship` runs fully autonomously, with no human present to grant browser-MCP permission or drive a UI test, so it always builds with `flow … --no-ui-testing` — the browser/`ui-tester` checkpoint is skipped while lint + typecheck still run and still gate each build's verdict. Browser-level acceptance-criteria verification is deferred to the human at the resulting PR; on a `--merge` run it happens post-merge. You never pass it.
- **`--ignore-blockers` is not exposed.** `ship` orders chains so dependencies merge first and validates `blocked_by` in SETUP rather than bypassing it. To ship a genuinely-blocked ticket, run `/feature:flow <id> --pr --ignore-blockers` by hand.

## Procedure

### SETUP
1. Resolve the ticket list (explicit IDs, or chain order from the epic's `blocked_by` graph). **For `--chain`, ship only *materialized* children** — glob `<epic-folder>/tasks/*/01-spec.md` and ship the IDs that resolve to a real spec, in `blocked_by` order. Skip any declared-but-unwritten child (a just-in-time epic declares its full `children:` roster upfront but authors child specs later, as the pipeline reaches each phase) and list the skipped IDs in the run report — do not attempt to flow a child whose `01-spec.md` does not yet exist. Confirm each shipped ticket's `blocked_by` deps are already `done`/merged; if not and you're shipping the chain, order them so deps merge first.
2. Pre-flight: `git checkout <base> && git pull --ff-only` (default `main`), confirm a clean tree and `gh auth status` is logged in. Read the repo's CLAUDE.md and `claudedocs/tickets/_lessons.md` so the per-ticket brief carries the project's load-bearing constraints and carry-forward lessons.
3. **Resolve the branch strategy** — by invocation shape, not by how many tickets end up shipping. A **solo run** (a single explicit ticket ID, no `--chain`) → no integration branch; `<BASE_BRANCH>` = `<base>`, and the ticket's single-ticket PR is the run's resulting PR. A **chain/epic run** (`--chain`, or two or more IDs) → always create an integration branch off `<base>` and use it as `<BASE_BRANCH>` for every per-ticket PR — even when only one child is materialized right now (later siblings join the same branch; the strategy keys on how ship was invoked). Name it `integration/<epic-id>` (or `integration/<first-ticket-id>` for an ad-hoc multi-ticket list). Create it once and push it: `git checkout <base> && git pull --ff-only && git checkout -b integration/<epic-id> && git push -u origin integration/<epic-id>`. If it already exists (resume), reuse it.
4. TodoWrite one item per ticket.

### PER TICKET (loop)
Each ticket runs three roles — **implementer → independent reviewer → implementer (address; merge on a chain)** — and the orchestrator spawns each as its own `Task` (implementer for Step 1, reviewer for Step 2, implementer for Step 3). Spawn full-tool subagents (implementer subagent_type e.g. `claude`; reviewer `general-purpose`) with **self-contained briefs** — subagents do **not** share your context. Every brief must carry:

- **Role + full autonomy** (no per-ticket human gate; decide and record reasoning).
- **Repo path + ticket identity**, including whether it's an epic child and its spec path (`claudedocs/tickets/<state>/<EPIC>/tasks/<ID>/01-spec.md`).
- **Base branch** = `<BASE_BRANCH>` (the integration branch for a chain, else `<base>`). Cut the feature branch from `<BASE_BRANCH>`, and target the PR at it.
- **Project conventions that override harness defaults** — for feature-pipeline repos: commit subject `<ID>: <imperative>`, **no `Co-Authored-By` trailer**, one concern per commit; plus any boundary rules from CLAUDE.md (e.g. this app's server/client `node:*` boundary).
- **Step 1 — Build:** invoke `Skill feature:flow` with args `<ID> --pr --no-ui-testing`. Ensure the PR's base is `<BASE_BRANCH>` — if `flow --pr` opened it against a different branch, retarget with `gh pr edit <n> --base <BASE_BRANCH>`. Then independently run `npm run typecheck` and the spec's verification tests; fix anything red.
- **Step 2 — Independent review:** the orchestrator spawns ONE reviewer subagent (`general-purpose`) using the reviewer prompt below, with the real PR number. The reviewer gets the spec path + PR diff + neutral instructions only — **never** the implementer's justifications.
- **Step 3 — Address (merge on a chain):** read the actually-posted review (`gh pr view <n> --comments`), validate each finding (ACCEPT real / DISMISS wrong, one-line reason each), fix accepted ones per conventions, push, re-run typecheck + tests (must be green). Then, **on a chain**: `gh pr merge <n> --squash --delete-branch` (merges into the integration branch). **On a solo run**: leave the PR **open** — it is the run's resulting PR; whether it merges is decided at END OF RUN (`--merge`). Either way, what lands is **code only** — the ticket folder stays in `review/` (status `in-review`); finalizing it to `done/` is `sync`'s job (see Ticket-state finalization under END OF RUN).
- **Step 4 — Report** the structured sections: ticket, branch, base, pr, built, checks, review_findings, addressed, merge SHA (chain) or open-PR state (solo), **ui_verification** (state plainly that browser ACs were **not** verified in-loop — `--no-ui-testing` is always on — and that real-browser verification is deferred to the human at the resulting PR, or post-merge on a `--merge` run), blockers, and **finalization** (ticket left in `review/` — run `/feature:sync` to promote to `done/`).
- **Guardrails:** spawn exactly one reviewer per ticket; never weaken/skip tests to go green; never merge the resulting PR unless `--merge` was passed; on a genuine blocker (merge protection, irreconcilable finding, unfixable test) STOP and report it instead of forcing/faking.

For a **UI ticket**, browser verification is **not** run during the loop — the build's `ui-tester` checkpoint is skipped by `--no-ui-testing`, so the implementer relies on lint, typecheck, and the spec's verification tests. Real-browser verification of the acceptance criteria falls to the human at the resulting PR (or post-merge on a `--merge` run). The independent reviewer still reasons about user-visible behavior from the diff.

### AFTER EACH IMPLEMENTER RETURNS (orchestrator verifies)
**On a chain:** `git checkout <integration branch> && git pull --ff-only`, then **independently**: confirm the merge commit is on the integration branch, `gh pr view <n>` shows `MERGED`, no stray open PR remains, `npm run typecheck` is clean, and the test suite is green. **On a solo run** nothing merges by design: confirm the PR is **open** and targets `<base>` (`gh pr view <n> --json state,baseRefName`), no stray extra PR exists, and — on the ticket's feature branch — typecheck is clean and the test suite is green. Only then mark the todo done and advance. If verification fails, treat it as a blocker — do not start the next ticket on a broken base.

### END OF RUN (the resulting PR)
**Chain/epic** — after every ticket has merged into the integration branch and verified green:
1. Confirm the integration branch is green as a whole: `git checkout <integration-branch> && git pull --ff-only` (the branch SETUP created — `integration/<epic-id>`, or `integration/<first-ticket-id>` for an ad-hoc list), then `npm run typecheck`, the test suite, and `npm run build`.
2. Open the integration PR. Never paste ticket text into a quoted command literal (see `skills/build/references/pr-creation.md` for the same hardening). Resolve the title by chain source — **`--chain <epic-id>`**: load it from the epic PRD via command substitution, `EPIC_TITLE=$(sed -n 's/^title: *//p' <epic-folder>/prd.md | head -1)`, and title `"<EPIC-ID>: $EPIC_TITLE"`; **ad-hoc multi-ID list** (no epic, no `prd.md`): build the title from the shipped IDs alone — shell-safe `<PREFIX>-<N>` tokens, no free text needed — e.g. `"<first-ticket-id>: integration of <ID1>, <ID2>, …"`. Either way, write the summary (the N tickets shipped, each per-ticket PR #, the per-ticket review outcomes) to a temp file, then `gh pr create --base <base> --head <integration-branch> --title "$TITLE" --body-file <summary-file>`.
3. **Default**: leave it open — report the PR URL and stop; this is the human gate. **With `--merge`**: merge it with a merge commit (`gh pr merge <n> --merge --delete-branch`) so the per-ticket squashed commits survive on `<base>`; if branch protection blocks the merge, STOP and report instead of forcing.

**Solo** — the resulting PR is the single-ticket PR already open from the loop. **Default**: report its URL and stop. **With `--merge`**: `gh pr merge <n> --squash --delete-branch` into `<base>`; if branch protection blocks it, STOP and report.

### Ticket-state finalization (all paths)
A merge — per-ticket into the integration branch, or the resulting PR via `--merge` — lands **code, not ticket state**: every ticket `flow --pr` built is sitting in `review/` with `status: in-review` (Transition 5), and `ship` does **not** perform the `review/ → done/` move (Transition 6) — `sync` owns that single transition, so `ship` does not reimplement it. Close the loop by running **`/feature:sync`**, which scans `in-review` tickets, detects each merged PR, moves the ticket to `done/`, and fires the Epic-completion predicate for epic children. Run `sync` once the code has actually reached `<base>` — after the resulting PR merges (by you, or by `--merge`); for a chain the children only reach `<base>` then. Surface "tickets remain in `review/` — merge the resulting PR, then run `/feature:sync` to finalize" as the final line of the run report so the next step is explicit.

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
For UI tickets, assess user-visible behavior against the spec and diff — ship defers live browser verification to the human gate, so do not attempt it or report missing browser evidence as a gap.

Be specific. Per finding: severity (blocking|major|minor|nit), file:line, what's wrong, why.
If nothing is blocking, say so explicitly.

POST the review to GitHub: `gh pr review <N> --comment --body "<structured findings>"` (if GitHub blocks self-review because the PR author == your `gh` identity, fall back to `gh pr comment <N> --body "<structured findings>"`),
then return the same findings as your final message.
```

## Recovery & GitHub identity

If a run stalls or dies, re-run `ship` — resumption state is on disk (ticket folders, feature branches, open PRs, posted reviews; SETUP reuses an existing integration branch). On re-run, inspect each ticket's actual state and resume at the **first incomplete stage** instead of restarting its sequence: a ticket in `review/` with an open PR skips Step 1 (`flow` on an in-review ticket only re-checks merge state — it does not rebuild); a PR whose comments already carry the independent review (`gh pr view <n> --comments`) skips Step 2 — never post a second review (one reviewer per ticket); a PR already `MERGED` skips to the orchestrator's verification. Only stages with no evidence on GitHub or disk re-run.

Two GitHub identity facts the loop depends on:

- **Self-review is blocked** when the PR author and the reviewer's `gh` identity are the same user — the reviewer falls back from `gh pr review` to `gh pr comment` (handled in the template above). A single-identity setup means findings are *comments*, not a formal approve/request-changes review.
- **Posting and merging under the user's identity needs the user's authorization** — the harness blocks autonomous self-merge without it, and posting can trip a security-heuristic flag. Both are expected here (invoking `ship` authorizes the per-ticket integration merges; `--merge` authorizes the resulting-PR merge), but the orchestrator should still glance at what was published (`gh api repos/{o}/{r}/issues/<N>/comments`) to confirm it's appropriate review content before relying on the merge.

## When NOT to run
- You want to gate **every ticket** — approve each per-ticket merge into the integration branch, not just the resulting PR → use `/feature:flow --pr` per ticket and merge manually.
- A single stage only → `/feature:plan` or `/feature:build`.
- Reconciling already-open PRs with merged state → `/feature:sync`.

## Notes / provenance
The independent reviewer is the load-bearing addition over plain flow — in practice it has been the independent review agent, not the implementer's own internal review, that caught a real concurrency bug.

The **integration-branch chain path has been exercised in practice**: per-ticket PRs target the `integration/<epic-id>` base (repoint `origin/HEAD` to the integration branch — or retarget with `gh pr edit --base` — so build's `--pr` lands there), and the final integration merge waits for the user by default, since autonomous merging under the user's identity requires their authorization (see Recovery & GitHub identity) — `--merge` is that authorization, granted per run. `--merge` itself and the solo resulting-PR path have not yet been exercised end-to-end — treat their first run as a shakedown.
