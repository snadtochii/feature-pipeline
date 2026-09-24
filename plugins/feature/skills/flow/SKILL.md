---
name: flow
description: "Run the feature pipeline (plan → implement → review → close) on a ticket, or walk an epic's children in dependency order."
allowed-tools:
  - Read
  - Glob
  - Grep
  - TodoWrite
  - Skill
  - Task
  - Agent
  - SendMessage
  - pipeline_get_ticket
  - pipeline_list_tickets
  - pipeline_get_artifact
  - pipeline_list_artifacts
  - pipeline_delete_artifact
  - mcp__plugin_server-native_ps__pipeline_get_ticket
  - mcp__plugin_server-native_ps__pipeline_list_tickets
  - mcp__plugin_server-native_ps__pipeline_get_artifact
  - mcp__plugin_server-native_ps__pipeline_list_artifacts
  - mcp__plugin_server-native_ps__pipeline_delete_artifact
argument-hint: "[ticket-id|epic-id] [--pr] [--no-commit] [--no-ui-testing] [--attach-screenshots] [--worktree] [--hint text] [--plan-model alias|inherit] [--build-model alias|inherit]"
---

# Feature Flow Pipeline

Thin sequencer with two modes:

- **Single-ticket mode** (default): runs `plan → implement → review → close` on the resolved ticket, entering at the stage its artifacts call for.
- **Epic mode** (when the resolved folder has `kind: epic` on `prd.md`): walks children in `blocked_by` topological order, recursively invoking `Skill flow` per child.

Flow's job in both modes is to resolve, validate, decide what to invoke, and invoke — the full ownership split (what flow owns vs. what the stages own) is the Responsibilities section below. Each stage runs as its own **stage subagent**, spawned from a self-contained brief (`references/stage-briefs.md`): flow's context holds only resolution, validation, the spawns, and the relayed reports, while plan prose, edits, reviewer reports, and test output live in the stage that produced them. The handoff between stages is on disk: `02-plan.md`, `03-implementation.md`, `04-review.md`.

Each stage is a separate skill that can also be invoked directly:
- `/feature:plan` — pre-plan synthesis (codebase exploration + open-questions surfacing) followed by plan design; writes `02-plan.md`. Flow runs it non-interactively inside the plan stage subagent — see STAGE EXECUTION's `--auto` wiring.
- `/feature:build` — the implement stage: implements the plan step by step and writes the implementer handoff `03-implementation.md`. Flow runs it with `--implement-only`; standalone, build also sequences the review and close stages itself.
- `/feature:review-stage` — four independent reviewers, then validate-then-fix; writes `04-review.md`.
- `/feature:close-stage` — the test checkpoint, the verdict `pass | partial | stuck`, `06-summary.md`, lessons, the verdict gate and the finalizer; writes `05-tests.md` and `06-summary.md`.

## Arguments

