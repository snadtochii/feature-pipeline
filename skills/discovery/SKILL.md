---
name: discovery
description: "Turn a rough feature idea into a ready-to-implement ticket through interactive Socratic dialogue. Use when user says 'I want to add', 'let's build', 'discover this feature', or 'new feature idea'. NOT for running the pipeline on an existing ticket."
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - TodoWrite
argument-hint: "[description] [--project name] [--id XX-N]"
---

# Feature Discovery

Interactive requirements discovery that transforms a rough idea into a detailed, ready-to-implement ticket spec.

## Arguments

```
/feature-pipeline:discovery $ARGUMENTS
```

- `$ARGUMENTS` — the rough idea, feature request, or problem statement (can include pasted text, images, file references) plus optional flags
- `--project <name>` — which personal project this is for (used in ticket frontmatter)
- `--id <XX-N>` — explicit ticket ID (auto-generated if omitted)

### Examples
```
/feature-pipeline:discovery I want to add dark mode to the app
/feature-pipeline:discovery I need a way to filter the task list by priority and date range --project big-leaves
/feature-pipeline:discovery The settings page is confusing, users can't find where to change their email --project symphony --id SY-12
/feature-pipeline:discovery (with screenshot pasted) This design needs to be implemented
```

## Discovery Process

The skill runs in **main context** (interactive) through these phases:

---

### PHASE 0: ENSURE TICKET INFRASTRUCTURE

1. **Check if `claudedocs/tickets/` directory exists** in the project root
2. If not:
   - Ask the user for a **ticket prefix** for this project (e.g., `BL` for big-leaves, `SY` for symphony)
   - Create the full structure:
     ```
     claudedocs/tickets/
     ├── backlog/
     ├── in-progress/
     └── done/
     ```
   - Write the config to `claudedocs/tickets/config.yaml` so future runs don't need to ask again. Initial content:
     ```yaml
     prefix: <PREFIX>
     ```
     This file is the source of truth for tickets-system configuration. Future fields go here too — do not introduce new dotfiles for additional config.
3. If `claudedocs/tickets/` already exists, read the prefix from `claudedocs/tickets/config.yaml` (parse the YAML and extract the `prefix` field)
   - If `config.yaml` is missing, scan existing ticket filenames to infer the prefix, or ask the user. Once known, write `config.yaml` so the next run doesn't repeat the inference.
4. Read the ticket template from this plugin's directory: find the `TEMPLATE.md` file co-located with this SKILL.md
   - This template defines the frontmatter schema and section structure
   - Use it as the base format for ticket generation in Phase 4

---

### PHASE 1: UNDERSTAND THE INPUT

1. **Parse the input**:
   - Extract the core idea/problem from the description
   - Note any images — analyze them for UI designs, wireframes, error screenshots, or architecture diagrams
   - Note any file references — read them for additional context
   - Identify the project (from `--project` flag, or ask if not obvious)

2. **Determine project root**:
   - If `--project` is provided, locate it (check common paths, ask if ambiguous)
   - If in a project directory already, use current working directory
   - The project root is needed for codebase exploration

3. **Quick acknowledgment** — confirm what you understood:
   ```
   ## Understanding Your Request

   **Idea**: [1-2 sentence summary of what you understood]
   **Project**: [project name]
   **Type**: [new feature | enhancement | bug fix | refactor]

   Let me explore the codebase first, then we'll flesh this out together.
   ```

---

### PHASE 2: EXPLORE THE CODEBASE

Spawn a `feature-pipeline:code-explorer` subagent to understand the relevant codebase context:

**Prompt**: "Explore the codebase at `<project-root>` to understand the areas relevant to: `<idea summary>`. Focus on: existing related features, patterns used, file structure, tech stack, and any existing implementations that overlap with this idea. Return a concise summary of what exists and how this feature would fit in."

This runs as a **background subagent** — continue to Phase 3 while it explores.

**Preserve the full explorer output** — do not just summarize it for the Socratic questions in Phase 3. The full output gets written to `00-exploration.md` in Phase 4 so that the `analyze` stage can reuse it instead of re-exploring the same codebase.

---

### PHASE 3: SOCRATIC DISCOVERY

Guide the developer through targeted questions to flesh out requirements. This is the core interactive phase.

**Approach**: Ask 3-5 questions at a time, grouped by theme. Don't dump 20 questions at once. Iterate based on answers.

