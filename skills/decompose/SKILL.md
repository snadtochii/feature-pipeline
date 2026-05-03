---
name: decompose
description: "Break an analyzed XL/L ticket into smaller child tickets that each go through the full pipeline. Use when 'decompose ticket', 'break down into tickets', 'split this epic', or 'too big, split it'. NOT for task breakdown within a single ticket."
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - TodoWrite
argument-hint: "[ticket-id]"
---

# Decompose — Epic to Child Tickets

Break an analyzed L/XL ticket into smaller child tickets (S/M complexity) that each go through the full feature pipeline independently.

## Arguments

```
/feature-pipeline:decompose $ARGUMENTS
```

`$1` = ticket ID (e.g. `FP-1`) or path to ticket file.

### Examples
```
/feature-pipeline:decompose FP-1
/feature-pipeline:decompose claudedocs/tickets/backlog/FP-1/
```

## Ticket Resolution & Artifacts Setup

Use the canonical logic in [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md). The ticket argument is `$1`.

## Required Input

- `01-spec.md` — the ticket specification (created by resolution logic if missing)
- `02-analysis.md` — **required**. Decomposition needs codebase context to identify natural seams. If missing, tell the user to run analyze first:
  ```
  No analysis found for <ticket-id>. Run analysis first:
  /feature-pipeline:analyze <ticket-id>
  ```

## Process

### Step 1: Assess Decomposability

Read the ticket and its analysis. Check whether decomposition is warranted:

1. **Read complexity from ticket frontmatter**. If S or M, warn:
   ```
   This ticket is complexity <X>. Decomposition is typically for L/XL tickets.
   Do you still want to decompose it?
   ```
   Proceed only if the user confirms.

2. **Read the parent ticket's acceptance criteria**. Count them — these must all be covered by children.

3. **Read `02-analysis.md`**. Extract:
   - Architecture layers the change crosses
   - Existing patterns and integration points
   - Dependencies and technical risks
   - Complexity signals (multi-subsystem, new patterns, cross-cutting)

### Step 2: Identify Seams

Analyze the spec + analysis to find natural decomposition boundaries. Prioritize these seam types in order:

1. **Vertical slices** (by user-facing feature) — best when the ticket has distinct user stories
2. **Horizontal layers** (by technical layer: data, service, UI) — best when layers are independent
3. **Dependency chain** (foundational → dependent) — best when there's clear scaffolding needed first

**Granularity rules** (adapted from breakdown skill patterns):

| Good child scope | Signal |
|---|---|
| Complexity S or M | 2-8 hours implementation |
| Touches a focused area | 2-8 files, one feature/layer |
| Clear boundaries | Has its own testable acceptance criteria |
| Independent pipeline run | Can be planned, implemented, reviewed on its own |

| Too small — fold into adjacent child | Signal |
|---|---|
| Trivial config or setup | Would produce a 1-step plan |
| No meaningful acceptance criteria | Just a line or two of code |

| Too large — split further or flag | Signal |
|---|---|
| Complexity L or XL | 8+ hours, multiple concerns |
| Crosses multiple features | Can't be reviewed as one cohesive change |

**Budget**: 3-7 children. If the analysis suggests more than 7, present the situation to the user and offer:
- Group related seams into larger children (staying within M complexity)
- Accept more children with the understanding of more pipeline overhead
- Re-scope the parent ticket

### Step 3: Propose Decomposition

Present the proposed children to the user **before creating any tickets**:

```
## Proposed Decomposition for <parent-id>

**Parent**: <title> (complexity <X>)
**Children**: <N> tickets

| # | Title | Complexity | Depends on | Covers AC |
|---|---|---|---|---|
| 1 | <title> | S | — | 1, 2 |
| 2 | <title> | M | #1 | 3, 4 |
| 3 | <title> | M | #1 | 5 |
| 4 | <title> | M | #2, #3 | 6, 7 |

### Acceptance Criteria Coverage
- [x] AC 1 → Child #1
- [x] AC 2 → Child #1
- [x] AC 3 → Child #2
...

### Ordering Rationale
<Why this order, what the dependency chain is>

→ Approve to create tickets
→ Adjust: tell me what to change
→ Cancel: keep the ticket as-is
```

**Validation before proposing:**
- Every parent acceptance criterion is covered by at least one child
- No child is complexity L or XL (defeats the purpose)
- First child is foundational (no dependencies on other children)
- Each child has at least 2 acceptance criteria

Iterate with the user until they approve.

### Step 4: Create Child Tickets

Once approved:

1. **Read the prefix** from `claudedocs/tickets/config.yaml` (`prefix` field)

2. **Determine next ticket IDs**. Scan `claudedocs/tickets/` for existing IDs to find the highest number, then assign sequentially: `<PREFIX>-<N+1>`, `<PREFIX>-<N+2>`, etc.

