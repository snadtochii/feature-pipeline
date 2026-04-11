# CLAUDE.md — feature-pipeline plugin

Guidance for Claude (and humans) working **on this plugin itself**. For usage of the pipeline, see [README.md](README.md).

This file captures invariants and conventions. Anything derivable from reading the code (file paths, skill names, stage order) stays in the code.

---

## What this repo is

A Claude Code plugin that ships an agentic feature-development pipeline: discovery → analyze → plan → implement → review → test. Each stage is a separate **skill** that can run standalone or be sequenced by the **feature-flow** orchestrator. Stages are backed by specialized **agents** (subagents with focused tool budgets and personas).

The primary audience for edits to this repo is Claude working on the plugin's own skills/agents — not end users. End-user docs live in README.md.

---

## Repository layout

```
feature-pipeline/
├── .claude-plugin/          # Plugin/marketplace metadata
│   ├── plugin.json
│   └── marketplace.json
├── agents/                  # Subagent definitions (one .md per agent)
├── skills/                  # Skill definitions (folder per skill, SKILL.md inside)
│   ├── feature-flow/        # Orchestrator
│   ├── discovery/           # Step 0 — ticket creation
│   ├── analyze/             # Stage 1
│   ├── plan/                # Stage 2
│   ├── implement/           # Stage 3
│   ├── review/              # Stage 4
│   └── test/                # Stage 5
├── README.md                # End-user docs
└── CLAUDE.md                # This file
```

---

## Pipeline flow (canonical)

```
discovery → ticket → feature-flow → analyze → plan → implement → review → test → completion
                                        ↑          ↓         ↓         ↓
                                        └──────────┴─────────┴─────────┘
                                             (human-gated loop-backs)
```

- **discovery** is step 0 — creates the ticket in `.tickets/backlog/`. It is not part of feature-flow.
- **feature-flow** orchestrates analyze → plan → implement → review → test with a human review gate after every stage.
- Failures loop backward: review failures re-run `implement`; test failures can re-run either `implement` (code bug) or `plan` (design flaw).

### Stage contract — inputs and outputs

Each stage reads and writes artifacts in `claudedocs/pipeline/<ticket-id>/`. **This contract is load-bearing — don't break it without updating every consumer.**

| Stage | Reads | Writes | Re-run reads |
|---|---|---|---|
| `analyze` | `01-spec.md` | `02-analysis.md` | (same) |
| `plan` | `01-spec.md`, `02-analysis.md` | `03-plan.md` | (same) |
| `implement` | `01-spec.md`, `03-plan.md` | `04-implementation.md` | **also** `05-review.md` (review loop-back), `bugs/*.md` (test loop-back) |
| `review` | Working tree diff | `05-review.md` | (same) |
| `test` | `01-spec.md`, `04-implementation.md` | `06-tests.md`, `bugs/*.md` | (same) |
| `feature-flow` (completion) | all above | `07-summary.md` | — |

**Rule:** when adding a new input to a stage, document it in the stage's `Required Input` section *and* update feature-flow's description of the loop-back path.

### Artifact naming

- Sequential: `NN-name.md` where `NN` is the stage order (01–07)
- `01`–`07` are reserved for the canonical stages in the order above. Don't reuse numbers.
- Bug reports from the test stage go in `bugs/BUG-NNN.md` (zero-padded to 3)
- The ticket spec is ALWAYS `01-spec.md` — the ticket-resolution logic writes it if missing

---

## Skill authoring conventions

General Claude Code skill-authoring rules — frontmatter fields and gotchas, trigger-phrase policy, variable substitution, progressive disclosure, body structure, validation errors — live in `~/.claude/skills/skill-creator/references/`. That is the source of truth. Do not duplicate its content here.

This section captures only what's **specific to this plugin** on top of those general rules.

### `allowed-tools` budgets for this plugin's skills

Space-separated, per the `allowed-tools` format. Reviewers must not include `Write` or `Edit` (review must not mutate the tree).