```
/feature:flow $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket folder (e.g. `claudedocs/tickets/backlog/BL-1/`)
Remaining args = pipeline flags (see table below)

### Flags

| Flag | Effect | Example |
|------|--------|---------|
| `--pr` | On verdict `pass`, the close stage opens a GitHub PR and finalizes the ticket into `review/` instead of `done/` (see `build/references/pr-creation.md`). Propagated to the close stage only; in epic-mode, forwarded per child (one PR per child). Degrades to a local commit + `done/` when GitHub tooling is absent. | `--pr` |
| `--no-ui-testing` | Skip only the browser/ui-tester portion of the close stage's test checkpoint; non-browser verification (lint/typecheck) still runs in implement and still gates the verdict. Use when the run can't get interactive browser-MCP permission (e.g. headless `claude -p`); browser verification then falls to a human at PR review. Propagated to the close stage only; in epic-mode, forwarded per child. | `--no-ui-testing` |
| `--attach-screenshots` | With `--pr`, the close stage attaches the browser pass's screenshots to the PR body with `gh pr create --attach` — the per-run form of the `git.attach_screenshots: true` config key. Off by default: an upload cannot be undone and is world-readable on a public repository. `gh` without `--attach` (below 2.99.0), or a refused attach, falls back to a path manifest; a run with no browser pass attaches nothing (see `build/references/ui-attach.md`). Propagated to the close stage only; in epic-mode, forwarded per child. | `--pr --attach-screenshots` |
| `--no-commit` | On verdict `pass`, the close stage leaves the changes uncommitted this run — no commit prompt, beating any `git.commit` config default (see `close-stage`'s commit-mode binding). Contradicts `--pr`: passing both stops at flow SETUP (or at the close stage's or standalone build's own flag validation when invoked directly) with a one-line error, before any stage runs. Propagated to the close stage only; in epic-mode, forwarded per child. | `--no-commit` |
| `--worktree` | The implement stage (`build`) does its code work in a dedicated git worktree cut from `origin/<base>`, instead of the current checkout — the ticket branch is pre-created, `.worktreeinclude` files are copied, `worktree.setup` runs, and the close stage's finalizer tears the worktree down once the work is committed on the branch (see `build/references/worktree.md`). Propagated to the implement stage only; review and close re-bind the recorded worktree themselves. In epic-mode, forwarded per child (one worktree per child). Contradicts nothing. Flow itself never provisions — it has no `Bash` — so every eligibility decision and every degrade notice (a ticket spanning 2+ repos, a `blocked_by` blocker whose code is not yet on the base) is printed by build, not here. | `--worktree` |
| `--hint "<text>"` | Thread a user note into the implement stage — a fresh run or a resumed one on a partially built ticket (see `build`'s `--hint` flag). Carried in the implement brief's `<HINT_BLOCK>`, and routes the run to implement unless an earlier routing row wins. Single-ticket mode only: in epic-mode it is dropped with the notice `--hint ignored in epic mode` — a hint names one ticket's situation. The close stage's `continue-with-hint` is the in-run counterpart: flow carries its returned hint into the next implement brief (`references/stage-briefs.md` §11). | `--hint "the failing check wants the label inside the button"` |
| `--plan-model <alias\|inherit>` | The model the plan stage subagent runs on. `inherit` (default) omits an explicit model. Supply a Claude alias/model ID on Claude or a supported Codex model ID on Codex; the value is passed verbatim when the active spawn surface exposes an override, otherwise the stage inherits with a notice. A rejected value falls back to inheritance after one retry, one line, never a verdict (`references/stage-briefs.md` §2). Binds the spawn, not the stage's args — nothing reaches `plan`'s own flags. In epic-mode, forwarded per child. Model names never go in `config.yaml`. | `--plan-model opus` |
| `--build-model <alias\|inherit>` | The model the implement, review and close stage subagents run on — same values, mapping, and fallback as `--plan-model`; binds those three spawns alike. Their role children use the selected runtime's role-model policy; this flag changes only the stages. In epic-mode, forwarded per child. | `--build-model sonnet` |

Resumption is auto-detected from on-disk artifacts — see "Resumption auto-detection" below. To start fresh against a partially-run ticket, delete the relevant artifacts before invoking flow.

### Examples
```
/feature:flow BL-1                              # single-ticket; auto-resumes if artifacts exist
/feature:flow claudedocs/tickets/backlog/BL-1/  # by folder path
/feature:flow BL-1 --pr                         # on pass, open a GitHub PR and land in review/
/feature:flow BL-1 --pr --no-ui-testing         # headless-safe: skip the browser pass, still open a PR
/feature:flow BL-1 --no-commit                  # on pass, leave changes uncommitted (beats git.commit config)
/feature:flow BL-1 --worktree                   # implement in a dedicated worktree; torn down once the work is committed
/feature:flow BL-1 --plan-model opus --build-model sonnet   # stronger model for plan, cheaper one for the later stages
/feature:flow BL-1 --hint "keep the existing API shape"     # thread a note into a (resumed) implement run
/feature:flow EPIC-1                            # epic-mode: walks children in dependency order
```

## Pipeline Order

**plan → implement → review → close → completion**

A stuck implement goes straight to close, and the close stage's `continue-with-hint` loops back to implement (`references/stage-briefs.md` §11).

---

## Stage Contract

Each stage reads and writes artifacts in `<ticket-folder>/`. This contract is load-bearing — each stage depends on the previous stage's output landing in the expected place.

| Stage | Reads | Writes |
|---|---|---|
| `plan` | `01-spec.md`, `exploration.md` (optional seed — Phase 1 explores only what it leaves uncovered or stale) | `02-plan.md` (includes Codebase Context + Open Questions Resolved sections from Phase 1 synthesis) |
| implement (`build --implement-only`) | `01-spec.md`, `02-plan.md`, `03-implementation.md` when present (auto-resumption); optional user hint from the implement brief's `<HINT_BLOCK>`, per build's Required Input contract; flag `--worktree` | `03-implementation.md` (implementer handoff: per-step entries, then `## Rationale` or `## Stuck`) |
| review (`review-stage`) | `01-spec.md`, `02-plan.md`, `03-implementation.md`, each blocker's `06-summary.md` (reviewer blocker context), `04-review.md` when present; `--base <branch>` when the forwarded overrides name a base branch | `04-review.md` (merged from 4 reviewer subagents, with a decision per finding), `## Post-review` in `03-implementation.md` |
| close (`close-stage`) | `01-spec.md` through `05-tests.md`, `06-summary.md` when present; flags `--pr`, `--no-commit`, `--no-ui-testing`, `--attach-screenshots` | `05-tests.md` (UI test results, or a skip artifact — no-UI, `--no-ui-testing` flag-skip, or app-unreachable), `06-summary.md` (always written, content varies per verdict), `## Post-test` in `03-implementation.md`; owns the verdict gate |

