# CLAUDE.md — feature-pipeline plugin

Guidance for Claude (and humans) working **on this plugin itself**. For usage of the pipeline, see [README.md](README.md).

This file captures invariants and conventions. Anything derivable from reading the code (file paths, skill names, stage order) stays in the code.

---

## What this repo is

A Claude Code plugin that ships an agentic feature-development pipeline: `discover → plan → implement → review → test`. Each stage is a separate **skill** that can run standalone or be sequenced by the **flow** orchestrator. Stages are backed by specialized **agents** (subagents with focused tool budgets and personas).

The primary audience for edits to this repo is Claude working on the plugin's own skills/agents — not end users. End-user docs live in README.md.

---

## Dev loop

Editing a skill or agent while another Claude Code session is open:

1. Make your edit in `skills/<name>/SKILL.md` or `agents/<name>.md`
2. In the consuming Claude Code session (not this repo — see below), run `/reload-plugins` — the updated skill/agent takes effect without a restart
3. Invoke the skill or trigger the agent to verify the change

**Keep the plugin repo separate from any consuming project** used for testing. Pick a throwaway project (or a real one), create a small ticket via `/feature-pipeline:discover`, then run `/feature-pipeline:flow <id>`. Running the pipeline against this plugin repo itself creates confusion about which `claudedocs/tickets/` artifacts belong where.

---

## Repository layout

```
feature-pipeline/
├── .claude-plugin/          # Plugin/marketplace metadata
│   ├── plugin.json
│   └── marketplace.json
├── agents/                  # Subagent definitions (one .md per agent)
├── skills/                  # Skill definitions (folder per skill, SKILL.md inside)
│   ├── flow/                # Orchestrator
│   ├── discover/            # Step 0 — ticket creation (Socratic dialogue, may emit 1..N tickets)
│   ├── explore/             # Open-ended Socratic exploration; can promote to discover
│   ├── plan/                # Stage 1 (pre-plan synthesis + plan mode)
│   ├── implement/           # Stage 2
│   ├── review/              # Stage 3 (4 parallel reviewers)
│   └── test/                # Stage 4 (UI/E2E)
├── README.md                # End-user docs
└── CLAUDE.md                # This file
```

---

## Pipeline flow (conceptual)

```
discover → ticket(s) → flow → plan → implement → review → test → completion
                                ↑        ↓         ↓        ↓
                                └────────┴─────────┴────────┘
                                   (human-gated loop-backs)
```

- **`discover`** is step 0 — interactive Socratic dialogue that creates ticket folders. Emits a single ticket (`claudedocs/tickets/backlog/<id>/01-spec.md` + `exploration.md`) for small/coherent work, or a parent epic + nested child tickets (`claudedocs/tickets/backlog/<EPIC>/prd.md` + `tasks/<CHILD>/01-spec.md` for each) when the scope splits naturally. Not part of flow.
- **`explore`** is a separate skill for open-ended Socratic exploration; can promote a conversation into `discover` once the user knows they want a ticket.
- **`flow`** orchestrates `plan → implement → review → test` with a human review gate after every stage. `plan` includes Phase 1 pre-plan synthesis (codebase exploration + open-questions surfacing) before entering plan mode.
- Failures loop backward: review failures re-run `implement`; test failures can re-run either `implement` (code bug) or `plan` (design flaw). Loop-back budgets in `flow`'s `.iterations.json`.

### Runtime source of truth

**Operational details live in `skills/flow/SKILL.md`**, not here. That file is loaded by Claude Code when a consumer runs the pipeline; this `CLAUDE.md` is only loaded when editing the plugin repo itself. If you move operational rules out of the skill and into this file, consumers lose visibility.

Canonical sources in `skills/flow/SKILL.md`:
- **Stage Contract** — reads/writes per stage, re-run inputs
- **Artifact Convention** — numbering rules, layout illustrations (solo + nested epic), `.stale/` and `.iterations.json` semantics
- **Loop-back iteration budget** — counter shape, budgets, escalation rules
- **Artifact invalidation** — `.stale/<timestamp>/` policy on deliberate re-runs
- **State transitions** (SETUP step 4, COMPLETION step 5) — solo vs nested-child move logic, all-children-done check for epics

