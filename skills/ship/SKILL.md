---
name: ship
description: "User-initiated (never auto-invoked) autonomous loop that builds, independently reviews, and addresses a ticket or a dependency chain, ending at an open pull request. For each ticket it spawns an implementer subagent that runs /feature:flow to build the ticket and open its PR (headless — browser/UI testing is skipped), spawns an independent reviewer subagent (given only the spec + PR diff, never the implementer's rationale), validates the findings, and fixes the real ones. A solo ticket — or each of several independent solo tickets — ends at its own open single-ticket PR; an epic squash-merges each per-ticket PR into an integration branch and ends at an open integration PR. The resulting PR is left open for human review by default — pass --merge to have ship land it on the base branch. Invoke explicitly with /feature:ship; not a plan-only or build-only run."
disable-model-invocation: true
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - TodoWrite
  - Task
argument-hint: "[ticket-id ...] [--base branch] [--merge] [--ui-test]"
---

# Ship — autonomous build → independent review → resulting PR

`ship` is the autonomy layer **on top of** `/feature:flow`. Flow builds one ticket and (with `--pr`) opens a PR. `ship` wraps that in four things flow does not do:

1. **An independent, bias-isolated reviewer** — a separate subagent that reviews the PR against the spec + diff *only*, never the implementer's own narrative of why the code is correct, and posts findings to GitHub.
2. **Self-validation + address** — the implementer fetches the posted review, judges each finding against reality (reviewers can be wrong), and fixes the real ones. **No per-ticket human gate** — in an epic run it then squash-merges the per-ticket PR into the integration branch; the human gate is the resulting PR(s) (item 4).
3. **A sequential loop** — in an epic run, after each per-ticket merge the orchestrator pulls the integration branch (so the next child plans against merged code) and advances; load-bearing for `blocked_by` chains: child N+1 must see child N merged before it plans. In a multi-solo run the tickets are independent, so each ships off `<base>` with no between-ticket pull.
4. **Resulting PR(s) as the human gate (open by default)** — every run ends at one or more open PRs targeting the base branch (`--base`, default `main`): a **solo** run's single-ticket PR, a **multi-solo** run's N independent single-ticket PRs (one per ticket), or — for an **epic** run — one integration→`<base>` PR collecting the per-ticket PRs that merged into `integration/<epic-id>` (cut from `<base>`). `ship` leaves the resulting PR(s) open for you to review; pass `--merge` to have ship merge them (solo/multi-solo: squash each; integration: merge commit, preserving the per-ticket squashed commits). If branch protection blocks a `--merge`, ship stops and reports.

> **Autonomy with a final gate.** `ship` runs each ticket end to end without a per-ticket human gate — it decides, fixes, and (in an epic run) merges per-ticket PRs into the integration branch on its own, stopping only on a *genuine* blocker (see Guardrails). The human gate is the **resulting PR(s)**: ship opens them and leaves them open unless you passed `--merge`. If you want to gate every child's merge into the integration branch instead, use `/feature:flow --pr` directly and merge by hand. This skill is **user-initiated only** (`disable-model-invocation: true`) — Claude will not auto-run it; invoke `/feature:ship` deliberately.

## Topology

The orchestrator (this skill, in the main conversation) drives the **outer loop**: it resolves the run shape, spawns subagents, and independently verifies each hop. It never edits ticket code itself.

**Environment requirement (applies to all of `ship`).** The orchestrator delegates building to an **implementer subagent**, and that implementer runs `feature:flow → build`, which itself spawns build's four reviewer subagents from within. So `ship` needs a harness where a **subagent can spawn subagents** and you can observe async agents — it was developed and proven in such a harness. In a vanilla single-level-subagent setup (a subagent has no `Task`), you can't delegate build to a subagent: run `/feature:flow <id> --pr` yourself in the main conversation and merge by hand instead of using `ship`.

Given that requirement, the orchestrator spawns each role directly — implementer, then the independent reviewer as its sibling, then an implementer to address the review. The tree stays shallow and the orchestrator can observe and recover each hop. Per ticket, in `blocked_by` order (epic run) or list order (multi-solo run):