---

## Responsibilities

flow owns:
1. Ticket resolution (per `references/ticket-resolution-fs.md` / `references/ticket-resolution-server.md`)
2. Kind validation (epic refusal) and blocker pre-check
3. Resumption auto-detection from on-disk artifacts (see below) — decides the entry stage
4. Stage invocation — spawning each stage as a subagent from `references/stage-briefs.md`, filling its brief (ticket argument, storage mode, forwarded overrides, flags, model), advancing through the §11 stage chain, relaying what each stage returns, and relaying any user-facing stop back to the stage (`stage-briefs.md` §5)

It does NOT own:
- State transitions — plan and implement perform Transition 1, and the close stage and its finalizer perform the rest, per `references/state-transitions-fs.md` / `references/state-transitions-server.md`
- The verdict gate — the close stage owns it end-to-end (verdict, option menu, user-choice capture, and the instruction set its finalizer child then applies); flow only carries the gate's text out of the close subagent and the choice back in (`references/stage-briefs.md` §5)
- Stage internals — plan owns its Phase 1 synthesis and plan design; implement its step loop; review its reviewers and fixes; close its test checkpoint and gate
- Agent coordination — each stage spawns its own subagents
- Artifact writes — every artifact is written by the stage that produces it

---

## Resumption auto-detection (single-ticket mode)

Flow inspects the ticket's existing artifacts at start and picks the **entry stage** automatically; from there the §11 stage chain in `references/stage-briefs.md` advances on each stage's report. Users who want to start fresh against a partially-run ticket delete the relevant artifacts manually.

**Routing table** (checked in order, first match wins). "Current" below means `06-summary.md` is not older than any of `02-plan.md`, `03-implementation.md`, `04-review.md` and `05-tests.md` — a re-plan makes the summary non-current, so its old gate is never re-presented; "the current pass" is the newest pass of `03-implementation.md`.

