# Tidy Loop

A scheduled loop that keeps a codebase's **structure** healthy without ever changing its
**behavior**. One finding per run, one isolated worktree, one draft pull request, zero merges.

Ships zero project facts. Everything project-specific lives in the consuming repo's
committed `.tidyloop.yaml`.

## The invariant

> A Tidy Loop run changes structure and never behavior.

That is checkable, not aspirational. A structure-only change has an oracle: the test files
from the base commit. Gate G1 restores them over the refactored source and runs them, which
simultaneously proves behavior was preserved under the existing suite *and* that no test was
adjusted to accommodate the diff — the two failure modes of an unattended refactor, closed by
one command.

Second invariant: **the loop never merges.** It opens draft pull requests. A human merges, or
closes them with a one-line reason the loop records and never re-proposes.

## Skills

| Skill | When | Shape |
| --- | --- | --- |
| `tidy-setup` | once per repo, before the first run | interactive — probes the repo, previews its hotspots, verifies the worktree prerequisites actually hold, provisions the dedicated loop clone, writes `.tidyloop.yaml` |
| `tidy-run` | weekly, on a schedule | unattended — scan, select one finding, work in a worktree, run the gates, open a draft PR or report why it didn't |

Two read-only agents back the run: `tidy-scanner` proposes structural findings as data and never
edits; `tidy-architect` delivers the final verdict on whether the diff genuinely deepened the
module or merely moved code.

## How a run works

1. **Preflight.** Abort cheap: no profile, a live run, a dirty loop clone, the open-PR churn
   budget reached, or nothing left after excluding files that are busy in open PRs and live
   worktrees.
2. **Score, then read.** `score = churn × lines` over the scan window — deterministic, no
   model, reproducible. Only the top N files are read.
3. **Select one.** Drop anything outside the category allowlist, anything with real behavior
   risk, anything over the diff cap. Take the top survivor. No survivors is a successful quiet
   week.
4. **Work in a worktree** cut from `origin/<base>` inside the loop clone.
5. **Gate.** Base-test, characterization, project checks, public surface, diff cap, mutation,
   smoke, architecture. Any red gate aborts the run — the loop never edits code to turn a gate
   green, never weakens a test, never adds a skip.
6. **Brief.** A draft PR whose body carries the full ranked list including everything dropped
   and why, the gate evidence, and the revert command.

## Why a dedicated clone

The loop owns a second checkout, always on the base branch. Three reasons: a scheduled run
cannot be blocked by a dirty working tree; the fork point is pinned rather than inferred from
whatever branch the user happens to be sitting on; and it is the only shape that generalizes
to a multi-repo workspace.

## Trust tiers

| Tier | Produces | Graduation |
| --- | --- | --- |
| 0 Observe | a report only | 2–4 runs whose top pick the user agrees with |
| 1 Single PR | one draft PR per run, mechanical categories only | per category: 5 merges, 0 reverts |
| 2 Graduated | raised caps for proven categories, mutation gate on | per repo, a quarter of stable metrics |

No tier auto-merges. A single revert demotes its category immediately. A category whose PRs
sit unread comes **off** the allowlist — work nobody wants is not proven work.

## Setup

```
/tidy-setup
```

Run it in the repo you want to onboard. It asks four questions, everything else it probes.

## Configuration

`.tidyloop.yaml` at the repo root, committed. The schema, field semantics, and validation
rules are the contract in
[`skills/tidy-setup/references/profile.md`](skills/tidy-setup/references/profile.md).

## Prior art

Kent Beck's *Tidy First?* (structure and behavior never share a diff), Google's Rosie and
Tricorder (independently tested chunks; churn weighed against reviewer time; review-time
flagging to prevent backsliding), CodeScene hotspots (rank by complexity × change frequency),
characterization testing (record current behavior as the oracle), and mutation testing
(coverage says a line ran; mutation says a test would notice if it were wrong).
