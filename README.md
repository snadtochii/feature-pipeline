# Feature Pipeline

A Claude Code and Codex plugin that provides an agentic feature development pipeline for personal projects.

## What It Does

Orchestrates the full feature lifecycle through specialized AI agents with one human gate at completion (plan mode is its own gate; build's verdict is the second gate):

```
[/explore →] /discover → ticket(s) → /flow → plan → build → done
```

`/explore` is an optional precursor for outcome-uncommitted ideas; `/discover` is the entry point when you already know you want a ticket. Build is one continuous loop — implement, review, and test happen as internal checkpoints with fixes applied in-context, exiting with verdict `pass | partial | stuck`.

```
                 plan → build → done
                          ↓
                  ┌──────┴──────┐
                  │  build loop │
                  ├─────────────┤
                  │  implement  │  (runs in main context; PostToolUse hook + skill-body fallback validate every edit)
                  │      ↓      │
                  │  review     │  (4 parallel reviewer subagents; fixes applied in-context)
                  │      ↓      │
                  │  test       │  (ui-tester subagent for UI work; skip otherwise)
                  │      ↓      │
                  │  exit       │  verdict: pass | partial | stuck
                  └─────────────┘
```

### Pipeline Stages

| Stage | Skill | Agent(s) | Execution | What Happens |
|-------|-------|----------|-----------|-------------|
| **Explore** *(optional pre-pipeline)* | `explore` | — (uses Read/Grep/Glob inline) | Interactive | Open-ended Socratic exploration of an unformed idea; ends by leaving, saving as a note, or promoting to `/discover` |
| **Discover** | `discover` | code-explorer | Interactive | Socratic requirements discovery → creates 1 ticket, or N sibling tickets under an epic when scope splits |
| **Plan** | `plan` | code-explorer + requirements-analyst (Phase 1 subagents) | Interactive | Pre-plan synthesis (codebase patterns + open questions) followed by interactive plan mode |
| **Build** | `build` | code-reviewer + security-engineer + performance-engineer + code-architect (review checkpoint) + ui-tester (test checkpoint) | Loop with internal checkpoints | One continuous loop: implement → review (4 parallel reviewers) → test (UI/E2E via Playwright). Validates after every edit, fixes failures in-context, exits with verdict `pass \| partial \| stuck` |

### Human Gates

Two gates: plan mode (the user refines the plan and exits when satisfied) and build's verdict gate (the user reviews the verdict and either accepts on `pass`, picks `accept-as-partial / continue-with-hint / abort` on `partial`, or picks the same options on `stuck`). No iteration budgets — the build loop self-monitors for stuck patterns and a 25-turn ceiling, then surfaces the gate.

### Modular Architecture

Each stage is a **separate skill** that can be invoked independently or orchestrated through `flow`:

```bash
# Full pipeline (orchestrator calls plan then build)
/feature:flow BL-1

# Individual stages (standalone, using existing artifacts)
/feature:plan BL-1                  # plan stage with Phase 1 synthesis + plan mode
/feature:build BL-1                 # build stage; auto-resumes from on-disk artifacts
```

## Installation

### Claude Code

```bash
# 1. Add the repo as a marketplace
/plugin marketplace add <github-user>/feature-pipeline

# 2. Install the plugin
/plugin install feature@<github-user>-feature

# 3. Activate
/reload-plugins
```

For local development:
```bash
claude --plugin-dir /path/to/feature-pipeline
```

### Codex

The repo includes a Codex manifest at `.codex-plugin/plugin.json` and a Codex marketplace file at `.agents/plugins/marketplace.json`.

For local development, add this repo as a local marketplace, restart Codex, and verify that the `feature` plugin exposes:

```bash
codex plugin marketplace add /path/to/feature-pipeline
```

```bash
/feature:discover
/feature:explore
/feature:plan
/feature:build
/feature:flow
```

The validation hook uses Codex's hook system. Enable both hook feature flags in Codex config before expecting bundled plugin hooks to execute:

```toml
[features]
codex_hooks = true
plugin_hooks = true
```

## Usage

### Optional Step 0a: Explore an Idea First

If your idea isn't yet outcome-committed — you don't know whether to build it, what scope it has, or what shape it should take — start with `/explore`:

```bash
/feature:explore I'm thinking about reworking how rate limiting works
```

`/explore` is open-ended Socratic dialogue. The agent asks probing questions one at a time (with a recommended answer per question), grounds in the codebase only when relevant, and ends however you want:

- **Leave** — no artifact, just shared understanding.
- **Save as a note** — `/explore` doesn't write notes itself. If you have a note-saving skill or workflow installed separately, signal it (e.g., "note this", "save the session") and it picks up the conversation directly.
- **Promote to a ticket** — say "make this a ticket" and `/explore` hands the conversation to `/feature:discover`, which runs its full flow including codebase exploration but only asks gap questions you haven't already covered.

Use `/explore` when the outcome is uncommitted. Use `/discover` directly when you already know you want a ticket.

### Step 0: Discover & Create a Ticket

```bash
/feature:discover I want to add dark mode to the app --project my-app
```

`/discover` runs interactive requirements discovery and produces ticket folders in `claudedocs/tickets/backlog/`. The output depends on scope:

- **Single ticket** — for small/coherent work, one ticket folder with `01-spec.md` and `exploration.md`.
- **Epic + nested child tickets** — when the scope splits naturally (multiple distinct user stories, XL complexity, or clean vertical/horizontal seams), `/discover` proposes a decomposition and creates a parent epic folder containing a `prd.md` plus `tasks/<CHILD-ID>/01-spec.md` for each child. Children are linked via frontmatter (`parent`, `epic`, `siblings`, `blocked_by`).

You see and approve the proposal before tickets are created.

### Step 1: Run the Pipeline

```bash
/feature:flow BL-1                       # full pipeline (plan → build); auto-resumes if artifacts exist
/feature:flow BL-1 --ignore-blockers     # bypass blocker validation (use with care)
```

Resumption is auto-detected from the artifacts on disk — flow skips plan when `02-plan.md` exists, build picks up at the right checkpoint based on which of `03-`/`04-`/`05-` is present, and a completed run (`06-summary.md` with `pass`) is reported as "already complete." To start fresh against a partially-run ticket, delete the relevant artifacts before invoking flow.

### Run Individual Stages

Each stage reads its input from the ticket folder, so you can run them independently as long as the required artifacts exist:

```bash
# Re-plan with the existing spec (overwrites 02-plan.md)
/feature:plan BL-1

# Run the build loop; auto-resumes from the latest on-disk artifact (03-implementation.md / 04-review.md / 05-tests.md) if one exists
/feature:build BL-1
```

### Blocker dependencies between siblings

When `/discover` produces an epic with children, sibling tickets can declare `blocked_by: [<sibling-id>]` in their frontmatter. The pipeline enforces this asymmetrically:

- `plan` runs against blocked tickets normally — its Phase 1 synthesis auto-loads the blocker's spec/plan as context, so you can plan against unfinished foundations.
- `build` refuses to run until every blocker is `done` (or `cancelled`). Override with `--ignore-blockers` if you accept the risk.

This lets you plan ahead while preventing builds on top of unfinished foundations.

## Ticket System

Tickets and pipeline artifacts share a single tree under `claudedocs/tickets/`. The ticket folder moves between `backlog/`, `in-progress/`, and `done/` as the pipeline advances; all contents move with it as a unit.

```
claudedocs/tickets/
├── backlog/          # Tickets waiting to be worked on
├── in-progress/      # Currently in the pipeline
└── done/             # Completed (cancellation expressed via frontmatter `status: cancelled`)
```

### Solo ticket layout

```
claudedocs/tickets/<state>/BL-1/
├── 01-spec.md              # The ticket — frontmatter (id, title, priority, complexity, status, project, tags) + spec body
├── exploration.md          # Discover-time codebase exploration (optional)
├── 02-plan.md              # plan — implementation blueprint (includes Codebase Context + Open Questions Resolved sections)
├── 03-implementation.md    # build — implementation summary + validation results (live, updated per plan step)
├── 04-review.md            # build — merged review findings (4 reviewer subagents)
├── 05-tests.md             # build — UI test results, skip artifact, or Failed Criteria section
└── 06-summary.md           # build — exit summary (always written; content varies per verdict)
```

### Epic with children layout

```
claudedocs/tickets/<state>/BL-1/        # epic folder; <state> follows the most-advanced child
├── prd.md                              # Parent PRD (frontmatter: kind: epic, children: [...])
├── exploration.md                      # Shared exploration, lives once for all siblings
└── tasks/
    ├── BL-2/                           # child ticket folder — same internal structure as a solo ticket
    │   ├── 01-spec.md                  # frontmatter: parent: BL-1, epic: <slug>, siblings: [...], blocked_by: [...] (optional)
    │   ├── 02-plan.md
    │   ├── 03-implementation.md
    │   ├── 04-review.md
    │   ├── 05-tests.md
    │   └── 06-summary.md
    ├── BL-3/
    └── BL-4/
```

The whole epic subtree moves between `<state>/` folders as a unit:
- `backlog/` → `in-progress/` when any child enters in-progress.
- `in-progress/` → `done/` only when every child is `done`, `cancelled`, or `partial-completion`.

The epic itself is non-pipelineable — `plan`/`build` refuse to run against an epic ID. Run them against a child instead.

## Plugin Structure

```
feature-pipeline/
├── .claude-plugin/
│   └── plugin.json         # Plugin metadata
├── .agents/
│   └── plugins/
│       └── marketplace.json # Codex marketplace entry
├── .codex-plugin/
│   └── plugin.json         # Codex plugin metadata
├── hooks/                  # PostToolUse validation hook
│   ├── hooks.json          # PostToolUse declaration for file-edit tools
│   └── validate.sh         # Validator script — reads validate: block from claudedocs/tickets/config.yaml
├── agents/                 # Specialized agent definitions
│   ├── code-explorer.md
│   ├── code-architect.md
│   ├── code-reviewer.md
│   ├── requirements-analyst.md
│   ├── security-engineer.md
│   ├── performance-engineer.md
│   └── ui-tester.md
├── skills/                 # Skill definitions
│   ├── flow/               # Thin sequencer — runs plan → build; each stage owns its state transitions
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── ticket-resolution.md   # ticket-folder resolution, epic refusal, blocker validation
│   │       └── state-transitions.md   # folder moves, frontmatter status, verdict decision table
│   ├── discover/           # Step 0 — requirements discovery (1..N tickets)
│   │   ├── SKILL.md
│   │   └── templates/
│   │       ├── task.md     # Solo + child ticket spec template
│   │       └── prd.md      # Epic PRD template
│   ├── explore/            # Optional Step 0a — outcome-uncommitted idea exploration
│   │   └── SKILL.md
│   ├── plan/               # Stage 1 — pre-plan synthesis + interactive plan mode
│   │   └── SKILL.md
│   └── build/              # Stage 2 — continuous loop with implement/review/test checkpoints
│       ├── SKILL.md
│       └── references/
│           ├── confidence-scale.md
│           ├── stuck-detection.md
│           └── validation-hook.md
├── README.md
└── CLAUDE.md
```

## Included Agents

| Agent | Role in Pipeline |
|-------|-----------------|
| `code-explorer` | Traces codebase features, maps architecture (used in plan's Phase 1 synthesis) |
| `requirements-analyst` | Surfaces open questions and complexity reassessment (used in plan's Phase 1 synthesis) |
| `code-reviewer` | Reviews correctness with confidence scoring (used in build's review checkpoint) |
| `security-engineer` | Reviews for OWASP Top 10, auth, data protection (used in build's review checkpoint) |
| `performance-engineer` | Reviews for bottlenecks, memory leaks, bundle size (used in build's review checkpoint) |
| `code-architect` | Reviews architectural fit against existing patterns (used in build's review checkpoint) |
| `ui-tester` | Tests UI flows via Playwright browser automation (used in build's test checkpoint) |

> Build runs in main context for its implement checkpoint so the user can interact with iterative coding.

## Customization

### Project-Specific Overrides

The pipeline reads your project's `CLAUDE.md` for conventions. Add project-specific lint/test commands there:

```markdown
## Commands
- Lint: `npm run lint`
- Test: `npm test`
- Build: `npm run build`
```

### Ticket Prefix

On the first run of `/discover` in a project, you'll be asked for a ticket prefix (e.g., `FP`, `MYAPP`, `WEB`). It's saved to `claudedocs/tickets/config.yaml` and reused for all subsequent tickets.

### Validation Hook

The plugin ships an optional `PostToolUse` hook (`hooks/hooks.json` + `hooks/validate.sh`) that runs lint and typecheck after file-edit tools. It matches `Write|Edit|MultiEdit|apply_patch` so the same hook covers Claude Code edit tools and Codex patch edits. Opt in by adding a `validate:` block to `claudedocs/tickets/config.yaml`:

```yaml
prefix: FP
validate:
  lint: "bun run lint"
  typecheck: "bun run typecheck"
```

Without the block, the hook is a silent no-op. The hook auto-detects the project root by walking up from the edited file looking for `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `mix.exs`, or `tsconfig.json` (override the marker list via `validate.cwd_markers`). Build's body-level fallback runs the same checks regardless of whether the hook is configured — the two layers are intentionally redundant.

For Codex, hooks require `[features] codex_hooks = true` in `config.toml`; bundled plugin hooks also require `plugin_hooks = true`. The plugin hook command resolves either `PLUGIN_ROOT` (Codex) or `CLAUDE_PLUGIN_ROOT` (Claude Code), so the same `hooks/hooks.json` is shared by both runtimes.

`jq` is required for the hook script; `yq` is recommended for richer YAML support but not required (a grep-based fallback handles the common case).

### MCP Servers

For full functionality, these MCP servers are recommended (but optional):
- **Playwright** — required for build's test checkpoint (UI testing)
- **Chrome DevTools** — enhanced browser testing
- **Serena** — semantic code navigation; used by `code-explorer` and `code-architect` agents when available, falls back to Grep/Glob/Read otherwise

## Requirements

- Claude Code CLI or Codex CLI
- Git (for build's review checkpoint diff)
- Playwright MCP (for build's UI test checkpoint)
