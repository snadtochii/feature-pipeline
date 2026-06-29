# CLAUDE.md — feature plugin

Guidance for Claude (and humans) working **on this plugin itself**. For usage of the pipeline, see [README.md](README.md).

This file captures invariants and conventions. Anything derivable from reading the code (file paths, skill names, stage order) stays in the code.

---

## What this repo is

A Claude Code and Codex plugin that ships an agentic feature-development pipeline: `discover → plan → build`. Each stage is a separate **skill** that can run standalone or be sequenced by the **flow** orchestrator. Build runs implement, review, and test as in-loop checkpoints inside one continuous loop. Stages are backed by specialized **agents** (subagents with focused tool budgets and personas).

The primary audience for edits to this repo is Claude working on the plugin's own skills/agents — not end users. End-user docs live in README.md.

---

## Dev loop

Editing a skill or agent while another Claude Code session is open:

1. Make your edit in `skills/<name>/SKILL.md` or `agents/<name>.md`
2. In the consuming Claude Code session (not this repo — see below), run `/reload-plugins` — the updated skill/agent takes effect without a restart
3. Invoke the skill or trigger the agent to verify the change

**Keep the plugin repo separate from any consuming project** used for testing. Pick a throwaway project (or a real one), create a small ticket via `/feature:discover`, then run `/feature:flow <id>`. Running the pipeline against this plugin repo itself creates confusion about which `claudedocs/tickets/` artifacts belong where.

---

## Repository layout

```
feature-pipeline/
├── .claude-plugin/          # Plugin/marketplace metadata
│   ├── plugin.json
│   └── marketplace.json
├── .codex-plugin/           # Codex plugin metadata
│   └── plugin.json
├── hooks/                   # PostToolUse validation hook
│   ├── hooks.json           # Declares file-edit matcher → validate.sh
│   └── validate.sh          # Reads validate: block from claudedocs/tickets/config.yaml
├── agents/                  # Subagent definitions (one .md per agent)
├── skills/                  # Skill definitions (folder per skill, SKILL.md inside)
│   ├── flow/                # Orchestrator (plan → build with completion gate)
│   ├── discover/            # Step 0 — ticket creation (Socratic dialogue, may emit 1..N tickets)
│   ├── explore/             # Open-ended Socratic exploration; can promote to discover
│   ├── debug/               # Standalone — reactive runtime-evidence debugger (not a pipeline stage)
│   ├── sync/                # Standalone — reconcile in-review tickets with GitHub PR state (not a pipeline stage)
│   ├── review/              # Standalone — repo-scoped PR reviewer with shared comment rules + embedded rubric (not a pipeline stage)
│   ├── ship/                # Standalone — autonomous build→review→merge loop over a ticket or chain (not a pipeline stage)
│   ├── plan/                # Stage 1 (pre-plan synthesis + plan design)
│   └── build/               # Stage 2 — continuous loop with implement/review/test checkpoints
├── README.md                # End-user docs
└── CLAUDE.md                # This file
```

---

## Pipeline flow (conceptual)

```
discover → ticket(s) → flow → plan → build → completion
                                       ↓
                               ┌──────┴──────┐
                               │  build loop │
                               ├─────────────┤
                               │  implement  │
                               │      ↓      │
                               │  review     │ (4 parallel reviewer subagents)
                               │      ↓      │
                               │  test       │ (ui-tester subagent or skip; --no-ui-testing forces the skip)
                               │      ↓      │
                               │  exit       │ verdict: pass | partial | stuck
                               └─────────────┘
```

- **`discover`** is step 0 — interactive Socratic dialogue that creates ticket folders. Emits a single ticket (`claudedocs/tickets/backlog/<id>/01-spec.md` + `exploration.md`) for small/coherent work, or a parent epic + nested child tickets (`claudedocs/tickets/backlog/<EPIC>/prd.md` + `tasks/<CHILD>/01-spec.md` for each) when the scope splits naturally. Not part of flow.
- **`explore`** is a separate skill for open-ended Socratic exploration; can promote a conversation into `discover` once the user knows they want a ticket.
- **`flow`** orchestrates `plan → build` with the completion gate. `plan` runs non-interactively under flow (flow passes the internal `--auto` signal), so build's verdict gate is the only gate; run standalone, `plan` uses interactive plan mode (its own gate). `plan` includes Phase 1 pre-plan synthesis (codebase exploration + open-questions surfacing) before plan design. Flag surface is `--ignore-blockers`, `--pr`, `--no-ui-testing`, and `--visual` (the flow→plan `--auto` signal is internal wiring, not a user-facing flow flag; `--visual` is propagated to plan, `--pr`/`--no-ui-testing` to build); resumption is auto-detected from on-disk artifacts (users delete artifacts to start fresh).
- **`build`** runs implement → review → test as internal checkpoints in one continuous loop. Validation fires after every edit (PostToolUse hook plus skill-body fallback). Reviewer findings and test failures are fixed in-context; the loop self-monitors for stuck patterns and a 25-turn ceiling.