```
orchestrator (main)
  ├─ epic run (resolved ID is kind: epic): create integration/<epic-id> off <base> (base for every per-ticket PR)
  ├─ solo run (one parentless ID) / multi-solo run (2+ parentless IDs): no integration branch — each ticket's PR targets <base> and is a resulting PR
  └─ per ticket, in blocked_by order (epic) or list order (multi-solo):
       1. implementer subagent → Skill feature:flow <id> --pr --no-ui-testing   (plan → build → open PR against <BASE_BRANCH>; only build's UI-test checkpoint is skipped — lint/typecheck still run and gate)
       2. reviewer subagent     → spec + diff only → posts PR review
       3. implementer subagent → Skill feature:address-review <n> --auto (validate → fix → reply → push) → re-run typecheck + tests → epic run: gh pr merge --squash into the integration branch; solo/multi-solo: leave the PR open
  ├─ orchestrator: verify the hop (epic run: merge landed + checks green; solo/multi-solo: PR open + checks green) → next ticket
  └─ end of run: the resulting PR(s) — epic run: one open integration→<base> PR; solo/multi-solo: the already-open ticket PR(s). Left open unless --merge.
```

Roles stay separated: the implementer owns build + fix authority (and per-ticket merge authority in an epic run); the reviewer is independent and adversarial. The orchestrator **independently verifies every hop** — do not trust the implementer's self-report; check the branch and PR state and run the checks yourself.

## Arguments

```
/feature:ship $ARGUMENTS
```

- `$1 …` = one or more IDs to ship, in the order given. Each is either a **solo ticket ID** or an **epic ID**; the run shape is resolved from what they are (see SETUP step 1):
  - one epic ID → **epic run** (walk its children in `blocked_by` order on `integration/<epic-id>`),
  - one solo ID (or a single epic child shipped directly) → **solo run** (one PR),
  - two or more solo IDs → **multi-solo run** (an independent PR each, e.g. `FP-14 FP-15`).
- `--base <branch>` = the trunk of the run (default `main`): the branch feature/integration branches are cut from and the branch the **resulting PR(s)** target. It does not change the branch strategy — a solo/multi-solo ticket's feature branch forks from `<base>` and its PR targets `<base>`; an epic's `integration/<epic-id>` branch forks from `<base>` and the final integration PR targets `<base>`.
- `--merge` = merge the **resulting PR(s)** into `<base>` at the end of the run instead of leaving them open. Solo/multi-solo single-ticket PRs: `gh pr merge --squash` (each); integration→`<base>` PR: `gh pr merge --merge` (a merge commit, so the per-ticket squashed commits survive on `<base>`). In an epic run, per-ticket merges into the integration branch happen regardless of this flag — the chain needs them to build on merged code. If branch protection (required reviews, status checks) blocks the merge, ship STOPs and reports; it never forces.
- `--ui-test` = opt-in end-of-run browser pass (default off — no UI verification). When passed, after the assembled branch is green and the resulting PR(s) are open, ship spawns **one** `ui-tester` subagent from main context to run the acceptance criteria's behavioral checks against the assembled branch and posts the screenshots to the resulting PR (see END OF RUN → UI verification). It governs **only** this end-of-run pass — every per-ticket build still runs headless (`flow … --no-ui-testing`). A setup gap or a UI-test failure is reported, never fatal — the run still ends at its normal PR outcome.

### Examples
```
/feature:ship PB-13                       # solo → open single-ticket PR into main
/feature:ship PB-13 --merge               # solo → squash-merge that PR into main once green
/feature:ship PB-14 PB-15                 # multi-solo → an independent PR per ticket into main, each left open
/feature:ship PB-14 PB-15 --merge         # multi-solo → squash-merge each PR into main once green
/feature:ship PB-11                       # epic (PB-11 is kind: epic) → children in dependency order → integration/PB-11 → open integration→main PR
/feature:ship PB-11 --merge               # epic → same, then ship merges the integration→main PR (merge commit)
/feature:ship PB-11 --ui-test             # epic → end-of-run browser pass on integration/PB-11, screenshots posted to the integration PR
```