| On disk | Routing |
|---|---|
| Ticket folder is in `review/` (status `in-review`) | PR is open — enter at **close**, whose merge-check row finalizes the ticket to `done/` via Transition 6 if the PR has merged, else reports the still-open PR. Checked **first** so a `review/` ticket whose `06-summary.md` reads `pass` isn't mistaken for "already complete." |
| No `02-plan.md` | Fresh start: enter at **plan**. |
| `06-summary.md` exists and is current, and the ticket's own status is `in-progress` | The close stage's tail never completed — enter at **close**, which re-presents the verdict gate. |
| `06-summary.md` exists with verdict `pass` | Print "Pipeline already complete for `<ticket-id>` (verdict: pass). To re-run, delete the relevant artifacts (`02-plan.md` onward) or run a stage directly with `/feature:plan <id>` or `/feature:build <id>`." Exit without changes. |
| `06-summary.md` exists with verdict `partial` or `stuck` and is current, the ticket's own status is neither `in-progress` nor `in-review`, and no `--hint` was passed | Print "`<ticket-id>` already closed (`<status>`, verdict `<v>`). Re-run with `--hint` to continue, or delete `03-implementation.md` onward to rebuild." Exit without changes. |
| `--hint` was passed | Enter at **implement**, which opens a new pass for the hint. |
| No `03-implementation.md`, or the current pass has neither `## Rationale` nor `## Stuck` | Enter at **implement**. |
| The current pass has `## Stuck` | Enter at **close** — a stuck handoff is not reviewed. |
| `05-tests.md` newer than `04-review.md`, and the current pass carries `## Post-test` | Enter at **close** — the tests and their fixes are the close stage's own output for this pass. |
| `04-review.md` missing, carrying `fix-step: pending`, or older than `03-implementation.md` | Enter at **review**. |
| Otherwise | Enter at **close**. |

A row that exits, or enters at close, prints `--hint unused — <reason>.` when `--hint` was passed, so the no-op is visible. The `## Post-test` row wins over the review row because the close stage's own `## Post-test` append leaves `03-implementation.md` newer than `04-review.md`; without `## Post-test` in the current pass, a `04-review.md` older than the handoff reviewed an earlier pass, and the ticket needs review.

The user signals "start fresh on a partial ticket" by deleting `02-plan.md` (and downstream `03-`/`04-`/`05-`/`06-`, if any). On the next flow invocation, the routing table matches the "No `02-plan.md`" row and runs from scratch.

**Signal keying.** How each routing signal above is read — the first row's state signal, the ticket's status, artifact presence and recency, the `06-summary.md` verdict, the handoff's section headings, `04-review.md`'s `fix-step:` marker, and the user's start-fresh deletion: [`keying-fs.md`](references/keying-fs.md) / [`keying-server.md`](references/keying-server.md) §1 and §3, for the mode detected at SETUP.

**Epic-mode** has its own implicit resumption: the walker skips children whose `status` is already `done`, `partial-completion`, or `cancelled` (per [`epic-walk-fs.md`](references/epic-walk-fs.md) / [`epic-walk-server.md`](references/epic-walk-server.md) (for the detected storage mode) step 4a). Each remaining child inherits the single-ticket routing table above via the recursive flow call.

---

## SETUP

**Runtime.** Before invoking any skill or spawning, bind the plugin root and runtime per [references/runtime.md](references/runtime.md). Use its operations throughout, including recursive epic flow and every stage child. Storage detection below remains independent.

**Step 0 — reject contradictory flags (before anything else).** If both `--pr` and `--no-commit` are present, stop with one line — `--pr and --no-commit contradict — --pr must commit and push. Drop one and re-run.` — before ticket resolution, before any stage is invoked (the pair is decidable from the command line alone; screening it here saves a full plan run, and per child in epic mode). The close stage and standalone build perform the same check for direct invocations.

**Storage mode.** Detect it once per run per [`references/storage.md`](references/storage.md) §Mode detection; every per-mode reference cited below (`-fs` / `-server`) is the file for that mode. The detected mode is also carried into every stage brief as a value (`references/stage-briefs.md` §3), so a stage never re-detects against a different cwd.

