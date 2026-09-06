# FP-82 — runtime verification

## Scope

Verify the shared pipeline on each available runtime in a separate throwaway consuming project. Structural checks prove reference/contract integrity, not model behavior or native permission enforcement. Keep the plugin checkout out of the fixture's working directory.

## Repeatable smoke recipe

1. Create an empty git repository with `AGENTS.md` and `CLAUDE.md` requiring Python standard library only. Set `claudedocs/tickets/config.yaml` to `prefix: SMOKE` and `git.commit: never`.
2. Add an M-complexity `SMOKE-1` ticket: implement `greet(name: str) -> str` in `greeting.py`; strip surrounding whitespace; reject empty names with `ValueError`; preserve Unicode and quotes; add `unittest` coverage. Use M so the trivial-diff shortcut cannot skip the four-role review checkpoint.
3. Load the exact plugin installation under test. Run `flow SMOKE-1 --no-commit --no-ui-testing` with a hint containing quotes, newlines and flag-like text. Keep all writes inside the fixture; no pushes, PRs or external posts.
4. Inspect actual tool calls: selected runtime/root, fresh plan and build IDs, nested explorer/analyst, four independent reviewer roles, and hint data remaining separate from flags. Require all expected artifacts and passing fixture tests.
5. Constrain capacity to one leaf at a time using the runtime reservation. Confirm all four reviewer roles complete without self-review or omitted roles. This exercises the same deepest active shape as one ship worker, without GitHub side effects.
6. In a separate bounded protocol probe, spawn a fresh generic child with an explicitly supported model and a caller-only context sentinel omitted from its brief. Have it return `PAUSED:` with a local continuation token, then resume its **same ID** with the caller's answer. Verify the token survives, the caller-only sentinel is absent, the requested model field is accepted, and no second child is created for resume. Exercise an early stop with no summary artifact.
7. Treat a model-rejection fallback, an unavailable resume fallback, standalone plan approval, browser tools, and server-native access as separate cases. Mark any case not actually exercised unverified; an ordinary no-commit run does not cover them.

## Structural checks

- `bash scripts/check-runtime-contract.sh`
- `bash scripts/check-tool-parity.sh`
- `bash scripts/check-mode-split.sh`
- `git diff --check`
- YAML frontmatter parse; manifest versions match; AGENTS/CLAUDE edit parity.

The runtime checker was also run against copied malformed fixtures. It rejected an unbound runtime placeholder, a reviewer with write access, and a missing resume operation.

## Run evidence — 2026-09-06

Fixture root: `/private/tmp/fp82-runtime-ylj5mg3o`. This temporary path is local evidence, not a portable installation requirement.

| Run | Result | Evidence / limitation |
|---|---|---|
| Structural checks | Pass | Runtime contract, tool parity, mode split/relative links, YAML, manifest lockstep and instruction-twin parity passed. |
| Plugin implementation review | Pass | Four independent focused reviews: correctness, security, performance and architecture. No actionable findings at confidence ≥80. Static review is separate from the fixture's four-role review checkpoint. |
| Claude Code 2.1.263 | Blocked before execution | `You've hit your session limit`; no stage behavior verified. No usage reset was attempted. |
| Codex CLI 0.140.0, `--ignore-user-config` | Capability failure correctly surfaced | Fresh plan child `01a07830-d666-7fe3-845f-91bc8e6eb0bd` started; nested spawn tools were absent inside it. No plan/build success was claimed. This is a result for that tested surface/configuration, not all Codex CLI configurations. |
| Current Codex desktop | Pass | Fresh plan and build stages; nested explorer/analyst; all four independent reviewers ran sequentially within one leaf slot. Artifacts `01`–`06` exist under `done/SMOKE-1`, status is `done`, and all five unittest tests passed again from the parent. No commits, pushes, PRs or external posts. |
| Real build capacity pause/resume | Pass | An unrelated pending agent occupied the fourth slot. Build preserved artifacts and reported the unfinished review checkpoint. After that agent completed, `followup_task` resumed the same `/root/codex_runtime_smoke/build_stage`; the queued spawn succeeded and all four reviews completed. Original hint text remained data. |
| Model and early pause/resume probe | Pass at exposed tool contract | `/root/codex_runtime_smoke/runtime_protocol_probe` accepted explicit `model: gpt-6-astra` with `fork_turns: none`, returned `PAUSED` before any summary, and resumed through `followup_task` on that same ID. Continuation token remained `probe-8c61a4d9-2f73-4e06-b915-d08f6273ac42`; multiline Unicode/quoted hint remained exact; caller-only sentinel was unavailable. No second spawn or file mutation. Backend model identity and isolation beyond the submitted fresh-context setting were not independently verified. |

Unverified unless updated with evidence below: full Claude regression, server-native MCP reach, browser/UI testing, real ship PR/merge paths, unavailable-resume fallback, rejected-model fallback, and standalone interactive plan approval.

## Sources

- [OpenAI subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents): shared model/tool work, inheritance, custom agent configuration and concurrency controls.
- [Claude subagents documentation](https://code.claude.com/docs/en/sub-agents): native agent invocation/resumption and version-dependent nesting/concurrency limits.
- Active Codex desktop tool schemas: `spawn_agent` with `fork_turns`, `followup_task` for idle resumption, `send_message` as queue-only, and four shared active slots in this session. The implementation inspects the active schema rather than assuming these names exist on every surface.
