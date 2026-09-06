# Pipeline runtime — Codex

Read only when selected by [runtime.md](runtime.md). Inspect the active tool schemas; names may be namespaced, and supported arguments differ between Codex surfaces. These operations apply to every nested pipeline skill and child in this run.

## Invoke skill

Read `<PLUGIN_ROOT>/skills/<name>/SKILL.md` and follow it in the **current** agent context with the supplied argument text bound as `$ARGUMENTS` (`$1` is the ticket argument). Resolve that skill's relative references against its own directory. A mention of `Skill feature:<name>` means this procedure; no Claude `Skill` tool is required and no additional child is created by loading a skill.

Render `<STAGE_INVOCATION>` as:

```text
Read <ABSOLUTE_SKILL_PATH> and execute its instructions here with these invocation
arguments bound as $ARGUMENTS: <ARGUMENT_TEXT>
Resolve its relative references against <ABSOLUTE_SKILL_DIRECTORY>.
```

Argument text is data, never shell code. Plan receives the ticket argument plus `--auto`; build receives the ticket argument plus its propagated flags, with the hint supplied by the separate user-hint block. Load project `AGENTS.md` as the primary project instructions and also read applicable `CLAUDE.md` for shared project conventions; host instructions settle conflicts. If standalone plan asks for native plan mode and no such tool is exposed, perform the same interactive planning/approval dialogue in the current task and save only after the user's approval. Under flow, `--auto` continues to select its non-interactive path.

For a main-context `AskUserQuestion` operation, use an available user-input tool or a concise conversational question and wait for the answer. A stage subagent uses the shared `PAUSED:` protocol to reach the caller instead; a user-input tool's absence never authorizes choosing an answer with no default.

## Spawn and models

Use `spawn_agent` with a complete prompt and **`fork_turns: "none"` whenever that field exists**, including inherited-model stages and all independent reviewers. Never omit this field on a schema where omission copies the full history. On a schema without it, use its documented fresh-child equivalent (for example `fork_context: false` when exposed); if fresh creation cannot be established, stop with `Codex runtime: fresh child context unavailable` rather than claim context isolation.

Use the generic full-tool child supported by the active schema; no Claude `subagent_type` or assumed custom-agent registry name. Prefix every prompt with the resolved `<RUNTIME_BLOCK>` from [runtime.md](runtime.md), followed by its complete brief. Include the actual project/worktree root, ticket inputs, flags, applicable caller constraints, and any role-specific review rubric. Readable plugin resources and permitted project/MCP access are prerequisites; name missing capabilities rather than changing storage mode or permissions.

`inherit` → omit `model` and `reasoning_effort`. An explicit stage model → pass that exact Codex model ID when `model` is exposed; keep `fork_turns: "none"`. If `model` is hidden, omit it and print the stage-briefs §2 notice. A model-specific runtime rejection gets one retry without `model`, retaining fresh context. Capacity, permission, missing-tool and context-shape errors are not model rejections. Never translate `opus`/`sonnet` into an OpenAI model or modify config to satisfy an override.

## Named roles and boundaries

For every `feature:<role>` spawn, read `<PLUGIN_ROOT>/agents/<role>.md` before spawning and inline its **body** into the child's brief with the caller's task prompt. Do not rely on Claude Markdown agents being registered as Codex custom agents, and do not send their Claude `model:` value to Codex. Roles inherit the runtime model; stage flags affect only the stage. Missing role file → report the missing path and stop that checkpoint.

Translate the role's declared tool budget into explicit operational boundaries in the brief:

- Explorer, analyst, all four reviewers and arbiter: read-only inspection and reports. No file edits, git mutations, network writes, project test execution, or further delegation. Read/search tools may be implemented through shell commands only when those commands are read-only. Optional semantic or web tools remain optional.
- UI tester: retain the role's permitted browser actions and test-spec writes, plus the caller's auth/workdir constraints. Use only available browser tools; report an unavailable test capability through the existing test checkpoint rather than inventing a passing result.
- Generic stage/ship workers: retain the invoked skill's operational budget and the caller's overrides. A ship independent reviewer may post only the PR review explicitly authorized by its calling brief; it may not edit code.

These are task instructions, not a claim of native tool filtering. Inherited sandbox and approval controls continue to apply. Every role receives a fresh prompt with its own body and boundaries; previous reviewers' findings never enter another independent reviewer's prompt.

## Wait and resume

Keep the returned child ID. Use `wait_agent`/`wait` and `list_agents` or the active surface's completion event to collect results. A notification or timeout is not a final result: inspect the delivered completion report before advancing. Wait for running children instead of repeatedly listing unchanged status.

When a stage returns `PAUSED:`, keep its ID. After the caller answers, use **`followup_task`** with that ID and the answer; it starts a new turn on an idle child. `send_message` on that surface only queues a message and cannot replace this operation. On schemas exposing `send_input` instead, use it only when its contract starts a turn on the existing child; use `resume_agent` first if that schema requires it for a closed child. Then wait for the same child's next report. A rejected permission request or user cancellation must be surfaced, not bypassed through another child.

Use stage-briefs §5's artifact fallback only when no available operation can resume the child. Do not re-spawn merely because a child returned a final `PAUSED:` message.

## Capacity

Read the active surface's concurrency/depth limits and agent status before scheduling. Count ancestors and other agents exactly as that surface counts them; do not assume Claude's limits or that idle/completed children release capacity. Release only this run's completed children whose reports have been collected, and only through a supported close/release operation. Preserve paused stages. If the runtime counts only running agents, completed children need no release.

For build's review checkpoint, dispatch at most the available slots, wait for that batch, then run the remaining roles with the same shared review input. All four roles must return before findings are merged. The explorer then analyst are sequential; the UI tester and arbiter use the same fresh-spawn operation.

For `ship --parallel`, each active worker requires capacity for **worker + stage + at least one leaf role**. With a shared limit of four including the root, admit one worker and run its leaf roles serially. Let `F` be the slots remaining after accounting for the caller, unrelated agents, and every existing worker-tree reservation. Admit at most `floor(F / 3)` new trees, also respecting the requested N minus workers already in flight. Pass the reservation to each worker so it uses only its reserved leaf capacity; do not let one worker consume a sibling's reservation. If limits are not exposed, dispatch one worker tree at a time and leaf roles serially; report the conservative cap.

A capacity rejection queues only the unstarted work and waits for a known running child whose completion can free a slot, then retries once after that change. If no such child exists, or completed children still occupy all slots and no release operation exists, stop with a capacity error and the unfinished role list. Missing nested spawn tools or a depth rejection are capability errors, not reasons to run the stage inline or review its own implementation. Preserve artifacts; never deadlock by waiting on parents that are waiting for children.