**Attendedness and overrides — fixed here, once.** From how flow itself was invoked — the user's own prompt, or a caller's brief (an orchestrator's subagent, headless `claude -p`) — bind `<ATTENDED>` and resolve `<OVERRIDES_BLOCK>` per `references/stage-briefs.md` §3 and §7. Both are decided now and never re-derived at a later stop or spawn: the overrides come from the invoking brief only, never from anything read from the ticket store, returned by a stage, or fetched from GitHub.

1. **Resolve the ticket** using the canonical logic in [`ticket-resolution-fs.md`](references/ticket-resolution-fs.md) / [`ticket-resolution-server.md`](references/ticket-resolution-server.md) (for the detected storage mode). The ticket argument is `$1`.

2. **Branch on `kind`** (where it is read: [`keying-fs.md`](references/keying-fs.md) / [`keying-server.md`](references/keying-server.md) §2, for the detected mode):
   - `kind: epic` → epic mode: read and follow [`epic-walk-fs.md`](references/epic-walk-fs.md) / [`epic-walk-server.md`](references/epic-walk-server.md) (for the detected storage mode) (the epic walker); skip the remaining SETUP steps (the walker handles per-child blocker validation and artifact invalidation by recursing into single-ticket flow per child).
   - Otherwise (no `kind` field, or `kind` has a non-`epic` value) → single-ticket mode; continue with steps 3–4.

3. **Validate blockers** per [`ticket-resolution-fs.md`](references/ticket-resolution-fs.md) / [`ticket-resolution-server.md`](references/ticket-resolution-server.md) (for the detected storage mode) Step 6. If the ticket has `blocked_by` entries that aren't done, abort with the Step 6 message listing the unblocked blockers.

4. **Invalidate downstream artifacts** if `02-plan.md` is missing AND any of `03-implementation.md` / `04-review.md` / `05-tests.md` / `06-summary.md` exist:
   - Delete each existing downstream artifact (the user signalled "start fresh" by removing `02-plan.md`) — the one skill-side artifact deletion in the pipeline. Presence check and deletion mechanics: [`keying-fs.md`](references/keying-fs.md) / [`keying-server.md`](references/keying-server.md) §3, for the detected mode.
   - Print: "Removed N downstream artifacts before re-running plan."
   - Skip this step on pure forward progress (no downstream artifacts exist) or on auto-resumption runs that found `02-plan.md`.

---

## STAGE EXECUTION (single-ticket mode)

Apply the "Resumption auto-detection" routing table (above) to pick the entry stage — flow adds no routing logic beyond that table and the chain. Each stage runs as a **stage subagent**: read [`references/stage-briefs.md`](references/stage-briefs.md) at this point, then, from the entry stage, one stage at a time along its §11 stage chain:

1. **Fill the brief** — inline the stage's template (§4 plan / §6 implement / §9 review / §10 close) verbatim and resolve every placeholder (§3), including `<RUNTIME_BLOCK>` and the runtime-rendered `<STAGE_INVOCATION>`: `<PROJECT_ROOT>`; `<TICKET_ARG>` and `<STORAGE_MODE>` per [`keying-fs.md`](references/keying-fs.md) / [`keying-server.md`](references/keying-server.md) §5, for the mode detected at SETUP — resolved **immediately before this spawn**, since plan and implement may have moved the ticket and close's finalizer moves it; `<ATTENDED>` and `<OVERRIDES_BLOCK>` as bound at SETUP (§3, §7); `<IMPLEMENT_FLAGS>` and `<HINT_BLOCK>` for implement, `<REVIEW_FLAGS>` for review, `<CLOSE_FLAGS>` for close.
2. **Spawn** through the selected runtime's fresh generic-worker operation (§1), applying §2's model selection from `--plan-model` (plan) or `--build-model` (implement, review, close). At the implement spawn, print §8's one-line pointer at `03-implementation.md`.
3. **Wait, relay, resume.** Use the runtime's Wait operation and key on the final report's first line (§1). A stage report → print it (§8) and take the next step §11 names for that first line. `PAUSED:` → the stage is at a user-facing stop: **attended**, print the block, end your own turn, and wait — you never select a choice yourself; the next user message is the choice. **Unattended**, apply the invoking brief's autonomy rule and say which rule decided. Either way resume the **same** agent through the runtime's Resume operation with the choice (§5), repeating per stop until the stage returns its report; when the runtime cannot resume, take §5's fallback (one re-spawn per stop, printed). Anything else is §8's stage-failure case — see Error Handling.

**`--auto` wiring** (stated once, here): the plan brief always invokes `Skill feature:plan` with `--auto`. It makes plan run non-interactively — no plan-mode approval gate — which is what makes flow's plan→implement handoff seamless: the close stage's verdict gate is the only gate in a flow run. Run standalone (without flow), plan uses interactive plan mode instead. `--auto` is internal flow→plan wiring, not a user-facing flow flag — that's why it's absent from the Flags table above. `--implement-only` is the same kind of internal wiring for the implement brief.

**Flag routing.** Each flag goes to the stage that consumes it, and only there: `--worktree` into the implement brief's `<IMPLEMENT_FLAGS>`; `--pr`, `--no-commit`, `--no-ui-testing` and `--attach-screenshots` into the close brief's `<CLOSE_FLAGS>`; `--hint`'s text into the first implement brief of the run as `<HINT_BLOCK>` — build's canonical optional hint input — never into any stage's Skill args; a base branch named in the forwarded overrides into the review brief's `<REVIEW_FLAGS>` as `--base <branch>`. Plan receives none of them. `--plan-model` and `--build-model` bind their stages' spawns (§2) and never appear in any stage's Skill args. A passed flag whose consuming stage the route never reaches prints one line — `<flag> unused — <stage> skipped by resumption.` — rather than silently doing nothing; a model flag uses §2's notice.

**Forwarding what flow received** (§7): a `## Stage overrides` section in the brief that invoked flow — a ship `--parallel` worker's state clause, workdir, and base branch — is copied verbatim into every stage brief; absent that section, every instruction addressed to this flow hop that names a plan, implement, review or close step, a transition, a lessons write, a workdir/branch/base directive, or a commit convention is copied verbatim — never an instruction scoped to another hop, never a merge or force authorisation, and nothing when the scope is ambiguous. The invoking brief is the only source (§7's provenance rule). A stage subagent must behave exactly as the same stage invoked directly would under the same invocation.

