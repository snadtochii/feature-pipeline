---
name: discover
description: "Turn a feature idea into one or more ready-to-implement tickets (solo, or an epic with child tickets)."
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

Interactive requirements discovery that transforms a rough idea into one or more detailed, ready-to-implement ticket specs. Discovery decides whether the idea is a single ticket or a multi-sibling effort under an epic.

## Arguments

```
/feature:discover $ARGUMENTS
```

- `$ARGUMENTS` — the rough idea, feature request, or problem statement (can include pasted text, images, file references) plus optional flags
- `--project <name>` — which personal project this is for (used in ticket frontmatter)
- `--id <XX-N>` — explicit ticket ID. In single-ticket mode, this is the ticket's ID. In multi-sibling mode, this is the **parent epic's** ID; children get the next available IDs in sequence.

### Examples
```
/feature:discover I want to add dark mode to the app
/feature:discover I need a way to filter the task list by priority and date range --project big-leaves
/feature:discover The settings page is confusing, users can't find where to change their email --project symphony --id SY-12
/feature:discover (with screenshot pasted) This design needs to be implemented
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
4. Read the ticket templates from this skill's `templates/` subfolder:
   - `templates/task.md` — task spec template (used for solo tickets and for children of an epic)
   - `templates/prd.md` — epic PRD template (used only when discovery emits multiple siblings)

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

Spawn a `feature:code-explorer` subagent to understand the relevant codebase context:

**Prompt**: "Explore the codebase at `<project-root>` to understand the areas relevant to: `<idea summary>`. Focus on: existing related features, patterns used, file structure, tech stack, and any existing implementations that overlap with this idea. Return a concise summary of what exists and how this feature would fit in."

This runs as a **background subagent** — continue to Phase 3 while it explores.

**Preserve the full explorer output** — do not just summarize it for the Socratic questions in Phase 3. The full output gets written to `exploration.md` in Phase 4 so that the `plan` stage's Phase 1 synthesis can reuse it instead of re-exploring the same codebase. The file lives at the epic-folder level when discovery emits multiple siblings (so it's shared and lives once, not duplicated per child) and at the ticket-folder level when discovery emits a single ticket.

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
- **Respect "enough"**: if the developer says "that's enough" or "let's move on", proceed to scope assessment with the best understanding you have.

---

### PHASE 3.5: SCOPE ASSESSMENT & DECOMPOSITION CHECKPOINT

Once Phase 3 coverage is "enough", assess whether the discovered work is best expressed as **one ticket** or **multiple sibling tickets under an epic**.

**Signals that suggest multi-sibling output (N>1)**:
- Multiple distinct user stories surfaced during Phase 3 (each could deliver value on its own)
- Estimated complexity is XL (>10 files, multiple subsystems)
- The scope crosses architecture layers in a way that splits cleanly (e.g., schema → service → UI, each independently verifiable)
- Natural ordering exists ("we need X before we can build Y")
- The discovery surfaced clear seams — vertical slices, horizontal layers, or a foundational + dependent structure

**Signals that suggest single-ticket output (N=1)**:
- One coherent change, one user-facing outcome
- Estimated complexity is S/M/L
- No clean independent slices — splitting would create artificial boundaries
- Acceptance criteria all relate to one feature, no clear ordering between them

#### When N=1: skip the checkpoint

Proceed directly to Phase 4 (single-mode). Do not show a checkpoint UI — there is nothing to decide. This keeps the single-ticket UX identical to what it was before discovery learned to split.

#### When N>1: present the checkpoint

Show the proposal **before creating any tickets**:

```
## Proposed Output: <N> Sibling Tickets under an Epic

I recommend splitting this into <N> tickets sharing epic `<epic-slug>`. Here's the proposed structure:

**Parent epic**: <EPIC-ID> — <epic title>

**Children**:

| # | Tentative ID | Title | Complexity | Covers AC | blocked_by |
|---|---|---|---|---|---|
| 1 | <CHILD-1-ID> | <title> | M | 1, 2 | — |
| 2 | <CHILD-2-ID> | <title> | M | 3, 4 | <CHILD-1-ID> |
| 3 | <CHILD-3-ID> | <title> | S | 5 | <CHILD-1-ID> |

### Acceptance Criteria Coverage
- [x] AC 1 → <CHILD-1-ID>
- [x] AC 2 → <CHILD-1-ID>
- [x] AC 3 → <CHILD-2-ID>
...

### Ordering Rationale
<Why this dependency chain — what foundational work each early child unlocks for later siblings>

### Why split (vs single ticket)?
<One-paragraph rationale — which seam was used, why a single ticket would be unwieldy>