### Flags ship does not take
- **`--pr` is implicit.** `ship` always builds with `flow --pr` — autonomy needs a PR to review and address — so you never pass it.
- **`--no-ui-testing` is implicit *down to `flow`*.** `ship` always builds each per-ticket ticket with `flow … --no-ui-testing` — mid-chain a feature is half-assembled and the implementer subagent can't reach browser MCP anyway, so the browser/`ui-tester` checkpoint is skipped while lint + typecheck still run and still gate each build's verdict. You never pass `--no-ui-testing` yourself; it's always on for the per-ticket builds. This is distinct from ship's own opt-in `--ui-test` (above), which governs a **single end-of-run** browser pass on the assembled branch — the one point the whole UI story is testable from main context. Without `--ui-test`, browser-level acceptance-criteria verification is deferred to the human at the resulting PR (post-merge on a `--merge` run); with it, ship runs the behavioral checks and attaches screenshots there too.
- **`--chain` is unnecessary.** An epic is recognized by its `kind: epic` and walked as a dependency chain automatically — just pass the epic ID (`/feature:ship <epic-id>`). A leftover `--chain` on the command line is ignored; the epic ID drives the chain either way.

## Procedure

### SETUP
1. **Resolve the ticket list and classify the run shape** — by the resolved tickets' identity, not by how many IDs or which flags were passed. Read each resolved ID's frontmatter (`kind` from an epic folder's `prd.md`; `parent`/`blocked_by` from a solo/child `01-spec.md`):
   - **Epic run** — exactly one resolved ID, and it is `kind: epic`. Ship its *materialized* children: glob `<epic-folder>/tasks/*/01-spec.md` and ship the IDs that resolve to a real spec, in `blocked_by` topological order. Skip any declared-but-unwritten child (a just-in-time epic declares its full `children:` roster upfront but authors child specs later, as the pipeline reaches each phase) and list the skipped IDs in the run report — do not attempt to flow a child whose `01-spec.md` does not yet exist.
   - **Solo run** — exactly one resolved ID that is **not** `kind: epic`. This covers a parentless solo ticket *and* a single epic child shipped directly (`parent:` set) — a lone child is a legitimate unit of work (as it is for `flow`/`build`), so ship it alone on its own feature branch off `<base>` with a single-ticket PR to `<base>`; its `blocked_by` deps are enforced by the blocker check below.
   - **Multi-solo run** — two or more resolved IDs, all parentless solo tickets (none `kind: epic`, none with `parent:` set). Ship each independently, in the order given.
   - **Guard (multi-ID lists only; STOP before building)** — a multi-ID list must be all parentless solo tickets. STOP and report if it contains:
     - any **epic child** (`parent:` set) → tell the user to ship its epic instead: `/feature:ship <parent-epic-id>` (an epic run walks the children in dependency order on an integration branch). Name each offending ID and its `parent`. Dependency resolution belongs to the epic run — never ship epic children as an ad-hoc independent-PR list.
     - any **epic ID** (`kind: epic`) → an epic ships on its own: `/feature:ship <epic-id>` alone. Don't combine an epic with other IDs in one list.
   - Every single-ID input is classified (epic run if `kind: epic`, else solo run) and every multi-ID list is either a multi-solo run or a guard STOP — the classification is total.
   - **Blocker check (every run)** — confirm each shipped ticket's `blocked_by` deps are already `done`/merged. In an epic run, order the children so deps merge first. In a solo or multi-solo run, an unmet `blocked_by` is a STOP (the dependency isn't in place) — surface it and direct the user to ship the dependency first (or its epic). If the dependency's PR is already merged but the ticket still reads unmet, run `/feature:sync` to reconcile it to `done/`, then re-run.
