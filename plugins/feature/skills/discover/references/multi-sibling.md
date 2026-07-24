# Multi-Sibling Discovery — Checkpoint + Generation

Canonical logic for discover's multi-sibling output. Read when Phase 3.5's scope assessment lands on N>1 (multiple sibling tickets under an epic) — a single-ticket discovery (N=1) never needs this file. Referenced by `discover` only.

Ticket IDs come from the *Generate ticket IDs* block in SKILL.md Phase 4 — it serves both modes and includes the multi-mode allocation rules (parent epic first, then children in checkpoint order).

## Phase 3.5 checkpoint

Show the proposal **before creating any tickets**:

```
## Proposed Output: <N> Sibling Tickets under an Epic

I recommend splitting this into <N> tickets sharing epic `<epic-slug>`. Here's the proposed structure:

**Parent epic**: <EPIC-ID> — <epic title>

**Children**:

| # | Tentative ID | Title | Complexity | Repos | Covers AC | blocked_by |
|---|---|---|---|---|---|---|
| 1 | <CHILD-1-ID> | <title> | M | <repo-a> | 1, 2 | — |
| 2 | <CHILD-2-ID> | <title> | M | <repo-a>, <repo-b> | 3, 4 | <CHILD-1-ID> |
| 3 | <CHILD-3-ID> | <title> | S | <repo-b> | 5 | <CHILD-1-ID> |

The `Repos` column appears only in a multi-repo workspace (per the Phase 1 detection) — omit the column entirely in a single-repo workspace. It lets the user check whether the split follows repo seams before approving.

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

Iterate with the user until they approve, adjust, or collapse to single-ticket. On "collapse", proceed to Phase 4 single-mode (SKILL.md) using the gathered material.

## Phase 4 multi-mode generation (after checkpoint approval)

**Storage-mode gate:** in server-native mode (per [`../../flow/references/storage.md`](../../flow/references/storage.md)), the generation steps live in [`server-create.md`](server-create.md) §Multi-mode — the checkpoint above applies unchanged in both modes (with server-native's positional-placeholder rendering for the *Tentative ID* column, defined there); the numbered steps below are fs-native.

1. **Create the parent epic folder** at `claudedocs/tickets/backlog/<EPIC-ID>/` and the children container at `claudedocs/tickets/backlog/<EPIC-ID>/tasks/`.

2. **Generate an `epic` slug** from the discovery topic (lowercase, hyphenated; e.g., `dark-mode-rollout`). This becomes the shared `epic:` value across the parent and all children.

3. **Write the parent PRD** to `claudedocs/tickets/backlog/<EPIC-ID>/prd.md` using `templates/prd.md`. The PRD captures feature-level content — problem, goals, end-to-end user journey, cross-cutting constraints, decomposition table, discovery rationale. **`templates/prd.md` is the canonical epic schema — fill in *every* frontmatter field it declares; do not restate or re-derive the standard field list here.** As you fill it, set the epic-specific values discover computes:
   - `id: <EPIC-ID>`
   - `title: <epic title>` — descriptive (the title shown in the Phase 3.5 checkpoint header), never the bare `<EPIC-ID>`
   - `kind: epic` — marks this non-pipelineable, so `plan`/`build` refuse to run against it
   - `epic: <epic-slug>`
   - `children: [<CHILD-1-ID>, <CHILD-2-ID>, ...]` — the declared roster
   - `repos:` — only in a multi-repo workspace, appended per [`multi-repo.md`](multi-repo.md): the union of the children's repos.

   Everything else (`status`, `created`, `project`, `priority`, `tags`, …) comes straight from the template — the template is the one place that list lives.

   The PRD is **not** a duplicate of the children's specs combined — it holds only feature-level content that applies across siblings: the original problem statement, feature-level acceptance criteria, cross-cutting constraints (a11y, perf, security applying to all children), the decomposition table, and discovery notes. Each child's spec narrows to its own slice.

4. **Write the shared exploration** to `claudedocs/tickets/backlog/<EPIC-ID>/exploration.md` (one file at the epic level — children share it via folder containment, not by per-child copies). Header:
   ```
   # Exploration — <EPIC-ID> (shared across siblings)
   **Source**: discover skill, Phase 2
   **Date**: <today's date>
   **Scope**: broad exploration of areas relevant to the feature idea, shared across all children of this epic
   ```

5. **Write each child spec** to `claudedocs/tickets/backlog/<EPIC-ID>/tasks/<CHILD-ID>/01-spec.md` using `templates/task.md`. **`templates/task.md` is the canonical task schema — fill in *every* frontmatter field it declares; do not restate or re-derive the standard field list here.** Because a child belongs to an epic, additionally **append** the multi-sibling linkage fields as real frontmatter — the template carries only the fields every ticket has, so write these explicitly for a child (never as commented placeholders):
   - `parent: <EPIC-ID>`
   - `epic: <epic-slug>` — same slug as the parent and siblings
   - `siblings: [<other-CHILD-IDs>]` — informational; the others, not self
   - `blocked_by: [<CHILD-ID>, ...]` — omit if no blockers

   In a multi-repo workspace, also append `repos:` per [`multi-repo.md`](multi-repo.md) — this child's repos, from the Phase 3.5 decomposition table.

   As you fill the standard fields the template already lists, give them child-specific values: `id` (the `<CHILD-ID>` allocated in the *Generate ticket IDs* block, SKILL.md Phase 4), `title` (descriptive, from the Phase 3.5 decomposition table — never the bare `<CHILD-ID>`; this is what boards, flow's epic-walker progress, and PR titles render), `complexity` (assessed per child), and `priority`/`tags` (inherit from the epic, plus any child-specific tags).

   Child body follows `templates/task.md` standard sections, scoped to the child's slice. The "Description" should reference the parent (`See parent epic <EPIC-ID> for full context`) rather than restating it. "Out of Scope" should reference siblings by ID where relevant (`X is handled by <SIBLING-ID>`).

6. **Present the result**:
   ```
   ## Epic + Children Created

   **Epic folder**: claudedocs/tickets/backlog/<EPIC-ID>/
   **Epic ID**: <EPIC-ID> (kind: epic — not pipelineable directly)
   **Epic slug**: <epic-slug>
   **Children**: <N>

   | ID | Title | Complexity | Repos | blocked_by |
   |---|---|---|---|---|
   | <CHILD-1-ID> | <title> | M | <repo-a> | — |
   | <CHILD-2-ID> | <title> | M | <repo-a>, <repo-b> | <CHILD-1-ID> |
   ...

   (Omit the `Repos` column in a single-repo workspace, matching the Phase 3.5 table.)

   **PRD**: claudedocs/tickets/backlog/<EPIC-ID>/prd.md
   **Shared exploration**: claudedocs/tickets/backlog/<EPIC-ID>/exploration.md

   → Edit any spec or the PRD to adjust
   → Start the first child: /feature:flow <CHILD-1-ID>
   → Or plan first: /feature:plan <CHILD-1-ID>
   ```