### Runtime source of truth

**Operational details live in `skills/flow/SKILL.md`**, not here. That file is loaded by Claude Code when a consumer runs the pipeline; this `CLAUDE.md` is only loaded when editing the plugin repo itself. If you move operational rules out of the skill and into this file, consumers lose visibility.

Canonical sources in `skills/flow/SKILL.md`:
- **Stage Contract** — reads/writes per stage
- **Artifact Convention** — numbering rules, layout illustrations (solo + nested epic)
- **Resumption auto-detection** — routing table for on-disk artifacts; users delete artifacts to start fresh

Centralized cross-stage rules live in `skills/flow/references/`:

`ticket-resolution.md`:
- **Step 1** — ticket-folder resolution (path or ID, including nested children under `tasks/`)
- **Step 4** — `kind: epic` refusal (epics are non-pipelineable)
- **Step 5** — locating shared `exploration.md` (solo vs child)
- **Step 6** — blocker validation (`blocked_by`)

`state-transitions.md`:
- **Transition 1** — Start-of-pipeline (`backlog`/`review`/`done` → `in-progress`); invoked by `plan` and `build` at start (idempotent; the `review/` source is the re-plan path for a ticket whose PR is open)
- **Transition 2** — End-of-pipeline (`in-progress` → `done`); invoked by `build` at the verdict gate on a `pass` without `--pr`. Includes the Epic-completion predicate (declared-roster reconciliation) for epic children.
- **Transition 3** — Abort (`in-progress` → `backlog`); invoked by `build` on `partial`/`stuck` + user choice `abort`. Includes the inverse all-children check for epic children.
- **Transition 4** — Partial-completion (frontmatter only, no folder move); invoked by `build` on `partial`/`stuck` + `continue-with-hint` (and as a precursor to T2 on `accept-as-partial`).
- **Transition 5** — Open-PR (`in-progress` → `review`, status `in-review`); invoked by `build` at the verdict gate on `pass` + `--pr`. The `--pr` flag and the push/`gh pr create` are part of the `--pr` auto-PR flow; T5 owns the folder move + status.
- **Transition 6** — Merge (`review` → `done`); invoked when `build` is re-run on a `review/` ticket, or when `sync` scans an `in-review` ticket (by status, wherever it sits), and the PR is detected merged (the merge check is part of the `--pr` auto-PR flow). T2's body re-pointed at the ticket's current state folder as source (`review/` for a solo ticket or an at-review epic; `in-progress/` for an epic child that `sync` promotes in place while a sibling is still mid-build).
- **Decision table** — verdict + user choice → which transitions fire. The contract `build` uses at the verdict gate.
- **Status query** — read-only inspection for future epic-walker tooling.

Individual stage skills (`skills/<stage>/SKILL.md`) own their own `Required Input` and `Output` sections, which are the authoritative per-stage contracts. Flow's Stage Contract table is a consolidated summary of those.

### Dev-side rule

When adding a new input to a stage, document it in the stage's `Required Input` section *and* update flow's Stage Contract table. Both live in skill files, not in this `CLAUDE.md`.

---

## Skill authoring conventions

