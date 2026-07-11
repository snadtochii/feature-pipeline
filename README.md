# Feature Pipeline

A Claude Code & Codex plugin that runs an agentic feature-development pipeline for personal projects: **discover → plan → build**. Each stage is a skill you can run on its own or chain together with `flow`.

```
/discover → ticket(s) → /flow → plan → build → done
```

`build` is one continuous loop — **implement → review → test** run as internal checkpoints, with fixes applied in context, exiting on a verdict of `pass | partial | stuck`. The only stop under `/flow` is that verdict gate.

## Install

### Claude Code

```bash
/plugin marketplace add <github-user>/feature-pipeline   # add the repo as a marketplace
/plugin install feature@<github-user>-feature            # install the plugin
/reload-plugins                                          # activate
```

Local development:

```bash
claude --plugin-dir /path/to/feature-pipeline
```

### Codex

The repo ships a Codex manifest (`.codex-plugin/plugin.json`) and marketplace file (`.agents/plugins/marketplace.json`).

Install the stable plugin from GitHub:

```bash
codex plugin marketplace add snadtochii/feature-pipeline --ref main
codex plugin list                           # verify feature@feature is available
codex plugin add feature@feature
codex plugin list                           # verify installed version and status
```

Start a new Codex task after installation so the task loads the plugin's skills, agents, and hooks.

Refresh an existing GitHub installation after a release:

```bash
codex plugin marketplace upgrade feature
codex plugin add feature@feature            # reinstall from the refreshed snapshot
codex plugin list                           # verify the new version is active
```

For local development, run the helper from your Feature Pipeline checkout. It stages tracked files plus non-ignored uncommitted files into a separate local marketplace and applies a local-only cachebuster before reinstalling. Gitignored files such as local credentials are not copied. It does not change the checkout's release manifest and does not silently substitute the stable GitHub copy. The helper requires Bash, Git, rsync, and the Codex CLI; on Windows, run it from WSL.

```bash
cd /path/to/feature-pipeline
scripts/install-codex-local.sh
codex plugin list                           # verify feature@feature-local is installed
```

Set `CODEX_HOME` to test against an isolated Codex home, or `FEATURE_CODEX_LOCAL_MARKETPLACE` to choose a different staging root. Both locations must be outside the checkout. Re-run the helper after local edits, then start a new Codex task to load the refreshed plugin.

Switch back to the stable GitHub installation:

```bash
codex plugin remove feature@feature-local
codex plugin add feature@feature
codex plugin list                           # verify feature@feature is installed
```

The validation hook uses Codex's hook system — enable `codex_hooks` and `plugin_hooks` in your Codex config. See [docs/advanced.md](docs/advanced.md#validation-hook) for the hook setup.

## Quick start

```bash
/feature:discover I want to add dark mode to the app --project my-app   # create a ticket
/feature:flow FP-1                                                      # plan → build → done
```

`discover` runs an interactive Socratic dialogue and writes ticket folder(s) under `claudedocs/tickets/backlog/`. `flow` then plans and builds the ticket, stopping only at build's verdict gate. On the first run in a project you'll be asked for a ticket prefix (e.g. `FP`), saved to `claudedocs/tickets/config.yaml`.

## The pipeline

| Command | What it does |
|---|---|
| `/feature:discover <idea>` | Socratic intake → one ticket, or an epic with child tickets when the scope splits. Add `--explore` to challenge an idea before committing. |
| `/feature:flow <id>` | Runs `plan → build` with a single verdict gate. Walks an epic's children in dependency order. Flags: `--pr`, `--no-ui-testing`. |
| `/feature:plan <id>` | Plan stage alone — pre-plan synthesis (codebase patterns + open questions), then interactive plan mode. |
| `/feature:build <id>` | Build loop alone — implement → review (4 parallel reviewers) → test (real-browser UI). Auto-resumes from on-disk artifacts. |

Resumption is auto-detected from the artifacts on disk; delete them to start a stage fresh. See [docs/advanced.md](docs/advanced.md) for the `--pr` auto-PR flow, `--no-ui-testing`, epics, and blocker dependencies.

## Standalone helpers

Run directly, outside the pipeline:

