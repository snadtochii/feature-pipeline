---
name: flow
description: "Run the feature pipeline (plan → build) on a ticket, or walk an epic's children in dependency order."
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
argument-hint: "[ticket-id|epic-id] [--pr] [--no-commit] [--no-ui-testing] [--worktree] [--hint text] [--plan-model alias|inherit] [--build-model alias|inherit]"
---

# Feature Flow Pipeline

Thin sequencer with two modes:

- **Single-ticket mode** (default): runs `plan → build` on the resolved ticket.
- **Epic mode** (when the resolved folder has `kind: epic` on `prd.md`): walks children in `blocked_by` topological order, recursively invoking `Skill flow` per child.

Flow's job in both modes is to resolve, validate, decide what to invoke, and invoke — the full ownership split (what flow owns vs. what the stages own) is the Responsibilities section below. Each stage runs as its own **stage subagent**, spawned from a self-contained brief (`references/stage-briefs.md`): flow's context holds only resolution, validation, the two spawns, and the relayed summaries, while plan prose, edits, reviewer reports, and test output live in the stage that produced them. The plan→build handoff is `02-plan.md` on disk.

Each stage is a separate skill that can also be invoked directly:
- `/feature:plan` — pre-plan synthesis (codebase exploration + open-questions surfacing) followed by plan design; writes `02-plan.md`. Flow runs it non-interactively inside the plan stage subagent — see STAGE EXECUTION's `--auto` wiring.
- `/feature:build` — implement → review → test as in-loop checkpoints; exits with verdict `pass | partial | stuck`; writes `03-implementation.md`, `04-review.md`, `05-tests.md`, `06-summary.md`. Flow runs it inside the build stage subagent and relays its verdict.

## Arguments

```
/feature:flow $ARGUMENTS
```

`$1` = ticket ID (e.g. `BL-1`) or path to ticket folder (e.g. `claudedocs/tickets/backlog/BL-1/`)
Remaining args = pipeline flags (see table below)

### Flags

| Flag | Effect | Example |
|------|--------|---------|
| `--pr` | On verdict `pass`, build opens a GitHub PR and finalizes the ticket into `review/` instead of `done/` (see `build/references/pr-creation.md`). Propagated to `build` only; in epic-mode, forwarded per child (one PR per child). Degrades to a local commit + `done/` when GitHub tooling is absent. | `--pr` |
| `--no-ui-testing` | Skip only the browser/ui-tester portion of build's test checkpoint; non-browser verification (lint/typecheck) still runs and still gates the verdict. Use when the run can't get interactive browser-MCP permission (e.g. headless `claude -p`); browser verification then falls to a human at PR review. Propagated to `build` only (plan has no UI-test concept); in epic-mode, forwarded per child. | `--no-ui-testing` |
| `--no-commit` | On verdict `pass`, build leaves the changes uncommitted this run — no commit prompt, beating any `git.commit` config default (see `build`'s State setup commit-mode binding). Contradicts `--pr`: passing both stops at flow SETUP (or at build's own Flag validation when invoked directly) with a one-line error, before any stage runs. Propagated to `build` only (plan has no commit concept); in epic-mode, forwarded per child. | `--no-commit` |
| `--worktree` | Build does its code work in a dedicated git worktree cut from `origin/<base>`, instead of the current checkout — the ticket branch is pre-created, `.worktreeinclude` files are copied, `worktree.setup` runs, and the worktree is torn down once the work is committed on the branch (see `build/references/worktree.md`). Propagated to `build` only (plan writes `02-plan.md` and has no worktree concept); in epic-mode, forwarded per child (one worktree per child). Contradicts nothing. Flow itself never provisions — it has no `Bash` — so every eligibility decision and every degrade notice (a ticket spanning 2+ repos, a `blocked_by` blocker whose code is not yet on the base) is printed by build, not here. | `--worktree` |
| `--hint "<text>"` | Thread a user note into build's loop — a fresh run or an auto-resumed one on a partially built ticket (see `build`'s `--hint` flag). Propagated to `build` only (plan has no hint concept). Single-ticket mode only: in epic-mode it is dropped with the notice `--hint ignored in epic mode` — a hint names one ticket's situation. Not the `continue-with-hint` path: that hint is relayed into the running build stage (`references/stage-briefs.md` §5), never re-invoked through flow. | `--hint "the failing check wants the label inside the button"` |
| `--plan-model <alias\|inherit>` | The model the plan stage subagent runs on. `inherit` (default) omits an explicit model. Supply a Claude alias/model ID on Claude or a supported Codex model ID on Codex; the value is passed verbatim when the active spawn surface exposes an override, otherwise the stage inherits with a notice. A rejected value falls back to inheritance after one retry, one line, never a verdict (`references/stage-briefs.md` §2). Binds the spawn, not the stage's args — nothing reaches `plan`'s own flags. In epic-mode, forwarded per child. Model names never go in `config.yaml`. | `--plan-model opus` |
| `--build-model <alias\|inherit>` | The model the build stage subagent runs on — same values, mapping, and fallback as `--plan-model`; binds the build spawn only. Build’s role children use the selected runtime’s role-model policy; this flag changes only the stage. In epic-mode, forwarded per child. | `--build-model sonnet` |

