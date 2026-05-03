# Feature Pipeline

A Claude Code plugin that provides an agentic feature development pipeline for personal projects.

## What It Does

Orchestrates the full feature lifecycle through specialized AI agents with human review gates between every stage:

```
[/explore →] /discover → ticket(s) → /flow → plan → implement → review → test → done
```

`/explore` is an optional precursor for outcome-uncommitted ideas; `/discover` is the entry point when you already know you want a ticket.

### Pipeline Stages

| Stage | Skill | Agent(s) | Execution | What Happens |
|-------|-------|----------|-----------|-------------|
| **Explore** *(optional pre-pipeline)* | `explore` | — (uses Read/Grep/Glob inline) | Interactive | Open-ended Socratic exploration of an unformed idea; ends by leaving, saving as a note, or promoting to `/discover` |
| **Discover** | `discover` | code-explorer | Interactive | Socratic requirements discovery → creates 1 ticket, or N sibling tickets under an epic when scope splits |
| **Plan** | `plan` | code-explorer + requirements-analyst (Phase 1 subagents) | Interactive | Pre-plan synthesis (codebase patterns + open questions) followed by interactive plan mode |
| **Implement** | `implement` | — (runs in main context) | Interactive | Code writing + lint + tests |
| **Review** | `review` | code-reviewer + security-engineer + performance-engineer + code-architect | 4 parallel subagents | Correctness, security, performance, and architectural-fit review |
| **Test** | `test` | ui-tester | Subagent | Real browser testing via Playwright |

### Human Gates

You review and approve/reject after every stage. Rejected work loops back to the appropriate stage with iteration budgets to prevent infinite loops.

### Modular Architecture

Each stage is a **separate skill** that can be invoked independently or orchestrated through `flow`:

```bash
# Full pipeline (orchestrator calls each stage skill in sequence)
/feature-pipeline:flow BL-1

# Individual stages (standalone, using existing artifacts)
/feature-pipeline:plan BL-1
/feature-pipeline:implement BL-1
/feature-pipeline:review BL-1
/feature-pipeline:test BL-1
```

## Installation

```bash
# 1. Add the repo as a marketplace
/plugin marketplace add <github-user>/feature-pipeline

# 2. Install the plugin
/plugin install feature-pipeline@<github-user>-feature-pipeline

# 3. Activate
/reload-plugins
```

For local development:
```bash
claude --plugin-dir /path/to/feature-pipeline
```

## Usage

### Optional Step 0a: Explore an Idea First

If your idea isn't yet outcome-committed — you don't know whether to build it, what scope it has, or what shape it should take — start with `/explore`:

```bash
/feature-pipeline:explore I'm thinking about reworking how rate limiting works
```

`/explore` is open-ended Socratic dialogue. The agent asks probing questions one at a time (with a recommended answer per question), grounds in the codebase only when relevant, and ends however you want:

- **Leave** — no artifact, just shared understanding.
- **Save as a note** — `/explore` doesn't write notes itself. If you have a note-saving skill or workflow installed separately, signal it (e.g., "note this", "save the session") and it picks up the conversation directly.
- **Promote to a ticket** — say "make this a ticket" and `/explore` hands the conversation to `/feature-pipeline:discover`, which runs its full flow including codebase exploration but only asks gap questions you haven't already covered.

Use `/explore` when the outcome is uncommitted. Use `/discover` directly when you already know you want a ticket.

### Step 0: Discover & Create a Ticket

```bash
/feature-pipeline:discover I want to add dark mode to the app --project my-app
```

`/discover` runs interactive requirements discovery and produces ticket folders in `claudedocs/tickets/backlog/`. The output depends on scope:

- **Single ticket** — for small/coherent work, one ticket folder with `01-spec.md` and `exploration.md`.
- **Epic + nested child tickets** — when the scope splits naturally (multiple distinct user stories, XL complexity, or clean vertical/horizontal seams), `/discover` proposes a decomposition and creates a parent epic folder containing a `prd.md` plus `tasks/<CHILD-ID>/01-spec.md` for each child. Children are linked via frontmatter (`parent`, `epic`, `siblings`, `blocked_by`).

You see and approve the proposal before tickets are created.

### Step 1: Run the Pipeline

```bash
# Full pipeline
/feature-pipeline:flow BL-1

# Partial runs
/feature-pipeline:flow BL-1 --only plan             # just the plan stage (Phase 1 synthesis + plan mode)
/feature-pipeline:flow BL-1 --from implement        # skip plan
/feature-pipeline:flow BL-1 --skip test             # everything except testing
/feature-pipeline:flow BL-1 --continue              # resume from where it left off
/feature-pipeline:flow BL-1 --ignore-blockers       # bypass blocker validation (use with care)
```

