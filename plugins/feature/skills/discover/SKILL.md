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
  - pipeline_create_ticket
  - pipeline_update_ticket
  - pipeline_write_artifact
  - pipeline_get_ticket
  - pipeline_list_tickets
argument-hint: "[description] [--project name] [--id XX-N] [--explore]"
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
- `--explore` — force **exploration mode** regardless of how detailed the input reads (see "Very vague or outcome-uncommitted input" below)

### Examples
```
/feature:discover I need a way to filter the task list by priority and date range --project big-leaves
/feature:discover --explore Reworking how rate limiting works — challenge this before I commit to a ticket
```

## Discovery Process

The skill runs in **main context** (interactive) through these phases:

---

### PHASE 0: ENSURE TICKET INFRASTRUCTURE

**Exploration-mode gate (runs first):** if this session enters exploration mode — the `--explore` flag, or vague/outcome-uncommitted input per the input-type branches below — **skip this phase entirely for now**: no directories, no `config.yaml`, no prefix prompt, no server calls. Run it only at the moment the developer commits to a ticket. An exploration session that ends with no ticket must leave the project — tree and server alike — untouched.

**Storage-mode dispatch:** detect the storage mode once per run per [`../flow/references/storage.md`](../flow/references/storage.md) (model-read `claudedocs/tickets/config.yaml`; fs-native default, config-error and unknown-value handling per that contract). In **server-native** mode, the marker (`mode: server-native` + `project`) must already exist in `config.yaml` — discover never flips a project's mode and never creates the fs state folders. Skip steps 1–3 below entirely (no directories, no prefix — server IDs come from the registry-configured prefix) and run only step 4 (templates); ticket generation then follows [`references/server-create.md`](references/server-create.md) at Phase 4. In **fs-native** mode, run steps 1–4 below unchanged.

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

1. **Parse the input**: identify the project (from `--project` flag, or ask if not obvious); handle images and file references per "Handling Different Input Types" below

2. **Determine project root**:
   - If `--project` is provided, locate it (check common paths, ask if ambiguous)
   - If in a project directory already, use current working directory
   - The project root is needed for codebase exploration

3. **Detect workspace shape** (single-repo vs multi-repo) — fs-native mode only; in server-native mode skip this step and treat the workspace as single-repo (`repos` has no server-side representation and is dropped per [`references/server-create.md`](references/server-create.md)):
   - The workspace is the folder holding `claudedocs/tickets/` (the same root Phase 0 establishes). **Multi-repo** iff the workspace root is not itself a git repo (no `.git` at the root) AND immediate child directories containing `.git` exist — check immediate children only, no recursion (avoids `node_modules/.git` and vendored-tree false positives)
   - **Multi-repo** → read and follow [`references/multi-repo.md`](references/multi-repo.md): the repos-append convention every later `repos` mention defers to
   - Any other shape is **single-repo**: the `repos` field is omitted everywhere downstream, and every repos-related step is skipped — single-repo output is byte-identical to a workspace where the concept doesn't exist

4. **Quick acknowledgment** — confirm what you understood:
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

**Recommend, don't just elicit**: For every question, propose your default answer first — informed by the codebase exploration, the input, and sensible product judgment. The user confirms, overrides, or asks for alternatives. Resolve trivial or codebase-driven decisions yourself with a stated default — ask the user only when judgment is genuinely theirs (product/UX trade-offs, business priorities, personal preference). This converts decisions you can reasonably make into confirmations. Format each question as:

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
- In a multi-repo workspace, the one-line repo confirmation per [`references/multi-repo.md`](references/multi-repo.md)

**Iteration rules**:
- **Themes loop, they don't queue**: cover each relevant theme, but re-enter any theme as often as needed. There is no fixed number of batches and no rule that one theme must finish before another begins.
- **Synthesize then check**: after each batch, restate what you've understood. If the user's answer is ambiguous, contradicts an earlier answer, leaves a hole the spec needs filled, or opens a sub-decision you didn't ask about, run another pass on that theme with clarifying questions before moving on. Don't paper over ambiguity to keep momentum.
- **Escalate to depth-first grilling on high-coupling branches**: if a single decision has answers that cascade into multiple dependent sub-decisions (e.g., "schema-first vs code-first" each implying different storage / migration / API choices), drop the batched cadence for that branch. Switch to one question at a time, walk the decision tree depth-first, and resolve each fork before backing out. Keep providing your recommended default at every node. Return to themed batching once the branch is resolved.
- **Stop when coverage is good enough** to write a clear spec — driven by coverage, not by a fixed count. Simple features may need a single batch; high-coupling or ambiguous ones may take many, especially with depth-first detours.
- **Respect "enough"**: if the developer says "that's enough" or "let's move on", proceed to scope assessment with the best understanding you have and create the best ticket(s) you can.

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

When the assessment lands on N>1, read and follow [`references/multi-sibling.md`](references/multi-sibling.md) — it holds the checkpoint presentation (shown before any tickets are created), its validation rules, and Phase 4's multi-mode generation steps. Ticket IDs still come from Phase 4's *Generate ticket IDs* block below, which serves both modes.

