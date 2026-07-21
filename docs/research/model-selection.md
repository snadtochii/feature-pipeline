# Model selection for feature-pipeline subagents

Research date: 2026-07-15

## Executive recommendation

Yes: a main-thread model can launch a child on a different or smaller model, but the control plane is runtime-specific.

- **Claude Code** has a mature, documented path: put a role default in each plugin agent's Markdown frontmatter, and let the main thread override it for a particular invocation when needed.
- **Codex** can select a child model and reasoning effort per spawn when that spawn-tool surface exposes the override fields, or through a custom agent TOML file. However, Codex's public plugin format currently does not document bundled agents, while this plugin ships Claude-style `agents/*.md` through an undocumented `agents` manifest field. Treat the current `model: opus` declarations as Claude settings, not portable Codex settings.

The best first change is therefore **role-based defaults with runtime-native selection and graceful inheritance**, not a new user-facing `--model` flag:

1. On Claude Code, move exploration, requirements analysis, performance review, and UI testing from `opus` to `sonnet`; keep correctness, security, and architecture review on `opus`.
2. On Codex, request `gpt-5.6-terra` at medium effort for code exploration and `gpt-5.6` for judgment-heavy roles; if per-spawn overrides are hidden or unavailable, retry/invoke without a pin and inherit the parent/runtime choice.
3. Do not add model names to ticket `config.yaml` yet. They are provider-specific, model availability changes, and neither runtime offers the same deterministic dynamic mechanism from a portable `SKILL.md`.
4. First make Codex spawning explicitly runtime-aware; do not rely on `.codex-plugin/plugin.json`'s current `agents` field until OpenAI documents it or a tested Codex-specific packaging path is added.

This keeps quality high where a missed finding is expensive while reducing the routine Opus fan-out.

## Official runtime behavior

### Claude Code

