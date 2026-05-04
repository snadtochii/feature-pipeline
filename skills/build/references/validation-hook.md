# Validation Hook

Build runs lint and typecheck after every meaningful change. The recommended delivery is a `PostToolUse` hook on `Write|Edit`, with skill-body validation as the always-on companion. The two layers are intentionally redundant — see "Why both layers always run" below.

## Layer 1 — Hook (recommended in Claude Code and Codex)

### Claude Code via plugin (preferred)

The plugin ships `hooks/hooks.json` declaring a `PostToolUse` entry that matches `Write|Edit|MultiEdit`, executes `${CLAUDE_PLUGIN_ROOT}/hooks/validate.sh`, and reads lint/typecheck commands from `claudedocs/tickets/config.yaml`. Users get the hook automatically when they enable the plugin; opt-in is by populating the `validate:` block in `config.yaml`:

```yaml
prefix: FP
validate:
  lint: "bun run lint"
  typecheck: "bun run typecheck"
```

The hook auto-detects the project root by walking up from the edited file looking for `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `mix.exs`, or `tsconfig.json`, bounded above by the workspace dir (the directory containing `claudedocs/tickets/config.yaml`). It `cd`s to the discovered project root before running the configured commands, so `bun run lint` finds the right `package.json` even when the workspace is a monorepo with the project in a subdir. Override the marker list via `validate.cwd_markers` if your project uses different conventions.

If `validate:` is absent or its keys are empty, the hook is a silent no-op. `jq` is a required dependency for the hook script (without it the hook is also a silent no-op with a one-line stderr warning); `yq` is recommended for richer YAML support but not required.

### Claude Code via user settings.json (alternative)

Users who prefer their own configuration can add an equivalent hook to `~/.claude/settings.json` or a project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "bun run lint && bun run typecheck"
          }
        ]
      }
    ]
  }
}
```

Substitute the project's actual lint/typecheck commands. Plugin-shipped and user-settings hooks merge additively — both fire — which is harmless and consistent with "Why both layers always run" below.

### Codex

Codex supports the same `PostToolUse` event name. Configure in `~/.codex/hooks.json` or `~/.codex/config.toml`. Requires the `codex_hooks = true` feature flag (per https://developers.openai.com/codex/hooks).

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "bun run lint && bun run typecheck"
          }
        ]
      }
    ]
  }
}
```

### Aider

Aider doesn't expose `PostToolUse` natively. Its closest equivalent is the `--auto-lint` flag (and `--auto-test`), which run after each commit rather than after each edit. Acceptable as a coarser-grained alternative; the skill-body fallback below covers the gap during the build loop.

## Layer 2 — Skill-body fallback (always on)

Build's body always runs lint and typecheck via `Bash` after every meaningful change, regardless of whether a hook is configured. The skill body:

1. Reads project `CLAUDE.md` at build start
2. Extracts lint/typecheck commands (looks for `## Commands`, `## Validation`, `## Testing`, or inline references like `npm run lint`/`pnpm test`/`cargo check`/`pytest`)
3. Runs each documented check after every meaningful change in the implement checkpoint
4. Fixes failures in-context before proceeding

If project `CLAUDE.md` documents no validation commands, build logs a one-line warning and proceeds without validation. Graceful degradation — the skill still works on projects without a documented setup.

## Why both layers always run

The two layers run simultaneously by design. Trade-off acknowledged: when both fire on the same edit, the lint/typecheck commands execute twice. Acceptable because:

1. **Lint caches make the second run near-free.** ESLint, ruff, mypy, tsc all cache aggressively; a no-op second invocation is typically sub-second.
2. **"Always run" eliminates a class of false-confidence bugs.** "Did the hook actually fire?" is a real question — hook configuration drift, harness updates, or matcher mismatches can silently disable validation. The skill-body fallback is the floor.
3. **The build skill stays correct in harnesses without hooks.** Aider, Copilot CLI, and generic SDKs lack `PostToolUse`; conditional logic that disables fallback when "a hook is detected" would require per-harness branching the skill body shouldn't carry.

If a project genuinely cannot tolerate the duplication (e.g., a slow custom validator), users can omit lint/typecheck commands from their project `CLAUDE.md` and rely on the hook alone. The skill-body fallback gracefully no-ops in that case.

## Verdict-side handling

Validation failures inside the implement checkpoint are observations the loop consumes — fix them in-context, then continue. They do not exit the loop with a verdict. Stuck-detection patterns in `stuck-detection.md` cover the case where validation failures repeat (action↔error repetition) and the loop can't recover.
