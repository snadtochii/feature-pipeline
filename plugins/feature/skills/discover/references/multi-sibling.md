# Multi-Sibling Discovery — Checkpoint + Generation

Canonical logic for discover's multi-sibling output. Read when Phase 3.5's scope assessment lands on N>1 (multiple sibling tickets under an epic) — a single-ticket discovery (N=1) never needs this file. Referenced by `discover` only.

Ticket IDs come from the *Generate ticket IDs* block in SKILL.md Phase 4 — it serves both output modes (single- and multi-ticket) and includes the multi-mode allocation rules (parent epic first, then children in checkpoint order). How IDs are allocated — and how the checkpoint renders ID references before they exist — is discover's storage file §3 for the detected mode.

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

**Storage-mode gate:** generation follows discover's storage file §5 (loaded at Phase 0) for the detected mode — it carries the full procedure, epic and children, through the result presentation. The checkpoint above applies unchanged in every mode, with ID references rendered per §3.