**Recommend, don't just elicit**: For every question, propose your default answer first — informed by the codebase exploration, the input, and sensible product judgment. The user confirms, overrides, or asks for alternatives. This converts decisions you can reasonably make into confirmations and reserves the user's attention for genuine product/UX trade-offs. Format each question as:

```
1. <question>
   **Default**: <your proposed answer> — <one-line rationale>
```

If a question genuinely has no defensible default (pure product/UX preference, business priority, personal taste), flag it explicitly: `**Default**: (no default — this is your call)`. Don't fabricate a recommendation when you don't have one.

**Themes are guides, not gates**: The themes below are areas to cover, not a fixed sequence. Skip themes that don't apply (e.g., UX for a backend-only feature). Re-enter a theme whenever new information demands it — see "Iteration rules" below.

#### Theme: Core Intent
Focus on the "what" and "why":
- What problem does this solve? Who experiences it?
- What does success look like? How would you know it's working?
- Is there a specific trigger or user action that starts this feature?
- Any existing workarounds or partial solutions?

#### Theme: Scope & Boundaries
Focus on defining edges:
- What's the simplest version that would be useful? (MVP)
- What should this explicitly NOT do? (Out of scope)
- Any related features it needs to work with?
- Any constraints (performance, accessibility, platform support)?

#### Theme: User Experience (if UI-facing)
Focus on the user journey:
- Walk me through the ideal user flow, step by step
- What happens on error? Empty state? Loading?
- Any specific design preferences or references?
- Mobile/responsive requirements?

#### Theme: Technical Considerations (informed by codebase exploration)
Use the code explorer results to ask informed questions:
- "I see you're using [pattern X] for similar features — should this follow the same pattern?"
- "There's an existing [component/service] that does something related — should we extend it or build new?"
- "The current [architecture layer] handles [related thing] — does this fit there?"
- Any API/data requirements? New endpoints needed?

**Iteration rules**:
- **Themes loop, they don't queue**: cover each relevant theme, but re-enter any theme as often as needed. There is no fixed number of batches and no rule that one theme must finish before another begins.
- **Synthesize then check**: after each batch, restate what you've understood. If the user's answer is ambiguous, contradicts an earlier answer, leaves a hole the spec needs filled, or opens a sub-decision you didn't ask about, run another pass on that theme with clarifying questions before moving on. Don't paper over ambiguity to keep momentum.
- **Escalate to depth-first grilling on high-coupling branches**: if a single decision has answers that cascade into multiple dependent sub-decisions (e.g., "schema-first vs code-first" each implying different storage / migration / API choices), drop the batched cadence for that branch. Switch to one question at a time, walk the decision tree depth-first, and resolve each fork before backing out. Keep providing your recommended default at every node. Return to themed batching once the branch is resolved.
- **Stop when coverage is good enough** to write a clear spec — driven by coverage, not by a fixed count. Simple features may need a single batch; high-coupling or ambiguous ones may take many, especially with depth-first detours.
- **Match depth to complexity** — don't over-question simple features.
- **Respect "enough"**: if the developer says "that's enough" or "let's move on", proceed to spec creation with the best ticket you can write.

---

### PHASE 4: GENERATE THE TICKET

1. **Generate ticket ID** (if not provided via `--id`):
   - Scan `claudedocs/tickets/` for existing IDs to determine next number
   - Read prefix from `claudedocs/tickets/config.yaml` (`prefix` field)
   - Format: `<PREFIX>-<N>` (no leading zeros, e.g., `BL-1`, `BL-2`, `BL-15`)

2. **Create the ticket folder** at `claudedocs/tickets/backlog/<PREFIX>-<N>/` (folder name is just the ID — no slug). The folder is the unit of organization; everything for this ticket (spec, artifacts, bugs, state) lives inside.

3. **Write the spec** to `claudedocs/tickets/backlog/<PREFIX>-<N>/01-spec.md`. The spec file IS the ticket — frontmatter for metadata, body for the content:

   ```markdown
   ---
   id: <generated-or-provided>
   title: <clear, concise title>
   priority: <assessed from discovery>
   complexity: <S | M | L | XL — assessed from scope>
   status: backlog
   created: <today's date>
   project: <project name>
   tags: [<relevant tags>]
   ---

   ## Description
   <Clear description of what needs to be built and why.
   Written from the synthesis of discovery dialogue.
   Include context that would help someone unfamiliar understand the motivation.>

   ## User Story
   As a <user type>, I want <goal> so that <benefit>.

   ## Acceptance Criteria
   - [ ] <Specific, testable criterion derived from discovery>
   - [ ] <Each criterion should be verifiable>
   - [ ] <Include happy path and key edge cases>

   ## Design Notes
   <Any wireframes, screenshots, design references, or UI decisions from discovery.
   If images were provided, reference them here.>

   ## Technical Notes
   <Informed by codebase exploration:
   - Relevant existing patterns/components to leverage
   - Architecture decisions
   - API requirements
   - Dependencies or integration points
   - Suggested approach (brief, not a full plan)>

   ## Out of Scope
   <Explicit boundaries from the scope discussion.
   What this ticket does NOT include.>

   ## Discovery Notes
   <Brief summary of key decisions and rationale from the discovery dialogue.
   Useful context for the analyze and plan stages.>
   ```

