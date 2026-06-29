# Feature Pipeline

A Claude Code and Codex plugin that provides an agentic feature development pipeline for personal projects.

## What It Does

Orchestrates the full feature lifecycle through specialized AI agents. Under `/flow` the only stop is build's verdict gate at completion — plan runs non-interactively, so there's no plan-mode prompt mid-pipeline; run `/plan` on its own and you get interactive plan mode with its own gate:

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
                  │  test       │  (ui-tester subagent for UI work; skip otherwise or on --no-ui-testing)
                  │      ↓      │
                  │  exit       │  verdict: pass | partial | stuck
                  └─────────────┘
```

### Pipeline Stages

| Stage | Skill | Agent(s) | Execution | What Happens |
|-------|-------|----------|-----------|-------------|
| **Explore** *(optional pre-pipeline)* | `explore` | — (uses Read/Grep/Glob inline) | Interactive | Open-ended Socratic exploration of an unformed idea; ends by leaving, saving as a note, or promoting to `/discover` |
| **Discover** | `discover` | code-explorer | Interactive | Socratic requirements discovery → creates 1 ticket, or N sibling tickets under an epic when scope splits |
| **Plan** | `plan` | code-explorer + requirements-analyst (Phase 1 subagents) | Interactive standalone / non-interactive under flow | Pre-plan synthesis (codebase patterns + open questions), then plan design — interactive plan mode standalone, or non-interactive when flow runs it with `--auto` |
| **Build** | `build` | code-reviewer + security-engineer + performance-engineer + code-architect (review checkpoint) + ui-tester (test checkpoint) | Loop with internal checkpoints | One continuous loop: implement → review (4 parallel reviewers) → test (UI/E2E via Playwright; skipped with `--no-ui-testing`). Validates after every edit, fixes failures in-context, exits with verdict `pass \| partial \| stuck` |
| **Debug** *(standalone, reactive)* | `debug` | — (runs inline; optional Playwright/Chrome read tools) | Interactive | Runtime-evidence root-cause debugging: hypothesize → instrument → reproduce → analyze → fix (gated) → verify + strip; exits `fixed \| diagnosed-unfixed \| cannot-reproduce \| exhausted`. Invoked directly — not a pipeline stage |
| **Sync** *(standalone)* | `sync` | — (runs inline; reads PR state via `gh`) | Manual | Reconcile in-review tickets with GitHub PR state: scan tickets by `status: in-review` (not just the `review/` folder — catches epic children whose subtree still sits in `in-progress/`), promote merged-PR tickets to `done/` (Transition 6), report open ones, flag closed-unmerged. Read-only on GitHub; invoked directly — not a pipeline stage |
| **Review** *(standalone)* | `review` | — (runs inline; reads/posts PR state via `gh`) | Manual / loop | Repo-scoped, PR-coupled (no ticket): enumerate open PRs, skip any whose current head SHA was already reviewed, apply an embedded maintainability rubric, post inline + summary findings (or a signed "no blocking issues" comment when clean), and manage the model-neutral `auto-reviewed` label. Never approves or mutates repo code; subagent-free + MCP-free (headless/Codex-safe); invoked directly — not a pipeline stage |
| **Address-review** *(standalone)* | `address-review` | — (runs inline; reads/posts PR state via `gh`, edits code to fix) | Manual / loop | PR-coupled (no ticket): fetch a PR's inline + summary review comments (from `review`), validate each finding (ACCEPT real / DISMISS wrong, one-line reason), fix the accepted ones, and post signed `🛠️ addressed (automated)` replies anchored to each comment. Interactive by default (triage → go → reply on approval); `--auto` for the unattended/loop path. Edits code (triggers the validation hook) but never approves, merges, or closes; subagent-free + MCP-free (headless/Codex-safe); invoked directly — not a pipeline stage |
| **Ship** *(standalone)* | `ship` | implementer + independent reviewer subagents | Manual | Autonomous build → independent review → merge loop over a ticket or `blocked_by` chain. Each ticket: an implementer subagent runs `/feature:flow --pr --no-ui-testing`, an independent reviewer posts findings, the implementer addresses + squash-merges. A chain/epic merges per-ticket PRs into an `integration/<epic-id>` branch and opens (never merges) a final integration→main PR for human review. Invoked directly — not a pipeline stage |

### Human Gates

Under `/flow`, the single gate is build's verdict gate (the user reviews the verdict and either accepts on `pass`, picks `accept-as-partial / continue-with-hint / abort` on `partial`, or picks the same options on `stuck`) — plan runs non-interactively, so it adds no gate, though it can pause once if the plan hits an open question with no safe default or a complexity overflow (and, when `--visual` is passed, for the plan-review surface). Run `/plan` standalone and it adds its own interactive plan-mode gate (the user refines the plan and exits when satisfied). No iteration budgets — the build loop self-monitors for stuck patterns and a 25-turn ceiling, then surfaces the gate.

### Modular Architecture

Each stage is a **separate skill** that can be invoked independently or orchestrated through `flow`:

```bash
# Full pipeline (orchestrator calls plan then build)
/feature:flow BL-1