Resumption is auto-detected from on-disk artifacts — see "Resumption auto-detection" below. To start fresh against a partially-run ticket, delete the relevant artifacts before invoking flow.

### Examples
```
/feature:flow BL-1                              # single-ticket; auto-resumes if artifacts exist
/feature:flow claudedocs/tickets/backlog/BL-1/  # by folder path
/feature:flow BL-1 --pr                         # on pass, open a GitHub PR and land in review/
/feature:flow BL-1 --pr --no-ui-testing         # headless-safe: skip browser checkpoint, still open a PR
/feature:flow BL-1 --no-commit                  # on pass, leave changes uncommitted (beats git.commit config)
/feature:flow BL-1 --worktree                   # build in a dedicated worktree; torn down once the work is committed
/feature:flow BL-1 --plan-model opus --build-model sonnet   # stronger model for plan, cheaper one for build
/feature:flow BL-1 --hint "keep the existing API shape"     # thread a note into build's (resumed) loop
/feature:flow EPIC-1                            # epic-mode: walks children in dependency order
```

## Pipeline Order

**plan → build → completion**

Build runs implement, review, and test as internal checkpoints inside one continuous loop — those are not flow-managed stages and don't surface their own gates to flow.

---

## Stage Contract

Each stage reads and writes artifacts in `<ticket-folder>/`. This contract is load-bearing — build depends on plan's output landing in the expected place.

| Stage | Reads | Writes |
|---|---|---|
| `plan` | `01-spec.md`, `exploration.md` (optional seed — used for incremental Phase 1 synthesis if present) | `02-plan.md` (includes Codebase Context + Open Questions Resolved sections from Phase 1 synthesis) |
| `build` | `01-spec.md`, `02-plan.md` (plus whichever of `03-implementation.md`/`04-review.md`/`05-tests.md` exist on disk for auto-resumption); optional user hint from the invoking stage brief, per build's Required Input contract | `03-implementation.md` (live, updated per plan step), `04-review.md` (merged from 4 reviewer subagents), `05-tests.md` (UI test results, or a skip artifact — no-UI, `--no-ui-testing` flag-skip, or app-unreachable), `06-summary.md` (always written, content varies per verdict) |

---

## Responsibilities

flow owns:
1. Ticket resolution (per `references/ticket-resolution-fs.md` / `references/ticket-resolution-server.md`)
2. Kind validation (epic refusal) and blocker pre-check
3. Resumption auto-detection from on-disk artifacts (see below) — decides which stages to invoke
4. Stage invocation — spawning each stage as a subagent from `references/stage-briefs.md`, filling its brief (ticket argument, storage mode, forwarded overrides, model), relaying what it returns, and relaying any user-facing stop back to the stage (`stage-briefs.md` §5)

It does NOT own:
- State transitions — plan and build perform these themselves per `references/state-transitions-fs.md` / `references/state-transitions-server.md`
- The verdict gate — build owns it end-to-end (verdict, option menu, user-choice capture, transition dispatch); flow only carries the gate's text out of the build subagent and the choice back in (`references/stage-briefs.md` §5)
- Stage internals — plan owns its Phase 1 synthesis and plan design; build owns its loop and checkpoints
- Agent coordination — plan and build spawn their own subagents
- Artifact writes — every artifact is written by the stage that produces it

---

## Resumption auto-detection (single-ticket mode)

Flow inspects the ticket's existing artifacts at start and routes to the right stage automatically. Users who want to start fresh against a partially-run ticket delete the relevant artifacts manually.

**Routing table** (checked in order, first match wins):