| Command | What it does |
|---|---|
| `/feature:guide` | Index of the standalone helpers — what each one does and when to reach for it. |
| `/feature:ship <id>` | Autonomous build → review → address loop over a ticket or `blocked_by` chain, ending at an open PR (`--merge` to land it, `--parallel` to build independent tickets concurrently in isolated worktrees). See [ship's flags](docs/advanced.md#ship-flags---base---merge---ui-test---parallel). |
| `/feature:review [<pr>]` | Review open PRs against a maintainability rubric; post inline + summary findings. Never approves or edits code. Omit `<pr>` to scan every open PR. |
| `/feature:address-review [<pr>]` | Validate a PR's review feedback — automated findings and human comments — fix the accepted ones, and post signed replies. Omit `<pr>` to use the current branch's PR. |
| `/feature:debug <description>` | Runtime-evidence root-cause debugger: hypothesize → reproduce → fix (gated) → verify. |
| `/feature:sync` | Reconcile in-review tickets with GitHub PR state; promote merged ones to `done/`. |
| `/feature:lessons-consolidate` | Sweep a bloated `_lessons.md` back to the atomic format — cluster, merge, and retire entries via a human-approved diff (git as the anchor). Optionally pass a path. |

## Tickets

Tickets and pipeline artifacts share one tree under `claudedocs/tickets/`. A ticket folder moves between state folders as the pipeline advances — everything inside moves with it.

```
claudedocs/tickets/
├── backlog/          # waiting to be worked on
├── in-progress/      # currently in the pipeline
├── review/           # PR open, awaiting merge (only on --pr runs)
└── done/             # completed (cancellation via frontmatter status: cancelled)
```

**Solo ticket** — one folder with the spec plus per-stage artifacts:

```
claudedocs/tickets/<state>/FP-1/
├── 01-spec.md              # the ticket: frontmatter + spec body
├── exploration.md          # discover-time codebase exploration
├── 02-plan.md              # plan — implementation blueprint
├── 03-implementation.md    # build — implementation summary
├── 04-review.md            # build — merged reviewer findings
├── 05-tests.md             # build — UI test results
└── 06-summary.md           # build — exit summary
```

**Epic with children** — a parent PRD plus child tickets nested under `tasks/`, sharing one exploration:

```
claudedocs/tickets/<state>/FP-1/
├── prd.md                  # parent PRD (kind: epic, children: [...])
├── exploration.md          # shared across siblings
└── tasks/
    ├── FP-2/               # child ticket — same layout as a solo ticket
    ├── FP-3/
    └── FP-4/
```

`/feature:flow <EPIC-ID>` walks the children in `blocked_by` order; `plan` and `build` refuse to run against an epic directly (run them on a child). See [docs/advanced.md](docs/advanced.md#epics-and-blocker-dependencies) for epics and blocker dependencies.

## Configuration

Project config lives in `claudedocs/tickets/config.yaml`. Every block below the prefix is optional:

```yaml
prefix: FP
validate:                        # lint/typecheck run after each edit (opt-in)
  lint: "bun run lint"
  typecheck: "bun run typecheck"
test:                            # lets build reach your app for the UI checkpoint
  url: http://localhost:4200
  start: "npm start"
worktree:                        # makes a fresh git worktree buildable
  setup: "pnpm install"
```

`worktree.setup` pairs with a committed `.worktreeinclude` file at the repo root — gitignore-style patterns listing the gitignored files (`.env`, auth sessions) a worktree creator copies into a fresh worktree before running setup.

The pipeline also reads your project's `CLAUDE.md` for conventions. Full reference — auth/`storage_state`, hook internals, the worktree contract, and MCP setup — is in [docs/advanced.md](docs/advanced.md#configuration-reference).

## Requirements

- Claude Code CLI or Codex CLI
- Git — for build's review-checkpoint diff
- Playwright MCP — for build's UI test checkpoint (optional; skip with `--no-ui-testing`)
- GitHub CLI (`gh`), authenticated, with a GitHub `origin` — for `--pr` and the `ship`/`review`/`address-review`/`sync` helpers; the pipeline degrades to local commits without it, and the PR helpers fail closed (change nothing) without it

---

**Advanced usage & full configuration reference:** [docs/advanced.md](docs/advanced.md).