Claude Code custom subagents are Markdown files with YAML frontmatter. Their `model` field accepts the aliases `sonnet`, `opus`, `haiku`, and `fable`, a full model ID accepted by `--model`, or `inherit`; omitting the field is equivalent to `inherit`. Claude resolves a subagent model in this precedence order: `CLAUDE_CODE_SUBAGENT_MODEL`, a per-invocation `model` argument, the agent's `model` frontmatter, then the main conversation's model. If an organization allowlist excludes a requested model, Claude skips it and uses the inherited model. [Claude Code subagent model selection](https://code.claude.com/docs/en/sub-agents#choose-a-model)

Therefore, the answer to the inbox question is **yes on Claude Code**: an Opus main thread can launch an exploration agent on Sonnet or Haiku, either because that agent is statically configured that way or because the main thread supplies the model for that invocation.

Important constraints:

- `CLAUDE_CODE_SUBAGENT_MODEL` is global for subagents and has higher precedence than both the per-invocation request and agent frontmatter. It is an escape hatch, not a per-role policy. [Claude Code subagent model selection](https://code.claude.com/docs/en/sub-agents#choose-a-model)
- Extended thinking is inherited from the main conversation and has no per-subagent setting. [Claude Code subagent model selection](https://code.claude.com/docs/en/sub-agents#choose-a-model)
- A Claude skill may declare static `model` and `effort` frontmatter. That override lasts for the current turn, and `context: fork` plus `agent` runs the skill in the named agent's environment. This is useful for a fixed workflow, but it is not a provider-neutral dynamic configuration system. [Claude Code skill frontmatter](https://code.claude.com/docs/en/slash-commands#frontmatter-reference), [running a skill in a subagent](https://code.claude.com/docs/en/slash-commands#run-skills-in-a-subagent)
- The model selection belongs to the executing agent or invocation, not to arbitrary prose inside the skill. A skill can instruct the main model to choose an invocation override, but an ordinary static frontmatter value cannot be computed from a ticket config at runtime.

Current Claude model positioning supports a conservative tier split: Anthropic describes Sonnet 5 as the best speed/intelligence combination, Opus 4.8 as intended for complex agentic coding, and Haiku 4.5 as fastest with a smaller context. The published API rates are $3/$15 per million input/output tokens for Sonnet 5, $5/$25 for Opus 4.8, and $1/$5 for Haiku 4.5; these rates illustrate the relative tradeoff but do not necessarily equal Claude Code subscription billing. [Anthropic model comparison and pricing](https://platform.claude.com/docs/en/about-claude/models/overview#latest-models-comparison)

### OpenAI Codex

Current local Codex clients support built-in `default`, `worker`, and `explorer` agents. User/project custom agents are standalone TOML files under `~/.codex/agents/` or `.codex/agents/`; `name`, `description`, and `developer_instructions` are required, while `model`, `model_reasoning_effort`, sandbox, MCP, and skill configuration inherit from the parent when omitted. [Codex subagents and custom-agent schema](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)

Codex's official guidance says unpinned orchestration can balance speed, price, and intelligence; it recommends `gpt-5.6-terra` for fast, read-heavy exploration and `gpt-5.6` for demanding ambiguous work. Higher reasoning effort increases latency and token use but can improve complex-task quality. Model availability depends on the account and loaded catalog; `gpt-5.3-codex-spark` is a Pro-only research-preview option rather than a safe plugin default. [Codex model and reasoning guidance](https://learn.chatgpt.com/docs/agent-configuration/subagents#choosing-models-and-reasoning)

The current open-source implementation confirms more precise per-spawn behavior:

- `spawn_agent` can accept optional `model` and `reasoning_effort` fields, but the tool builder conditionally removes them unless `expose_spawn_agent_model_overrides` is enabled. A skill cannot assume every Codex surface will expose them. [Codex spawn tool schema](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)
- When exposed, the requested model must exactly match a loaded model that supports the active multi-agent backend; invalid values return an error and a short list of available models. Reasoning effort is also validated against that model. [Codex model override validation](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_common.rs)
- In MultiAgent V2, a full-history fork inherits the parent agent type, model, and effort and rejects those overrides. Use `fork_turns: "none"` or a bounded positive turn count when selecting a different child model. [Codex V2 spawn implementation](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)

Therefore, the answer is also **yes on Codex**, with two qualifications: the override must be exposed by the active surface, and a different-model child cannot be a full-history fork. The plugin's existing self-contained subagent briefs fit `fork_turns: "none"` well.

Codex skills do not currently have the Claude-specific `model`, `effort`, `context: fork`, and `agent` frontmatter contract in the public Codex skill documentation. The documented portable `SKILL.md` core is `name` plus `description`, with instructions and optional resources; model selection belongs to Codex agent/spawn configuration rather than to a portable skill declaration. [Codex skill format](https://learn.chatgpt.com/docs/build-skills#create-a-skill)

## Codex plugin portability finding

There is a real format mismatch in this repository:

- `.codex-plugin/plugin.json` declares `"agents": "./agents/"`.
- `agents/*.md` use Claude Code's Markdown schema and all declare `model: opus`.
- The repo contains no `.codex/agents/*.toml` definitions.

OpenAI's current public plugin schema lists `skills`, `mcpServers`, `apps`, and `hooks` as bundled components; its documented plugin structure does not include `agents`, and Codex's documented custom agents are TOML files in user/project `.codex/agents/` directories. [Codex plugin manifest fields](https://learn.chatgpt.com/docs/build-plugins#manifest-fields), [Codex custom agents](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agents)

This does **not** prove that the current Codex desktop build ignores the plugin's Markdown agents: there may be a compatibility or unpublished loader in the installed client. It does mean that behavior is not a safe public contract. In particular, there is no basis to interpret Claude's `model: opus` alias as an OpenAI model selection. The design should preserve this as a bounded compatibility uncertainty and test it directly, not silently assume translation.

## Current feature-pipeline policy and cost shape

All seven custom agent definitions hard-code `model: opus`:

| Agent | Spawned by | Current policy |
|---|---|---|
| `code-explorer` | `discover`, `plan` | Opus |
| `requirements-analyst` | `plan` | Opus |
| `code-reviewer` | `build` | Opus |
| `security-engineer` | `build` | Opus |
| `performance-engineer` | `build` | Opus |
| `code-architect` | `build` | Opus |
| `ui-tester` | `build`, optional `ship` UI pass | Opus |

`AGENTS.md` explicitly says every agent pins Opus. `skills/build/SKILL.md` launches four reviewer agents concurrently and may then launch the UI tester; its trivial-diff short-circuit can avoid the four reviewers, and the UI reachability pre-flight avoids launching a tester against an unreachable app. `skills/build/references/test-preflight.md` and `skills/build/SKILL.md` also embed the word “Opus,” so those references would drift if the policy changes.

`ship` has another category: its implementer, independent reviewer, and address hops use generic/full-tool subagent types rather than the seven custom agent files. They have no feature-pipeline model policy and therefore inherit or follow runtime orchestration. The optional assembled-branch UI pass does use `feature:ui-tester`.

A non-trivial `plan → build` can therefore launch six custom Opus children before UI testing (two planning agents plus four reviewers), or seven with UI testing. Running `discover` first adds another explorer. This is exactly the workload where role-tiering is worthwhile: high parallel fan-out multiplies token and latency cost even when the main thread is already a high-capability model.

## Proposed model-selection design

### 1. Define semantic role tiers, then map them per runtime

Use two policy tiers rather than embedding a model brand into operational prose:

- **scan**: bounded, read-heavy, evidence-gathering work whose result is checked or synthesized by the main thread.
- **judgment**: ambiguous decisions or high-cost-to-miss findings.

Recommended defaults:

| Role | Tier | Claude default | Codex default | Rationale |
|---|---|---|---|---|
| `code-explorer` | scan | `sonnet` | `gpt-5.6-terra`, medium | Read-heavy mapping; main/analyst synthesizes it. Sonnet is preferred over Haiku by default because codebase exploration benefits from the larger current context. |
| `requirements-analyst` | judgment | `sonnet` | `gpt-5.6`, high | Needs ambiguity detection, but no code mutation; Sonnet is a sensible Claude cost/quality midpoint. |
| `code-reviewer` | judgment | `opus` | `gpt-5.6`, high | Correctness misses directly affect shipped code. |
| `security-engineer` | judgment | `opus` | `gpt-5.6`, high | Highest cost of a false negative. |
| `performance-engineer` | scan | `sonnet` | `gpt-5.6-terra`, high if supported; otherwise medium | Diff-oriented evidence scan, with findings confidence-filtered and merged. |
| `code-architect` | judgment | `opus` | `gpt-5.6`, high | Cross-file pattern and boundary reasoning. |
| `ui-tester` | scan | `sonnet` | `gpt-5.6`, medium | Procedural tool use with explicit acceptance criteria; use the general model rather than Terra because this role acts, writes specs, and debugs browser state. |

This is deliberately conservative: it reduces routine Opus use without downgrading correctness, security, or architecture. Haiku can later become an opt-in economy choice after evaluation, but its smaller current context makes it a risky default for broad repository exploration.

### 2. Keep the selection runtime-native

**Claude Code path**

- Change each `agents/*.md` `model` field according to the table.
- Keep aliases rather than pinned full IDs so the plugin tracks the user's available/current family and organization policy.
- Permit a per-invocation promotion to `opus` for unusually complex exploration or requirements work. The environment override remains authoritative.

**Codex path**

- In every skill that spawns, use a self-contained brief and `fork_turns: "none"` when requesting a role-specific model.
- If the active `spawn_agent` schema exposes `model` and `reasoning_effort`, request the table's Codex default.
- If those fields are hidden, or the exact model is unavailable, spawn without them and inherit/allow Codex orchestration to choose. Never fail a pipeline solely because an optimization model is unavailable.
- Do not treat `agents/*.md` as Codex model configuration. Use built-in `explorer`/generic children plus self-contained role instructions until bundled Codex custom agents have a documented packaging mechanism. If the installed Codex compatibility loader is intentionally retained, test it as an optimization, not as the only path.

### 3. Do not add flags or ticket config in the first iteration

Avoid `--fast`, `--cheap`, `--quality`, or a `models:` block in `claudedocs/tickets/config.yaml` initially:

- The identifiers and valid reasoning levels differ by runtime and account.
- Claude's environment override, Claude per-invocation model, Codex per-spawn override, and Codex agent TOML all have different precedence.
- A new flow flag would need propagation through `flow → plan → build`, Stage Contract updates, standalone-skill behavior, resumption semantics, and fallback rules for an optimization that can already be expressed through native runtime controls.

First collect quality/cost evidence from the role defaults. If users later need a portable user control, add one semantic policy such as `model_policy: economy | balanced | quality`, map it per runtime, and never store provider model IDs in tickets.

### 4. Fallback contract

The operational rule should be:

1. Apply an explicit user/runtime override when present.
2. Otherwise request the role default when the surface supports it.
3. On unavailable/hidden/unsupported model or effort, retry once without the optimization and inherit the parent/runtime model.
4. Record a short diagnostic in the stage artifact; do not convert model selection into a `partial` or `stuck` verdict.
5. Do not silently downgrade a judgment role to the cheapest model. Its fallback is inheritance, not a hard-coded smaller model.

On Claude, organization allowlist fallback is already built in. On Codex, an invalid explicit spawn override errors, so the skill must own the one retry without model/effort.

## Files affected by an implementation

Minimum policy change:

- `agents/code-explorer.md`
- `agents/requirements-analyst.md`
- `agents/code-reviewer.md`
- `agents/security-engineer.md`
- `agents/performance-engineer.md`
- `agents/code-architect.md`
- `agents/ui-tester.md`
- `AGENTS.md` (replace the all-Opus invariant with the role-tier table and runtime split)

Operational/runtime wiring:

- Add `skills/flow/references/model-selection.md` as the shared cross-stage contract.
- Link/invoke it from `skills/discover/SKILL.md`, `skills/plan/SKILL.md`, `skills/build/SKILL.md`, and `skills/ship/SKILL.md` at each spawn point.
- Update `skills/build/SKILL.md` and `skills/build/references/test-preflight.md` to remove model-brand wording such as “Opus ui-tester.”
- Update `docs/advanced.md` with native override and fallback behavior.
- Audit `.codex-plugin/plugin.json`'s undocumented `agents` field. Remove it only after the Codex runtime-neutral spawn path is verified; retaining it temporarily is safer than breaking an existing compatibility loader, but it must not be described as a documented guarantee.

No ticket artifact schema, state transition, flow flag, or `config.yaml` field needs to change in the first iteration.

## Validation and test plan

Use a separate consuming project, per this repo's dev-loop rule.

1. **Static validation**
   - Parse every agent's YAML frontmatter.
   - Confirm Claude aliases are only `sonnet`/`opus` for the proposed defaults.
   - Confirm reviewer tool budgets remain read-only.
   - Grep for stale “every agent pins Opus,” “Opus ui-tester,” and equivalent wording.
   - Validate `.codex-plugin/plugin.json` with the current Codex plugin tooling and explicitly note whether `agents` is accepted, ignored, or rejected.

2. **Claude Code behavior**
   - Reload the plugin, start a high-capability main session, and invoke one agent from each tier.
   - Verify the child transcript/status reports the expected model.
   - Exercise a per-invocation promotion of `code-explorer` to Opus.
   - Set `CLAUDE_CODE_SUBAGENT_MODEL` once and verify it overrides the role default.
   - If possible under a managed test account, exclude a role model and verify inheritance rather than pipeline failure.

3. **Codex behavior**
   - Start a new task after local plugin reinstall.
   - Inspect the active `spawn_agent` schema. Test both cases: override fields exposed and hidden.
   - With overrides exposed, spawn `code-explorer` using `fork_turns: "none"`, Terra, and medium effort; verify the child thread's model metadata.
   - Confirm that the same override with `fork_turns: "all"` is rejected, then confirm the documented non-full fork succeeds.
   - Request a nonexistent model, verify the error is bounded, retry without the pin, and confirm the child completes on inheritance.
   - Determine empirically whether `feature:*` Markdown agents are loaded by the Codex plugin. Record the result by Codex version; do not make the pipeline depend on it unless OpenAI documents the contract.

4. **Pipeline regression**
   - Run `discover` and `flow` on one small UI ticket and one non-trivial backend ticket.
   - Verify plan artifacts, four-way review merge, UI pre-flight, test artifact, and verdict behavior are unchanged.
   - Verify the trivial-diff reviewer skip and unreachable-app UI skip still avoid unnecessary children.
   - Run `ship` once to confirm its generic implementer/reviewer inheritance is unaffected and its optional UI pass uses the new policy.

5. **Evaluate the tradeoff**
   - Compare child count, input/output tokens, wall time, review findings accepted, reviewer failures, and post-review defects across a small fixed ticket corpus.
   - Promote a scan role back to the judgment tier if it materially loses accepted findings; consider Haiku only if Sonnet shows excess cost with no quality advantage on that corpus.

## Bottom line

The plugin should stop equating “subagent” with “Opus.” Use Sonnet/Terra for bounded evidence collection and retain the strongest models for correctness, security, and architecture. Claude Code can implement this immediately through agent frontmatter. Codex can do it through exposed per-spawn overrides or custom-agent TOML, but the plugin must first remove its dependency on the undocumented assumption that Claude-style Markdown agents—and especially `model: opus`—are portable Codex agent configuration.