### Run Individual Stages

Each stage reads its input from the artifacts directory, so you can run them independently as long as the required artifacts exist:

```bash
# Run just the review on an already-implemented ticket
/feature-pipeline:review BL-1

# Re-plan with the existing spec
/feature-pipeline:plan BL-1

# Test a feature that's already implemented
/feature-pipeline:test BL-1
```

### Blocker dependencies between siblings

When `/discover` produces an epic with children, sibling tickets can declare `blocked_by: [<sibling-id>]` in their frontmatter. The pipeline enforces this asymmetrically:

- `plan` runs against blocked tickets normally — its Phase 1 synthesis auto-loads the blocker's spec/plan as context, so you can plan against unfinished foundations.
- `implement`, `review`, `test` refuse to run until every blocker is `done` (or `cancelled`). Override with `--ignore-blockers` if you accept the risk.

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
├── 02-plan.md              # Implementation blueprint (includes Codebase Context + Open Questions Resolved sections)
├── 03-implementation.md    # Implementation summary + validation results
├── 04-review.md            # Merged review findings (4 reviewers)
├── 05-tests.md             # UI test execution results
├── 06-summary.md           # Pipeline completion summary
├── .iterations.json        # Loop-back counter state
└── bugs/                   # Bug reports from testing (if any)
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
    │   ├── 06-summary.md
    │   ├── .iterations.json
    │   └── bugs/
    ├── BL-3/
    └── BL-4/
```

The whole epic subtree moves between `<state>/` folders as a unit:
- `backlog/` → `in-progress/` when any child enters in-progress.
- `in-progress/` → `done/` only when every child is `done` or `cancelled`.

The epic itself is non-pipelineable — `plan`/`implement`/`review`/`test` refuse to run against an epic ID. Run them against a child instead.

## Plugin Structure

```
feature-pipeline/
├── .claude-plugin/
│   └── plugin.json         # Plugin metadata
├── agents/                 # Specialized agent definitions
│   ├── code-explorer.md
│   ├── code-architect.md
│   ├── code-reviewer.md
│   ├── requirements-analyst.md
│   ├── security-engineer.md
│   ├── performance-engineer.md
│   └── ui-tester.md
├── skills/                 # Skill definitions
│   ├── flow/               # Orchestrator — sequences stages with gates
│   │   └── SKILL.md
│   ├── discover/           # Step 0 — requirements discovery (1..N tickets)
│   │   ├── SKILL.md
│   │   └── templates/
│   │       ├── task.md     # Solo + child ticket spec template
│   │       └── prd.md      # Epic PRD template
│   ├── explore/            # Optional Step 0a — outcome-uncommitted idea exploration
│   │   └── SKILL.md
│   ├── plan/               # Stage 1 — pre-plan synthesis + interactive plan mode
│   │   └── SKILL.md
│   ├── implement/          # Stage 2 — code + lint + tests
│   │   └── SKILL.md
│   ├── review/             # Stage 3 — parallel code review (4 reviewers)
│   │   └── SKILL.md
│   └── test/               # Stage 4 — UI/E2E browser testing
│       └── SKILL.md
└── README.md
```

## Included Agents

| Agent | Role in Pipeline |
|-------|-----------------|
| `code-explorer` | Traces codebase features, maps architecture (used in plan's Phase 1 synthesis) |
| `requirements-analyst` | Surfaces open questions and complexity reassessment (used in plan's Phase 1 synthesis) |
| `code-reviewer` | Reviews correctness with confidence scoring (used in review) |
| `security-engineer` | Reviews for OWASP Top 10, auth, data protection (used in review) |
| `performance-engineer` | Reviews for bottlenecks, memory leaks, bundle size (used in review) |
| `code-architect` | Reviews architectural fit against existing patterns (used in review) |
| `ui-tester` | Tests UI flows via Playwright browser automation (used in test) |

> The `implement` stage does not have a dedicated agent — it runs in the main conversation so the user can interact with it during iterative coding.

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

### MCP Servers

For full functionality, these MCP servers are recommended (but optional):
- **Playwright** — required for the test stage (UI testing)
- **Chrome DevTools** — enhanced browser testing
- **Serena** — semantic code navigation; used by `code-explorer` and `code-architect` agents when available, falls back to Grep/Glob/Read otherwise

## Requirements

- Claude Code CLI
- Git (for review stage diffs)
- Playwright MCP (for UI testing stage)
