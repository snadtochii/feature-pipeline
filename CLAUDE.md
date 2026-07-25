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

1. Make your edit in `plugins/feature/skills/<name>/SKILL.md` or `plugins/feature/agents/<name>.md`
2. In the consuming Claude Code session (not this repo — see below), run `/reload-plugins` — the updated skill/agent takes effect without a restart
3. Invoke the skill or trigger the agent to verify the change

**Keep the plugin repo separate from any consuming project** used for testing. Pick a throwaway project (or a real one), create a small ticket via `/feature:discover`, then run `/feature:flow <id>`. Running the pipeline against this plugin repo itself creates confusion about which `claudedocs/tickets/` artifacts belong where.

---

## Repository layout

The repo is a **multi-plugin marketplace**: the two marketplace files stay at the repo root and index the plugins under `plugins/`. A plugin that ships runtime components carries both manifests; `server-native` is Claude-only by design — it exists to declare an MCP server through install-time prompts, which Codex has no equivalent for, so it appears in the Claude marketplace alone and Codex users bind the same server through `config.toml`.

Path convention: in prose references throughout this file, an unqualified `skills/`, `agents/`, `hooks/`, or `docs/` path names the item inside the `feature` plugin (i.e. `plugins/feature/…`). Operational commands and audit steps use the full repo-root-relative `plugins/feature/…` path so they run as written from the repo root.