Centralized cross-stage rules live in `skills/flow/references/ticket-resolution.md`:
- **Step 1** — ticket-folder resolution (path or ID, including nested children under `tasks/`)
- **Step 4** — `kind: epic` refusal (epics are non-pipelineable)
- **Step 5** — locating shared `exploration.md` (solo vs child)
- **Step 6** — blocker validation (`blocked_by`)

Individual stage skills (`skills/<stage>/SKILL.md`) own their own `Required Input` and `Output` sections, which are the authoritative per-stage contracts. Flow's Stage Contract table is a consolidated summary of those.

### Dev-side rule

When adding a new input to a stage, document it in the stage's `Required Input` section *and* update flow's Stage Contract table *and* its loop-back path description. All three live in skill files, not in this `CLAUDE.md`.

---

## Skill authoring conventions

General Claude Code skill-authoring rules — frontmatter fields, trigger-phrase policy, variable substitution, progressive disclosure, body structure, validation errors — are documented in the official Anthropic skills reference (https://code.claude.com/docs/en/skills) and the Agent Skills open standard (https://agentskills.io). Those are the sources of truth. Do not duplicate their content here.

This section captures only what's **specific to this plugin** on top of those general rules.

### `allowed-tools` budgets for this plugin's skills

Typical budget per role, expressed as unordered tool sets. The review *skill* may write to `claudedocs/` to save its merged artifact, but its *reviewer agents* are read-only — they must not mutate the tree they review.

| Skill | Typical budget |
|---|---|
| `flow` (orchestrator) | Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite, Skill |
| `discover` (intake) | Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite |
| `explore` (open-ended dialogue) | Read, Write, Edit, Glob, Grep, Bash, TodoWrite |
| `plan` (pre-plan synthesis + plan mode) | Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite (Task for Phase 1 subagents) |
| `implement` | Read, Write, Edit, Glob, Grep, Bash, TodoWrite |
| `review` | Read, Write, Glob, Grep, Bash, Task, TodoWrite (Write is for the merged `04-review.md` artifact only — no `Edit`, reviewer agents stay read-only) |
| `test` | Read, Write, Edit, Glob, Grep, Bash, Task, TodoWrite + Playwright/Chrome MCP |

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

Agents in this plugin live at `agents/*.md` and are loaded as subagent types namespaced `feature-pipeline:<agent-name>`. This section captures only what's **specific to this plugin**.

### Tool budgets for this plugin's agents

| Agent role | Tools | Rationale |
|---|---|---|
| Explorer (`code-explorer`) | Read-only set + Serena semantic tools | Describe, don't mutate; Serena adds symbol-level leverage |
| Analyst (`requirements-analyst`) | Read-only set | Describe, don't mutate; purely spec/analysis work — no codebase navigation |
| Reviewer (`code-reviewer`, `security-engineer`, `performance-engineer`) | Read-only set | Reviews must not mutate the tree; work on diffs, not codebase navigation |
| Architect (`code-architect`) | Read-only set + Serena semantic tools | Pattern comparison across sibling code is this agent's core work |
| UI tester (`ui-tester`) | Read set + Playwright/Chrome MCP | Browser testing, no code mutation |

**Read-only set:** `Glob, Grep, LS, Read, NotebookRead, WebFetch, TodoWrite, WebSearch`. (`KillShell` and `BashOutput` are deliberately excluded — they only make sense paired with `Bash`, which read-only agents don't have.)

**Serena semantic tools** (optional enhancement — additive, agents fall back to Grep/Glob/Read when Serena MCP is unavailable): `mcp__serena__find_symbol`, `mcp__serena__find_referencing_symbols`, `mcp__serena__get_symbols_overview`. Added to agents whose core work is symbol-level navigation or cross-file pattern recognition. Not added to reviewers — they work on diffs, not codebase navigation, and the tools would be noise.

### Model: opus for every agent in this plugin

Every agent pins `model: opus` rather than inheriting. Rationale: the pipeline is for personal projects where per-run velocity and reasoning quality matter more than throughput cost. Reviewers, architects, explorers, and analysts all benefit from deeper reasoning on per-ticket work where volume is low. Exception: if a future agent does purely mechanical work where Opus's reasoning is wasted, `sonnet` or `haiku` are acceptable — none currently qualify.

### Body template

Every agent in this plugin uses the body structure: **Triggers / Behavioral Mindset / Focus Areas / Key Actions / Outputs / Boundaries**. Rationale: the explicit `Triggers` body section reinforces delegation accuracy for parallel-review scenarios, and the structured shape makes it easy to compare agents against the tool-budget table above when reviewing changes.

### No implementer agent

The implement stage runs in main context (see "Main-context vs subagent" below); implementation tool access is governed by the `implement` skill's `allowed-tools`, not by an agent tool budget. There is intentionally no `implementer.md` in `agents/`.

---

## Main-context vs subagent — which runs where

Not every stage runs as a subagent. The rule:

| Runs in main context | Runs as subagent |
|---|---|
| `flow` (orchestrator) | `code-explorer`, `requirements-analyst` (spawned by `plan` Phase 1) |
| `discover` (interactive dialogue) | `code-reviewer`, `security-engineer`, `performance-engineer`, `code-architect` (spawned by `review`) |
| `explore` (open-ended dialogue) | `ui-tester` (spawned by `test`) |
| `plan` (uses `EnterPlanMode`, needs user interaction; spawns subagents in Phase 1) | |
| `implement` (long interactive coding + validation) | |

**Rule:** run in main context only when you need *interactivity* or *plan mode*. Otherwise prefer a subagent — it keeps the main context clean.

The `implement` skill folds its behavioral guidelines (mindset, focus areas, boundaries) directly into the SKILL.md body rather than delegating to a subagent — this is intentional, since the stage needs main-context interactivity for iterative coding + validation. See `skills/implement/SKILL.md` for the canonical implementer mindset.

---

## Ticket resolution (shared across skills)

Every stage skill resolves a ticket argument identically. Canonical logic lives in **`skills/flow/references/ticket-resolution.md`** and is referenced from `flow`, `plan`, `implement`, `review`, and `test`. `discover` handles the intake/creation variant inline (prefix logic and ID allocation live there).

**Do not duplicate the resolution logic inline** in a stage skill — link to the reference. If the resolution rules change, update the reference once.

Quick summary (full version in the reference):
- Path-like argument → read directly (folder path or `01-spec.md` path inside the folder).
- ID argument → search `backlog/`, `in-progress/`, `done/`, then glob across `claudedocs/tickets/**/<id>/` to catch nested children under `tasks/`.
- Not found → ask the user.
- Resolves to a ticket folder. Two shapes:
  - Solo ticket: `claudedocs/tickets/<state>/<id>/` containing `01-spec.md` and stage artifacts.
  - Child of an epic: `claudedocs/tickets/<state>/<EPIC>/tasks/<CHILD>/` containing `01-spec.md` and stage artifacts; the parent epic folder (`<state>/<EPIC>/`) holds `prd.md` and the shared `exploration.md`.
- Stages refuse to run against an epic (`kind: epic` in `prd.md` frontmatter) — see Step 4 in the reference.

---

## Ticket format

Tickets are markdown with YAML frontmatter — see `skills/discover/templates/task.md` (task spec, used for solo and child tickets) and `skills/discover/templates/prd.md` (epic PRD, used when discover emits multiple siblings) for the canonical schemas.

- **Prefix** per project (e.g. `FP`, `MYAPP`, `WEB`). Stored as the `prefix` field in `claudedocs/tickets/config.yaml`. Discover creates the file on first run and infers from existing tickets if it's missing. `config.yaml` is the canonical home for tickets-system configuration — future fields (status flow customization, complexity scale, etc.) go here, not in new dotfiles.
- **Validation hook config** lives in the same `claudedocs/tickets/config.yaml` under an optional `validate:` block:
  - `validate.lint` — string, shell command run after each Write/Edit/MultiEdit (e.g. `"bun run lint"`).
  - `validate.typecheck` — string, shell command run after each Write/Edit/MultiEdit (e.g. `"bun run typecheck"`).
  - `validate.cwd_markers` — optional list, overrides the default project-root markers (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `mix.exs`, `tsconfig.json`). The hook walks up from the edited file looking for any of these to pick the cwd for the lint/typecheck commands.
  - Missing block, missing keys, or malformed YAML → hook is a silent no-op. `jq` is required for the hook to function; without `jq` the hook logs one line to stderr and exits 0 (the build skill's body-level fallback still runs). `yq` is recommended for richer YAML support but not required.
- **ID format:** `<PREFIX>-<N>` — no leading zeros.
- **Folder name:** just the ID, no slug — `claudedocs/tickets/<state>/<PREFIX>-<N>/` (or for nested children, `<state>/<EPIC>/tasks/<CHILD>/`).
- **Status flow:** `backlog → in-progress → done` (folders match). Cancellation is expressed via frontmatter `status: cancelled` inside `done/`, not a separate folder.
- Solo ticket folders move between state folders as the pipeline advances — the entire folder (spec, artifacts, `bugs/`, `.iterations.json`, `.stale/`) moves as a unit.
- For epics: the **whole subtree** moves between state folders together (rule: any-child-in-progress → in-progress; all-children-done-or-cancelled → done). `prd.md`'s `status` field tracks the folder location; per-child `status` lives in each child's `01-spec.md`. See `flow/SKILL.md` SETUP step 4 and COMPLETION step 5.
- **Multi-sibling linkage frontmatter** (set on children when discover emits an epic):
  - `parent: <EPIC-ID>` — the epic this child belongs to.
  - `epic: <slug>` — human-readable shared identifier across siblings (e.g. `dark-mode-rollout`).
  - `siblings: [<child-id>, ...]` — informational cross-references.
  - `blocked_by: [<child-id>, ...]` — sequencing dependencies. Enforced by `plan`/`implement`/`review`/`test`: implement+ refuse if blockers aren't done; plan auto-loads blocker context. Bypass with `--ignore-blockers`. See ticket-resolution Step 6.
- **Epic frontmatter** (on `prd.md`):
  - `kind: epic` — marks as non-pipelineable.
  - `children: [<child-id>, ...]` — populated by discover.
  - `epic: <slug>` — same slug as children.

---

## Adding a new stage

1. Create `skills/<stage>/SKILL.md` following the skill body template above.
2. Reserve the next artifact number (`07-*.md`) — update the "Artifact Convention" section in `skills/flow/SKILL.md`.
3. Add the stage to flow's pipeline order, stage list, and flag handling (`--from`, `--to`, `--only`, `--skip`).
4. Add `--continue` detection: when to resume from this stage.
5. Document the stage's input/output contract in the stage's `Required Input`/`Output` sections *and* in flow's Stage Contract table.
6. If the new stage introduces a loop-back, add a counter to `.iterations.json` and wire it into the loop-back iteration budget section of `skills/flow/SKILL.md`.
7. Update `skills/flow/SKILL.md`'s Artifact invalidation downstream table for the new stage.
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
3. **Check trigger phrases** — every skill description must include natural trigger phrases that a user would actually type.
4. **Walk the stage contract in `skills/flow/SKILL.md`** — if you changed inputs/outputs, update the Stage Contract table *and* every consuming stage's `Required Input` section.
5. **Sweep for cross-skill drift** — when a filename, skill name, or schema changes, grep across `skills/` and `agents/` for stale references and update them. The "Editing discipline" section below applies.

There's no automated test suite for the plugin itself. Validation is by manual pipeline runs on real tickets.

---

## Commit discipline

- No marketing language in commit messages ("magnificent", "blazingly fast", etc.).
- Reference the issue/feature the commit addresses.
- Keep commits small — one concern per commit.

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

- **Design-match reviewer as 5th parallel reviewer** in the `review` stage. Deferred because it assumes design artifacts (Figma, wireframes) that not every personal-project ticket has. Reconsider when a ticket workflow routinely includes design references.
- **Step-type routing** in `plan`/`implement` (`figma-ui`, `component`, `service`, etc.) — too project-specific to generalize. The `plan` skill annotates step content explicitly instead of routing by step type.
- **PR-workflow integration** (auto-review of GitHub PRs, addressing reviewer feedback through PR comments). Out of scope for the core pipeline since it would assume GitHub + `gh` CLI and a specific PR workflow; `feature-pipeline` is general-purpose and ticket-folder-driven, not PR-driven.
