# Codex Goals and Matt Pocock skills: execution design findings

Research date: 2026-09-08. This note covers original-source product and skill behavior. It does not establish the cause of any particular failure in the shared run; that requires the run transcript and repository history. Remote skill links target the current `main` branch and may change.

## What Codex Goals actually provide

**Documented:** Goals persist an objective within the current task and support continuation across turns. Continuation occurs at idle boundaries, with no queued user input or pending work. Interruptions, budgets, and blockers can stop progress. Plan-only work does not trigger continuation; a continuation without a tool call suppresses another automatic continuation. Completion requires concrete evidence. Goals are suitable for uncertain, multistep paths to a clear finish line. They do not favor vague goals: the official guidance asks for outcome, verification, constraints, boundaries, iteration policy, and blocked-stop conditions. [OpenAI: Using Goals in Codex](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)

**Current tool contract in this session:** `create_goal` may run only when explicitly requested, fails while another unfinished goal exists, and accepts an optional explicitly requested token budget. `get_goal` exposes state/accounting. `update_goal` supports complete or blocked; blocked requires the same impasse across at least three consecutive goal turns. User/system controls pause, resume, and budgets. These are observations of this session's supplied tool descriptions, not claims that every Codex client exposes identical tools.

**Implication:** Use one epic-level Goal with per-ticket acceptance checkpoints when the desired behavior is autonomous traversal. Treat the ticket loop as execution policy beneath that Goal. Neither the documentation nor the current contract promises a fresh context at ticket boundaries, automatic per-ticket Goal replacement, isolated worktrees, or a dependency scheduler. Those require explicit design.

## Agent capacity is a runtime constraint, not a universal Codex constant

**Documented:** `agents.max_concurrent_threads_per_session` caps concurrently open spawned-agent threads, excluding the primary task. When unset, Codex chooses a default. `agents.max_threads` is a legacy alias. The configuration also exposes default subagent model/reasoning settings. `features.goals` enables persisted goals and automatic continuation. [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

**Observed here:** This session's collaboration instructions advertise four total concurrent slots including the root. Its tools are `spawn_agent`, `followup_task`, `interrupt_agent`, `list_agents`, and messaging/waiting operations. That surface is not identical to every public configuration/tool description. Do not infer the failed run's available slots from this research session, nor change global settings as a substitute for inspecting the actual runtime.

**Design inference:** A serial implementation loop should succeed with zero review parallelism. Where independent review requires a child, reserve one child slot, make the main agent the implementation owner, and perform review sequentially. Capacity failure should cause scheduling/backoff or a documented fallback, not a scope/acceptance decision for the user. Avoid retaining multiple orchestration ancestors solely to forward instructions.

## What Matt Pocock's current skills contribute

The original repository describes small composable skills and offers editable installation for Codex; its README lists a native Codex plugin as roadmap work. This is a collection of engineering disciplines rather than evidence of a fully implemented Codex Goal runner. [Matt Pocock skills README](https://github.com/mattpocock/skills)

| Source | Useful contract | Fit for an autonomous ticket runner |
| --- | --- | --- |
| [implement](https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/implement/SKILL.md) | Implement a spec/tickets; use TDD at agreed seams; run regular focused checks and one final full suite; review; commit. | A very small execution spine. It does not define dependency selection, restart state, PRs, independent-work ownership, or failure recovery. |
| [to-tickets](https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/to-tickets/SKILL.md) | Independently verifiable vertical slices sized for one context window, explicit blockers, dependency frontier. Wide refactors may use expand–migrate–contract and an integration branch. | Strong ticket preparation. It includes user approval of the breakdown, so it belongs before unattended execution when tickets are already refined. |
| [code-review](https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/code-review/SKILL.md) | Separate standards and spec reviews, each in a parallel subagent; require a fixed diff baseline and spec source. | Good review axes, but directly adopting it preserves parallel-agent demand and missing-input questions. Supply the inputs up front and adapt scheduling. |
| [tdd](https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/tdd/SKILL.md) | Observable behavior at public interfaces; one failing test then implementation per slice; independent expected values. | Useful test quality discipline. It explicitly requires confirming seams with the user before writing tests, so agreements must be carried from ticket refinement into execution. |
| [wayfinder](https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/wayfinder/SKILL.md) | A durable index of decisions, on-demand ticket context, a dependency frontier; normally one decision ticket per session. | Useful inspiration for context indexing, but it is primarily planning, not an epic implementation runner. |

**A concrete composition mismatch to resolve:** `implement` calls review before committing, but `code-review` specifies `git diff <fixed-point>...HEAD`. That comparison excludes uncommitted implementation changes. A runner must define a review snapshot that includes the actual changes, or create a checkpoint commit before review. This is an inference from the two source files, not a demonstrated incident in the user's run. [implement](https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/implement/SKILL.md), [code-review](https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/code-review/SKILL.md)

## Proposed operating contract

This is a design recommendation, not documented Codex behavior:

1. Resolve the epic, declared ticket roster, dependency graph, existing branch/PR evidence, and execution policy once. Establish completion and review criteria before entering the loop.
2. Select one ready ticket. Load its spec, prerequisite results, relevant repository guidance, and a compact durable execution record.
3. Reuse a valid plan if one is necessary and already exists. Otherwise plan only enough to resolve implementation risk; do not repeat intake or require a separate stage agent by default.
4. Implement in the main agent. Run relevant focused checks as feedback. Record the actual commands and results.
5. Review the complete change against acceptance criteria and standards. Use at most one independent reviewer at a time; fix actionable findings in context and review the changed areas again when needed.
6. Run final required checks and any explicitly applicable UI verification. Record a reason for each permitted skip; missing required evidence is not a pass.
7. Apply the requested commit/PR policy. Bind ticket completion evidence to a commit and, when applicable, a PR URL. Distinguish implemented/open-PR from merged.
8. Persist the ticket result, select the next eligible ticket, and continue. Complete the outer Goal only when every in-scope ticket meets the declared finish condition and the epic integration check passes.

The durable execution record should retain ticket ID, phase, base/head commits, current branch/worktree, review result, test evidence, PR URL, and exact next action. A resume should reconcile these fields against current repository/PR state instead of trusting a narrative summary.

## Packaging decision

Start with a Codex-specific runner contract inside the existing marketplace and reuse storage/ticket/PR primitives where their contracts fit. A separate plugin may be a convenient installation boundary once that runner is proven, but splitting repositories or duplicating every storage concern does not itself fix execution ambiguity. Evaluate the runner first against serial execution, one reviewer slot, interrupted runs, review fixes, existing PRs, and blocked dependencies. Keep the Claude-oriented nested stage workflow available while measuring the Codex path on a separate consuming project.
