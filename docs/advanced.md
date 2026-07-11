# Advanced usage & configuration reference

Deeper material that doesn't belong in the [README](../README.md) front door: the auto-PR and review→merge flow, epics and blocker dependencies, and the full configuration reference.

## Contents

- [Auto-PR (`--pr`) and the review → merge flow](#auto-pr---pr-and-the-review--merge-flow)
- [Skip browser testing (`--no-ui-testing`)](#skip-browser-testing---no-ui-testing)
- [Epics and blocker dependencies](#epics-and-blocker-dependencies)
- [Configuration reference](#configuration-reference)
  - [Project conventions (CLAUDE.md)](#project-conventions-claudemd)
  - [Ticket prefix](#ticket-prefix)
  - [Validation hook](#validation-hook)
  - [App test config](#app-test-config)
  - [Worktree setup](#worktree-setup)
  - [MCP servers](#mcp-servers)

## Auto-PR (`--pr`) and the review → merge flow

By default a passing build stops at the verdict gate and asks whether to commit. With `--pr`, build ships non-interactively instead: it detects the base branch, creates a branch (forking from `main` when needed), commits, pushes to `origin`, opens a **GitHub pull request** via `gh`, and lands the ticket in a `review/` state (`status: in-review`) rather than `done/`. You're notified with the PR URL.

Once the PR merges, re-run `/feature:flow <id>` (or `/feature:build <id>`) — build detects the merge and finalizes the ticket to `done/`. To finalize merged reviews in batch or unattended, run `/feature:sync`: it scans every `in-review` ticket by status and promotes the merged ones to `done/` in one pass. In epic mode, `--pr` opens one PR per child.

`--pr` needs the GitHub CLI (`gh`) installed and authenticated and a GitHub `origin` remote. If any is missing, build degrades gracefully — it commits locally, finalizes to `done/`, and prints one line explaining why the PR step was skipped. It never blocks the verdict gate.

## Skip browser testing (`--no-ui-testing`)

Build's test checkpoint verifies UI tickets in a real browser via the `ui-tester` subagent (Playwright/Chrome MCP), which needs interactive MCP permission. That permission isn't available in a non-interactive/headless run (e.g. `claude -p`), so a UI ticket can stall at the browser checkpoint.

Pass `--no-ui-testing` to skip **only** the browser portion of the test checkpoint — non-browser verification (your `validate.lint`/`validate.typecheck` checks) still runs and still gates the verdict. `05-tests.md` records that browser testing was skipped by flag (not "passed"), so the verdict and any PR stay honest about what was verified; browser-level verification then falls to a human at PR review. The flag propagates `flow → build` and, in epic mode, is forwarded to every child.

## Epics and blocker dependencies

When `/feature:discover` produces an epic, sibling child tickets can declare `blocked_by: [<sibling-id>]` in their frontmatter. The pipeline enforces this asymmetrically:

- `plan` runs against blocked tickets normally — its Phase 1 synthesis auto-loads the blocker's spec/plan as context, so you can plan against unfinished foundations.
- `build` refuses to run until every blocker is `done` (or `cancelled`). If a `blocked_by` entry is wrong, edit the ticket's `blocked_by` frontmatter.

This lets you plan ahead while preventing builds on top of unfinished foundations.

Run an epic with `/feature:flow <EPIC-ID>` — it walks the children in `blocked_by` topological order, invoking flow per child, and moves the whole epic subtree to `done/` when the last child finalizes. `/feature:plan` and `/feature:build` refuse to run directly against an epic ID; run them against a child.

## Multi-repo workspaces

A workspace where `claudedocs/tickets/` sits next to several sibling git repositories (the workspace folder itself is not a git repo, but its immediate children have `.git`) is **multi-repo**. Discover detects this shape automatically — no configuration involved — and appends a `repos:` frontmatter field to the tickets it creates:

```yaml
repos: [big-leaves-api, big-leaves-astro]
```

- Values are **exact on-disk directory names**, never shortened.
- Epics carry the union of their children's repos; each child carries its own subset. The decomposition tables show a `Repos` column so you can check whether a split follows repo seams.
- The field is **informational-only** — it gives you at-a-glance visibility into a ticket's repo footprint; no stage parses or enforces it.
- Single-repo workspaces (the common case) never see the field or the table column.

## Configuration reference

All project config lives in `claudedocs/tickets/config.yaml`. Everything except `prefix` is optional.

### Project conventions (CLAUDE.md)

The pipeline reads your project's `CLAUDE.md` for conventions. Declaring your commands there helps the stages use the right ones:

```markdown
## Commands
- Lint: `npm run lint`
- Test: `npm test`
- Build: `npm run build`
```

### Ticket prefix

On the first run of `/feature:discover` in a project, you'll be asked for a ticket prefix (e.g. `FP`, `MYAPP`, `WEB`). It's saved to `config.yaml` and reused for all subsequent tickets.

```yaml
prefix: FP
```

### Validation hook

The plugin ships an optional `PostToolUse` hook (`hooks/hooks.json` + `hooks/validate.sh`) that runs lint and typecheck after file-edit tools. It matches `Write|Edit|MultiEdit|apply_patch`, so the same hook covers Claude Code edit tools and Codex patch edits. Opt in with a `validate:` block:

```yaml
prefix: FP
validate:
  lint: "bun run lint"
  typecheck: "bun run typecheck"
```

Without the block, the hook is a silent no-op. It auto-detects the project root by walking up from the edited file looking for `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `mix.exs`, or `tsconfig.json`. Override the marker list with `validate.cwd_markers`. Build's body-level fallback runs the same checks regardless of whether the hook is configured — the two layers are intentionally redundant.

`jq` is required for the hook script; `yq` is recommended for richer YAML support but not required (a grep-based fallback handles the common case).

For Codex, hooks require `[features] codex_hooks = true` in `config.toml`; bundled plugin hooks also require `plugin_hooks = true`:

```toml
[features]
codex_hooks = true
plugin_hooks = true
```

The hook command resolves either `PLUGIN_ROOT` (Codex) or `CLAUDE_PLUGIN_ROOT` (Claude Code), so the same `hooks/hooks.json` is shared by both runtimes.

### App test config

Build's test checkpoint can read an optional `test:` block. It declares how to reach (and optionally start and authenticate) your app, so a cheap reachability pre-flight runs before the browser test subagent is spawned — the subagent is never launched against an app it can't reach. Unlike `validate:`, the `test:` block is read by the build skill, not by the validation hook.

```yaml
prefix: FP
test:
  url: http://localhost:4200          # pre-flight curls this for reachability
  start: "npm start"                  # booted (backgrounded) only if url is down; torn down after
  auth:
    storage_state: .auth/admin.json   # path to a Playwright saved session — gitignored, never committed
    attach_tab: true                  # fallback: attach to an already-authenticated running tab
```

Every key is optional; with no `test:` block the test checkpoint discovers the URL and handles auth inside the tester. **No secrets in `config.yaml`** — it is committed, so `auth.storage_state` is a path to a gitignored session file, never an inline credential.

`auth.storage_state` is loaded by the `ui-tester` via the Playwright MCP `browser_set_storage_state` tool (it restores the saved cookies/localStorage before navigating); on a Playwright MCP version that doesn't expose that tool, the tester falls back to `attach_tab`. The file must sit inside the project/workspace root (Playwright MCP restricts file access to the workspace root unless launched with `--allow-unrestricted-file-access`). Produce it once with your normal Playwright auth setup, or let the tester save it after a one-time login (it confirms the path is gitignored before saving, since the file holds live session cookies). When the app is unreachable and no `start` is declared (or it times out), the checkpoint records a non-blocking skip and proceeds.

### Worktree setup

An optional `worktree:` block declares how to make a fresh `git worktree` buildable. A new worktree starts without gitignored files (`.env`, auth storage-state, local config) and without installed dependencies; this contract fixes both, declared once per project. Like `test:`, the block is read by the model, never by `hooks/validate.sh` (the hook's parsers extract only the `validate:` block).

```yaml
prefix: FP
worktree:
  setup: "pnpm install"   # run once inside a fresh worktree, after include-files are copied
```

- `worktree.setup` — string, a shell command run once inside a fresh worktree, after the `.worktreeinclude`-matched files are copied. Missing block (or missing key) → no setup step: a fresh worktree needs manual setup, exactly as without this contract.

The block pairs with a `.worktreeinclude` file:

#### The `.worktreeinclude` file

A file at the consuming repo's root, **committed** to the repo, containing gitignore-style glob patterns, one per line. It lists the gitignored files a fresh worktree needs. The contract for whoever creates a worktree — you by hand, a script, or a skill — is **copy, then setup**:

1. `git worktree add <path> <branch>`
2. Copy every file matching a `.worktreeinclude` pattern from the main checkout into the fresh worktree, preserving relative paths.
3. Run `worktree.setup` inside the worktree.

The split is deliberate: the copy is generic mechanics owned by the worktree creator; `setup` owns the project-specific steps (dependency install, codegen).

Worked example — an app with a `.env`, a Playwright saved session, and pnpm:

```
# .worktreeinclude — at the repo root, committed
.env
.auth/admin.json
```

```yaml
# claudedocs/tickets/config.yaml
worktree:
  setup: "pnpm install"
```

A fresh worktree then receives `.env` and `.auth/admin.json` (the Playwright storage-state file that `test.auth.storage_state` points at) copied from the main checkout — both remain gitignored in the worktree — and `pnpm install` produces its `node_modules`. The worktree builds, validates, and UI-tests like the main checkout.

**Trust and secrets.** `worktree.setup` is the user's own declared command — the same trust tier as `validate.lint` and `test.start` — and follows the same execution discipline as `test.start` (see `skills/build/references/test-preflight.md`): the command is written verbatim into a script file (or a nonce-delimited single-quoted heredoc), never substituted into a shell command line, and ticket-derived text never goes into it. **No secrets in `config.yaml` or `.worktreeinclude`** — both are committed; patterns reference paths, never secret values, and the copied files stay gitignored in the worktree too.

**Single-repo assumption.** The contract is per-repository: `.worktreeinclude` lives at the git repo's root, and `worktree.setup` assumes `config.yaml` sits inside the repo it describes. Multi-repo workspaces — where `config.yaml` is workspace-level and tickets carry `repos:` frontmatter — are not covered by this contract.

### MCP servers

Recommended for full functionality, but optional:

- **Playwright** — required for build's test checkpoint (UI testing).
- **Chrome DevTools** — enhanced browser testing.
- **Serena** — semantic code navigation; used by the `code-explorer` and `code-architect` agents when available, falling back to Grep/Glob/Read otherwise.