2. Pre-flight: `git checkout <base> && git pull --ff-only` (default `main`), confirm a clean tree and `gh auth status` is logged in. Read the repo's CLAUDE.md and `claudedocs/tickets/_lessons.md` so the per-ticket brief carries the project's load-bearing constraints and carry-forward lessons.
3. **Resolve the branch strategy** — from the run shape classified in step 1:
   - **Solo or multi-solo run** → no integration branch. `<BASE_BRANCH>` = `<base>` for every ticket; each ships on its own feature branch (build names it from the ticket ID) and opens its own single-ticket PR against `<base>`. A solo run's one PR — and each of a multi-solo run's N PRs — is a resulting PR of the run.
   - **Epic run** → create an integration branch off `<base>` and use it as `<BASE_BRANCH>` for every per-ticket PR — even when only one child is materialized right now (later siblings join the same branch). Name it `integration/<epic-id>`. Create it once and push it: `git checkout <base> && git pull --ff-only && git checkout -b integration/<epic-id> && git push -u origin integration/<epic-id>`. If it already exists (resume), reuse it.
4. TodoWrite one item per ticket.

### PER TICKET (loop)
Each ticket runs three roles — **implementer → independent reviewer → implementer (address; merge in an epic run)** — and the orchestrator spawns each as its own `Task` (implementer for Step 1, reviewer for Step 2, implementer for Step 3). Spawn full-tool subagents (implementer subagent_type e.g. `claude`; reviewer `general-purpose`) with **self-contained briefs** — subagents do **not** share your context. Every brief must carry:

- **Role + full autonomy** (no per-ticket human gate; decide and record reasoning).
- **Repo path + ticket identity**, including whether it's an epic child and its spec path (`claudedocs/tickets/<state>/<EPIC>/tasks/<ID>/01-spec.md`).
- **Base branch** = `<BASE_BRANCH>` (the integration branch in an epic run, else `<base>`). Cut the feature branch from `<BASE_BRANCH>`, and target the PR at it.
- **Project conventions that override harness defaults** — for feature-pipeline repos: commit subject `<ID>: <imperative>`, **no `Co-Authored-By` trailer**, one concern per commit; plus any boundary rules from CLAUDE.md (e.g. this app's server/client `node:*` boundary).
- **Step 1 — Build:** invoke `Skill feature:flow` with args `<ID> --pr --no-ui-testing`. Ensure the PR's base is `<BASE_BRANCH>` — if `flow --pr` opened it against a different branch, retarget with `gh pr edit <n> --base <BASE_BRANCH>`. Then independently run `npm run typecheck` and the spec's verification tests; fix anything red. Keep the PR body to build's summary plus a single one-line inner-cycle review provenance — the full internal 4-reviewer findings must **not** land in the PR body, since the independent reviewer (Step 2) reads it (bias isolation).
- **Step 2 — Independent review:** the orchestrator spawns ONE reviewer subagent (`general-purpose`) using the reviewer prompt below, with the real PR number. The reviewer gets the spec path + PR diff + neutral instructions only — **never** the implementer's justifications; the PR body it reads carries only the one-line inner-cycle review provenance (build's internal reviewer-checkpoint result, e.g. "Review checkpoint: 4 parallel reviewers — zero findings at confidence ≥ 80"), never the full inner-cycle findings — bias isolation.
- **Step 3 — Address (merge in an epic run):** invoke `Skill feature:address-review <n> --auto` — it fetches the actually-posted review, validates each finding (ACCEPT real / DISMISS wrong, one-line reason each), fixes the accepted ones, pushes, and posts signed replies. `--auto` is the unattended path (no interactive gate). Then run **ship's own wrapper** around it: independently re-run typecheck + the spec's verification tests (must be green — never weaken or skip a test to get there). Then, **in an epic run**: `gh pr merge <n> --squash --delete-branch` (merges into the integration branch). **In a solo or multi-solo run**: leave the PR **open** — it is a resulting PR of the run; whether it merges is decided at END OF RUN (`--merge`). The split: `address-review` does the code-fix + signed replies; ship does the test-gate + merge. Either way, what lands is **code only** — the ticket folder stays in `review/` (status `in-review`); finalizing it to `done/` is `sync`'s job (see Ticket-state finalization under END OF RUN).
- **Step 4 — Report** the structured sections: ticket, branch, base, pr, built, checks, review_findings, addressed, merge SHA (epic run) or open-PR state (solo/multi-solo), **ui_verification** (state plainly that browser ACs were **not** verified in this per-ticket loop — `--no-ui-testing` is always on — and that real-browser verification is deferred to the human at the resulting PR, or post-merge on a `--merge` run, or to ship's own end-of-run `--ui-test` pass when that flag was set), blockers, and **finalization** (ticket left in `review/` — run `/feature:sync` to promote to `done/`).
- **Guardrails:** spawn exactly one reviewer per ticket; never weaken/skip tests to go green; never merge the resulting PR unless `--merge` was passed; on a genuine blocker (merge protection, irreconcilable finding, unfixable test) STOP and report it instead of forcing/faking.

For a **UI ticket**, browser verification is **not** run during the loop — the build's `ui-tester` checkpoint is skipped by `--no-ui-testing`, so the implementer relies on lint, typecheck, and the spec's verification tests. Real-browser verification of the acceptance criteria falls to the human at the resulting PR (or post-merge on a `--merge` run) — unless `--ui-test` was passed, in which case ship runs one end-of-run behavioral pass on the assembled branch and attaches screenshots to that PR (see END OF RUN → UI verification). The independent reviewer still reasons about user-visible behavior from the diff.

### AFTER EACH IMPLEMENTER RETURNS (orchestrator verifies)
**In an epic run:** `git checkout <integration branch> && git pull --ff-only`, then **independently**: confirm the merge commit is on the integration branch, `gh pr view <n>` shows `MERGED`, no stray open PR remains, `npm run typecheck` is clean, and the test suite is green. **In a solo or multi-solo run** nothing merges by design: confirm the ticket's PR is **open** and targets `<base>` (`gh pr view <n> --json state,baseRefName`), no stray extra PR exists, and — on the ticket's feature branch — typecheck is clean and the test suite is green. In a multi-solo run the next ticket's implementer forks fresh from `<base>` (there is no integration branch to pull between tickets). Only then mark the todo done and advance. If verification fails, treat it as a blocker — do not start the next ticket on a broken base.

### END OF RUN (the resulting PR(s))
**Epic run** — after every child has merged into the integration branch and verified green:
1. Confirm the integration branch is green as a whole: `git checkout integration/<epic-id> && git pull --ff-only`, then `npm run typecheck`, the test suite, and `npm run build`.
2. Open the integration PR. Never paste ticket text into a quoted command literal (see `skills/build/references/pr-creation.md` for the same hardening). Resolve the title from the epic PRD via command substitution: `EPIC_TITLE=$(sed -n 's/^title: *//p' <epic-folder>/prd.md | head -1)`, then set `TITLE="<EPIC-ID>: $EPIC_TITLE"`. Write the summary (the N children shipped, each per-ticket PR #, the per-ticket review outcomes) to a temp file, then `gh pr create --base <base> --head integration/<epic-id> --title "$TITLE" --body-file <summary-file>`.
3. **Default**: leave it open — report the PR URL and stop; this is the human gate. **With `--merge`**: on a `--ui-test` run, run UI verification (below) and post screenshots to this PR **first** — `--delete-branch` destroys the branch the pass needs. Then merge it with a merge commit (`gh pr merge <n> --merge --delete-branch`) so the per-ticket squashed commits survive on `<base>`; if branch protection blocks the merge, STOP and report instead of forcing.

**Solo run** — the resulting PR is the single-ticket PR already open from the loop. **Default**: report its URL and stop. **With `--merge`**: on a `--ui-test` run, run UI verification (below) and post screenshots to this PR **first** — `--delete-branch` destroys the branch the pass needs. Then `gh pr merge <n> --squash --delete-branch` into `<base>`; if branch protection blocks it, STOP and report.

**Multi-solo run** — the resulting PRs are the N independent single-ticket PRs already open from the loop (no integration branch, no aggregate PR). **Default**: report all N PR URLs and stop. **With `--merge`**: on a `--ui-test` run, run UI verification (below) for every ticket and post each ticket's screenshots to its own PR **first** — `--delete-branch` destroys the branches the pass needs. Then squash-merge them into `<base>` one at a time (`gh pr merge <n> --squash --delete-branch`). Each PR's checks were run against the *initial* `<base>`, so every merge moves the base out from under the remaining PRs and their green checks go stale — two independent PRs can interact through shared behavior with no textual merge conflict, so a later merge can leave `<base>` red though its own checks were green. Before merging each subsequent PR, update its branch from the now-current `<base>` and require its checks/tests to pass again against the merged base; merge only when green. If a revalidation fails, or branch protection blocks any merge, STOP and report which PRs merged and which remain open — do not force, and do not leave the run state ambiguous.

### UI verification (`--ui-test` only)
Skip this section entirely unless `--ui-test` was passed (default is no browser pass). It runs **after** the resulting PR(s) are open (above) and **before** any `--merge` — the screenshots have to land on an existing PR, and on a `--merge` run they're the evidence the human still gets. It never changes the PR outcome; a setup gap or a behavioral failure is reported and the run continues to its normal open/merge ending (AC5).

The assembled branch is the first point the whole UI story is testable, and the orchestrator runs in main context where browser MCP is reachable. Spawn **one** `ui-tester` subagent per run (one browser session, not per ticket) to run the acceptance criteria's behavioral checks against the assembled branch, then post its screenshots to the resulting PR:
- **Epic run** → assembled branch is `integration/<epic-id>`; screenshots post to the integration PR.
- **Solo run** → assembled branch is the ticket's open PR head; screenshots post to that PR.
- **Multi-solo run** → the one end-of-run pass walks each ticket's open PR head in turn, posting each ticket's screenshots to its own PR. Each ticket is a distinct branch and app-state, so the single session re-runs the pre-flight per ticket — re-check-out that ticket's branch (`git checkout <ticket-branch> && git pull --ff-only`) and, if `test.start` booted the app, re-boot it (with its own §4 teardown) — before that ticket's behavioral checks and screenshot post.

1. **Pre-flight (reuse, do not reinvent).** Resolve the app URL + auth exactly as `skills/build/references/test-preflight.md` prescribes — §1 URL resolution from the project `test:` block (`test.url` → CLAUDE.md hint → dev-port probe, held as a data value), §2 reachability `curl`, §3 optional `test.start` boot + bounded poll with §4 teardown, §5 auth recipe (`storage_state` → `attach_tab`) composed into the spawn prompt. That reference is the single source of truth for the recipe — don't restate it here. §3's PID/script files are keyed on a stable id: use `<epic-id>` for the epic pass (whose assembled branch is `integration/<epic-id>`, not one ticket) and the ticket-id for the solo/multi-solo passes. Check out the assembled branch first (`git checkout <assembled-branch> && git pull --ff-only`) so the running app reflects the code under test.
2. **Spawn.** Give the `ui-tester` subagent (subagent_type `feature:ui-tester`) a self-contained brief: the spec path(s) whose acceptance criteria to verify behaviorally, the pre-flight-resolved reachable URL, the §5 auth recipe, and an instruction to capture a screenshot per acceptance criterion. It judges **behavior** (flow completes, elements respond, no console errors, right text renders); it does not judge alignment/aesthetics — that's the human's job from the images.
3. **Post the screenshots to the resulting PR**, following `pr-comments.md` §7 injection discipline. The orchestrator has Bash but no Write tool, so materialize the comment body — the per-AC behavioral verdict plus a manifest of the saved screenshot file paths — in a file the same way the reviewer hop does — a §5 quoted-heredoc into a `mktemp -d` file with a verified-unique nonce delimiter — then post with `gh pr comment "<N>" --body-file "<file>"`: `<N>` a controlled integer, never a `--body "…"` literal, never interpolating agent-generated text or file paths into the command, never `eval`. `gh pr comment --body-file` posts text only — it can't upload local image files (inline GitHub images need the web-UI drag-drop or a CDN/asset upload this path doesn't perform), so the path manifest is the normal outcome; only a runner that can upload the images to the repo/CDN embeds them inline. Either way the behavioral verdict and the screenshot paths reach the PR — evidence is surfaced, never dropped.
4. **Degrade, never block (AC5).** If the app is unreachable, there's no `test:` config or resolvable URL, or the browser MCP isn't available, **report it in the run report and continue** to the normal end-of-run PR outcome. Mirrors the test-checkpoint's non-blocking skip in `test-preflight.md` §6 — a UI-test setup gap or a failed behavioral check is recorded, never fatal, and never blocks or alters the resulting-PR outcome. This is a trial flag — treat its first runs as a shakedown.

### Ticket-state finalization (all paths)
A merge — per-ticket into the integration branch, or a resulting PR via `--merge` — lands **code, not ticket state**: every ticket `flow --pr` built is sitting in `review/` with `status: in-review` (Transition 5), and `ship` does **not** perform the `review/ → done/` move (Transition 6) — `sync` owns that single transition, so `ship` does not reimplement it. Close the loop by running **`/feature:sync`**, which scans `in-review` tickets, detects each merged PR, moves the ticket to `done/`, and fires the Epic-completion predicate for epic children — Transition 6 promotes a child only once its merge commit is reachable from `<base>`, so `sync` is safe to run at any point in the run. Surface "tickets remain in `review/` — merge the resulting PR(s), then run `/feature:sync` to finalize" as the final line of the run report so the next step is explicit.

### REVIEWER PROMPT TEMPLATE (bias isolation is the crux)
```
You are an independent, skeptical code reviewer. Review GitHub PR #<N> in <REPO_PATH>.
Assume nothing is correct until you verify it against the spec and the actual code.

Get the change: `gh pr diff <N>`, `gh pr view <N> --json title,body,headRefName,baseRefName,files`,
and read the surrounding source/tests as needed. The PR body carries only a one-line inner-cycle
review provenance, not the implementer's rationale — judge the diff against the spec yourself.

GROUND TRUTH is the ticket spec at <SPEC_PATH> — read it and judge the diff against it.
Also read any carry-forward checklist in claudedocs/tickets/_lessons.md.

Review in priority order: (1) correctness vs each acceptance criterion; (2) bugs / edge cases /
concurrency / the carry-forward checklist; (3) project boundary or architecture violations;
(4) convention violations (commit subject, no Co-Authored-By, file placement);
(5) test-coverage gaps vs the spec's Verification; (6) security & performance.
For UI tickets, assess user-visible behavior against the spec and diff — ship defers live browser verification to the human gate, so do not attempt it or report missing browser evidence as a gap.

Be specific. Per finding: severity (blocking|major|minor|nit), file:line, what's wrong, why.

POST the review by following the shared contract in $CLAUDE_PLUGIN_ROOT/skills/review/references/pr-comments.md
— read that file (it lives under the plugin root, not this repo's cwd) and apply it as written; the
notes below are only your brief, not a restatement of it:
- Post ONE logical review via the Reviews API (§4): line-anchored findings as `comments[]`, other
  findings in the summary body each tagged `[F<k>]`, ending with the §1 footer `_— 🔎 review (automated)_`
  and the §2 hidden marker `<!-- fp-review agent=<codex|claude> head=<SHA> -->` (its `head=<SHA>` is the
  PR's current head; `agent=codex` when `$PLUGIN_ROOT` is set and `$CLAUDE_PLUGIN_ROOT` is not, else
  `agent=claude`). Reproduce both literals EXACTLY as written here even if the file read fails — ship's
  recovery scan greps for that exact marker.
- You have Bash but no Write tool: materialize every body/payload in FILES via §4/§5's
  quoted-heredoc-to-`mktemp -d` mechanism with a verified-unique nonce delimiter — never a
  `--body "…"` literal, never `eval` (§7).
- On a Reviews-API error or a blocked self-review (PR author == your `gh` identity), fall back to the
  single `gh pr comment` path (§5); no blocking findings → post one signed summary per §6. Do not
  approve or request changes.

OUTPUT DISCIPLINE: the PR comment is FINDINGS-ONLY — at most a one-line verdict plus a compact
acceptance-criteria checklist. Do NOT narrate per-AC "verified, all pass" prose onto the PR. Put the
full per-AC verification narration in your FINAL MESSAGE to the orchestrator (ship's run report),
never on the PR — then return that narration + the posted findings as your final message.
```

## Recovery & GitHub identity

If a run stalls or dies, re-run `ship` — resumption state is on disk (ticket folders, feature branches, open PRs, posted reviews; in an epic run SETUP reuses an existing integration branch, while a multi-solo run has no integration branch, so its resume state is purely the per-ticket folders/branches/PRs). On re-run, inspect each ticket's actual state and resume at the **first incomplete stage** instead of restarting its sequence: a ticket in `review/` with an open PR skips Step 1 (`flow` on an in-review ticket only re-checks merge state — it does not rebuild); a PR already carrying an `fp-review` marker for its **current** head SHA skips Step 2 — run the `pr-comments.md` §3 idempotency scan (`gh pr view <n> --json headRefOid,comments,reviews`, match `head=<current-SHA>`) rather than treating any prior review comment as sufficient (the head may have moved), and never post a second review at the same head (one reviewer per ticket); a PR already `MERGED` skips to the orchestrator's verification. Only stages with no evidence on GitHub or disk re-run.

Two GitHub identity facts the loop depends on:

- **Self-review is blocked** when the PR author and the reviewer's `gh` identity are the same user — the reviewer falls back from the Reviews API to `gh pr comment` (`pr-comments.md` §5, handled in the template above). A single-identity setup means findings are *comments*, not a formal approve/request-changes review.
- **Posting and merging under the user's identity needs the user's authorization** — the harness blocks autonomous self-merge without it, and posting can trip a security-heuristic flag. Both are expected here (invoking `ship` authorizes the per-ticket integration merges; `--merge` authorizes the resulting-PR merge), but the orchestrator should still glance at what was published (`gh api repos/{o}/{r}/issues/<N>/comments`) to confirm it's appropriate review content before relying on the merge.

## When NOT to run
- You want to gate **every ticket** — approve each per-ticket merge into the integration branch, not just the resulting PR → use `/feature:flow --pr` per ticket and merge manually.
- A single stage only → `/feature:plan` or `/feature:build`.
- Reconciling already-open PRs with merged state → `/feature:sync`.

## Notes / provenance
The independent reviewer is the load-bearing addition over plain flow — in practice it has been the independent review agent, not the implementer's own internal review, that caught a real concurrency bug.

`--ui-test` is a **trial flag** — opt-in on purpose. Once the end-of-run browser pass is proven in practice, the intended follow-up (noted in FP-33's out-of-scope, not built here) is to flip the default on and retire `--ui-test` in favor of the shared `--no-ui-testing` opt-out, so ship has one UI-testing switch rather than a permanent positive/negative flag pair.

The **integration-branch epic path has been exercised in practice**: per-ticket PRs target the `integration/<epic-id>` base (repoint `origin/HEAD` to the integration branch — or retarget with `gh pr edit --base` — so build's `--pr` lands there), and the final integration merge waits for the user by default, since autonomous merging under the user's identity requires their authorization (see Recovery & GitHub identity) — `--merge` is that authorization, granted per run. The **multi-solo path (an independent PR per ticket) is new** — treat its first run as a shakedown. `--merge` itself and the solo resulting-PR path have likewise not been exercised end-to-end.
