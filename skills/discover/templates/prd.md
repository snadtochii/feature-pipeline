---
id: XX-1
title: Epic Title
kind: epic              # marks this as non-pipelineable — plan/implement/review/test refuse to run against epics
epic: epic-slug         # human-readable shared identifier across siblings (lowercase, hyphenated)
children: [XX-2, XX-3, XX-4]
priority: medium        # low | medium | high | critical
status: backlog         # backlog | in-progress | done (status follows the most-advanced child; whole subtree moves between state folders together)
created: 2026-01-01
project: project-name
tags: [feature, area]
---

## Problem
What's broken or missing today, and who experiences it. The original problem statement that triggered this discovery — independent of how it gets implemented in the children below.

## Goals & Success Criteria
What "done" looks like at the **feature** level (not at any individual child's level). How would we know the whole epic was successful?

- Goal 1
- Goal 2

## User Journey
End-to-end story across all siblings — the full path the user takes through the feature once every child is implemented. This is what no single child captures on its own.

## Feature-level Acceptance Criteria
ACs that describe the feature as a whole. These get distributed across children in the Decomposition table below; each child's spec then narrows to just its assigned ACs.

- [ ] AC 1
- [ ] AC 2
- [ ] AC 3

## Cross-cutting Constraints
Non-negotiable constraints that apply to **every child**, not just one. Examples:
- Accessibility level (e.g., WCAG 2.1 AA)
- Performance budget (e.g., interaction latency < 100ms)
- Security or compliance requirements
- Existing patterns or integration points all children must respect

Listing them here once means children's specs don't duplicate them — each child's "Constraints" section can focus on slice-specific items.

## Out of Scope (feature-level)
Things this whole epic does NOT do. (Each child has its own out-of-scope for slice-specific exclusions.)

## Decomposition

| ID | Title | Complexity | Covers AC | blocked_by |
|---|---|---|---|---|
| XX-2 | <child title> | M | 1, 2 | — |
| XX-3 | <child title> | M | 3, 4 | XX-2 |
| XX-4 | <child title> | S | 5 | XX-2 |

### Ordering Rationale
Why this dependency chain — what foundational work each early child unlocks for later siblings.

## Discovery Notes
Brief summary of key decisions and rationale from the discovery dialogue:
- Why split into N children (which seam was used: vertical slice / horizontal layer / dependency chain)
- Alternatives considered and why they were rejected
- Open questions that surfaced and how they were resolved
- Anything the plan stage should know about the trade-offs that shaped this decomposition