| Skill role | Typical budget |
|---|---|
| Orchestrator (feature-flow) | `Read Write Edit Glob Grep Bash Task TodoWrite Skill` |
| Analysis/intake stage (discovery, analyze) | `Read Write Edit Glob Grep Bash Task TodoWrite` |
| Plan stage | `Read Write Edit Glob Grep Bash TodoWrite` (plus plan-mode tools) |
| Implementation stage | `Read Write Edit Glob Grep Bash TodoWrite` |
| Review stage | `Read Glob Grep Bash Task TodoWrite` |
| Test stage | `Read Write Edit Glob Grep Bash Task TodoWrite` + Playwright/Chrome MCP |

If you need a tool not in this table, add it explicitly and document why.

### Shared references

When a block would otherwise be duplicated across multiple stage skills, extract it. The canonical example is `skills/feature-flow/references/ticket-resolution.md`, referenced from every stage skill that resolves a ticket argument.

---

## Agent authoring conventions

General Claude Code agent-authoring rules — frontmatter fields, `tools:` comma-separated format, description policy, optional fields (`permissionMode`, `maxTurns`, `skills`, `hooks`), body template options — live in `~/.claude/skills/skill-creator/references/agent-frontmatter.md`. That is the source of truth. Do not duplicate its content here.

Agents in this plugin live at `agents/*.md` and are loaded as subagent types namespaced `feature-pipeline:<agent-name>`. This section captures only what's **specific to this plugin**.

### Tool budgets for this plugin's agents

| Agent role | Tools | Rationale |
|---|---|---|
| Explorer/analyst (`code-explorer`, `requirements-analyst`) | Read-only set | Describe, don't mutate |
| Reviewer (`code-reviewer`, `security-engineer`, `performance-engineer`, `code-architect` in review mode) | Read-only set | Reviews must not mutate the tree |
| Architect in blueprint mode (`code-architect`) | Read-only set | Produces blueprints, not code |
| UI tester (`ui-tester`) | Read set + Playwright/Chrome MCP | Browser testing, no code mutation |

Read-only set: `Glob, Grep, LS, Read, NotebookRead, WebFetch, TodoWrite, WebSearch, KillShell, BashOutput`.

### Model: opus for every agent in this plugin

Every agent pins `model: opus` rather than inheriting. Rationale: the pipeline is for personal projects where per-run velocity and reasoning quality matter more than throughput cost. Reviewers, architects, explorers, and analysts all benefit from deeper reasoning on per-ticket work where volume is low. Exception: if a future agent does purely mechanical work where Opus's reasoning is wasted, `sonnet` or `haiku` are acceptable — none currently qualify.

### Body template: Template B

Every agent in this plugin uses Template B (Triggers / Behavioral Mindset / Focus Areas / Key Actions / Outputs / Boundaries) — see `agent-frontmatter.md` for the template itself. This plugin does not use Template A. Rationale: matches the user's personal-agent standard in `~/.claude/agents/`, SuperClaude alignment, and the explicit `Triggers` body section reinforces delegation accuracy for parallel-review scenarios.

### No implementer agent

The implement stage runs in main context (see "Main-context vs subagent" below); implementation tool access is governed by the `implement` skill's `allowed-tools`, not by an agent tool budget. There is intentionally no `implementer.md` in `agents/`.

---

## Main-context vs subagent — which runs where

Not every stage runs as a subagent. The rule:

| Runs in main context | Runs as subagent |
|---|---|
| `feature-flow` (orchestrator) | Analysis/review work |
| `discovery` (interactive dialogue) | Parallel/isolated tasks |
| `plan` (uses `EnterPlanMode`, needs user interaction) | Contexts that should fork |
| `implement` (long interactive coding + validation) | — |

**Rule:** run in main context only when you need *interactivity* or *plan mode*. Otherwise prefer a subagent — it keeps the main context clean.

The `implement` skill folds its behavioral guidelines (mindset, focus areas, boundaries) directly into the SKILL.md body rather than delegating to a subagent — this is intentional, since the stage needs main-context interactivity for iterative coding + validation. See `skills/implement/SKILL.md` for the canonical implementer mindset.

---

## Ticket resolution (shared across skills)

Every stage skill resolves a ticket argument identically. Canonical logic lives in **`skills/feature-flow/references/ticket-resolution.md`** and is referenced from `feature-flow`, `analyze`, `plan`, `implement`, `review`, and `test`. `discovery` handles the intake/creation variant inline (prefix logic lives there).

**Do not duplicate the resolution logic inline** in a stage skill — link to the reference. If the resolution rules change, update the reference once.

