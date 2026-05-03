---
id: XX-1
title: Feature Title
# Multi-sibling fields — present only when this is a child of an epic. Omit for solo tickets.
# parent: XX-0          # epic ID this child belongs to
# epic: epic-slug       # shared epic slug across siblings (cross-cutting tag)
# siblings: [XX-2, XX-3]  # other children of the same epic (informational)
# blocked_by: [XX-2]    # sibling IDs that must complete before this one starts (soft now — documentation; enforcement deferred)
priority: medium        # low | medium | high | critical
complexity: M           # S | M | L | XL
status: backlog         # backlog | in-progress | done | cancelled (cancelled lives in done/, expressed via this field)
created: 2026-01-01
project: project-name   # which personal project
tags: [ui, settings]
---

## Description
What needs to be built and why.

For child tickets, keep this scoped to this slice and reference the parent epic for full context (`See parent epic <PARENT-ID> for the feature-level overview`). Do not restate the parent's PRD here.

## User Story
As a [user type], I want [goal] so that [benefit].

For child tickets, narrow the user story to this child's slice rather than copying the epic-level story.

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

For child tickets, list only the ACs assigned to this child by the discovery checkpoint (or any child-specific criteria added during analyze).

## Design Notes
Any wireframes, screenshots, or design references.

## Constraints
Non-negotiable technical boundaries — what the implementation MUST do, not how it should be done.
Examples: existing patterns/services it must use, integration points it can't bypass, cross-cutting requirements (a11y, perf, security), external dependencies that frame the work.
Approach, file list, and architecture choices belong to the plan stage — keep them out of here.

For child tickets, list only constraints specific to this slice. Cross-cutting constraints that apply to all siblings live in the parent PRD; do not duplicate them here.

## Out of Scope
What this ticket explicitly does NOT include.

For child tickets, reference siblings by ID where relevant (`X is handled by <SIBLING-ID>`).
