# stack-first

A stack-agnostic dependency guard for Claude Code and Codex. It keeps dependency decisions deliberate: consult your project's preferred ecosystem before adding a library, and record every ruling.

It ships **zero** ecosystem facts and **zero** project rulings — everything project-specific lives in the consuming repo's `docs/STACK.md`.

## What's in it

- **`stack-first` skill** — a model-invocable, five-step tech-selection procedure. Triggers on any dependency/library/framework/tool selection moment, including plan-time recommendations. It reads `docs/STACK.md`, checks for an existing ruling, live-checks the preferred ecosystem for an in-ecosystem analog (verifying current status/docs), surfaces the trade-off, and records the verdict as a ledger row before any install.
- **Non-blocking install-command hook** — a `PreToolUse` hook on the `Bash` tool. When a command adds a dependency (`pnpm add`, `pnpm install <pkg>`, `npm install <pkg>`, `npm i <pkg>`, `yarn add`, `bun add`), it emits a reminder to run the `stack-first` skill. It **never blocks** — the install always proceeds. Bare lockfile installs (`npm install`, `pnpm i`) and shadcn CLI invocations (`npx shadcn`, `pnpm dlx shadcn`, `bunx shadcn-ui`, local `pnpm shadcn`) are exempt.

Command filtering lives in the hook script, not the matcher — matchers match tool names only.

## The `docs/STACK.md` ledger

Your project supplies its own ledger at the repo root `docs/STACK.md`. The skill offers to create it when absent.

- **Header** declares the preferred ecosystem — a name and its index URL.
- **Rows** record one decision each: `Package | Status (adopted | exception | rejected) | Date | Reason`.

The row format is documented so the ledger can be hand-edited directly, outside the skill. See the skill body (`skills/stack-first/SKILL.md`) for the full contract.

## Install

Enable the plugin from the marketplace that ships it, then trust its hook.

- **Claude Code:** `/plugin install stack-first@feature`
- **Codex:** add the marketplace, then install the `stack-first` plugin.

### Post-install trust requirement

Plugin hooks require trust after installation on **both** runtimes. Until you trust the plugin, its `PreToolUse` hook does not run — the reminder will not fire. Trust the plugin after installing so the install-command guard activates.
