---
name: discovery
description: Interactive feature discovery for personal projects. Takes a rough idea (text, images, files), explores the codebase, guides through Socratic requirements discovery, and produces a detailed ticket spec ready for /feature-pipeline:feature-flow. Use as step 0 before the pipeline.
---

# Feature Discovery

Interactive requirements discovery that transforms a rough idea into a detailed, ready-to-implement ticket spec.

## Arguments

```
/feature-pipeline:discovery <description> [--project <name>] [--id <XX-N>]
```

- `<description>` — the rough idea, feature request, or problem statement (can include pasted text, images, file references)
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

1. **Check if `.tickets/` directory exists** in the project root
2. If not:
   - Ask the user for a **ticket prefix** for this project (e.g., `BL` for big-leaves, `SY` for symphony)
   - Create the full structure:
     ```
     .tickets/
     ├── backlog/
     ├── in-progress/
     ├── review/
     └── done/
     ```
   - Save the prefix to `.tickets/.prefix` (plain text, just the prefix string) so future runs don't need to ask again
3. If `.tickets/` already exists, read the prefix from `.tickets/.prefix`
   - If `.prefix` file is missing, scan existing ticket filenames to infer the prefix, or ask the user
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

---

### PHASE 3: SOCRATIC DISCOVERY

Guide the developer through targeted questions to flesh out requirements. This is the core interactive phase.

**Approach**: Ask 3-5 questions at a time, grouped by theme. Don't dump 20 questions at once. Iterate based on answers.

#### Round 1: Core Intent
Focus on the "what" and "why":
- What problem does this solve? Who experiences it?
- What does success look like? How would you know it's working?
- Is there a specific trigger or user action that starts this feature?
- Any existing workarounds or partial solutions?

#### Round 2: Scope & Boundaries
Focus on defining edges:
- What's the simplest version that would be useful? (MVP)
- What should this explicitly NOT do? (Out of scope)
- Any related features it needs to work with?
- Any constraints (performance, accessibility, platform support)?

#### Round 3: User Experience (if UI-facing)
Focus on the user journey:
- Walk me through the ideal user flow, step by step
- What happens on error? Empty state? Loading?
- Any specific design preferences or references?
- Mobile/responsive requirements?

#### Round 4: Technical Considerations (informed by codebase exploration)
Use the code explorer results to ask informed questions:
- "I see you're using [pattern X] for similar features — should this follow the same pattern?"
- "There's an existing [component/service] that does something related — should we extend it or build new?"
- "The current [architecture layer] handles [related thing] — does this fit there?"
- Any API/data requirements? New endpoints needed?

**Iteration rules**:
- After each round, synthesize what you've learned before asking more
- If answers reveal new areas, add focused follow-up questions
- Stop when you have enough to write a clear spec (usually 2-4 rounds)
- Don't over-question simple features — match depth to complexity
- If the developer says "that's enough" or "let's move on", proceed to spec creation

---

### PHASE 4: GENERATE THE TICKET

1. **Generate ticket ID** (if not provided via `--id`):
   - Scan `.tickets/` for existing IDs to determine next number
   - Read prefix from `.tickets/.prefix`
   - Format: `<PREFIX>-<N>` (no leading zeros, e.g., `BL-1`, `BL-2`, `BL-15`)

2. **Generate ticket filename**:
   - Prefix with the ticket ID, then slugify the title: lowercase, hyphens, no special chars
   - Format: `<PREFIX>-<N>-<slug>.md`
   - Example: `BL-1-dark-mode-toggle.md`, `SY-12-task-list-filtering.md`

3. **Write the ticket** to `.tickets/backlog/<PREFIX>-<N>-<slug>.md`:

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

4. **Present the ticket**:
   ```
   ## Ticket Created

   **File**: .tickets/backlog/<slug>.md
   **ID**: <ticket-id>
   **Title**: <title>
   **Complexity**: <S/M/L/XL>
   **Priority**: <priority>

   [Show the full ticket content]

   → Edit if you want to adjust anything
   → Run `/feature-pipeline:feature-flow <ticket-id>` to start the pipeline
   → Run `/feature-pipeline:feature-flow <ticket-id> --only analyze` to just analyze first
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
- Spend more time in Phase 3 Round 1 (core intent)
- Ask broader exploratory questions first
- Help the developer narrow down before going into specifics

### Very detailed input (pre-thought-out feature)
- Acknowledge the detail level
- Skip redundant discovery questions
- Focus Phase 3 on gaps, edge cases, and things not mentioned
- Move faster to ticket generation

## Important Rules

1. **Be conversational, not interrogative** — this is a dialogue, not a survey
2. **Synthesize as you go** — show what you've understood after each round
3. **Match depth to complexity** — don't over-discover simple features
4. **Use codebase context** — make questions specific to the project, not generic
5. **Create the ticket, don't just discuss** — always end with a concrete artifact
6. **Respect "enough"** — if the developer wants to move on, create the best ticket you can
7. **No implementation** — this skill discovers and documents, it does not code
