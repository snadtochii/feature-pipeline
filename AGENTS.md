# AGENTS.md — feature plugin

Guidance for coding agents (Claude Code, Codex) and humans working **on this plugin itself**. `CLAUDE.md` imports this file, so both runtimes load the same text. For usage of the pipeline, see [README.md](README.md).

This file captures invariants and conventions. Anything derivable from reading the code (file paths, skill names, stage order) stays in the code.

---

## What this repo is

A Claude Code and Codex plugin that ships an agentic feature-development pipeline: `discover → plan → build`. Each stage is a separate **skill** that can run standalone or be sequenced by the **flow** orchestrator. Build runs implement, review, and test as in-loop checkpoints inside one continuous loop, then hands its post-gate mechanics to a fresh-context finalizer child. Stages are backed by specialized **agents** (subagents with focused tool budgets and personas).

The primary audience for edits to this repo is a coding agent working on the plugin's own skills/agents — not end users. End-user docs live in README.md.

---

## Dev loop

Editing a skill or agent while another Claude Code session is open:

1. Make your edit in `plugins/feature/skills/<name>/SKILL.md` or `plugins/feature/agents/<name>.md`
2. In the consuming Claude Code session (not this repo — see below), run `/reload-plugins` — the updated skill/agent takes effect without a restart
3. Invoke the skill or trigger the agent to verify the change

**Keep the plugin repo separate from any consuming project** used for testing. Pick a throwaway project (or a real one), create a small ticket via `/feature:discover`, then run `/feature:flow <id>`. Running the pipeline against this plugin repo itself creates confusion about which `claudedocs/tickets/` artifacts belong where.

---

## Repository layout

The repo is a **multi-plugin marketplace**: the two marketplace files stay at the repo root and index the plugins under `plugins/`. `feature` and `stack-first` carry both manifests. Two plugins are Claude-only by design and appear in the Claude marketplace alone: `server-native` exists to declare an MCP server through install-time prompts, which Codex has no equivalent for, so Codex users bind the same server through `config.toml`; `tidy-loop` binds its write fences as `PreToolUse` hooks declared in agent frontmatter and delegates every write to Claude subagent types, neither of which Codex can load from a plugin manifest.

Path convention: in prose references throughout this file, an unqualified `skills/`, `agents/`, `hooks/`, or `docs/` path names the item inside the `feature` plugin (i.e. `plugins/feature/…`). Operational commands and audit steps use the full repo-root-relative `plugins/feature/…` path so they run as written from the repo root.

`scripts/` at the repo root holds the repository's own tooling, repo-root-relative like every operational path above: the `check-*.sh` validators, the `check-tidy-checks.mjs` checks runner, and `measure-session.py` beside its committed `measure-session.expected.json` anchor.

### Measuring a run

`scripts/measure-session.py` turns a Claude Code session transcript into a token report — per agent, per role, per ticket, and per build phase — so a change to the pipeline is measured before and after rather than argued about. It **reports rather than gates**, which is why it is deliberately absent from `.github/workflows/validation.yml`; its own check is `python3 scripts/measure-session.py self-test`. Two things about it are invariants rather than usage: no saving is ever reported without the quality-parity fields beside it, and the report's two units — weighted units for the role and ticket tables, re-read sum for the phase tables — are never comparable to each other. Its module docstring owns the command lines, the weights and the recognition contracts; this file does not restate them.

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
                               │  review     │ (4 reviewer roles; capacity-bounded)
                               │      ↓      │
                               │  test       │ (ui-tester subagent or skip; --no-ui-testing forces the skip)
                               │      ↓      │
                               │  exit       │ verdict: pass | partial | stuck
                               └──────┬──────┘
                                      ↓
                                  finalizer   (subagent: commit, PR, transition, worktree teardown)