4. **Persist the Phase 2 exploration for the analyze stage**:
   - Write the full Phase 2 explorer output to `claudedocs/tickets/backlog/<PREFIX>-<N>/00-exploration.md` (same folder as the spec)
   - Include a short header at the top of the file:
     ```
     # Exploration — <ticket-id>
     **Source**: discovery skill, Phase 2
     **Date**: <today's date>
     **Scope**: broad exploration of areas relevant to the feature idea (not yet ticket-scoped — analyze will do targeted follow-up)
     ```
   - This artifact is read by `analyze` as a seed for incremental exploration, avoiding a second full codebase sweep. If discovery's exploration was thin (e.g., small or purely-UI feature), still write the file so analyze can see what discovery covered.

5. **Present the ticket**:
   ```
   ## Ticket Created

   **Folder**: claudedocs/tickets/backlog/<ticket-id>/
   **ID**: <ticket-id>
   **Title**: <title>
   **Complexity**: <S/M/L/XL>
   **Priority**: <priority>

   [Show the full ticket content]

   → Edit if you want to adjust anything
   → Run `/feature-pipeline:flow <ticket-id>` to start the pipeline
   → Run `/feature-pipeline:flow <ticket-id> --only analyze` to just analyze first
   ```

---

## Complexity Assessment Guide

Assess complexity based on discovery findings:

| Size | Signal |
|------|--------|
| **S** | Single file change, clear scope, no new patterns needed |
| **M** | 2-5 files, follows existing patterns, moderate scope |
| **L** | 5-10 files, new patterns or components, cross-cutting concerns |
| **XL** | 10+ files, new architecture, multiple subsystems affected |

## Priority Assessment Guide

If the developer doesn't specify priority, assess from context:

| Priority | Signal |
|----------|--------|
| **critical** | Blocking other work, data loss risk, security issue |
| **high** | Key user-facing feature, significant improvement |
| **medium** | Nice to have, planned enhancement |
| **low** | Polish, minor improvement, tech debt |

## Handling Different Input Types

### Text-only description
Standard flow — go through all phases.

### Description + images
- Analyze images in Phase 1
- If they're UI designs: extract layout, components, interactions, states
- If they're error screenshots: identify the problem, affected area
- If they're architecture diagrams: understand system context
- Use image insights to ask more targeted questions in Phase 3

### Description + file references
- Read referenced files in Phase 1
- Use file content to understand existing context
- Skip redundant codebase exploration for areas already covered by referenced files

### Very vague input ("I want to improve things")
- Spend more time in the Core Intent theme
- Ask broader exploratory questions first
- Help the developer narrow down before going into specifics

### Very detailed input (pre-thought-out feature)
- Acknowledge the detail level
- Skip redundant discovery questions
- Focus Phase 3 on gaps, edge cases, and things not mentioned
- Move faster to ticket generation

## Important Rules

1. **Be conversational, not interrogative** — this is a dialogue, not a survey
2. **Lead with a recommendation** — every question carries your proposed default with a one-line rationale; ask the user only when judgment is genuinely theirs (product/UX trade-offs, business priorities, personal preference). Resolve trivial or codebase-driven decisions yourself with a stated default.
3. **Synthesize as you go** — restate what you've understood after each batch, and re-enter a theme if the synthesis surfaces ambiguity or new questions
4. **Match depth to complexity** — don't over-discover simple features, and don't under-discover coupled ones (escalate to depth-first grilling when a decision branch cascades)
5. **Use codebase context** — make questions specific to the project, not generic
6. **Create the ticket, don't just discuss** — always end with a concrete artifact
7. **Respect "enough"** — if the developer wants to move on, create the best ticket you can
8. **No implementation** — this skill discovers and documents, it does not code