---

### PHASE 4: GENERATE THE TICKET(S)

Two modes: **single-ticket** (N=1, the default-collapsed output) and **multi-sibling** (N>1, after checkpoint approval).

#### Generate ticket IDs

**Server-native storage mode: skip this block.** The server allocates IDs atomically at create time (per [`references/server-create.md`](references/server-create.md)) — there is no local scan. `--id` is **rejected** in this mode with a one-line explanation: server-allocated IDs leave nothing for the flag to set. The scan below is fs-native only.

Scan the **entire** `claudedocs/tickets/` tree recursively — epic children live nested under `<state>/<EPIC>/tasks/<CHILD>/` and draw from the **same single sequential numbering space** as top-level tickets, so a top-level-only scan can hand out an ID a nested child already uses. Collect every folder anywhere under `claudedocs/tickets/**` whose name matches the configured `<PREFIX>-<N>` (the folder name IS the ID — match folder names, not frontmatter; ignore non-matching prefixes), take the maximum `<N>`, and allocate from `max + 1` (no matches → start at `<PREFIX>-1`). No leading zeros; gaps left by deleted tickets are fine — never backfill them.

- **Single-mode**: allocate one ID — `<PREFIX>-<max+1>`.
- **Multi-mode**: allocate `N + 1` IDs — the first goes to the parent epic, the next `N` to the children in checkpoint order.
- If `--id <XX-N>` was provided: in single-mode, that's the ticket's ID; in multi-mode, that's the parent epic's ID, and the children are allocated as the next IDs after `max(existing tree max, supplied epic N)` — not blindly `<XX-N+1>`, which can collide with a higher-numbered nested child.
- **`--id` collision check**: before using any `--id`-supplied ID, check whether a folder with that ID already exists anywhere in the tree. If it does, warn the user and pause for explicit confirmation; never silently overwrite or proceed.

#### Single-mode (N=1)

In server-native storage mode, follow the single-mode procedure in [`references/server-create.md`](references/server-create.md) instead of the steps below (which are fs-native).

1. **Create the ticket folder** at `claudedocs/tickets/backlog/<TICKET-ID>/` (folder name is just the ID — no slug).

2. **Write the spec** to `claudedocs/tickets/backlog/<TICKET-ID>/01-spec.md` using `templates/task.md`. The spec file IS the ticket — frontmatter for metadata, body for the content.

   In a multi-repo workspace, append `repos:` per [`references/multi-repo.md`](references/multi-repo.md).

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

Generation steps live in [`references/multi-sibling.md`](references/multi-sibling.md), read at the Phase 3.5 N>1 branch point — epic folder creation, epic slug, PRD write, shared exploration write, child specs, and the result presentation. Epic and child IDs come from the *Generate ticket IDs* block above. In server-native storage mode, the generation steps live in [`references/server-create.md`](references/server-create.md) instead — the Phase 3.5 checkpoint from `multi-sibling.md` applies unchanged in both modes.

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

### Very vague or outcome-uncommitted input ("I want to improve things", "not sure this is a ticket yet")
- Entered automatically when the input reads vague or uncommitted, or **forced via `--explore`** — the flag beats the "Very detailed input" routing: a well-formed idea still gets challenged, and the session may end without a ticket
- Read and follow [`references/exploration-mode.md`](references/exploration-mode.md) — one-question-at-a-time depth-first cadence, deferred explorer spawn, commit-to-ticket handoff, and the leave-without-a-ticket carve-out

### Very detailed input (pre-thought-out feature)
- Acknowledge the detail level
- Skip redundant discovery questions
- Focus Phase 3 on gaps, edge cases, and things not mentioned (and on questions surfaced by Phase 2 codebase findings)
- Move faster through Phase 3.5 and ticket generation

## Important Rules

Question cadence, defaults, synthesis, and depth rules live in Phase 3 ("Recommend, don't just elicit" + "Iteration rules"); the checkpoint gate lives in Phase 3.5; multi-sibling rules (PRD scope, epic non-pipelineability, shared exploration) live in [`references/multi-sibling.md`](references/multi-sibling.md). The rules below are the ones no phase body states.

1. **Be conversational, not interrogative** — this is a dialogue, not a survey
2. **Use codebase context** — make questions specific to the project, not generic
3. **Create the artifact(s), don't just discuss** — always end with concrete tickets in the ticket store (fs folders, or server rows per the storage mode), with one carve-out: exploration mode may end without a ticket when the developer chooses to leave (see [`references/exploration-mode.md`](references/exploration-mode.md))
4. **No implementation** — this skill discovers and documents, it does not code
5. **`title` is descriptive, never the bare `<ID>`** — every template (`task.md`, `prd.md`) already declares `title`; fill it with a human-readable title, not the ticket ID — boards, flow's epic-walker progress, and PR-title construction all render it, and a bare ID reads as a missing one