```
feature-pipeline/
├── .claude-plugin/
│   └── marketplace.json     # Claude marketplace — indexes plugins/* (stays at repo root)
├── .agents/
│   └── plugins/
│       └── marketplace.json # Codex marketplace — indexes plugins/* (stays at repo root)
├── scripts/
│   └── install-codex-local.sh  # Local Codex install helper (stages plugins/feature/)
├── plugins/
│   ├── feature/             # The feature-development pipeline plugin
│   │   ├── .claude-plugin/
│   │   │   └── plugin.json
│   │   ├── .codex-plugin/
│   │   │   └── plugin.json
│   │   ├── hooks/           # PostToolUse validation hook
│   │   │   ├── hooks.json   # Declares file-edit matcher → validate.sh
│   │   │   └── validate.sh  # Reads validate: block from claudedocs/tickets/config.yaml
│   │   ├── agents/          # Subagent definitions (one .md per agent)
│   │   ├── docs/            # Advanced usage & configuration reference (bundled with the plugin)
│   │   └── skills/          # Skill definitions (folder per skill, SKILL.md inside)
│   │       ├── flow/                # Orchestrator (plan → build with completion gate)
│   │       ├── discover/            # Step 0 — ticket creation (Socratic dialogue, may emit 1..N tickets)
│   │       ├── debug/               # Standalone — reactive runtime-evidence debugger (not a pipeline stage)
│   │       ├── sync/                # Standalone — reconcile every ticket in backlog/in-progress/review with GitHub PR state (not a pipeline stage)
│   │       ├── review/              # Standalone — repo-scoped PR reviewer with shared comment rules + embedded rubric (not a pipeline stage)
│   │       ├── address-review/      # Standalone — validate + address a PR's review comments, post signed replies (not a pipeline stage)
│   │       ├── ship/                # Standalone — autonomous build→review loop over a ticket or chain, ending at an open PR (not a pipeline stage)
│   │       ├── lessons-consolidate/ # Standalone — sweep _lessons.md to the atomic format via a human-approved diff (not a pipeline stage)
│   │       ├── guide/               # Standalone — index of the standalone skills and when to reach for each (not a pipeline stage)
│   │       ├── plan/                # Stage 1 (pre-plan synthesis + plan design)
│   │       └── build/               # Stage 2 — continuous loop with implement/review/test checkpoints
│   ├── server-native/       # MCP connector plugin — manifest only, no runtime components;
│   │   └── .claude-plugin/  # declares the personal server via install-time userConfig prompts.
│   │                        # Claude-only: Codex has no install-time prompting (config.toml instead).
│   └── stack-first/         # Stack-agnostic dependency-guard plugin (independent versions)
│       ├── .claude-plugin/
│       │   └── plugin.json
│       ├── .codex-plugin/
│       │   └── plugin.json
│       ├── hooks/           # Non-blocking PreToolUse install-command guard
│       │   ├── hooks.json
│       │   └── stack-first-guard.sh
│       └── skills/
│           └── stack-first/ # Five-step tech-selection procedure + docs/STACK.md contract
├── README.md                # End-user docs
├── AGENTS.md                # Codex twin of this file
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

- **`discover`** is step 0 — interactive Socratic dialogue that creates ticket folders. Emits a single ticket (`claudedocs/tickets/backlog/<id>/01-spec.md` + `exploration.md`) for small/coherent work, or a parent epic + nested child tickets (`claudedocs/tickets/backlog/<EPIC>/prd.md` + `tasks/<CHILD>/01-spec.md` for each) when the scope splits naturally. For vague/outcome-uncommitted input it starts in exploration mode (one-question-at-a-time Socratic dialogue with recommended defaults) and may end without creating a ticket when the user chooses to leave; the `--explore` flag forces that mode regardless of input shape. Not part of flow.
- **`flow`** orchestrates `plan → build` with the completion gate. `plan` runs non-interactively under flow (flow passes the internal `--auto` signal), so build's verdict gate is the only gate; run standalone, `plan` uses interactive plan mode (its own gate). `plan` includes Phase 1 pre-plan synthesis (codebase exploration + open-questions surfacing) before plan design. Flag surface is `--pr` and `--no-ui-testing` (the flow→plan `--auto` signal is internal wiring, not a user-facing flow flag; both are propagated to build); resumption is auto-detected from on-disk artifacts (users delete artifacts to start fresh).
- **`build`** runs implement → review → test as internal checkpoints in one continuous loop. Validation fires after every edit (PostToolUse hook plus skill-body fallback). Reviewer findings and test failures are fixed in-context; the loop self-monitors for stuck patterns and a 25-turn ceiling.

### Runtime source of truth

**Operational details live in `skills/flow/SKILL.md`**, not here. That file is loaded by Claude Code when a consumer runs the pipeline; this `CLAUDE.md` is only loaded when editing the plugin repo itself. If you move operational rules out of the skill and into this file, consumers lose visibility.

Canonical sources in `skills/flow/SKILL.md`:
- **Stage Contract** — reads/writes per stage
- **Artifact Convention** — numbering rules, layout illustrations (solo + nested epic)
- **Resumption auto-detection** — routing table for on-disk artifacts; users delete artifacts to start fresh

Centralized cross-stage rules live in `skills/flow/references/` (the folder also holds flow-private references like `epic-walk.md`; only the cross-stage ones are listed here):

`storage.md`:
- The storage adapter seam — the fs-native ↔ server-native switch every storage-touching reference dispatches through. Owns: **mode detection** (`config.yaml` `mode` + `project` keys; missing file/key or `mode: fs-native` → fs-native, with no storage call of any kind; `mode: server-native` + `project` → server-native), the **loud-failure doctrine** (a failed server-native op stops the skill, naming server and operation — never an fs fallback), the **fs↔server status mapping** (server status writable only via the CAS transition tool), the **CAS conflict doctrine** (re-read → re-evaluate → proceed-or-stop, never force), and the **operation vocabulary** (resolve, read metadata, read/write/list artifacts, transition status, update fields, list tickets/children, create, lessons) with an fs and a server-native procedure per operation. `ticket-resolution.md`, `state-transitions.md`, and `lessons-log.md` route through it.

`ticket-resolution.md`:
- Every step dispatches on the storage mode per `storage.md` — fs folder procedures, or server-native row + artifact operations
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
- **Transition 6** — Merge (current state folder → `done`); invoked when `build` is re-run on a `review/` ticket, or when `sync` scans a ticket in `backlog/`, `in-progress/`, or `review/` (fs-native: folder-keyed, not by status; server-native: any non-terminal row status) and its PR is detected merged (the merge check is part of the `--pr` auto-PR flow). T2's body re-pointed at the ticket's current state folder as source: for `build` a solo source is always `review/` (or an at-review epic); for `sync` a solo source is whichever of `backlog/`/`in-progress/`/`review/` the scan found it in (a crash, re-plan, or manual merge can park a merged PR outside `review/`); an epic child flips in place while a sibling is still mid-build.
- **Decision table** — verdict + user choice → which transitions fire. The contract `build` uses at the verdict gate.
- **Status query** — read-only inspection for future epic-walker tooling.
- Every transition also carries its **Server-native** CAS form (`from[]`/`to` via the transition tool), dispatched per `storage.md`; the fs mechanics above are the fs-native form.

`lessons-log.md`:
- The cross-ticket lessons-log contract — atomic entry format, write-time supersession check, prefer-newest on conflict, promotion on recurrence, format overflow, grep-scoped consumption. Producers (`build`, `debug`) and consumers (`plan`, `ship`), plus the standalone `lessons-consolidate` normalizer, all point here; summary in the Cross-ticket lessons log section below. Dual-mode: fs appends to `_lessons.md`; server-native maps the same rules onto the lesson tools (per-section Server-native notes).

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
| `flow` (thin sequencer) | Read, Glob, Grep, TodoWrite, Skill + pipeline MCP tools (`pipeline_get_ticket`, `pipeline_list_tickets` for the epic walk's derived roster, `pipeline_get_artifact`, `pipeline_list_artifacts` for resumption keying, `pipeline_delete_artifact` for SETUP's downstream-artifact invalidation — the one skill-side artifact deletion) — used only in server-native storage mode; named by bare `pipeline_*` name and dual-listed in `allowed-tools` under both bindings — `mcp__plugin_server-native_ps__*` (the separate `server-native` connector plugin declares the server on Claude Code) and the bare form standing for Codex's `mcp__<server>__*` from the user's MCP config. flow keeps no Write/Edit/Bash — MCP reads + the invalidation delete fit its thin-sequencer budget |
| `discover` (intake) | Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite + pipeline MCP tools (`pipeline_create_ticket`, `pipeline_update_ticket`, `pipeline_write_artifact`, `pipeline_get_ticket`, `pipeline_list_tickets`, `pipeline_list_artifacts` for partial-failure reconciliation of artifact rows) — used only in server-native storage mode for ticket creation; named by bare `pipeline_*` name and dual-listed in `allowed-tools` under both bindings — `mcp__plugin_server-native_ps__*` (the separate `server-native` connector plugin declares the server on Claude Code) and the bare form standing for Codex's `mcp__<server>__*` from the user's MCP config |
| `plan` (pre-plan synthesis + plan design) | Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite, AskUserQuestion (Task for Phase 1 subagents; AskUserQuestion for auto mode's batched no-default open-questions pause) + pipeline MCP tools (`pipeline_get_ticket`, `pipeline_get_artifact`, `pipeline_list_artifacts`, `pipeline_write_artifact`, `pipeline_transition_ticket`, `pipeline_list_lessons`) — used only in server-native storage mode; named by bare `pipeline_*` name and dual-listed in `allowed-tools` under both bindings — `mcp__plugin_server-native_ps__*` (the separate `server-native` connector plugin declares the server on Claude Code) and the bare form standing for Codex's `mcp__<server>__*` from the user's MCP config |
| `build` (continuous loop) | Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite (Task for the 4 reviewer subagents at the review checkpoint and the ui-tester subagent at the test checkpoint; Write for `03-implementation.md`/`04-review.md`/`05-tests.md`/`06-summary.md`) + pipeline MCP tools (`pipeline_get_ticket`, `pipeline_get_artifact`, `pipeline_list_artifacts`, `pipeline_write_artifact`, `pipeline_transition_ticket`, `pipeline_update_ticket`, `pipeline_list_tickets` for the verdict gate's epic-child sibling scans, and the lesson tools `pipeline_add_lesson`/`pipeline_list_lessons`/`pipeline_update_lesson`/`pipeline_delete_lesson`) — used only in server-native storage mode; named by bare `pipeline_*` name and dual-listed in `allowed-tools` under both bindings — `mcp__plugin_server-native_ps__*` (the separate `server-native` connector plugin declares the server on Claude Code) and the bare form standing for Codex's `mcp__<server>__*` from the user's MCP config |
| `debug` (standalone runtime debugger) | Read, Write, Edit, Glob, Grep, Bash, TodoWrite + additive-optional browser-capture MCP subset (Playwright/Chrome read/observe) + pipeline MCP tools (`pipeline_get_ticket`, `pipeline_write_artifact`, `pipeline_add_lesson`) — used only in server-native storage mode for ticket resolution, the ticket-scoped debug report, and lesson capture; named by bare `pipeline_*` name and dual-listed in `allowed-tools` under both bindings — `mcp__plugin_server-native_ps__*` (the separate `server-native` connector plugin declares the server on Claude Code) and the bare form standing for Codex's `mcp__<server>__*` from the user's MCP config; no Task — this skill spawns no subagents |
| `sync` (standalone PR reconciler) | Read, Glob, Grep, Bash, Edit, TodoWrite — `Bash` for `gh` PR-state reads plus, fs-native, the Transition 6 folder `mv`; `Edit` for the fs-native `status` frontmatter flip + pipeline MCP tools (`pipeline_list_tickets` for the status-derived scan set, `pipeline_get_ticket` for single-ticket resolution and CAS re-reads, `pipeline_transition_ticket` for Transition 6, `pipeline_update_ticket` for the `pr_url` back-fill) — used only in server-native storage mode; named by bare `pipeline_*` name and dual-listed in `allowed-tools` under both bindings — `mcp__plugin_server-native_ps__*` (the separate `server-native` connector plugin declares the server on Claude Code) and the bare form standing for Codex's `mcp__<server>__*` from the user's MCP config; no `Task` — spawns no subagents |
| `review` (standalone PR reviewer) | Read, Glob, Grep, Bash, TodoWrite — `Bash` for all `gh` PR reads/posts and label management; no `Task` (inline review for cross-platform/headless parity), no `Write`/`Edit` (never mutates the repo code it reviews), no MCP |
| `address-review` (standalone PR feedback addresser) | Read, Write, Edit, Glob, Grep, Bash, TodoWrite — the mutating sibling of `review`: `Bash` for `gh` review-comment reads + signed reply posts, `Write`/`Edit` to apply accepted fixes (triggers the validation hook), `TodoWrite` to track threads; no `Task` (inline for cross-platform/headless parity), no MCP |
| `ship` (standalone autonomous build→review→merge loop) | Read, Glob, Grep, Bash, TodoWrite, Task — `Task` to spawn the per-ticket implementer subagent (one per ready ticket, each in an isolated git worktree, under `--parallel`), `Bash` for `git`/`gh`/test verification of each merge plus worktree provisioning/removal; orchestrates `feature:flow` + an independent reviewer and never edits ticket code itself + pipeline MCP tools (`pipeline_get_ticket`/`pipeline_list_tickets` for run-shape classification + the derived epic roster, `pipeline_update_ticket` for `pr_url` linkage — the integration PR on the epic row, plus per-ticket backfill, `pipeline_get_artifact`/`pipeline_list_artifacts` for reviewer ground truth (spec body inlined into the independent reviewer's brief) and recovery's artifact-trail inspection, `pipeline_list_lessons` for the pre-run gotcha scan + reviewer lesson injection; `pipeline_transition_ticket`/`pipeline_add_lesson`/`pipeline_update_lesson` only at `--parallel`'s orchestrator serialization points, where the orchestrator owns the transitions and lessons writes workers skip) — used only in server-native storage mode; named by bare `pipeline_*` name and dual-listed in `allowed-tools` under both bindings — `mcp__plugin_server-native_ps__*` (the separate `server-native` connector plugin declares the server on Claude Code) and the bare form standing for Codex's `mcp__<server>__*` from the user's MCP config |
| `lessons-consolidate` (standalone `_lessons.md` sweep) | Read, Grep, Glob, Edit, Write, Bash, TodoWrite — `Read`/`Grep`/`Glob` to parse and cluster entries, `Bash` for the size-cap measure (`grep -c '^## '`, `wc`) and the git-anchor checks (`git check-ignore`/`ls-files`), `Write`/`Edit` to rewrite the file only after diff approval; no `Task` — spawns no subagents, no MCP |
| `guide` (standalone skill index) | Read — the body is static guidance; no `Task`, no `Write`/`Edit`, no `Bash`, no MCP — spawns no subagents, mutates nothing |

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

### Don't uncomment frontmatter blocks — write conditional fields explicitly

A conditionally-present frontmatter field (e.g. `templates/task.md`'s epic-child linkage fields, present only for children) must **not** ship as a commented-out block that a fill step later uncomments. Uncommenting a block rewrites the region around it and can consume the always-present field directly adjacent — this is how epic children silently lost `title`. Instead, keep the template to the fields every ticket carries, and have the fill step (discover's child-write) **append** the conditional fields as real frontmatter when they apply. No commented block means no uncomment operation, so no required field can be absorbed — for `title`, `tags`, or any future field.

### Flag naming

One axis, one flag name, shared across skills; defaults may differ per skill; negative names (`--no-x`) only where the default is on.

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

`code-explorer` additionally sets `effort: high` — exploration is many-tool-call work where extra per-step deliberation (what to search next, which lead to follow) pays off, and its output is cached as `exploration.md` and trusted downstream by `plan`, so gathering quality caps ticket quality.

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
| `plan` (needs main-context interactivity — interactive plan mode standalone, or auto mode's batched no-default / complexity-overflow pauses; spawns subagents in Phase 1) | `ui-tester` (spawned by `build`'s test checkpoint) |
| `build` (long interactive loop with implement/review/test checkpoints) | |
| `debug` (interactive runtime-debugging loop; spawns no subagents) | |
| `sync` (standalone PR reconciler; reads PR state via `gh`, performs Transition 6; spawns no subagents) | |
| `review` (standalone repo-scoped PR reviewer; reads/posts PR state via `gh`; spawns no subagents) | |
| `address-review` (standalone PR feedback addresser; reads/posts PR state via `gh`, edits code to apply accepted fixes; spawns no subagents) | |
| `ship` (standalone autonomous build→review→merge orchestrator; spawns the per-ticket implementer subagent, never runs as one) | |
| `lessons-consolidate` (standalone `_lessons.md` sweep; proposes a diff, rewrites on approval; spawns no subagents) | |
| `guide` (standalone skill index; static guidance only; spawns no subagents) | |

**Rule:** run in main context only when you need *interactivity* or *plan mode*. Otherwise prefer a subagent — it keeps the main context clean.

The `build` skill folds the implementer mindset directly into the SKILL.md body rather than delegating to a subagent — this is intentional, since the implement checkpoint needs main-context interactivity for iterative coding + validation. See `skills/build/SKILL.md` for the canonical implementer mindset.

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
- **Storage mode** lives in the same `claudedocs/tickets/config.yaml` as optional top-level `mode` and `project` keys — the fs-native ↔ server-native switch, model-read at skill start per `skills/flow/references/storage.md`:
  - `mode: fs-native`, a missing key, or a missing file — tickets are the folder tree described in this section, fully offline (zero network, detection included). The personal server ships as the separate `server-native` connector plugin, which an fs-native machine simply does not install — so nothing is declared and nothing connects (see `plugins/feature/docs/advanced.md`).
  - `mode: server-native` with `project: <server-project-id>` — tickets are rows on the personal server (reached through the `pipeline_*` tools); the state folders don't exist and artifact bodies are frontmatter-free (the row is the sole metadata source). Pipeline tools unavailable or a call failing → the skill stops loudly, never falls back to fs writes.
  - `config.yaml` itself and `hooks/validate.sh` stay fs-local in both modes — the file is project execution config plus the mode marker, not ticket data. `prefix` remains meaningful only for fs allocation (server IDs come from the registry-configured prefix).
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
- **Worktree config** lives in the same `claudedocs/tickets/config.yaml` under an optional `worktree:` block — the contract that makes a fresh `git worktree` buildable. Like `test:`, it is **model-read** only, never read by `hooks/validate.sh` (the hook's parsers extract only the `validate:` block):
  - `worktree.setup` — string, shell command run once inside a fresh worktree, after the `.worktreeinclude`-matched files are copied (copy-then-setup: the copy is generic mechanics owned by the worktree creator; `setup` owns project-specific steps like dependency install or codegen). Trust/execution discipline is identical to `test.start` (`skills/build/references/test-preflight.md`): the user's own declared command — same trust tier as `validate.lint` — written verbatim into a script file with the Write tool (on a Bash-only surface, a nonce-delimited single-quoted heredoc per `skills/review/references/pr-comments.md` §4), never substituted into a shell command line; ticket-derived text never goes into it.
  - Pairs with **`.worktreeinclude`** — a committed file at the consuming repo's root, gitignore-style glob patterns one per line, listing the gitignored files the worktree creator copies from the main checkout into a fresh worktree (preserving relative paths) immediately after `git worktree add`, before running `worktree.setup`.
  - **No secrets** — `config.yaml` and `.worktreeinclude` are committed; patterns reference paths, never secret values, and the copied files stay gitignored in the worktree too.
  - Missing block or file → no-op: a fresh worktree needs manual setup, exactly as without the contract. In multi-repo workspaces (`repos:` frontmatter) the contract splits: `worktree.setup` is workspace-level and repo-agnostic (manifest sniffing), `.worktreeinclude` lives at each child repo's root. Full reference: `docs/advanced.md` §Worktree setup.
- **ID format:** `<PREFIX>-<N>` — no leading zeros.
- **Folder name:** just the ID, no slug — `claudedocs/tickets/<state>/<PREFIX>-<N>/` (or for nested children, `<state>/<EPIC>/tasks/<CHILD>/`).
- **Status flow:** `backlog → in-progress → done` (folders match), with an optional `review/` hop (`in-progress → review → done`) on `--pr` runs where a PR is opened for review before merge. Cancellation is expressed via frontmatter `status: cancelled` inside `done/`, not a separate folder; the open-PR state is expressed via `status: in-review` inside `review/`.
- Solo ticket folders move between state folders as the pipeline advances — the entire folder (spec, artifacts) moves as a unit.
- For epics: the **whole subtree** moves between state folders together under the precedence `in-progress` ⊐ `review` ⊐ `done` (any-child-in-progress → in-progress; else any-child-in-review → review; else every declared child materialized-and-terminal → done). `prd.md`'s `status` field tracks the folder location; per-child `status` lives in each child's `01-spec.md`. See `skills/flow/references/state-transitions.md` for the full transition logic and the Epic-completion predicate.
- **`repos` frontmatter** (optional, multi-repo workspaces only): `repos: [<dir-name>, ...]` — the repositories a ticket touches, as exact on-disk directory names. Appended by discover (never present in the templates) when the workspace is multi-repo: the folder holding `claudedocs/tickets/` is not itself a git repo but has immediate child directories with `.git`. Epics carry the union of their children's repos; children carry their own subset. One downstream consumer parses it — `ship --parallel` partitions its run into per-repo lanes from `repos:` (`skills/ship/references/parallel-walk.md` §1); elsewhere informational. Single-repo workspaces omit it entirely.
- **Multi-sibling linkage frontmatter** (set on children when discover emits an epic):
  - `parent: <EPIC-ID>` — the epic this child belongs to.
  - `epic: <slug>` — human-readable shared identifier across siblings (e.g. `dark-mode-rollout`).
  - `siblings: [<child-id>, ...]` — informational cross-references.
  - `blocked_by: [<child-id>, ...]` — sequencing dependencies. Enforced by `plan`/`build`: build refuses if blockers aren't done; plan auto-loads blocker context. See ticket-resolution Step 6.
- **Epic frontmatter** (on `prd.md`):
  - `kind: epic` — marks as non-pipelineable.
  - `children: [<child-id>, ...]` — populated by discover.
  - `epic: <slug>` — same slug as children.

### Cross-ticket lessons log

`claudedocs/tickets/_lessons.md` is a project-local log of gotchas — constraints that bit a prior ticket and would bite the next one, never generic best practices. `build` captures at its verdict gate (atomic one-subject-per-line entries, a write-time supersession check with prefer-newest on conflict, and a promotion-on-recurrence proposal into the project's `CLAUDE.md`); the standalone `debug` skill is a second producer; consumers (`plan`'s Phase 1; `ship`) grep it by subject keywords and never full-load it. The full contract — entry format, date-stamping, supersession, prefer-newest, promotion, format overflow, and grep-scoped consumption — lives in `skills/flow/references/lessons-log.md`; every producer and consumer points there.

---

## Adding a new stage

Build owns artifact slots `03-implementation.md` through `06-summary.md`. Slot `07-debug.md` is reserved by the standalone `debug` skill (its optional ticket-context report on non-`fixed` exits); `debug` is **not** a flow stage, so it does not follow the checklist below. The next free slot for a new *stage* is `08-*.md`.

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

1. **Lint the frontmatter** — no angle brackets, no markdown in descriptions, valid YAML, every tool listed in `allowed-tools`/`tools` actually exists. The `pipeline_*` entries are the exception: they are declared intent, and each must appear in both forms — bare and `mcp__plugin_server-native_ps__`-scoped — with the two lists holding the same tool set. Run `scripts/check-tool-parity.sh` rather than eyeballing it: the scoped prefix is derived from `plugins/server-native/.claude-plugin/plugin.json`, so the check also catches a connector rename. A bare-only entry grants nothing on Claude Code and raises no error.
2. **Check tool budget** against the table above — reviewers must not have write access.
3. **Check invocation control** — skills that are only ever user-invoked (`debug`, `sync`, `review`, `ship`, `lessons-consolidate`, `guide`) set `disable-model-invocation: true` (user-only; description not loaded into context). Skills invoked programmatically by another skill via the Skill tool (`flow`, `plan`, `build`, `discover`, `address-review` — the last invoked by `ship`'s address hop) stay model-invocable but carry a terse one-line description with no auto-trigger phrases.
4. **Walk the stage contract in `skills/flow/SKILL.md`** — if you changed inputs/outputs, update the Stage Contract table *and* every consuming stage's `Required Input` section.
5. **Sweep for cross-skill drift** — when a filename, skill name, or schema changes, grep across `plugins/feature/skills/` and `plugins/feature/agents/` for stale references and update them. The "Editing discipline" section below applies.
6. **Build skill tool-budget audit** — grep `plugins/feature/skills/build/SKILL.md` for any tool reference outside its `allowed-tools` (Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite, plus the `pipeline_*` tools its frontmatter lists, in either the bare or the `mcp__plugin_server-native_ps__`-scoped form). Should return no matches.
7. **Reviewer-agent read-only audit** — confirm `plugins/feature/agents/code-reviewer.md`, `plugins/feature/agents/security-engineer.md`, `plugins/feature/agents/performance-engineer.md`, and `plugins/feature/agents/code-architect.md` list no `Bash` or `Edit` in their `tools:`. Reviewers must not mutate the tree they review.
8. **Tool-parity check** — run `scripts/check-tool-parity.sh`; it must exit 0. This is the executable form of expectation 1 and the only automated check in the repo.
9. **Failed-criteria placement** — failed test criteria live inside `05-tests.md` under a `## Failed Criteria` section. Verify build-skill output stays consistent with this placement.