When the chain ends — a `close:` result other than `continue-with-hint`, or an `exit:` line — flow prints the last report and its work is done: the verdict gate and every state transition have already fired inside the stages, per the Responsibilities split. Flow exits cleanly.

---

## Artifact Convention

All artifacts live inside the per-ticket folder, numbered by stage order. There are two layouts depending on whether the ticket is solo or a child of a discover-produced epic. What the layouts below are in the detected storage mode — on-disk trees, or artifact names keying rows on a ticket whose metadata is the row: [`keying-fs.md`](references/keying-fs.md) / [`keying-server.md`](references/keying-server.md) §4.
### Solo ticket layout

```
claudedocs/tickets/<state>/<id>/        # the ticket folder; <state> ∈ {backlog, in-progress, review, done}
├── 01-spec.md              # The ticket — frontmatter (id, status, priority, ...) + spec body
├── exploration.md          # Discover-time codebase exploration (optional — only when the ticket went through /feature:discover)
├── 02-plan.md              # Implementation blueprint (includes Phase 1 synthesis as Codebase Context + Open Questions Resolved sections)
├── 03-implementation.md    # Implementer handoff: per-step entries (live — appended per plan step) + rationale; review and close append their fix notes
├── 04-review.md            # Review stage: merged findings (4 reviewer subagents) and their decisions
├── 05-tests.md             # Close stage: UI test results, skip artifact, or Failed Criteria section
├── 06-summary.md           # Close stage summary (always written, content varies per verdict)
└── screenshots/            # Browser-pass captures (close stage, or ship's --ui-test) — 05-tests.md links them relative to itself
```

### Epic with children layout (discover multi-mode output)

```
claudedocs/tickets/<state>/<EPIC-ID>/   # epic folder; <state> follows most-advanced child
├── prd.md                  # Parent PRD (frontmatter: kind: epic, children: [...]) — flow walks children in epic-mode; every stage refuses to run directly against this
├── exploration.md          # Shared exploration, lives once for all siblings
├── screenshots/            # Captures from a pass covering the epic; a per-child pass writes the child folder's own screenshots/
└── tasks/
    ├── <CHILD-1-ID>/       # child ticket folder — same internal structure as a solo ticket above
    │   ├── 01-spec.md      # frontmatter: parent: <EPIC-ID>, blocked_by: [...] (optional)
    │   ├── 02-plan.md
    │   ├── 03-implementation.md
    │   ├── 04-review.md
    │   ├── 05-tests.md
    │   └── 06-summary.md
    ├── <CHILD-2-ID>/
    └── <CHILD-3-ID>/
```