```


### Runtime source of truth

**Operational details live in `skills/flow/SKILL.md`**, not here. That file is loaded by the consumer's runtime when a consumer runs the pipeline; this `AGENTS.md` is only loaded when editing the plugin repo itself. If you move operational rules out of the skill and into this file, consumers lose visibility.

**Runtime dispatch.** `flow`, `plan`, `build`, and `ship` load [`runtime.md`](plugins/feature/skills/flow/references/runtime.md) at entry and read its selected `runtime-claude.md` or `runtime-codex.md`. That reference owns skill invocation, fresh child creation, role loading, model mapping, wait/resume, and capacity. Child briefs carry the absolute plugin root and runtime binding independently of storage mode and stage overrides. Keep these operational rules in the runtime references so consumers receive them.

Canonical sources in `skills/flow/SKILL.md`:
- **Stage Contract** — reads/writes per stage
- **Artifact Convention** — numbering rules, layout illustrations (solo + nested epic)
- **Resumption auto-detection** — routing table for on-disk artifacts; users delete artifacts to start fresh

Centralized cross-stage rules live in `skills/flow/references/`: the `storage.md` mode-detection stub plus one `<concern>-fs.md` / `<concern>-server.md` pair per storage concern, of which a run reads exactly one. Skill-local pairs under `skills/<skill>/references/` follow the same shape. Each file's header states its scope and consumers.

Individual stage skills (`skills/<stage>/SKILL.md`) own their own `Required Input` and `Output` sections, which are the authoritative per-stage contracts. Flow's Stage Contract table is a consolidated summary of those.

### Dev-side rule

When adding a new input to a stage, document it in the stage's `Required Input` section *and* update flow's Stage Contract table. Both live in skill files, not in this `AGENTS.md`.

---

## Skill authoring conventions

General Claude Code skill-authoring rules — frontmatter fields, trigger-phrase policy, variable substitution, progressive disclosure, body structure, validation errors — are documented in the official Anthropic skills reference (https://code.claude.com/docs/en/skills) and the Agent Skills open standard (https://agentskills.io). Those are the sources of truth. Do not duplicate their content here.

This section captures only what's **specific to this plugin** on top of those general rules.

### `allowed-tools` budgets

Per-skill and per-agent tool budgets, with the rationale for each entry, live in [docs/contributing/tool-budgets.md](docs/contributing/tool-budgets.md). Read it before touching any `allowed-tools` or `tools` frontmatter. Reviewer agents are read-only — they never list `Bash`, `Edit`, or `Write`. A tool outside a budget is added to that file explicitly, with the reason.

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

When a block would otherwise be duplicated across multiple stage skills, extract it. The canonical example is the `skills/flow/references/ticket-resolution-fs.md` / `ticket-resolution-server.md` pair, referenced from every stage skill that resolves a ticket argument.

### Per-mode reference convention

Storage-mode-specific prose lives in **one file per concern per storage mode** — never in a shared file. Names carry the mode suffix, `<concern>-fs.md` / `<concern>-server.md`, and `scripts/check-mode-split.sh` enforces the split: a `-fs` file never contains `server-native`, `pipeline_`, or `mcp__`; a `-server` file never names a state folder (`backlog/`, `in-progress/`, `review/`, `done/`) or a folder move; and every `-fs` file has its `-server` sibling in the same directory and vice versa. Relative `.md` link resolution is `scripts/check-md-links.sh`, which spans every documentation tree it lists rather than this one alone.

- **Header.** Every mode file opens with the conditional-load sentence: `Canonical logic for <X> in <mode> storage mode. Read when the storage mode detected per [storage.md](storage.md) is <mode> — <the other case> never needs this file. Referenced by <Y>.` In a `-fs` file the other case is worded "a run in the other storage mode" (the token `server-native` is forbidden there); a `-server` file may say "an fs-native run".
- **Absence, not negation.** The other mode is excluded by leaving its text out — never by sentences like "there are no folders to move here". Beyond the header, a reader of a mode file never learns the other mode exists.
- **Shared logic is duplicated, and the pair is a lockstep mirror.** Logic both modes need (the Epic-completion predicate, the decision table, error handling) is written into both files of the pair rather than into a third shared file, so a run still reads one file per concern. Edit both when it changes — the same discipline as the two plugin manifests.
- **Citing from a file loaded in both modes.** A SKILL.md or a mode-neutral reference cites the pair — `[x-fs.md](…) / [x-server.md](…)` — or the single mode file when the sentence itself is mode-specific. Inside a mode file, cite only same-mode siblings. `storage.md`, the stub, is cited only for mode detection.
- **`storage.md` stays under 300 words** — the detection contract plus the pointer table. Doctrine goes to the mode files.
- **Skill-local pairs.** A skill whose own storage mechanics outgrow a dispatch sentence keeps them in `skills/<skill>/references/<concern>-fs.md` / `<concern>-server.md` — same header, same forbidden-token rules, same lockstep `##` heading set — numbered `§N` so the skill body cites `[x-fs.md](…) / [x-server.md](…) §N, for the mode detected at <anchor>`. Loaded once by the owning skill and cited by it and its own references (a reference shared with another skill anchors its dispatch on "the mode detected at the caller's start"); a same-mode file of another skill may point at one section for a documented shared divergence, never the reverse; a subagent spawn prompt inlines what the mode file resolved, never a link to it.