There's no automated test suite for the plugin itself. Validation is by manual pipeline runs on real tickets.

---

## Commit discipline

- No marketing language in commit messages ("magnificent", "blazingly fast", etc.).
- Reference the issue/feature the commit addresses.
- Keep commits small — one concern per commit.
- **Bump the plugin version every PR.** For the `feature` plugin, update `version` in BOTH `plugins/feature/.claude-plugin/plugin.json` and `plugins/feature/.codex-plugin/plugin.json` (semver: patch for fixes/refinements, minor for new skills/features) in the same PR as the change — the two `feature` manifests must stay in lockstep. `stack-first` versions independently: when a change touches it, bump its own lockstep pair (`plugins/stack-first/.claude-plugin/plugin.json` + `plugins/stack-first/.codex-plugin/plugin.json`); the two plugins' versions are not coupled. The discover → plan → build pipeline does not auto-include this, so when running the pipeline on this repo, add the version bump as an explicit plan/build step.

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
- **PR auto-review and reviewer-feedback loops *inside the pipeline stages*** (plan/build/flow auto-reviewing GitHub PRs and folding reviewer comments back through the pipeline). The pipeline stages stay review-free and ticket-folder-driven — PR *creation* is the only GitHub coupling they have: the opt-in `--pr` flag opens a PR on a passing build and lands the ticket in `review/`, degrading to a local commit when `gh`/GitHub is absent (see `skills/build/references/pr-creation.md`). The autonomous-review capability itself lives in the **standalone `ship` skill** (`skills/ship/`): on top of `--pr`, `ship` orchestrates an independent reviewer that posts to the PR plus an autonomous address loop over a ticket or dependency chain — merging per-ticket PRs into an integration branch on chains and leaving the resulting PR open for human review by default (`--merge` lands it). Keeping it out of the stages preserves the pipeline as general-purpose; `ship` is the opt-in layer for the full autonomous loop.
- **Clean-abort routine for `flow`** (`flow --abort`). Small standalone change; the existing verdict gate's `abort` choice covers the common case (revert folder + reset frontmatter). A dedicated flag would standardize multi-step abort behavior across deeper future flow surfaces.
- **Validator auto-detection in `hooks/validate.sh`** (project-type detection, e.g., infer "run pyright" from a `pyproject.toml`). Currently the user explicitly declares `validate.lint` and `validate.typecheck`. Auto-detection is too magic for a plugin that should respect existing project conventions; revisit if explicit-config maintenance becomes a real friction.
- **Default-on end-of-run UI verification in `ship`** (flip `ship`'s end-of-run browser pass from the opt-in `--ui-test` to default-on, opted out via the shared `--no-ui-testing`). Deferred until the end-of-run pass proves itself on real runs; adopting it would leave `ship` with a single UI-testing switch instead of a positive/negative flag pair, matching the one-axis-one-flag naming convention.