→ Approve to generate
→ Adjust (change titles, merge children, change ordering, change `blocked_by`)
→ Collapse to one ticket (treat as N=1 single-ticket discovery)
```

**Validation before proposing**:
- Every gathered acceptance criterion is assigned to at least one child
- No child is complexity L or XL (would defeat the split)
- First child has no `blocked_by` dependencies on siblings
- Each child has at least 2 acceptance criteria (otherwise fold into adjacent child)
- Total children: 2-7. If the natural split exceeds 7, present that to the user and offer to group related children.

Iterate with the user until they approve, adjust, or collapse to single-ticket. On "collapse", proceed to Phase 4 single-mode using the gathered material.

---

### PHASE 4: GENERATE THE TICKET(S)

Two modes: **single-ticket** (N=1, the default-collapsed output) and **multi-sibling** (N>1, after checkpoint approval).

#### Generate ticket IDs

Determine the next available number by scanning the **entire** `claudedocs/tickets/` tree — recursively, not just the top level. Child tickets of an epic live nested under `<state>/<EPIC>/tasks/<CHILD>/` and draw their IDs from the **same single sequential numbering space** as top-level tickets, so a top-level-only scan can hand out an ID a nested child already uses.

Scan mechanic: read the configured prefix from `claudedocs/tickets/config.yaml` (`prefix` field), then collect every folder anywhere under `claudedocs/tickets/**` whose name matches `<PREFIX>-<N>` — the folder name IS the ID (no slug), so match folder names rather than parsing frontmatter. Ignore folders whose prefix doesn't match the configured one. Parse the numeric `<N>` from each match, take the maximum, and allocate from `max + 1`. If no folder matches (first ticket of the project), start at `<PREFIX>-1`. Format: `<PREFIX>-<N>`, no leading zeros (e.g., `BL-1`, `BL-2`, `BL-15`); IDs need not be contiguous — gaps left by deleted tickets are fine, never backfill them.

- **Single-mode**: allocate one ID — `<PREFIX>-<max+1>`.
- **Multi-mode**: allocate `N + 1` IDs as `max+1 … max+1+N`. The first (`max+1`) goes to the parent epic, the next `N` go to the children in checkpoint order.
- If `--id <XX-N>` was provided: in single-mode, that's the ticket's ID; in multi-mode, that's the parent epic's ID, and the children are allocated from the tree-wide scan as the next IDs after `max(existing tree max, supplied epic N)` — not blindly `<XX-N+1>`, which can collide with a higher-numbered nested child.
- **`--id` collision check**: before using any `--id`-supplied ID, check whether a folder with that ID already exists anywhere in the tree — top-level or nested under `tasks/`. If it does, warn the user and pause for explicit confirmation before reusing it; never silently overwrite or proceed.

#### Single-mode (N=1)

1. **Create the ticket folder** at `claudedocs/tickets/backlog/<TICKET-ID>/` (folder name is just the ID — no slug).

2. **Write the spec** to `claudedocs/tickets/backlog/<TICKET-ID>/01-spec.md` using `templates/task.md`. The spec file IS the ticket — frontmatter for metadata, body for the content.

3. **Write the exploration** to `claudedocs/tickets/backlog/<TICKET-ID>/exploration.md` (no `00-` prefix — numbering is reserved for stage artifacts in task folders). Include a short header at the top:
   ```
   # Exploration — <TICKET-ID>
   **Source**: discover skill, Phase 2
   **Date**: <today's date>
   **Scope**: broad exploration of areas relevant to the feature idea (not yet ticket-scoped — plan's Phase 1 synthesis will do targeted follow-up)
   ```
   Then the full Phase 2 explorer output verbatim. This artifact is read by `plan`'s Phase 1 synthesis as a seed for incremental exploration, avoiding a second full codebase sweep. If exploration was thin (e.g., small or purely-UI feature), still write the file so plan can see what discovery covered.

4. **Present the ticket**:
   ```
   ## Ticket Created

   **Folder**: claudedocs/tickets/backlog/<TICKET-ID>/
   **ID**: <TICKET-ID>
   **Title**: <title>
   **Complexity**: <S/M/L/XL>
   **Priority**: <priority>

   [Show the full ticket content]

   → Edit if you want to adjust anything
   → Run `/feature:flow <TICKET-ID>` to start the pipeline
   → Run `/feature:plan <TICKET-ID>` to just plan first (Phase 1 synthesis surfaces gaps and patterns before build)
   ```

#### Multi-mode (N>1)

1. **Create the parent epic folder** at `claudedocs/tickets/backlog/<EPIC-ID>/` and the children container at `claudedocs/tickets/backlog/<EPIC-ID>/tasks/`.

2. **Generate an `epic` slug** from the discovery topic (lowercase, hyphenated; e.g., `dark-mode-rollout`). This becomes the shared `epic:` value across the parent and all children.

3. **Write the parent PRD** to `claudedocs/tickets/backlog/<EPIC-ID>/prd.md` using `templates/prd.md`. The PRD captures feature-level content — problem, goals, end-to-end user journey, cross-cutting constraints, decomposition table, discovery rationale. Frontmatter must include:
   - `id: <EPIC-ID>`
   - `kind: epic` — **required**, marks this as non-pipelineable; `plan`/`build` will refuse to run against it
   - `epic: <epic-slug>`
   - `children: [<CHILD-1-ID>, <CHILD-2-ID>, ...]`
   - `status: backlog`, `created`, `project`, `priority`, `tags`

   The PRD is **not** a duplicate of the children's specs combined — it holds only feature-level content that applies across siblings: the original problem statement, feature-level acceptance criteria, cross-cutting constraints (a11y, perf, security applying to all children), the decomposition table, and discovery notes. Each child's spec narrows to its own slice.

4. **Write the shared exploration** to `claudedocs/tickets/backlog/<EPIC-ID>/exploration.md` (one file at the epic level — children share it via folder containment, not by per-child copies). Header:
   ```
   # Exploration — <EPIC-ID> (shared across siblings)
   **Source**: discover skill, Phase 2
   **Date**: <today's date>
   **Scope**: broad exploration of areas relevant to the feature idea, shared across all children of this epic
   ```

5. **Write each child spec** to `claudedocs/tickets/backlog/<EPIC-ID>/tasks/<CHILD-ID>/01-spec.md` using `templates/task.md`. Child frontmatter must include:
   - `id: <CHILD-ID>`
   - `parent: <EPIC-ID>`
   - `epic: <epic-slug>`
   - `siblings: [<other-CHILD-IDs>]` (informational; the others, not self)
   - `blocked_by: [<CHILD-ID>, ...]` (omit if no blockers)
   - `priority: <inherit from epic>`
   - `complexity: <assessed per child>`
   - `status: backlog`, `created`, `project`, `tags: <inherit from epic + child-specific>`

   Child body follows `templates/task.md` standard sections, scoped to the child's slice. The "Description" should reference the parent (`See parent epic <EPIC-ID> for full context`) rather than restating it. "Out of Scope" should reference siblings by ID where relevant (`X is handled by <SIBLING-ID>`).

6. **Present the result**:
   ```
   ## Epic + Children Created

   **Epic folder**: claudedocs/tickets/backlog/<EPIC-ID>/
   **Epic ID**: <EPIC-ID> (kind: epic — not pipelineable directly)
   **Epic slug**: <epic-slug>
   **Children**: <N>

   | ID | Title | Complexity | blocked_by |
   |---|---|---|---|
   | <CHILD-1-ID> | <title> | M | — |
   | <CHILD-2-ID> | <title> | M | <CHILD-1-ID> |
   ...

   **PRD**: claudedocs/tickets/backlog/<EPIC-ID>/prd.md
   **Shared exploration**: claudedocs/tickets/backlog/<EPIC-ID>/exploration.md

   → Edit any spec or the PRD to adjust
   → Start the first child: /feature:flow <CHILD-1-ID>
   → Or plan first: /feature:plan <CHILD-1-ID>
   ```

---

## Complexity Assessment Guide

Assess complexity based on discovery findings:

| Size | Signal |
|------|--------|
| **S** | Single file change, clear scope, no new patterns needed |
| **M** | 2-5 files, follows existing patterns, moderate scope |
| **L** | 5-10 files, new patterns or components, cross-cutting concerns |
| **XL** | 10+ files, new architecture, multiple subsystems affected — strong signal to split into siblings |

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
- Focus Phase 3 on gaps, edge cases, and things not mentioned (and on questions surfaced by Phase 2 codebase findings)
- Move faster through Phase 3.5 and ticket generation

## Important Rules

1. **Be conversational, not interrogative** — this is a dialogue, not a survey
2. **Lead with a recommendation** — every question carries your proposed default with a one-line rationale; ask the user only when judgment is genuinely theirs (product/UX trade-offs, business priorities, personal preference). Resolve trivial or codebase-driven decisions yourself with a stated default.
3. **Synthesize as you go** — restate what you've understood after each batch, and re-enter a theme if the synthesis surfaces ambiguity or new questions
4. **Match depth to complexity** — don't over-discover simple features, and don't under-discover coupled ones (escalate to depth-first grilling when a decision branch cascades)
5. **Use codebase context** — make questions specific to the project, not generic
6. **One checkpoint, only when N>1** — single-ticket discoveries skip Phase 3.5 entirely; multi-sibling discoveries always show the proposal before creating tickets
7. **PRD is feature-level, children are task-level** — the PRD is not a duplicate of children's specs combined; it captures only what spans siblings (problem, cross-cutting constraints, decomposition, discovery notes)
8. **Exploration lives once per discovery session** — at the epic-folder level for multi-sibling, at the ticket-folder level for single. No per-child duplication.
9. **Epics are non-pipelineable** — `kind: epic` in PRD frontmatter; `plan`/`build` will refuse to run against an epic ID. Children are the pipelineable items.
10. **No `breakdown.md` artifact** — decomposition rationale and AC coverage live as sections inside `prd.md`, not in a separate file
11. **Create the artifact(s), don't just discuss** — always end with concrete tickets on disk
12. **Respect "enough"** — if the developer wants to move on, create the best ticket(s) you can
13. **No implementation** — this skill discovers and documents, it does not code