Quick summary (full version in the reference):
- Path-like argument → read directly
- ID argument → search `backlog/`, `in-progress/`, `review/`, then glob
- Not found → ask the user
- Artifacts dir: `claudedocs/pipeline/<ticket-id>/` with `01-spec.md` as the canonical spec copy

---

## Ticket format

Tickets are markdown with YAML frontmatter — see `skills/discovery/TEMPLATE.md` for the canonical schema.

- **Prefix** per project (`BL` for big-leaves, `SY` for symphony). Stored in `.tickets/.prefix`. Discovery creates the file on first run and infers from existing tickets thereafter.
- **ID format:** `<PREFIX>-<N>` — no leading zeros.
- **Filename:** `<PREFIX>-<N>-<slug>.md`
- **Status flow:** `backlog → in-progress → review → done` (folders match)
- Tickets move between folders as the pipeline advances. `feature-flow` moves `backlog → in-progress` at setup; completion moves `in-progress → done` and updates the `status` frontmatter field.

---

## Adding a new stage

1. Create `skills/<stage>/SKILL.md` following the skill body template above
2. Reserve the next artifact number (`08-*.md`) — update the artifact convention in feature-flow
3. Add stage to feature-flow's pipeline order, stage list, and flag handling (`--from`, `--to`, `--only`, `--skip`)
4. Add `--continue` detection: when to resume from this stage
5. Document the stage's input/output contract in the stage contract table above
6. If the stage spawns subagents, create them in `agents/` and wire them up

## Adding a new agent

1. Create `agents/<name>.md` using the canonical body template
2. Set `tools` explicitly based on the tool budget table
3. Set `model` — default to `opus`
4. Reference the agent from a skill (otherwise it's dead weight — unused agents shouldn't ship)

---

## Validation expectations

Before committing changes to skills or agents:

1. **Lint the frontmatter** — no angle brackets, no markdown in descriptions, valid YAML
2. **Check tool budget** against the table above — reviewers must not have write access
3. **Check trigger phrases** — every skill description must include natural trigger phrases
4. **Run the skill-creator review mode** on the changed skill: `/skill-creator <name> --review`
5. **Walk the stage contract** — if you changed inputs/outputs, update every consumer

There's no automated test suite for the plugin itself. Validation is by skill-creator review + manual pipeline runs on real tickets.

---

## Commit discipline

- No marketing language in commit messages ("magnificent", "blazingly fast", etc.)
- Reference the issue/feature the commit addresses
- Keep commits small — one concern per commit
- Never commit `.DS_Store` (already in `.gitignore`)

---

## Considered and deferred

Decisions made during the current conventions pass that were evaluated and explicitly *not* adopted. Kept here so future maintenance has context on why the code looks the way it does.

- **Design-match reviewer as 5th parallel reviewer** in the `review` stage. Deferred because it assumes design artifacts (Figma, wireframes) that not every personal-project ticket has. Reconsider when a ticket workflow routinely includes design references.
- **Ticket-folder structure** with `meta.md` + `description.md` + `images/` (from the user's production `jira-describe`/`describe`/`prepare` flow). Deferred because feature-pipeline's current separation — flat ticket `.md` in `.tickets/` vs numbered artifacts in `claudedocs/pipeline/<id>/` — is actually cleaner. Reconsider if image handling becomes a hard requirement.
- **Code-explorer output caching** across discovery, analyze, and plan stages. Current flow runs `code-explorer` twice (once in discovery, once in analyze), which is a real inefficiency — but the fix is structural (shared memory layer or explicit artifact reuse) and worth its own pass.
- **Step-type routing** in plan/implement (`figma-ui`, `component`, `service`, etc.) — valuable in the user's production flow but too project-specific to generalize. Plan skill now annotates step content explicitly instead.
- **`breakdown` as a new pipeline stage**. Research was unambiguous: too much sprint-planning ceremony for personal projects. The valuable patterns (per-step edge cases, technical notes, 2–4h task atomicity, pre-plan quality checklist) were folded into the plan skill's Plan Structure instead.
- **PR-workflow integration** with the user's `code-review` and `address-review` skills. Those skills assume GitHub + `gh` CLI; feature-pipeline is general-purpose. Users working on GitHub projects can pair feature-pipeline with those separate skills without embedding the dependency.
