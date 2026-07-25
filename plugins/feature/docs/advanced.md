# Advanced usage & configuration reference

Deeper material that doesn't belong in the [README](../../../README.md) front door: the auto-PR and review→merge flow, epics and blocker dependencies, and the full configuration reference.

## Contents

- [Auto-PR (`--pr`) and the review → merge flow](#auto-pr---pr-and-the-review--merge-flow)
- [Skip browser testing (`--no-ui-testing`)](#skip-browser-testing---no-ui-testing)
- [Epics and blocker dependencies](#epics-and-blocker-dependencies)
- [Ship flags (`--base`, `--merge`, `--ui-test`, `--parallel`)](#ship-flags---base---merge---ui-test---parallel)
- [Configuration reference](#configuration-reference)
  - [Project conventions (CLAUDE.md)](#project-conventions-claudemd)
  - [Ticket prefix](#ticket-prefix)
  - [Validation hook](#validation-hook)
  - [App test config](#app-test-config)
  - [Worktree setup](#worktree-setup)
  - [MCP servers](#mcp-servers)
  - [Storage mode and the personal server](#storage-mode-and-the-personal-server)

## Auto-PR (`--pr`) and the review → merge flow

By default a passing build stops at the verdict gate and asks whether to commit. With `--pr`, build ships non-interactively instead: it detects the base branch, creates a branch (forking from `main` when needed), commits, pushes to `origin`, opens a **GitHub pull request** via `gh`, and lands the ticket in a `review/` state (`status: in-review`) rather than `done/`. You're notified with the PR URL.

Once the PR merges, re-run `/feature:flow <id>` (or `/feature:build <id>`) — build detects the merge and finalizes the ticket to `done/`. To finalize merged reviews in batch or unattended, run `/feature:sync`: it scans every ticket in `backlog/`, `in-progress/`, and `review/` and promotes the merged ones to `done/` in one pass. In epic mode, `--pr` opens one PR per child.

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

## Ship flags (`--base`, `--merge`, `--ui-test`, `--parallel`)

`/feature:ship` is the autonomous layer on top of the pipeline: per ticket it builds (`flow --pr`), spawns an independent reviewer, addresses the review, and ends the run at open PR(s) left as the human gate. Its four flags:

- **`--base <branch>`** — the trunk of the run (default `main`): the branch feature/integration branches are cut from and the branch the resulting PR(s) target. It doesn't change the branch strategy — an epic still gets an `integration/<epic-id>` branch; solo and multi-solo tickets still ship on per-ticket feature branches.
- **`--merge`** — merge the resulting PR(s) into `<base>` at the end of the run instead of leaving them open (solo/multi-solo: squash each; an epic's integration PR: a merge commit, preserving the per-ticket squashed commits). In an epic run, per-ticket merges into the integration branch happen regardless — the chain needs them. If branch protection blocks a merge, ship stops and reports.
- **`--ui-test`** — opt-in end-of-run browser pass (default off). After the resulting PR(s) are open, one `ui-tester` subagent verifies the acceptance criteria's behavioral checks against the assembled branch and posts the evidence to the PR(s). Per-ticket builds always run headless regardless of this flag.
- **`--parallel [N]`** — opt-in concurrent walk (default off — the walk is serial). Ship computes the **ready set** — tickets whose `blocked_by` dependencies are all terminal — and builds each ready ticket concurrently in its own isolated git worktree, up to N in flight (default 3), greedily dispatching newly-unblocked tickets as workers finish. It applies to epic runs and multi-solo runs; a pure dependency chain walks one ticket at a time either way. In a [multi-repo workspace](#multi-repo-workspaces) the run is partitioned into **per-repo lanes** from the tickets' `repos:` frontmatter: lanes run concurrently against their own repo checkouts (cross-repo parallelism needs no worktrees), worktrees are provisioned only for a lane running two or more of its tickets at once, and N stays one global cap across lanes. Integration merges (one at a time, revalidated per merge), ticket state transitions, and lessons-log writes stay serialized in the orchestrator, and a failed worker doesn't abort its siblings — the end-of-run report names what needs a serial resume. Parallel mode requires the [worktree setup contract](#worktree-setup) (`worktree:` block + optional `.worktreeinclude`) — in a multi-repo workspace only for lanes doing intra-repo concurrency; when the contract is absent or a worktree setup fails, ship logs why and falls back to the serial walk (per lane, in a lane run).

## Multi-repo workspaces

A workspace where `claudedocs/tickets/` sits next to several sibling git repositories (the workspace folder itself is not a git repo, but its immediate children have `.git`) is **multi-repo**. Discover detects this shape automatically — no configuration involved — and appends a `repos:` frontmatter field to the tickets it creates:

```yaml
repos: [big-leaves-api, big-leaves-astro]
```

- Values are **exact on-disk directory names**, never shortened.
- Epics carry the union of their children's repos; each child carries its own subset. The decomposition tables show a `Repos` column so you can check whether a split follows repo seams.
- One consumer parses the field: `ship --parallel` partitions its run into per-repo lanes from `repos:` (see the flag above). Everywhere else it is informational — at-a-glance visibility into a ticket's repo footprint.
- Single-repo workspaces (the common case) never see the field or the table column.
- The worktree setup contract has a multi-repo convention — workspace-level `worktree.setup`, per-repo `.worktreeinclude` — documented in [Worktree setup](#worktree-setup).

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

**Trust and secrets.** `worktree.setup` is the user's own declared command — the same trust tier as `validate.lint` and `test.start` — and follows the same execution discipline as `test.start` (see `skills/build/references/test-preflight.md`): the command is written verbatim into a script file with the Write tool — on a Bash-only surface, via a nonce-delimited single-quoted heredoc (`skills/review/references/pr-comments.md` §4) — never substituted into a shell command line, and ticket-derived text never goes into it. **No secrets in `config.yaml` or `.worktreeinclude`** — both are committed; patterns reference paths, never secret values, and the copied files stay gitignored in the worktree too.

**Multi-repo workspaces.** In a [multi-repo workspace](#multi-repo-workspaces) — where `config.yaml` is workspace-level and tickets carry `repos:` frontmatter — the contract splits along that line: `worktree.setup` is workspace-level config shared by every repo, so write it as **one repo-agnostic command** via manifest sniffing, while `.worktreeinclude` stays at each child repo's root (each repo lists its own gitignored needs; a repo may have none). Worked example for a workspace mixing Node and Go repos:

```yaml
# claudedocs/tickets/config.yaml — at the workspace root
worktree:
  setup: "if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi; if [ -f go.mod ]; then go mod download; fi"
```

The command runs inside whichever repo's worktree is being provisioned and sniffs that repo's manifests — the Node repos install dependencies, the Go repo downloads modules, and a repo matching neither runs nothing. The trust discipline above applies unchanged. Note on validation: a repo-relative `.worktreeinclude` pattern cannot reach the workspace-level `config.yaml` (it sits above the repo root) — and doesn't need to: multi-repo worktrees are created under the workspace root, so the validation hook's ancestor walk-up finds the workspace `config.yaml` and per-edit validation keeps firing inside them.

### MCP servers

Recommended for full functionality, but optional:

- **Playwright** — required for build's test checkpoint (UI testing).
- **Chrome DevTools** — enhanced browser testing.
- **Serena** — semantic code navigation; used by the `code-explorer` and `code-architect` agents when available, falling back to Grep/Glob/Read otherwise.
- **Personal server** — required only in server-native storage mode, where it *is* the ticket store. Shipped as a separate `server-native` plugin you install alongside `feature`; setup for both platforms is below.

### Storage mode and the personal server

A project stores its tickets in one of two modes, declared in `claudedocs/tickets/config.yaml`. Most projects want the default and can skip this section entirely.

```yaml
prefix: FP
mode: fs-native        # default — omit the key entirely and you get this
```

```yaml
prefix: FP
mode: server-native    # tickets are rows on an MCP server, not files
project: my-project    # required with server-native — the project's id in the server's registry
```

- **`fs-native`** — tickets are the folder tree under `claudedocs/tickets/` described in the [README](../../../README.md#tickets). A missing `mode` key or a missing `config.yaml` means this. Ticket reads and writes are entirely local.
- **`server-native`** — tickets are authoritative rows on a personal MCP server, and `project:` names the project in that server's registry. That server's tool surface spans several domains; the `feature` skills use only its `pipeline_*` tools. The state folders (`backlog/`, `in-progress/`, `review/`, `done/`) do not exist, and artifact bodies carry no frontmatter — the row is the only metadata source. `mode: server-native` with no `project` key is a config error, not a fallback.

`config.yaml` itself stays local in both modes: it is project execution config plus the mode marker, not ticket data.

Nothing else in this section matters unless you run `server-native`. If a `pipeline_*` tool is unavailable or a call fails in that mode, the skill **stops** naming the server and the failed operation — it never silently writes local files instead.

#### Claude Code setup

The server is **not** declared by the `feature` plugin. It lives in a second, separate plugin — **`server-native`** — that carries nothing but the server declaration: no skills, no agents, no hooks.

That split is the whole opt-in mechanism. Install `feature` alone and no MCP server is declared, so none connects and there is nothing to configure or switch off. Install `server-native` alongside it only when you actually run server-native projects:

```
feature                    → the 11 skills. Everyone installs this.
feature + server-native    → the same skills, plus the personal server.
```

`server-native` asks for two values when you install or enable it:

- **Personal server base URL** — the base URL only, *without* a trailing `/api/mcp`; the plugin appends that path. Use `https://` — the token travels as an `Authorization: Bearer` header, so an `http://` host sends it in cleartext.
- **Personal server API token** — the Bearer token your server accepts. It is marked sensitive, so answering the prompt puts it in your OS keychain rather than in a settings file or the repo.

Both are **required**, which is deliberate: an unconfigured value means the server is not registered at all rather than registered with a broken address. There is no "install it but leave it blank" state to reason about — you either install the connector and configure it, or you don't install it.

Three layers decide what a skill can call, and it pays to keep them apart:

- **The server** owns which tools exist. It is the sole source of truth for the tool surface — the connector cannot add, remove, or hide a tool, only reach the ones the server already exposes.
- **The manifest** owns the connection, the credential storage, and the namespace. Claude Code namespaces plugin-declared tools by their **declaring** plugin, so the callable names are `mcp__plugin_server-native_ps__pipeline_get_ticket` and friends — note `server-native`, not `feature`. A skill in one plugin may use a server declared by another.
- **`allowed-tools`** in a skill's frontmatter is a per-turn permission grant. Listing a tool lets the skill call it without prompting you; leaving one out does not remove it from the session — the call still happens, it just asks first. So a scoped name that has gone stale degrades into a permission prompt per call rather than an error.

#### Codex setup

The Codex manifest declares no MCP server, because Codex has no install-time prompting: the URL would have to be a committed literal. Add the server to your own `config.toml` instead:

```toml
[mcp_servers.ps]
url = "https://<your-host>/api/mcp"
bearer_token_env_var = "PERSONAL_SERVER_MCP_TOKEN"
```

Codex infers the transport from the presence of `url`, so the block needs no `type` key — unlike the Claude manifest, where `"type": "http"` is mandatory and a type-less entry is read as stdio and skipped.

`bearer_token_env_var` names an environment variable — Codex reads the token from it and sends `Authorization: Bearer <token>`, so the secret stays in your environment rather than in the file. Export it wherever you keep shell secrets:

```sh
export PERSONAL_SERVER_MCP_TOKEN='…'
```

Codex namespaces MCP tools without a plugin segment, so keying the block `ps` (as above) yields `mcp__ps__pipeline_get_ticket`. The skills' `allowed-tools` list the bare `pipeline_*` names alongside the Claude-scoped ones; the bare entry is how the skills name the tool, standing in for whatever your `config.toml` key makes the callable name. If your Codex version enforces `allowed-tools` against the qualified MCP name, add the qualified form to the affected skill's frontmatter — that name depends on your server key, which is why the plugin does not hardcode one.
