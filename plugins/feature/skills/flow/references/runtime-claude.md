# Pipeline runtime — Claude Code

Read only when selected by [runtime.md](runtime.md). These operations apply to every nested pipeline skill and child in this run.

## Invoke skill

Use `Skill` with `skill: feature:<name>` and the complete `args` string. Render `<STAGE_INVOCATION>` as:

```text
Invoke the Skill tool with skill feature:<stage> and args <ARGUMENT_TEXT>.
```

The argument is tool data, never a shell command. Plan gets the ticket argument plus `--auto`; build gets the ticket argument plus its propagated flags. The stage brief's user-hint block is build's optional hint input.

## Spawn and models

Use the active `Agent` tool (`Task` on surfaces exposing that name) with `subagent_type: general-purpose` for stage, ship worker and generic arbiter children. Use the registered `feature:<role>` for explorer, analyst, reviewers and UI tester as their calling skill prescribes; its existing agent definition controls role tools and model. The generic arbiter receives its calling reference's complete read-only prompt. Prefix every prompt with the resolved `<RUNTIME_BLOCK>` from [runtime.md](runtime.md). Use a new agent instance, not a conversation fork.

For a stage override, `inherit` → omit `model`; otherwise pass the user's requested alias or model ID verbatim in `model`. Follow stage-briefs §2 for model-rejection fallback. Do not alter the registered role models or global runtime settings.

## Wait and resume

Retain each returned agent ID and collect its result using the active tool's foreground result or background completion mechanism. A timeout or progress update is not a final report. A `PAUSED:` report is a turn boundary, not completion of the stage.

Resume that same ID with `SendMessage` (`to` = agent ID, message = the caller's answer, using the active schema). It resumes a completed subagent where supported. On a surface exposing resume through the spawn tool instead, use its documented resume field with the same ID. If neither mechanism can resume, use stage-briefs §5's bounded artifact fallback. A permission denial or user cancellation is not a missing resume capability.

## Capacity

Launch the four independent reviewers concurrently when capacity permits. When the runtime reports a concurrency limit, wait for already-running children to finish before dispatching the remaining roles; collect all four before merging findings. Never retry a capacity failure as a model failure, skip a role, or close a paused stage to free a slot.

Count subagent layers below the current caller: `flow → stage → role` needs two; `ship → worker → stage → role` needs three. Check exposed depth constraints before dispatch; a missing nested spawn tool or explicit depth rejection stops that stage with a capability error, preserving artifacts. Do not assume a universal numeric limit or modify user settings. For `ship --parallel`, reserve capacity for each worker's stage plus at least one leaf role; reduce the effective worker count and print the change when the exposed limit requires it.

Claude's native skill invocation, registered role definitions, artifact routing, and pause/answer behavior otherwise remain unchanged.