How the epic and its children advance together as a unit, and where per-child and epic-level `status` live, is the detected mode's [`keying-fs.md`](references/keying-fs.md) / [`keying-server.md`](references/keying-server.md) §4.

**Naming rules:**
- Sequential: `NN-name.md` where `NN` is the stage order
- `01-spec.md` IS the ticket — it carries frontmatter (live state metadata) and the spec body. There is no separate "ticket file" outside the folder.
- `02`–`06` are reserved for canonical stages in order: `02-plan.md`, `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md`. Don't reuse numbers.
- Plain (un-numbered) filenames at the ticket-folder root are reserved for pre-spec / pre-stage artifacts (currently just `exploration.md`) and for the close stage's derived PR-body files `pr-body-attach.md` / `pr-body-manifest.md`, written only when a `--pr` close attaches screenshots ([`ui-attach.md`](../build/references/ui-attach.md) §5) and rewritten on every such run; for child tickets of an epic, the shared `exploration.md` lives one level up at the epic folder, not in the child folder.
- The ticket folder moves between state folders (`backlog/` → `in-progress/` → `review/` → `done/`) as the pipeline advances. Everything inside moves with it. (`review/` is on the path only for `--pr` runs; a non-`--pr` `pass` goes straight `in-progress/` → `done/`.)
- `screenshots/` is the one reserved **directory** name at the ticket-folder root — the rule above reserves plain filenames, not directories. It is the browser pass's evidence home, and `05-tests.md` links into it with paths relative to itself, which is durable precisely because everything inside the folder moves with it (the rule above). Whether this directory exists at all is mode-specific: [`keying-fs.md`](references/keying-fs.md) / [`keying-server.md`](references/keying-server.md) §4.

---

## Standalone re-run guidance

To re-run a single stage outside flow, invoke the skill directly:
- `/feature:plan <id>` — re-runs Phase 1 synthesis + interactive plan mode; overwrites `02-plan.md`.
- `/feature:build <id>` — runs the implement stage in the main conversation, auto-resuming from `03-implementation.md`, then sequences the review and close stages itself from the same briefs (`references/stage-briefs.md` §11), relaying the close stage's stops.
- `/feature:review-stage <id>` — one review round against the current diff; returns a recorded round without redoing it.
- `/feature:close-stage <id>` — the test checkpoint, verdict, gate and finalizer; re-presents a pending gate.

Stage skills handle their own ticket resolution and validation; flow is not in the call chain when invoked this way.

## Continuation & Partial Runs

Resumption is auto-detected — see "Resumption auto-detection" above, including how the user signals "start fresh".

When the close stage's verdict is `partial` or `stuck`, its verdict gate presents `accept-as-partial | continue-with-hint | abort` — the close stage subagent pauses with that menu, flow relays it and the choice (`references/stage-briefs.md` §5). On `continue-with-hint` the close stage returns the user's hint, and flow spawns implement again with it in `<HINT_BLOCK>`, then review and close — the §11 chain loops through flow, with no count cap because every round needs a relayed decision. A later `/feature:flow <id> --hint "<text>"` on a partially built or already-closed ticket is the other way to thread a note in: the run enters at implement with the hint.

## Error Handling

- **Stage subagent failure** (a stage returns `review: error` or `close: error`, returns without one of its report formats, or returns a `close:` ending with no `06-summary.md` for the ticket — `references/stage-briefs.md` §8): report what came back to the user and ask how to proceed — retry (**one** fresh spawn of that stage from the same template with placeholders re-resolved; every stage resumes from disk, plan starts over; a retry that fails the same way is handed back, never spawned a third time) or abort (every artifact stays in place).
- **Ticket not found**: defer to the error handling in `references/ticket-resolution-fs.md` / `references/ticket-resolution-server.md` — ask the user for the correct path.
- **Project path can't be determined**: ask the user.
- **Blocker validation fails**: abort at SETUP step 3; print the Step 6 message verbatim. The ticket folder stays in `backlog/` and frontmatter `status` is unchanged (flow has not touched state at this point).

Plan-mode cancellation, verdict-gate ambiguity, and verdict-vs-summary inconsistencies are all handled inside the stages that produce them (plan and close respectively), not in flow.