3. **Create each child ticket folder + spec** at `claudedocs/tickets/backlog/<PREFIX>-<N>/01-spec.md` (folder name is just the ID — no slug; the spec file inside the folder IS the ticket):

   ```yaml
   ---
   id: <PREFIX>-<N>
   title: <child title>
   parent: <parent-id>
   priority: <inherit from parent>
   complexity: <assessed per child>
   status: backlog
   created: <today's date>
   project: <inherit from parent>
   tags: <inherit from parent + add specific tags>
   ---
   ```

   The ticket body follows the standard template sections:
   - **Description**: Scoped to this child's concern. Reference the parent ticket for full context.
   - **User Story**: Derived from the subset of the parent's story this child addresses.
   - **Acceptance Criteria**: Subset of parent's ACs assigned to this child, plus any child-specific criteria.
   - **Constraints**: Non-negotiable technical boundaries for this child — existing patterns/services it must use, integration points it can't bypass, cross-cutting requirements. Informed by `02-analysis.md`. Keep out: approach, file list, architecture choices (those belong to the plan stage).
   - **Out of Scope**: What this child does NOT cover (handled by sibling tickets). Reference siblings by ID.

4. **Seed each child's exploration** by copying the parent's `exploration.md` into each child's ticket folder at `claudedocs/tickets/backlog/<child-id>/exploration.md`. Add a header note:
   ```
   # Exploration — <child-id>
   **Source**: inherited from parent <parent-id> discover/analysis
   **Date**: <original date>
   **Note**: This exploration was done for the parent epic. The analyze stage
   for this child should do targeted incremental exploration for the child's
   specific scope.
   ```

5. **Update the parent ticket** — add `children` field to the frontmatter of `01-spec.md` in the parent's ticket folder:
   ```yaml
   children: [<child-1-id>, <child-2-id>, ...]
   ```

6. **Write the decomposition artifact** to the parent's ticket folder as `02b-decomposition.md`:
   ```markdown
   # Decomposition — <parent-id>
   **Date**: <today's date>
   **Children**: <N> tickets

   ## Split Rationale
   <Why this ticket was decomposed and the seam identification logic>

   ## Children
   | ID | Title | Complexity | Depends on | Covers AC |
   |---|---|---|---|---|
   | <id> | <title> | <complexity> | <deps> | <AC numbers> |
   ...

   ## Acceptance Criteria Coverage
   - [x] AC 1: <text> → <child-id>
   - [x] AC 2: <text> → <child-id>
   ...

   ## Ordering Rationale
   <Why this execution order, dependency chain explanation>

   ## Execution Plan
   Run each child through the pipeline in order:
   1. /feature-pipeline:flow <child-1-id>
   2. /feature-pipeline:flow <child-2-id>
   ...
   ```

### Step 5: Present Results

```
## Decomposition Complete

**Parent**: <parent-id> — <title>
**Children created**: <N>

| ID | Title | Complexity | Folder |
|---|---|---|---|
| <id> | <title> | <X> | claudedocs/tickets/backlog/<id>/ |
...

**Decomposition artifact**: claudedocs/tickets/<parent-state>/<parent-id>/02b-decomposition.md

### Next Steps
→ Start the first child: /feature-pipeline:flow <first-child-id>
→ Or analyze first: /feature-pipeline:analyze <first-child-id>
→ View any child: read its `01-spec.md`
→ View the decomposition rationale: read 02b-decomposition.md in the parent's folder
```

## Output

- **Child ticket folders**: `claudedocs/tickets/backlog/<PREFIX>-<N>/` (one per child, each containing `01-spec.md` and an inherited `exploration.md`)
- **Updated parent spec**: `children` field added to the parent's `01-spec.md` frontmatter
- **Decomposition artifact**: `02b-decomposition.md` in the parent's ticket folder

## Error Handling

- `02-analysis.md` missing → tell user to run analyze first, do not proceed
- Ticket not found → follow resolution error handling (ask the user)
- Parent already has `children` field → warn: "This ticket was already decomposed. Re-decompose? This will not delete existing child tickets."
- Acceptance criteria not fully covered → block creation, show which ACs are uncovered
- Child complexity is L or XL → warn and ask user to split further or accept

## Important Rules

1. **Never create tickets without user approval** — always present the proposal first
2. **Every parent AC must be covered** — no gaps allowed; validate before creation
3. **Children are S or M complexity** — if a child is L/XL, the decomposition isn't granular enough
4. **Inherit, don't duplicate** — children reference the parent, not copy its full description
5. **Exploration is inherited, not re-run** — copy `exploration.md`, let analyze do incremental work
6. **Order matters** — first child must have no dependencies on siblings
7. **This skill does not run children through the pipeline** — it creates the tickets; the user (or board UI) runs each child's pipeline separately