---

## Agent authoring conventions

General Claude Code agent-authoring rules — frontmatter fields, `tools:` format, description policy, optional fields (`permissionMode`, `maxTurns`, `skills`, `hooks`), body template options — are documented in the official Anthropic subagents reference (https://code.claude.com/docs/en/sub-agents). That is the source of truth. Do not duplicate its content here.

Agents in this plugin live at `agents/*.md`. Claude loads them as registered subagent types namespaced `feature:<agent-name>`; the Codex runtime loads their bodies into fresh generic children and supplies their operational boundaries explicitly. This section captures only what's **specific to this plugin**.

### Tool budgets

Agent tool budgets live in [docs/contributing/tool-budgets.md](docs/contributing/tool-budgets.md). Every agent except `ui-tester` holds the read-only set; reviewers must not mutate the tree they review.

### Model: opus for every Claude agent definition

Every Claude agent definition pins `model: opus` rather than inheriting. Rationale: the pipeline is for personal projects where per-run velocity and reasoning quality matter more than throughput cost. Reviewers, architects, explorers, and analysts all benefit from deeper reasoning on per-ticket work where volume is low. Exception: if a future agent does purely mechanical work where Opus's reasoning is wasted, `sonnet` or `haiku` are acceptable — none currently qualify.

`code-explorer` additionally sets `effort: high` — exploration is many-tool-call work where extra per-step deliberation (what to search next, which lead to follow) pays off, and its output is cached as `exploration.md` and trusted downstream by `plan`, so gathering quality caps ticket quality.

Codex role children inherit their runtime model. The runtime loader uses the shared role body without translating Claude `model: opus` or `effort` metadata into Codex settings. Explicit `--plan-model` / `--build-model` overrides bind only their stage spawns.

### Body template

Every agent in this plugin uses the body structure: **Triggers / Behavioral Mindset / Focus Areas / Key Actions / Outputs / Boundaries**. Rationale: the explicit `Triggers` body section reinforces delegation accuracy for parallel-review scenarios, and the structured shape makes it easy to compare agents against the tool-budget table when reviewing changes.

### No implementer agent

This is scoped to the implement checkpoint. That checkpoint runs in main context (see "Main-context vs subagent" below); implementation tool access is governed by the `build` skill's `allowed-tools`, not by an agent tool budget. There is intentionally no `implementer.md` in `agents/`. Build's other mutating child, the post-gate `finalizer`, is a different role: it writes no implementation, and its budget is the minimum for commit/PR/transition/teardown.

---

## Main-context vs subagent — which runs where

Not every stage runs as a subagent. The rule:

| Runs in main context | Runs as subagent |
|---|---|
| `flow` (orchestrator) | `code-explorer`, `requirements-analyst` (spawned by `plan` Phase 1) |
| `discover` (interactive dialogue) | `code-reviewer`, `security-engineer`, `performance-engineer`, `code-architect` (spawned by `build`'s review checkpoint) |
| `plan` standalone (interactive plan mode, or auto mode's batched no-default / complexity-overflow pauses; spawns subagents in Phase 1) | `ui-tester` (spawned by `build`'s test checkpoint) |
| | `finalizer` (spawned by `build`'s verdict gate once the decision is resolved; non-interactive — a condition needing a human comes back as a `needs-decision` result build relays) |
| `build` standalone (long interactive loop with implement/review/test checkpoints) | `plan` and `build` under `flow` — each a stage subagent spawned from `skills/flow/references/stage-briefs.md`; their user-facing stops pause the subagent and flow relays them (`stage-briefs.md` §5) |
| `debug` (interactive runtime-debugging loop; spawns no subagents) | |
| `sync` (standalone PR reconciler; reads PR state via `gh`, performs Transition 6; spawns no subagents) | |
| `review` (standalone repo-scoped PR reviewer; reads/posts PR state via `gh`; spawns no subagents) | |
| `address-review` (standalone PR feedback addresser; reads/posts PR state via `gh`, edits code to apply accepted fixes; spawns no subagents) | |
| `ship` (standalone autonomous build→review→merge orchestrator; spawns the per-ticket implementer subagent, never runs as one) | |
| `lessons-consolidate` (standalone `_lessons.md` sweep; proposes a diff, rewrites on approval; spawns no subagents) | |
| `guide` (standalone skill index; static guidance only; spawns no subagents) | |

**Rule:** run in main context only when you need *interactivity* or *plan mode* from the user's own session. Otherwise prefer a subagent — it keeps the main context clean. A stage that needs a decision while running as a subagent does not move to main context; it pauses and flow relays the decision (`stage-briefs.md` §5).

The `build` skill folds the implementer mindset directly into the SKILL.md body rather than delegating to a subagent — this is intentional, since the implement checkpoint needs main-context interactivity for iterative coding + validation. See `skills/build/SKILL.md` for the canonical implementer mindset.

---

## Ticket resolution (shared across skills)

Every stage skill resolves a ticket argument identically. Canonical logic lives in the **`skills/flow/references/ticket-resolution-fs.md`** / **`ticket-resolution-server.md`** pair (one file per storage mode) and is referenced from `flow`, `plan`, and `build`. `discover` handles the intake/creation variant inline (prefix logic and ID allocation live there).

**Do not duplicate the resolution logic inline** in a stage skill — link to the pair. If the resolution rules change, update both files of the pair.

---

## Ticket format

Tickets are markdown with YAML frontmatter — see `skills/discover/templates/task.md` (task spec, used for solo and child tickets) and `skills/discover/templates/prd.md` (epic PRD, used when discover emits multiple siblings) for the canonical schemas.

- **Prefix** per project (e.g. `FP`, `MYAPP`, `WEB`). Stored as the `prefix` field in `claudedocs/tickets/config.yaml`. Discover creates the file on first run and infers from existing tickets if it's missing. `config.yaml` is the canonical home for tickets-system configuration — future fields (status flow customization, complexity scale, etc.) go here, not in new dotfiles.
- **Storage mode** lives in the same `claudedocs/tickets/config.yaml` as optional top-level `mode` and `project` keys — the fs-native ↔ server-native switch, model-read at skill start per `skills/flow/references/storage.md`:
  - `mode: fs-native`, a missing key, or a missing file — tickets are the folder tree described in this section, fully offline (zero network, detection included). The personal server ships as the separate `server-native` connector plugin, which an fs-native machine simply does not install — so nothing is declared and nothing connects (see `plugins/feature/docs/advanced.md`).
  - `mode: server-native` with `project: <server-project-id>` — tickets are rows on the personal server (reached through the `pipeline_*` tools); the state folders don't exist and artifact bodies are frontmatter-free (the row is the sole metadata source). Pipeline tools unavailable or a call failing → the skill stops loudly, never falls back to fs writes.
  - `config.yaml` itself and `hooks/validate.sh` stay fs-local in both modes — the file is project execution config plus the mode marker, not ticket data. `prefix` remains meaningful only for fs allocation (server IDs come from the registry-configured prefix).
- **Execution config** — the optional `validate:`, `test:`, `git:`, and `worktree:` blocks live in the same `config.yaml`; keys and trust rules are in `docs/advanced.md`. Only `validate:` is read by `hooks/validate.sh`; the others are model-read.
- **ID format:** `<PREFIX>-<N>` — no leading zeros.
- **Folder name:** just the ID, no slug — `claudedocs/tickets/<state>/<PREFIX>-<N>/` (or for nested children, `<state>/<EPIC>/tasks/<CHILD>/`).
- **Status flow:** `backlog → in-progress → done` (folders match), with an optional `review/` hop (`in-progress → review → done`) on `--pr` runs where a PR is opened for review before merge. Cancellation is expressed via frontmatter `status: cancelled` inside `done/`, not a separate folder; the open-PR state is expressed via `status: in-review` inside `review/`.
- Solo ticket folders move between state folders as the pipeline advances — the entire folder (spec, artifacts) moves as a unit.
- For epics: the **whole subtree** moves between state folders together under the precedence `in-progress` ⊐ `review` ⊐ `done` (any-child-in-progress → in-progress; else any-child-in-review → review; else every declared child materialized-and-terminal → done). `prd.md`'s `status` field tracks the folder location; per-child `status` lives in each child's `01-spec.md`. See `skills/flow/references/state-transitions-fs.md` (folder mechanics) / `state-transitions-server.md` (CAS form) for the full transition logic and the Epic-completion predicate.
- **`repos` frontmatter** (optional, multi-repo workspaces only): `repos: [<dir-name>, ...]` — the repositories a ticket touches, as exact on-disk directory names. Appended by discover (never present in the templates) when the workspace is multi-repo: the folder holding `claudedocs/tickets/` is not itself a git repo but has immediate child directories with `.git`. Epics carry the union of their children's repos; children carry their own subset. Two downstream consumers parse it — `ship --parallel` partitions its run into per-repo lanes from `repos:` (`skills/ship/references/parallel-walk.md` §1), and build's `--worktree` eligibility reads it to bind the repo (exactly one entry) or degrade to an in-place build (2+, since one worktree cannot span repos); elsewhere informational. Single-repo workspaces omit it entirely.
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

`claudedocs/tickets/_lessons.md` is a project-local log of gotchas — constraints that bit a prior ticket and would bite the next one, never generic best practices. `build` captures at its verdict gate (atomic one-subject-per-line entries, a write-time supersession check with prefer-newest on conflict, and a promotion-on-recurrence proposal into the project's `CLAUDE.md`); the standalone `debug` skill is a second producer; consumers (`plan`'s Phase 1; `ship`) grep it by subject keywords and never full-load it. The full contract — entry format, date-stamping, supersession, prefer-newest, promotion, format overflow, and grep-scoped consumption — lives in the `skills/flow/references/lessons-log-fs.md` / `lessons-log-server.md` pair (one file per storage mode); every producer and consumer points there.

---

## Validation and extension checklists

Before committing changes to skills or agents, walk [docs/contributing/validation.md](docs/contributing/validation.md); it also holds the add-a-stage and add-an-agent checklists. Always:

- `scripts/check-tool-parity.sh`, `scripts/check-mode-split.sh`, `scripts/check-md-links.sh`, and `bash scripts/check-runtime-contract.sh` exit 0; `node scripts/check-tidy-checks.mjs` too when the change touches tidy-loop checks.
- Reviewer agents (`code-reviewer`, `security-engineer`, `performance-engineer`, `code-architect`) list no `Bash` or `Edit`; `finalizer` keeps `Bash` — `scripts/check-runtime-contract.sh` asserts both directions.
- An edit to a shared section of a `-fs`/`-server` pair lands in both files.
- A new validation script gets a step in `.github/workflows/validation.yml`, or it stays manual-only.

---

## Commit discipline

- No marketing language in commit messages ("magnificent", "blazingly fast", etc.).
- Reference the issue/feature the commit addresses.
- Keep commits small — one concern per commit.
- **Bump the plugin version every PR.** For the `feature` plugin, update `version` in BOTH `plugins/feature/.claude-plugin/plugin.json` and `plugins/feature/.codex-plugin/plugin.json` (semver: patch for fixes/refinements, minor for new skills/features) in the same PR as the change — the two `feature` manifests must stay in lockstep. `stack-first` and `tidy-loop` version independently, and their versions are not coupled to each other or to `feature`: a change touching `stack-first` bumps its lockstep pair (`plugins/stack-first/.claude-plugin/plugin.json` + `plugins/stack-first/.codex-plugin/plugin.json`), and a change touching `tidy-loop` bumps `plugins/tidy-loop/.claude-plugin/plugin.json` alone. The discover → plan → build pipeline does not auto-include this, so when running the pipeline on this repo, add the version bump as an explicit plan/build step.

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