# Individual stages (standalone, using existing artifacts)
/feature:plan BL-1                  # plan stage standalone — Phase 1 synthesis + interactive plan mode
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
/feature:debug
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
/feature:flow BL-1                       # single ticket: plan → build; auto-resumes if artifacts exist
/feature:flow BL-1 --ignore-blockers     # bypass blocker validation (use with care)
/feature:flow BL-1 --pr                  # on pass, open a GitHub PR and land the ticket in review/
/feature:flow BL-1 --pr --no-ui-testing  # skip the browser checkpoint (headless-safe), still open a PR
/feature:flow BL-1 --visual              # render an HTML plan-review surface, pause for review before build
/feature:flow EPIC-1                     # epic: walks children in blocked_by topological order
```

#### Auto-PR (`--pr`)

By default a passing build stops at the verdict gate and asks whether to commit. With `--pr`, build instead ships non-interactively: it detects the base branch, creates a branch (forking from `main` when needed), commits, pushes to `origin`, opens a **GitHub pull request** via `gh`, and finalizes the ticket into a new `review/` state (`status: in-review`) instead of `done/`. You're notified with the PR URL. Once the PR merges, re-run `/feature:flow <id>` (or `/feature:build <id>`) — build detects the merge and finalizes the ticket to `done/`. In epic-mode, `--pr` opens one PR per child. To finalize merged reviews in batch (or unattended), run `/feature:sync` — it scans every `in-review` ticket by status (including epic children still parked in `in-progress/`) and promotes the merged ones to `done/` in one pass.

`--pr` needs the GitHub CLI (`gh`) installed and authenticated and a GitHub `origin` remote. If any is missing, build degrades gracefully — it commits locally, finalizes to `done/`, and prints one line explaining why the PR step was skipped. It never blocks the verdict gate.

#### Skip browser testing (`--no-ui-testing`)

Build's test checkpoint verifies UI tickets in a real browser via the `ui-tester` subagent (Playwright/Chrome MCP), which needs interactive MCP permission. That permission isn't available in a non-interactive/headless run (e.g. `claude -p`), so a UI ticket can stall at the browser checkpoint. Pass `--no-ui-testing` to skip **only** the browser/ui-tester portion of the test checkpoint — non-browser verification (your `validate.lint`/`validate.typecheck` checks) still runs and still gates the verdict. `05-tests.md` records that browser testing was skipped by flag (not "passed"), so the verdict and any PR stay honest about what was verified; browser-level verification then falls to a human at PR review. The flag propagates `flow → build` and, in epic-mode, is forwarded to every child. Without it, behaviour is unchanged. Note: a flag-skipped `pass` finalizes the ticket as complete, so browser verification belongs to PR review — a later plain `/feature:build` re-run will see the completed run, not re-open the browser checkpoint.

#### Visual plan review (`--visual`)

By default a plan is reviewed as Markdown (in plan mode when run standalone, or not at all under flow's non-blocking handoff). With `--visual`, after `02-plan.md` is written the plan stage also generates `02-plan.html` — a self-contained HTML review surface (architecture diagram, file-change map, steps, open questions, and trade-offs side-by-side) you open in a browser. It needs no build step and no install; diagrams load from a CDN at view time and the page stays readable when offline. You review it, then paste edits or `-> note` marks back; the stage folds them into `02-plan.md` (the source of truth) and regenerates the HTML. Markdown stays canonical — `build` only ever reads `02-plan.md`, never the HTML. The flag propagates `flow → plan` and, in epic-mode, is forwarded to every child; the derived `02-plan.html` is gitignored so it never lands in a PR. On a resumed run (the plan already exists, so flow would normally skip plan), `--visual` triggers a visual-only refresh + review gate before build rather than being silently skipped. Without it, behaviour is unchanged.

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

Tickets and pipeline artifacts share a single tree under `claudedocs/tickets/`. The ticket folder moves between `backlog/`, `in-progress/`, `review/`, and `done/` as the pipeline advances; all contents move with it as a unit.

```
claudedocs/tickets/
├── backlog/          # Tickets waiting to be worked on
├── in-progress/      # Currently in the pipeline
├── review/           # PR open, awaiting merge (only on `--pr` runs; status: in-review)
└── done/             # Completed (cancellation expressed via frontmatter `status: cancelled`)
```

### Solo ticket layout

```
claudedocs/tickets/<state>/BL-1/
├── 01-spec.md              # The ticket — frontmatter (id, title, priority, complexity, status, project, tags) + spec body
├── exploration.md          # Discover-time codebase exploration (optional)
├── 02-plan.md              # plan — implementation blueprint (includes Codebase Context + Open Questions Resolved sections)
├── 02-plan.html            # plan — derived HTML review surface (only on --visual runs; a view of 02-plan.md)
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
    │   ├── 02-plan.html                # only on --visual runs (derived view of 02-plan.md)
    │   ├── 03-implementation.md
    │   ├── 04-review.md
    │   ├── 05-tests.md
    │   └── 06-summary.md
    ├── BL-3/
    └── BL-4/
