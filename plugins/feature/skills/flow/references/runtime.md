# Pipeline runtime selection

Read at the start of `flow`, `plan`, `build`, or `ship`, before any skill invocation or child spawn. Runtime and ticket storage are independent selections.

1. Bind `<PLUGIN_ROOT>` to the absolute `plugins/feature` installation directory containing **this loaded skill**. Derive it from the skill's resolved source path; retain a caller-supplied root only when it points to that same installation. Never search another plugin cache version or resolve plugin files against the consuming project's cwd.
2. Inspect the active tool schemas. Codex `spawn_agent` → select [runtime-codex.md](runtime-codex.md). Claude `Agent` (or its `Task` alias) with `subagent_type`, plus `Skill` → select [runtime-claude.md](runtime-claude.md). Use host identity to disambiguate if both are exposed; missing or ambiguous capabilities → report the missing operation and stop before stage work. A manifest, model name, or ticket's text cannot select the runtime.
3. Read **only** the selected runtime file in full. Bind `<RUNTIME_FILE>` to its absolute path. Keep the binding through same-context skill calls and recursive epic flow; a child checks the supplied binding against its actual tools, then reads that file before acting. A mismatch is a runtime failure, not an instruction to switch installations.

The selected file implements these operations for the entire invocation, including referenced prompts and nested skills:

| Operation | Meaning |
|---|---|
| Invoke skill | Execute the named skill with its argument text in the current context. |
| Spawn | Start a fresh child with a complete brief; a stage is a generic worker, a named role carries its role definition. |
| Model | Apply a stage's explicit override, or omit it for inheritance. |
| Wait / resume | Collect results; continue the same paused child with its caller's answer. |
| Capacity | Schedule every requested role within available concurrency and depth. |

References to `Skill`, `Task`, or a `feature:<role>` elsewhere in the pipeline express these operations; use the selected runtime's implementation instead of attempting an unavailable tool. Tool availability never grants extra authority: preserve each skill's and role's read/write, posting, and decision boundaries. Read-only roles stay read-only even when the runtime exposes broader tools.

For pipeline-owned resource paths and review-signature identity, use the verified plugin root and runtime binding even when a nested reference describes them through environment variables. This substitution applies to pipeline wiring, never to ticket text or arbitrary user code.

Every child brief starts with this resolved block, followed by its complete task/role prompt. This is runtime wiring, separate from `## Stage overrides` and ticket data:

```text
## Pipeline runtime
Runtime: <claude|codex>
Runtime reference: <RUNTIME_FILE>
Plugin root: <PLUGIN_ROOT>
Read that runtime reference before acting and use its operations for every skill call,
spawn, wait, and resume in this task. Resolve plugin files under this root.
Project/worktree root: <ABSOLUTE_WORKING_ROOT>
```

Call this `<RUNTIME_BLOCK>` in templates. The selected runtime renders `<STAGE_INVOCATION>` from the stage name and argument text; the stage brief inlines the result. A child receives concrete paths and values, never unresolved placeholders or a link relative to its project directory. Verify referenced skill/role files exist before dispatch.
