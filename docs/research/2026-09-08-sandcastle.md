# Sandcastle: what to borrow for a native Codex Goal runner

Inspected 2026-09-08. Sources pinned to main commit `e99f832f26dc9d245c019a9ddd19fa5dee792427`. This is a source review; no Sandcastle code was installed or executed.

## Status and fit

GitHub's API returned `archived: false`, `disabled: false`, and a last push of 2026-06-29. The latest main commit is a release merge dated 2026-06-29; the latest published non-prerelease is `v0.12.0`, also 2026-06-29. The repository's September `updated_at` is not evidence of a September code change. These are activity observations, not a maintainer support guarantee or proof of abandonment. [Repository metadata](https://api.github.com/repos/mattpocock/sandcastle), [pinned commit](https://github.com/mattpocock/sandcastle/commit/e99f832f26dc9d245c019a9ddd19fa5dee792427), [release](https://github.com/mattpocock/sandcastle/releases/tag/v0.12.0)

Sandcastle is a TypeScript orchestration library around external coding-agent processes. It supplies agent providers, sandbox providers, branch/worktree handling, process results, and lifecycle management. Its runtime can use Docker, Podman, Vercel, or a host-execution provider. That is a different deployment choice from the requested native Codex task with a Goal and a main agent implementing tickets. [README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md)

## The useful primitives

| Primitive | Source behavior | What our runner should borrow |
| --- | --- | --- |
| `run()` | Owns an invocation lifecycle and returns iterations, optional completion signal, stdout, commits, branch, logs, preserved-worktree path, and optional session resume/fork functions. | Return explicit machine-readable evidence and resource identifiers for every phase. |
| `createSandbox()` | Creates one reusable environment on an explicit branch; implement and review can reuse dependencies and filesystem state. | Separate workspace lifetime from individual execution/review phases. |
| `createWorktree()` | Owns a worktree independently of sandboxes; its run methods can choose sandbox providers. | Give one component ownership of workspace creation and cleanup. |
| `sandbox.exec()` | Exposes exit code/stdout/stderr; callers decide whether command failure blocks progression. | Check required tests with actual commands, outside a model's success prose. |
| Branch strategies | `head` operates in the existing checkout; `branch` uses a named branch; `merge-to-head` returns temporary-branch commits to the host using Git merge. | Choose branch/PR policy before execution and record the base commit. No implicit merging. |

[Run result contract](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts#L442), [sandbox API](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/createSandbox.ts), [worktree API](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/createWorktree.ts), [merge implementation](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxLifecycle.ts#L404)

`close()` and `await using` provide explicit cleanup. A sandbox close preserves a dirty worktree and returns its path; a clean worktree is removed. Operation cancellation is separate: an `AbortSignal` cancels the in-flight operation, while reusable handles remain available for inspection/resumption or explicit close. Factories deliberately do not take the operation's signal. Session fork isolates history, not the branch or workspace. [Close implementation](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/createSandbox.ts#L1082), [abort ADR](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0004-abort-signal-on-run-and-interactive.md), [fork contract](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/run.ts#L463)

For our prototype, preserve workspace/evidence on interruption and distinguish `cancel operation`, `pause ticket`, and `dispose workspace`. Never infer branch isolation from a fresh agent context.

## Templates are illustrations, not acceptance state machines

The repository explicitly describes its bundled templates as minimal demonstrations of orchestration shapes. [Template scope](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.out-of-scope/bundled-workflow-templates.md)

- **Simple loop:** repeatedly invokes an agent with fresh prompt expansion and a bounded iteration count, using `merge-to-head`. Its prompt owns issue selection and verification. This demonstrates serial work but does not supply our required evidence ledger. [Source](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/simple-loop/main.mts)
- **Sequential reviewer:** runs one implementation then one review in a shared sandbox/branch, with cleanup in `finally`. However, zero implementation commits stops the whole loop, conflating empty backlog with blocked/no-op/incomplete work. The review result is not inspected for an acceptance verdict. The outer code neither merges the named branch nor creates a PR. [Source](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/sequential-reviewer/main.mts)
- **Premature ticket closure:** the sequential implementation prompt closes the issue after its own tests/commit, before the subsequent review runs. The reviewer mutates code, rather than returning an independent read-only assessment. That ordering does not satisfy a contract requiring review and PR evidence before ticket completion. [Implement prompt](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/sequential-reviewer/implement-prompt.md), [review prompt](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/sequential-reviewer/review-prompt.md)
- **Parallel planner with review:** validates a planner's structured list, launches issue pipelines with `Promise.allSettled`, and sends fulfilled runs with any commits to a merger. It preserves sibling progress when one pipeline rejects, but its merge eligibility is not a verified acceptance/test verdict. Its unbounded mapping is also unsuitable as our default concurrency policy. [Source](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/parallel-planner-with-review/main.mts)

The engine correctly rejects observed nonzero agent exit codes, but completion itself is detected by finding a configured string in model output. Hitting the iteration cap returns without a completion signal; the caller must interpret that result. A post-signal grace timeout can also resolve with buffered output when the process hangs. Therefore a completion marker is a control signal, not proof that acceptance criteria passed. [Orchestrator](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/Orchestrator.ts)

## Codex support and boundaries

There is an actual `codex(model, options)` provider, not just generic-provider potential. It launches `codex exec --json`, supplies the prompt over stdin, parses events, and supports captured filesystem sessions plus resume/fork. This source-level support was not smoke-tested during this research. The default launch disables Codex approvals and sandboxing; its optional automatic-review mode uses `on-request` with `danger-full-access`. Do not copy that permission policy into the existing managed Codex session. [Codex provider](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts#L749)

## Decision for this prototype

Borrow the explicit phase sequence, typed outputs, workspace ownership, cancellation semantics, and separation between invocation and verification. Keep native Goal continuation as the outer runner. Let the main agent select and implement one ticket, then obtain a bounded independent review when available, repair, verify, and apply the requested PR policy.

Use distinct persisted outcomes: `ready`, `implementing`, `reviewing`, `verifying`, `pr-ready`, `complete`, and `blocked`, with commit-bound evidence. Only the acceptance gate advances the ticket; zero commits, a completion phrase, a stopped process, or an exhausted retry counter cannot complete it. Reconcile the real branch/PR/check state on resume.

Do not introduce Sandcastle as a dependency for this native prototype. Reconsider it when there is an explicit requirement for external CLI agents, container/cloud isolation, or separately managed parallel workers. Its useful contribution here is its small orchestration API and resource discipline; its sample ticket policies need stronger gates for the user's workflow.