```

The whole epic subtree moves between `<state>/` folders as a unit (precedence `in-progress` ⊐ `review` ⊐ `done`):
- `backlog/` → `in-progress/` when any child enters in-progress.
- `in-progress/` → `review/` when no child is in-progress and at least one is `in-review` (a `--pr` child opened a PR).
- `→ done/` only when every child **declared in the epic's `children:` roster** is materialized and terminal (`done`, `cancelled`, or `partial-completion`). `in-review` is non-terminal — an open PR keeps the epic out of `done/`. A declared child not yet authored also keeps the epic out of `done/`, so a just-in-time epic (full roster declared upfront, child specs written as the pipeline reaches each phase) isn't marked complete early.

Running an epic: `/feature:flow <EPIC-ID>` walks the children in `blocked_by` topological order, invoking flow recursively per child. The epic subtree moves to `done/` automatically when the last child finalizes. `/feature:plan` and `/feature:build` still refuse to run directly against an epic ID — run them against a child instead, or use flow.

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
│   ├── debug/              # Standalone — reactive runtime-evidence debugger (not a pipeline stage)
│   │   └── SKILL.md
│   ├── sync/               # Standalone — reconcile in-review tickets with GitHub PR state (not a pipeline stage)
│   │   └── SKILL.md
│   ├── review/             # Standalone — repo-scoped PR reviewer with shared comment rules + embedded rubric (not a pipeline stage)
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── pr-comments.md        # shared comment contract (role footer, hidden markers, empty-review, post + reply gh patterns)
│   │       └── review-rubric.md      # embedded maintainability rubric applied to every PR
│   ├── address-review/     # Standalone — validate + address a PR's review comments, post signed replies (not a pipeline stage)
│   │   └── SKILL.md         # consumes ../review/references/pr-comments.md for the reply contract
│   ├── ship/               # Standalone — autonomous build → review → merge loop over a ticket or chain (not a pipeline stage)
│   │   └── SKILL.md
│   ├── plan/               # Stage 1 — pre-plan synthesis + plan design (interactive plan mode standalone, non-interactive under flow)
│   │   └── SKILL.md
│   └── build/              # Stage 2 — continuous loop with implement/review/test checkpoints
│       ├── SKILL.md
│       └── references/
│           ├── confidence-scale.md
│           ├── stuck-detection.md
│           ├── validation-hook.md
│           └── pr-creation.md
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

### App Test Config

The build skill's test checkpoint can read an optional `test:` block in the same `claudedocs/tickets/config.yaml`. It declares how to reach (and optionally start and authenticate) your app, so a cheap reachability pre-flight runs before the browser test subagent is spawned — the subagent is never launched against an app that can't be reached. Unlike `validate:`, the `test:` block is read by the build skill, not by the validation hook.

```yaml
prefix: FP
test:
  url: http://localhost:4200          # pre-flight curls this for reachability
  start: "npm start"                  # booted (backgrounded) only if url is down; torn down after
  auth:
    storage_state: .auth/admin.json   # path to a Playwright saved session — gitignored, never committed
    attach_tab: true                  # fallback: attach to an already-authenticated running tab
```

Every key is optional; with no `test:` block the test checkpoint discovers the URL and handles auth inside the tester as before. **No secrets in `config.yaml`** — it is committed, so `auth.storage_state` is a path to a gitignored session file, never an inline credential.

`auth.storage_state` is loaded by the `ui-tester` via the Playwright MCP `browser_set_storage_state` tool (it restores the saved cookies/localStorage before navigating); on a Playwright MCP version that doesn't expose that tool, the tester falls back to `attach_tab`. The file must sit inside the project/workspace root (Playwright MCP restricts file access to the workspace root unless launched with `--allow-unrestricted-file-access`). Produce it once with your normal Playwright auth setup, or let the tester save it after a one-time login (it confirms the path is gitignored before saving, since the file holds live session cookies). When the app is unreachable and no `start` is declared (or it times out), the checkpoint records a non-blocking skip and proceeds — it never stalls the loop waiting on you.

### MCP Servers

For full functionality, these MCP servers are recommended (but optional):
- **Playwright** — required for build's test checkpoint (UI testing)
- **Chrome DevTools** — enhanced browser testing
- **Serena** — semantic code navigation; used by `code-explorer` and `code-architect` agents when available, falls back to Grep/Glob/Read otherwise

## Requirements

- Claude Code CLI or Codex CLI
- Git (for build's review checkpoint diff)
- Playwright MCP (for build's UI test checkpoint)
- GitHub CLI (`gh`), authenticated, with a GitHub `origin` — only for `--pr` (auto-PR); the pipeline degrades to a local commit without it
