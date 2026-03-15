# Feature Pipeline

A Claude Code plugin that provides an agentic feature development pipeline for personal projects.

## What It Does

Orchestrates the full feature lifecycle through specialized AI agents with human review gates between every stage:

```
/discovery → ticket → /feature-flow → analyze → plan → implement → review → test → done
```

### Pipeline Stages

| Stage | Agent(s) | Execution | What Happens |
|-------|----------|-----------|-------------|
| **Discovery** | code-explorer | Interactive | Socratic requirements discovery → ticket creation |
| **Analyze** | code-explorer + requirements-analyst | Subagent | Codebase exploration + spec analysis |
| **Plan** | (plan mode) | Interactive | Implementation blueprint with file list and build sequence |
| **Implement** | implementer | Interactive | Code writing + lint + tests |
| **Review** | code-reviewer + security-engineer + performance-engineer | 3 Parallel subagents | Correctness, security, and performance review |
| **Test** | ui-tester | Subagent | Real browser testing via Playwright |

### Human Gates

You review and approve/reject after every stage. Rejected work loops back to the appropriate stage.

## Installation

```bash
# From GitHub (private or public repo)
/plugin install https://github.com/<user>/feature-pipeline

# From local directory (for development)
claude --plugin-dir /path/to/feature-pipeline
```

## Usage

### Step 0: Discover & Create a Ticket

```bash
/feature-pipeline:discovery I want to add dark mode to the app --project my-app
```

This guides you through interactive requirements discovery and produces a ticket in `.tickets/backlog/`.

### Step 1: Run the Pipeline

```bash
# Full pipeline
/feature-pipeline:feature-flow BL-1

# Partial runs
/feature-pipeline:feature-flow BL-1 --only analyze        # just analysis
/feature-pipeline:feature-flow BL-1 --from implement       # skip analysis + planning
/feature-pipeline:feature-flow BL-1 --skip test            # everything except testing
/feature-pipeline:feature-flow BL-1 --continue             # resume from where it left off
```

## Ticket System

Tickets are markdown files in `.tickets/`:

```
.tickets/
├── backlog/          # Tickets waiting to be worked on
├── in-progress/      # Currently in the pipeline
├── review/           # (optional) In review
└── done/             # Completed
```

Each ticket has YAML frontmatter with id, title, priority, complexity, status, project, and tags.

## Pipeline Artifacts

Each run produces artifacts in `claudedocs/pipeline/<ticket-id>/`:

```
claudedocs/pipeline/BL-1/
├── 01-spec.md              # Enriched ticket specification
├── 02-analysis.md          # Requirements analysis + codebase context
├── 03-plan.md              # Implementation blueprint
├── 04-implementation.md    # Implementation summary + validation results
├── 05-review.md            # Merged review findings (3 reviewers)
├── 06-tests.md             # UI test execution results
├── 07-summary.md           # Pipeline completion summary
└── bugs/                   # Bug reports from testing (if any)
```

## Included Agents

| Agent | Role in Pipeline |
|-------|-----------------|
| `code-explorer` | Traces codebase features, maps architecture |
| `code-architect` | Designs implementation blueprints |
| `code-reviewer` | Reviews correctness with confidence scoring |
| `requirements-analyst` | Analyzes specs for completeness and feasibility |
| `system-architect` | Designs backend/system architecture |
| `security-engineer` | Reviews for OWASP Top 10, auth, data protection |
| `performance-engineer` | Reviews for bottlenecks, memory leaks, bundle size |
| `implementer` | Writes production code, runs lint/tests |
| `ui-tester` | Tests UI flows via Playwright browser automation |

## Customization

### Project-Specific Overrides

The pipeline reads your project's `CLAUDE.md` for conventions. Add project-specific lint/test commands there:

```markdown
## Commands
- Lint: `npm run lint`
- Test: `npm test`
- Build: `npm run build`
```

### MCP Servers

For full functionality, these MCP servers are recommended (but optional):
- **Playwright** — required for Stage 5 (UI testing)
- **Chrome DevTools** — enhanced browser testing
- **Serena** — semantic code navigation during discovery and planning

## Requirements

- Claude Code CLI
- Git (for review stage diffs)
- Playwright MCP (for UI testing stage)