| On disk | Routing |
|---|---|
| Ticket folder is in `review/` (status `in-review`) | PR is open — skip plan; invoke `/feature:build <ticket-id>` (pass-through). Build owns the merge-check: it finalizes the ticket to `done/` via Transition 6 if the PR has merged, else reports the still-open PR. Must be checked **first** so a `review/` ticket whose `06-summary.md` reads `pass` isn't mistaken for "already complete." |
| `06-summary.md` exists with verdict `pass` | Print "Pipeline already complete for `<ticket-id>` (verdict: pass). To re-run, delete the relevant artifacts (`02-plan.md` onward) or run a stage directly with `/feature:plan <id>` or `/feature:build <id>`." — plus, when `--hint` was passed, `--hint unused — no build ran (pipeline already complete).` Exit without changes. |
| `06-summary.md` exists with verdict `partial` or `stuck` | Skip plan; invoke `/feature:build <ticket-id>` (build's own auto-resumption picks up where it left off). |
| `02-plan.md` exists, no `06-summary.md` | Skip plan; invoke `/feature:build <ticket-id>` (build's own auto-resumption picks up wherever its checkpoints landed). |
| Neither `02-plan.md` nor `06-summary.md` | Fresh start: invoke `/feature:plan <ticket-id>`, then `/feature:build <ticket-id>`. |

The user signals "start fresh on a partial ticket" by deleting `02-plan.md` (and downstream `03-`/`04-`/`05-`/`06-`, if any). On the next flow invocation, the routing table matches the "neither exists" row and runs from scratch. Internal build checkpoints (implement → review → test inside one build invocation) write directly to the canonical artifacts — no special-casing needed.

**Signal keying.** How each routing signal above is read — the first row's state signal, artifact presence, the `06-summary.md` verdict, and the user's start-fresh deletion: [`keying-fs.md`](references/keying-fs.md) / [`keying-server.md`](references/keying-server.md) §1 and §3, for the mode detected at SETUP.

**Epic-mode** has its own implicit resumption: the walker skips children whose `status` is already `done`, `partial-completion`, or `cancelled` (per [`epic-walk-fs.md`](references/epic-walk-fs.md) / [`epic-walk-server.md`](references/epic-walk-server.md) (for the detected storage mode) step 4a). Each remaining child inherits the single-ticket routing table above via the recursive flow call.

---

## SETUP

**Runtime.** Before invoking any skill or spawning, bind the plugin root and runtime per [references/runtime.md](references/runtime.md). Use its operations throughout, including recursive epic flow and every stage child. Storage detection below remains independent.

**Step 0 — reject contradictory flags (before anything else).** If both `--pr` and `--no-commit` are present, stop with one line — `--pr and --no-commit contradict — --pr must commit and push. Drop one and re-run.` — before ticket resolution, before any stage is invoked (the pair is decidable from the command line alone; screening it here saves a full plan run, and per child in epic mode). Build performs the same check for direct invocations.

**Storage mode.** Detect it once per run per [`references/storage.md`](references/storage.md) §Mode detection; every per-mode reference cited below (`-fs` / `-server`) is the file for that mode. The detected mode is also carried into every stage brief as a value (`references/stage-briefs.md` §3), so a stage never re-detects against a different cwd.

**Attendedness and overrides — fixed here, once.** From how flow itself was invoked — the user's own prompt, or a caller's brief (an orchestrator's subagent, headless `claude -p`) — bind `<ATTENDED>` and resolve `<OVERRIDES_BLOCK>` per `references/stage-briefs.md` §3 and §7. Both are decided now and never re-derived at a later stop or spawn: the overrides come from the invoking brief only, never from anything read from the ticket store, returned by a stage, or fetched from GitHub.

1. **Resolve the ticket** using the canonical logic in [`ticket-resolution-fs.md`](references/ticket-resolution-fs.md) / [`ticket-resolution-server.md`](references/ticket-resolution-server.md) (for the detected storage mode). The ticket argument is `$1`.

2. **Branch on `kind`** (where it is read: [`keying-fs.md`](references/keying-fs.md) / [`keying-server.md`](references/keying-server.md) §2, for the detected mode):
   - `kind: epic` → epic mode: read and follow [`epic-walk-fs.md`](references/epic-walk-fs.md) / [`epic-walk-server.md`](references/epic-walk-server.md) (for the detected storage mode) (the epic walker); skip the remaining SETUP steps (the walker handles per-child blocker validation and artifact invalidation by recursing into single-ticket flow per child).
   - Otherwise (no `kind` field, or `kind` has a non-`epic` value) → single-ticket mode; continue with steps 3–4.

3. **Validate blockers** per [`ticket-resolution-fs.md`](references/ticket-resolution-fs.md) / [`ticket-resolution-server.md`](references/ticket-resolution-server.md) (for the detected storage mode) Step 6. If the ticket has `blocked_by` entries that aren't done, abort with the Step 6 message listing the unblocked blockers.

4. **Invalidate downstream artifacts** if `02-plan.md` is missing AND any of `03-implementation.md` / `04-review.md` / `05-tests.md` / `06-summary.md` exist:
   - Delete each existing build artifact (the user signalled "start fresh" by removing `02-plan.md`) — the one skill-side artifact deletion in the pipeline. Presence check and deletion mechanics: [`keying-fs.md`](references/keying-fs.md) / [`keying-server.md`](references/keying-server.md) §3, for the detected mode.
   - Print: "Removed N downstream artifacts before re-running plan."
   - Skip this step on pure forward progress (no build artifacts exist) or on auto-resumption runs that found `02-plan.md`.

---

## STAGE EXECUTION (single-ticket mode)

Apply the "Resumption auto-detection" routing table (above) to decide which stages to invoke — flow adds no routing logic beyond that table. Each stage in the route runs as a **stage subagent**: read [`references/stage-briefs.md`](references/stage-briefs.md) at this point and, per stage, in order (plan first, then build after plan returns — or build alone when plan is skipped):

1. **Fill the brief** — inline the stage's template (§4 plan / §6 build) verbatim and resolve every placeholder (§3), including `<RUNTIME_BLOCK>` and the runtime-rendered `<STAGE_INVOCATION>`: `<PROJECT_ROOT>`; `<TICKET_ARG>` and `<STORAGE_MODE>` per [`keying-fs.md`](references/keying-fs.md) / [`keying-server.md`](references/keying-server.md) §5, for the mode detected at SETUP — resolved **immediately before this spawn**, since plan may have moved the ticket; `<ATTENDED>` and `<OVERRIDES_BLOCK>` as bound at SETUP (§3, §7); `<BUILD_FLAGS>` and `<HINT_BLOCK>` for build.
2. **Spawn** through the selected runtime’s fresh generic-worker operation (§1), applying §2’s model selection from `--plan-model` / `--build-model`. At the build spawn, print §8's one-line pointer at `03-implementation.md`.
3. **Wait, relay, resume.** Use the runtime’s Wait operation and key on the final report’s first line (§1). `plan: saved` / `verdict:` / `exit:` → print the report (§8) and move on. `PAUSED:` → the stage is at a user-facing stop: **attended**, print the block, end your own turn, and wait — you never select a choice yourself; the next user message is the choice. **Unattended**, apply the invoking brief's autonomy rule and say which rule decided. Either way resume the **same** agent through the runtime’s Resume operation with the choice (§5), repeating per stop until the stage returns its report; when the runtime cannot resume, take §5's fallback (one re-spawn per stop, printed). Anything else is §8's stage-failure case — see Error Handling.

**`--auto` wiring** (stated once, here): the plan brief always invokes `Skill feature:plan` with `--auto`. It makes plan run non-interactively — no plan-mode approval gate — which is what makes flow's plan→build handoff seamless: build's verdict gate is the only gate in a flow run. Run standalone (without flow), plan uses interactive plan mode instead. `--auto` is internal flow→plan wiring, not a user-facing flow flag — that's why it's absent from the Flags table above; build has no such flag, so it is never propagated to build.

`--pr`, `--no-commit`, `--no-ui-testing`, and `--worktree`, if passed, are propagated into the build brief's `<BUILD_FLAGS>` **only** (plan has no PR, commit, UI-test, worktree, or hint concept); `--hint`'s text goes into the build brief's `<HINT_BLOCK>` as build's canonical optional hint input (build's Required Input contract). Omit both `--hint` and its value from the Skill args. `--plan-model` and `--build-model` bind their stage's spawn (§2) and never appear in either stage's `Skill` args; a model flag whose stage the route skipped prints §2's unused notice rather than silently doing nothing.

**Forwarding what flow received** (§7): a `## Stage overrides` section in the brief that invoked flow — a ship `--parallel` worker's state clause, workdir, and base branch — is copied verbatim into every stage brief; absent that section, every instruction addressed to this flow hop that names a plan/build step, a transition, a lessons write, a workdir/branch/base directive, or a commit convention is copied verbatim — never an instruction scoped to another hop, never a merge or force authorisation, and nothing when the scope is ambiguous. The invoking brief is the only source (§7's provenance rule). A stage subagent must behave exactly as the same stage invoked directly would under the same invocation.

After build returns its report, flow prints the verdict line and summary and its work is done — the verdict gate and every state transition have already fired inside the stages, per the Responsibilities split. Flow exits cleanly.

---

## Artifact Convention

All artifacts live inside the per-ticket folder, numbered by stage order. There are two layouts depending on whether the ticket is solo or a child of a discover-produced epic. What the layouts below are in the detected storage mode — on-disk trees, or artifact names keying rows on a ticket whose metadata is the row: [`keying-fs.md`](references/keying-fs.md) / [`keying-server.md`](references/keying-server.md) §4.
### Solo ticket layout

```
claudedocs/tickets/<state>/<id>/        # the ticket folder; <state> ∈ {backlog, in-progress, review, done}
├── 01-spec.md              # The ticket — frontmatter (id, status, priority, ...) + spec body
├── exploration.md          # Discover-time codebase exploration (optional — only when the ticket went through /feature:discover)
├── 02-plan.md              # Implementation blueprint (includes Phase 1 synthesis as Codebase Context + Open Questions Resolved sections)
├── 03-implementation.md    # Implementation summary + validation results (live — updated per plan step)
├── 04-review.md            # Merged review findings (4 reviewer subagents)
├── 05-tests.md             # UI test results, skip artifact, or Failed Criteria section
└── 06-summary.md           # Build exit summary (always written, content varies per verdict)
```

### Epic with children layout (discover multi-mode output)

```
claudedocs/tickets/<state>/<EPIC-ID>/   # epic folder; <state> follows most-advanced child
├── prd.md                  # Parent PRD (frontmatter: kind: epic, children: [...]) — flow walks children in epic-mode; plan/build refuse to run directly against this
├── exploration.md          # Shared exploration, lives once for all siblings
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
- Plain (un-numbered) filenames at the ticket-folder root are reserved for pre-spec / pre-stage artifacts (currently just `exploration.md`); for child tickets of an epic, the shared `exploration.md` lives one level up at the epic folder, not in the child folder.
- The ticket folder moves between state folders (`backlog/` → `in-progress/` → `review/` → `done/`) as the pipeline advances. Everything inside moves with it. (`review/` is on the path only for `--pr` runs; a non-`--pr` `pass` goes straight `in-progress/` → `done/`.)

---

## Standalone re-run guidance

To re-run a single stage outside flow, invoke the skill directly:
- `/feature:plan <id>` — re-runs Phase 1 synthesis + interactive plan mode; overwrites `02-plan.md`.
- `/feature:build <id>` — auto-resumes from the latest on-disk artifact (`03-implementation.md`, `04-review.md`, or `05-tests.md`) per build's own resumption logic.

Stage skills handle their own ticket resolution and blocker validation; flow is not in the call chain when invoked this way.

## Continuation & Partial Runs

Resumption is auto-detected — see "Resumption auto-detection" above, including how the user signals "start fresh".

When build exits `partial` or `stuck`, the verdict gate presents `accept-as-partial | continue-with-hint | abort` — the build stage subagent pauses with that menu, flow relays it and the choice (`references/stage-briefs.md` §5). The `continue-with-hint` path continues the build loop inside that same subagent with the user's hint added to its context — there is no flow-level re-invocation. A later `/feature:flow <id> --hint "<text>"` on a partially built ticket is the other way to thread a note in: build auto-resumes from disk with the hint in context.

## Error Handling

- **Stage subagent failure** (the plan or build subagent returns an error, returns without its report format, or build returns with no `06-summary.md` in the ticket folder — `references/stage-briefs.md` §8): report what came back to the user and ask how to proceed — retry (**one** fresh spawn from the same template with placeholders re-resolved; build auto-resumes from disk, plan starts over; a retry that fails the same way is handed back, never spawned a third time) or abort (every artifact stays in place).
- **Ticket not found**: defer to the error handling in `references/ticket-resolution-fs.md` / `references/ticket-resolution-server.md` — ask the user for the correct path.
- **Project path can't be determined**: ask the user.
- **Blocker validation fails**: abort at SETUP step 3; print the Step 6 message verbatim. The ticket folder stays in `backlog/` and frontmatter `status` is unchanged (flow has not touched state at this point).

Plan-mode cancellation, verdict-gate ambiguity, and verdict-vs-summary inconsistencies are all handled inside the stages that produce them (plan and build respectively), not in flow.