General Claude Code skill-authoring rules — frontmatter fields, trigger-phrase policy, variable substitution, progressive disclosure, body structure, validation errors — are documented in the official Anthropic skills reference (https://code.claude.com/docs/en/skills) and the Agent Skills open standard (https://agentskills.io). Those are the sources of truth. Do not duplicate their content here.

This section captures only what's **specific to this plugin** on top of those general rules.

### `allowed-tools` budgets for this plugin's skills

Typical budget per role, expressed as unordered tool sets. The build *skill* may write to `claudedocs/` to save its merged review artifact and its other in-loop artifacts, but its *reviewer agents* are read-only — they must not mutate the tree they review.

| Skill | Typical budget |
|---|---|
| `flow` (thin sequencer) | Read, Glob, Grep, TodoWrite, Skill |
| `discover` (intake) | Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite |
| `explore` (open-ended dialogue) | Read, Glob, Grep, Bash, TodoWrite, Skill |
| `plan` (pre-plan synthesis + plan design) | Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite, AskUserQuestion (Task for Phase 1 subagents; AskUserQuestion for auto mode's batched no-default open-questions pause) |
| `build` (continuous loop) | Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite (Task for the 4 reviewer subagents at the review checkpoint and the ui-tester subagent at the test checkpoint; Write for `03-implementation.md`/`04-review.md`/`05-tests.md`/`06-summary.md`) |
| `debug` (standalone runtime debugger) | Read, Write, Edit, Glob, Grep, Bash, TodoWrite + additive-optional browser-capture MCP subset (Playwright/Chrome read/observe); no Task — this skill spawns no subagents |
| `sync` (standalone PR reconciler) | Read, Glob, Grep, Bash, Edit, TodoWrite — `Bash` for `gh` PR-state reads + the Transition 6 folder `mv`, `Edit` for the `status` frontmatter flip; no `Task` — spawns no subagents |
| `review` (standalone PR reviewer) | Read, Glob, Grep, Bash, TodoWrite — `Bash` for all `gh` PR reads/posts and label management; no `Task` (inline review for cross-platform/headless parity), no `Write`/`Edit` (never mutates the repo code it reviews), no MCP |
| `ship` (standalone autonomous build→review→merge loop) | Read, Glob, Grep, Bash, TodoWrite, Task — `Task` to spawn the per-ticket implementer subagent, `Bash` for `git`/`gh`/test verification of each merge; orchestrates `feature:flow` + an independent reviewer and never edits ticket code itself |

If you need a tool not in this table, add it explicitly and document why.

### Frontmatter format — YAML list, always

**This plugin's convention:** all `allowed-tools` (skills) and `tools` (agents) use the **YAML list form**, not the inline string form. One tool per line, 2-space indent under the field:

```yaml
# Skills
allowed-tools:
  - Read
  - Write
  - Glob

# Agents
tools:
  - Read
  - Glob
  - Grep
```

**Why:** skill `allowed-tools` is space-separated and agent `tools` is comma-separated in their inline string forms — opposite separators in two fields that do the same thing. Using the wrong separator silently fails (one malformed tool name, no error raised). The YAML list form works unambiguously for both and eliminates the asymmetry at the source. Every skill and agent in this plugin uses it; if you're adding a new one, match the convention.

### Shared references

When a block would otherwise be duplicated across multiple stage skills, extract it. The canonical example is `skills/flow/references/ticket-resolution.md`, referenced from every stage skill that resolves a ticket argument.

---

## Agent authoring conventions

General Claude Code agent-authoring rules — frontmatter fields, `tools:` format, description policy, optional fields (`permissionMode`, `maxTurns`, `skills`, `hooks`), body template options — are documented in the official Anthropic subagents reference (https://code.claude.com/docs/en/sub-agents). That is the source of truth. Do not duplicate its content here.

Agents in this plugin live at `agents/*.md` and are loaded as subagent types namespaced `feature:<agent-name>`. This section captures only what's **specific to this plugin**.

### Tool budgets for this plugin's agents

| Agent role | Tools | Rationale |
|---|---|---|
| Explorer (`code-explorer`) | Read-only set + Serena semantic tools | Describe, don't mutate; Serena adds symbol-level leverage |
| Analyst (`requirements-analyst`) | Read-only set | Describe, don't mutate; purely spec/analysis work — no codebase navigation |
| Reviewer (`code-reviewer`, `security-engineer`, `performance-engineer`) | Read-only set | Reviews must not mutate the tree; work on diffs, not codebase navigation |
| Architect (`code-architect`) | Read-only set + Serena semantic tools | Pattern comparison across sibling code is this agent's core work |
| UI tester (`ui-tester`) | Read tools + `Write`, `Edit`, `Bash` + Playwright/Chrome MCP | Browser testing — the one mutating agent in this table: `Write` codifies passing runs into spec files, `Bash` runs the test framework and `git check-ignore`s a storage-state path before saving it, `Edit` adjusts specs. `browser_set_storage_state`/`browser_storage_state` are additive-optional (version-gated — falls back to `attach_tab` when absent) |

**Read-only set:** `Glob, Grep, LS, Read, NotebookRead, WebFetch, TodoWrite, WebSearch`. (`KillShell` and `BashOutput` are deliberately excluded — they only make sense paired with `Bash`, which read-only agents don't have.)

**Serena semantic tools** (optional enhancement — additive, agents fall back to Grep/Glob/Read when Serena MCP is unavailable): `mcp__serena__find_symbol`, `mcp__serena__find_referencing_symbols`, `mcp__serena__get_symbols_overview`. Added to agents whose core work is symbol-level navigation or cross-file pattern recognition. Not added to reviewers — they work on diffs, not codebase navigation, and the tools would be noise.

### Model: opus for every agent in this plugin

Every agent pins `model: opus` rather than inheriting. Rationale: the pipeline is for personal projects where per-run velocity and reasoning quality matter more than throughput cost. Reviewers, architects, explorers, and analysts all benefit from deeper reasoning on per-ticket work where volume is low. Exception: if a future agent does purely mechanical work where Opus's reasoning is wasted, `sonnet` or `haiku` are acceptable — none currently qualify.

### Body template

Every agent in this plugin uses the body structure: **Triggers / Behavioral Mindset / Focus Areas / Key Actions / Outputs / Boundaries**. Rationale: the explicit `Triggers` body section reinforces delegation accuracy for parallel-review scenarios, and the structured shape makes it easy to compare agents against the tool-budget table above when reviewing changes.

### No implementer agent

Build's implement checkpoint runs in main context (see "Main-context vs subagent" below); implementation tool access is governed by the `build` skill's `allowed-tools`, not by an agent tool budget. There is intentionally no `implementer.md` in `agents/`.

---

## Main-context vs subagent — which runs where

Not every stage runs as a subagent. The rule:

| Runs in main context | Runs as subagent |
|---|---|
| `flow` (orchestrator) | `code-explorer`, `requirements-analyst` (spawned by `plan` Phase 1) |
| `discover` (interactive dialogue) | `code-reviewer`, `security-engineer`, `performance-engineer`, `code-architect` (spawned by `build`'s review checkpoint) |
| `explore` (open-ended dialogue) | `ui-tester` (spawned by `build`'s test checkpoint) |
| `plan` (needs main-context interactivity — interactive plan mode standalone, or auto mode's batched no-default / complexity-overflow pauses; spawns subagents in Phase 1) | |
| `build` (long interactive loop with implement/review/test checkpoints) | |
| `debug` (interactive runtime-debugging loop; spawns no subagents) | |
| `sync` (standalone PR reconciler; reads PR state via `gh`, performs Transition 6; spawns no subagents) | |
| `review` (standalone repo-scoped PR reviewer; reads/posts PR state via `gh`; spawns no subagents) | |
| `ship` (standalone autonomous build→review→merge orchestrator; spawns the per-ticket implementer subagent, never runs as one) | |

**Rule:** run in main context only when you need *interactivity* or *plan mode*. Otherwise prefer a subagent — it keeps the main context clean.

The `build` skill folds the implementer mindset (focus areas, boundaries) directly into the SKILL.md body rather than delegating to a subagent — this is intentional, since the implement checkpoint needs main-context interactivity for iterative coding + validation. See `skills/build/SKILL.md` for the canonical implementer mindset.

---

## Ticket resolution (shared across skills)

Every stage skill resolves a ticket argument identically. Canonical logic lives in **`skills/flow/references/ticket-resolution.md`** and is referenced from `flow`, `plan`, and `build`. `discover` handles the intake/creation variant inline (prefix logic and ID allocation live there).

**Do not duplicate the resolution logic inline** in a stage skill — link to the reference. If the resolution rules change, update the reference once.

Quick summary (full version in the reference):
- Path-like argument → read directly (folder path or `01-spec.md` path inside the folder).
- ID argument → search `backlog/`, `in-progress/`, `review/`, `done/`, then glob across `claudedocs/tickets/**/<id>/` to catch nested children under `tasks/`.
- Not found → ask the user.
- Resolves to a ticket folder. Two shapes:
  - Solo ticket: `claudedocs/tickets/<state>/<id>/` containing `01-spec.md` and stage artifacts.
  - Child of an epic: `claudedocs/tickets/<state>/<EPIC>/tasks/<CHILD>/` containing `01-spec.md` and stage artifacts; the parent epic folder (`<state>/<EPIC>/`) holds `prd.md` and the shared `exploration.md`.
- `plan` and `build` refuse to run against an epic (`kind: epic` in `prd.md` frontmatter) — see Step 4 in the reference.

---

## Ticket format

Tickets are markdown with YAML frontmatter — see `skills/discover/templates/task.md` (task spec, used for solo and child tickets) and `skills/discover/templates/prd.md` (epic PRD, used when discover emits multiple siblings) for the canonical schemas.

- **Prefix** per project (e.g. `FP`, `MYAPP`, `WEB`). Stored as the `prefix` field in `claudedocs/tickets/config.yaml`. Discover creates the file on first run and infers from existing tickets if it's missing. `config.yaml` is the canonical home for tickets-system configuration — future fields (status flow customization, complexity scale, etc.) go here, not in new dotfiles.
- **Validation hook config** lives in the same `claudedocs/tickets/config.yaml` under an optional `validate:` block:
  - `validate.lint` — string, shell command run after each Write/Edit/MultiEdit (e.g. `"bun run lint"`).
  - `validate.typecheck` — string, shell command run after each Write/Edit/MultiEdit (e.g. `"bun run typecheck"`).
  - `validate.cwd_markers` — optional list, overrides the default project-root markers (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `mix.exs`, `tsconfig.json`). The hook walks up from the edited file looking for any of these to pick the cwd for the lint/typecheck commands.
  - Missing block, missing keys, or malformed YAML → hook is a silent no-op. `jq` is required for the hook to function; without `jq` the hook logs one line to stderr and exits 0 (the build skill's body-level fallback still runs). `yq` is recommended for richer YAML support but not required.
- **App-test config** lives in the same `claudedocs/tickets/config.yaml` under an optional `test:` block — a project-level contract for build's test checkpoint. Unlike `validate:`, it is **model-read** by the build skill (and the injected `ui-tester` spawn prompt), never by `hooks/validate.sh`:
  - `test.url` — string, the app URL the test-checkpoint pre-flight `curl`s for reachability before spawning the browser subagent.
  - `test.start` — string, shell command run (backgrounded, bounded poll) only when `test.url` is unreachable; the pre-flight owns its teardown.
  - `test.auth.storage_state` — string, path to a Playwright saved-session file (inside the project root; gitignored). The `ui-tester` loads it via the Playwright MCP `browser_set_storage_state` tool where exposed, else falls back to `attach_tab`. **The path is referenced, never the secret** — point it at a gitignored session file; credentials are never written into the committed `config.yaml`.
  - `test.auth.attach_tab` — bool, fall back to attaching to an already-authenticated running tab.
  - Every key is optional; with no `test:` block the test checkpoint behaves exactly as before (URL discovery and auth fallback happen inside `ui-tester`). The build skill injects the resolved URL + recipe into the `ui-tester` spawn prompt — see `skills/build/references/test-preflight.md`.
- **ID format:** `<PREFIX>-<N>` — no leading zeros.
- **Folder name:** just the ID, no slug — `claudedocs/tickets/<state>/<PREFIX>-<N>/` (or for nested children, `<state>/<EPIC>/tasks/<CHILD>/`).
- **Status flow:** `backlog → in-progress → done` (folders match), with an optional `review/` hop (`in-progress → review → done`) on `--pr` runs where a PR is opened for review before merge. Cancellation is expressed via frontmatter `status: cancelled` inside `done/`, not a separate folder; the open-PR state is expressed via `status: in-review` inside `review/`.
- Solo ticket folders move between state folders as the pipeline advances — the entire folder (spec, artifacts) moves as a unit.
- For epics: the **whole subtree** moves between state folders together under the precedence `in-progress` ⊐ `review` ⊐ `done` (any-child-in-progress → in-progress; else any-child-in-review → review; else every declared child materialized-and-terminal → done). `prd.md`'s `status` field tracks the folder location; per-child `status` lives in each child's `01-spec.md`. See `skills/flow/references/state-transitions.md` for the full transition logic and the Epic-completion predicate.
- **Multi-sibling linkage frontmatter** (set on children when discover emits an epic):
  - `parent: <EPIC-ID>` — the epic this child belongs to.
  - `epic: <slug>` — human-readable shared identifier across siblings (e.g. `dark-mode-rollout`).
  - `siblings: [<child-id>, ...]` — informational cross-references.
  - `blocked_by: [<child-id>, ...]` — sequencing dependencies. Enforced by `plan`/`build`: build refuses if blockers aren't done; plan auto-loads blocker context. Bypass with `--ignore-blockers`. See ticket-resolution Step 6.
- **Epic frontmatter** (on `prd.md`):
  - `kind: epic` — marks as non-pipelineable.
  - `children: [<child-id>, ...]` — populated by discover.
  - `epic: <slug>` — same slug as children.

### Cross-ticket lessons log

`claudedocs/tickets/_lessons.md` is a project-local log of gotchas captured at the build verdict gate. One header line per ticket: `## <ticket-id> (<verdict>): <one-sentence lesson>` (a line may carry multiple IDs once entries are merged). Build appends a lesson after writing `06-summary.md`, then reconciles the file — deduping, flagging internal contradictions, and flagging stale path references — behind a user-approval gate (see `skills/build/references/lessons-curation.md`). The standalone `debug` skill is a second producer: on a root cause that's a project-specific would-recur gotcha, it appends a line in the same `^## `-matching format — `## <ticket-id> (debug): …` with a ticket in scope, or `## debug/<slug> (<exit>): …` standalone — without running curation (build's next verdict-gate reconcile absorbs any duplicate or stale entry). Plan reads the file in Phase 1 and threads it into the requirements-analyst's open-questions surface.

The file is project-local context — generic best practices don't belong here, only constraints/gotchas that bit a prior ticket and would bite the next one if not surfaced. The leading underscore in the filename keeps it sorted above ticket-state folders (`backlog/`, `in-progress/`, `review/`, `done/`) when listing `claudedocs/tickets/`.

---

## Adding a new stage

Build owns artifact slots `03-implementation.md` through `06-summary.md`. Slot `07-debug.md` is reserved by the standalone `debug` skill (its optional ticket-context report on non-`fixed` exits); `debug` is **not** a flow stage, so it does not follow the checklist below. The next free slot for a new *stage* is `08-*.md`. (`02-plan.html` is not a stage slot — it's plan's optional `--visual` derived view of `02-plan.md`, a `.html` sibling that no stage reads back.)

1. Create `skills/<stage>/SKILL.md` following the skill body template above.
2. Reserve the next free artifact number (`08-*.md` — `07-debug.md` is taken by the standalone `debug` skill) — update the "Artifact Convention" section in `skills/flow/SKILL.md`.
3. Add the stage to flow's pipeline order and stage list.
4. Add auto-resumption rules: when this stage is re-invoked on an existing ticket, which on-disk artifact signals "resume from here" vs "start fresh." Document the routing table in the stage skill body and in flow's Resumption auto-detection section.
5. Document the stage's input/output contract in the stage's `Required Input`/`Output` sections *and* in flow's Stage Contract table.
6. Update `skills/flow/SKILL.md`'s Artifact invalidation downstream table for the new stage.
7. If the stage performs state transitions (folder moves, frontmatter `status` updates), add the relevant transition(s) to `skills/flow/references/state-transitions.md` and invoke them inline from the stage skill body. Do not write state-machine logic inline.
8. If the stage spawns subagents, create them in `agents/` and wire them up.
9. If the stage operates on a ticket (most do), reference `flow/references/ticket-resolution.md` for resolution + epic refusal + blocker validation, and add the stage to the consumer list in that reference.

## Adding a new agent

1. Create `agents/<name>.md` using the canonical body template (Template B).
2. Set `tools` explicitly based on the tool budget table.
3. Set `model` — default to `opus`.
4. Reference the agent from a skill (otherwise it's dead weight — unused agents shouldn't ship).

---

## Validation expectations

Before committing changes to skills or agents:

1. **Lint the frontmatter** — no angle brackets, no markdown in descriptions, valid YAML, every tool listed in `allowed-tools`/`tools` actually exists.
2. **Check tool budget** against the table above — reviewers must not have write access.
3. **Check invocation control** — skills that are only ever user-invoked (`debug`, `explore`, `sync`, `review`, `ship`) set `disable-model-invocation: true` (user-only; description not loaded into context). Skills invoked programmatically by another skill via the Skill tool (`flow`, `plan`, `build`, `discover`) stay model-invocable but carry a terse one-line description with no auto-trigger phrases.
4. **Walk the stage contract in `skills/flow/SKILL.md`** — if you changed inputs/outputs, update the Stage Contract table *and* every consuming stage's `Required Input` section.
5. **Sweep for cross-skill drift** — when a filename, skill name, or schema changes, grep across `skills/` and `agents/` for stale references and update them. The "Editing discipline" section below applies.
6. **Build skill tool-budget audit** — grep `skills/build/SKILL.md` for any tool reference outside its `allowed-tools` (Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite). Should return no matches.
7. **Reviewer-agent read-only audit** — confirm `agents/code-reviewer.md`, `agents/security-engineer.md`, `agents/performance-engineer.md`, and `agents/code-architect.md` list no `Bash` or `Edit` in their `tools:`. Reviewers must not mutate the tree they review.
8. **Failed-criteria placement** — failed test criteria live inside `05-tests.md` under a `## Failed Criteria` section. Verify build-skill output stays consistent with this placement.

There's no automated test suite for the plugin itself. Validation is by manual pipeline runs on real tickets.

---

## Commit discipline

- No marketing language in commit messages ("magnificent", "blazingly fast", etc.).
- Reference the issue/feature the commit addresses.
- Keep commits small — one concern per commit.
- **Bump the plugin version every PR.** Update `version` in BOTH `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` (semver: patch for fixes/refinements, minor for new skills/features) in the same PR as the change — the two manifests must stay in lockstep. The discover → plan → build pipeline does not auto-include this, so when running the pipeline on this repo, add the version bump as an explicit plan/build step.

## Editing discipline

When removing a stage, skill, artifact, file, feature, flag, or any other element from a system, the resulting docs and code describe **only what IS now** — never leave behind retrospective mentions of what used to exist.

- No "former X", "formerly Y", "previously was Z", "used to be", "this replaces", "now-removed", "deprecated", "legacy" in the surviving artifacts.
- No notes like "the 02- slot is intentionally empty (was the analyze artifact)" — numbering gaps and missing fields don't need apologetic explanations; readers infer from absence.
- After deleting something, sweep the rest of the repo for references to its name, filename, or concept and remove them or rephrase to describe the current state. The new docs/skills should look like the removed thing was never there.
- Migration history belongs in commit messages and PR descriptions — not in source files, skills, or docs that downstream agents and humans will read on every load.

This applies to skill files, code comments, README sections, frontmatter comments, layout illustrations, naming-rule documentation, and any other artifact that describes the current shape of the system.

---

## Considered and deferred

Decisions evaluated and explicitly *not* adopted, kept here so future maintenance has context on why the code looks the way it does. Each entry references a real, current piece of the codebase — not removed features.

- **Design-match reviewer as 5th parallel reviewer** in build's review checkpoint. Deferred because it assumes design artifacts (Figma, wireframes) that not every personal-project ticket has. Reconsider when a ticket workflow routinely includes design references.
- **Step-type routing** in `plan`/`build` (`figma-ui`, `component`, `service`, etc.) — too project-specific to generalize. The `plan` skill annotates step content explicitly instead of routing by step type.
- **PR auto-review and reviewer-feedback loops *inside the pipeline stages*** (plan/build/flow auto-reviewing GitHub PRs and folding reviewer comments back through the pipeline). The pipeline stages stay review-free and ticket-folder-driven — PR *creation* is the only GitHub coupling they have: the opt-in `--pr` flag opens a PR on a passing build and lands the ticket in `review/`, degrading to a local commit when `gh`/GitHub is absent (see `skills/build/references/pr-creation.md`). The autonomous-review capability itself lives in the **standalone `ship` skill** (`skills/ship/`): on top of `--pr`, `ship` orchestrates an independent reviewer that posts to the PR plus an autonomous address-and-merge loop over a ticket or dependency chain. Keeping it out of the stages preserves the pipeline as general-purpose; `ship` is the opt-in layer for the full autonomous loop.
- **Clean-abort routine for `flow`** (`flow --abort`). Small standalone change; the existing verdict gate's `abort` choice covers the common case (revert folder + reset frontmatter). A dedicated flag would standardize multi-step abort behavior across deeper future flow surfaces.
- **Validator auto-detection in `hooks/validate.sh`** (project-type detection, e.g., infer "run pyright" from a `pyproject.toml`). Currently the user explicitly declares `validate.lint` and `validate.typecheck`. Auto-detection is too magic for a plugin that should respect existing project conventions; revisit if explicit-config maintenance becomes a real friction.
