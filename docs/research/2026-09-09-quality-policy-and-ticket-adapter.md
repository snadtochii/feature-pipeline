# Explicit quality policy and filesystem ticket adapter

Implemented September 9, 2026 in the uninstalled Codex ticket-runner prototype.
The existing feature plugin and marketplace manifests were not changed.

## Quality policy

Every new run declares implementation skills, reviewer rubrics and common command
checks. Ticket additions extend those requirements. The main agent must read and
apply selected skills; the independent reviewer must apply every selected rubric,
including the built-in baseline. Missing files, omitted skill/rubric IDs, changed
policy/context contents, stale reports and failed commands block the commit gate.

The work receipt records the current plan, implementation summary, skill IDs and
acceptance-evidence mapping. The review packet contains parent/shared context,
predecessor evidence, selected rubrics, required checks, executed check evidence,
and the current work receipt. Receipts are verifiable declarations of what was
claimed, not proof that an agent applied a rule correctly. Meaningful review and
acceptance coverage remain agent responsibilities.

The [quality policy reference](../../prototypes/codex-ticket-runner/quality-policy.md)
contains configuration and receipt examples. External skills are selected by
actual local paths; they are not downloaded or invoked by the Python process.
The main agent applies their process. Review rubrics supply criteria to one
reviewer, avoiding nested reviewer orchestration.

## Feature-ticket adapter

The [adapter reference](../../prototypes/codex-ticket-runner/feature-adapter.md)
describes import and publication. Import derives solo/epic specs, the authoritative
`children` roster, `blocked_by` edges, parent PRD, shared exploration and existing
plans. It validates complete materialization and parent/ID consistency, preserves
cancelled children, and requires reachable commit evidence for previously done
prerequisites. It copies immutable inputs into the external run directory and
leaves operational paths/checks in the profile rather than the requirements spec.

Publication writes `02-plan.md` through `06-summary.md`, preserves source title,
body and other metadata, and moves the entire epic subtree through the existing
state directories. Untouched sibling status lines remain byte-for-byte intact.
Local child commits can become done while later work remains; the final child and
epic wait for final integration. An epic-PR run keeps delivery pending until the
actual PR is verified, then publishes `in-review` and the shared PR URL.

Publication preflight checks source and artifact drift, all required ignore rules,
destination collisions and symlinks. Atomic writes and saved state allow replay
after interruption. An unexpected external edit is preserved and reported. Repeating
publication skips unchanged files. A failed final-check rerun revokes completion
and returns the affected epic to in-progress.

## Verification

**All 47 regression tests passed** in 168.546 seconds against the final Python
files. The suite covers both the original runner mechanics and the new policy,
context, YAML, artifact and delivery boundaries. Run from the prototype directory:

```sh
python3 -m unittest discover -v
```

During development, targeted probes exposed incomplete ignore-rule validation,
symlink-destination handling, empty optional configuration, an existing parent
review status, and unnecessary rewriting of untouched sibling status comments.
All received focused fixes and regression coverage. The publication fault test
injects a failure while writing a changed summary after the folder move, then
checks replay and idempotence. GitHub success/failure replies in delivery tests are
offline fixtures; they are not evidence of a live PR.

An [independent forward trial](2026-09-09-adapter-forward-test.md) used a separate
consuming repository, a two-child feature epic, a selected implementation skill,
an additional review rubric and one independent reviewer. It completed two ticket
commits and ten passing tests. The reviewer found a real integer-conversion boundary
bug; the executor recorded changes_required, reproduced failing checks, fixed it,
and obtained a passing re-review. The epic and children reached done with all ten
numbered artifacts, and the code checkout stayed clean.

The trial ran against frozen helper code. Two documentation/test files changed
during it, as disclosed in its report. Subsequent preflight fixes were tested in
an isolated copy and then transferred byte-for-byte into the repository. A
status/resumption check with the final helper on the completed forward fixture
also returned complete. The final regression log is
`/private/tmp/codex-runner-final-regression.log`.

Observed instruction friction also led to two clarifications: a Goal is optional
unless explicitly requested, and the work receipt should be refreshed with actual
results after checks pass so its acceptance map does not retain pending wording.
The latter is an instruction improvement after the trial; the helper already
supports same-tree receipt updates without invalidating passing commands.

The repository's runtime-contract, mode-split and tool-parity scripts passed.
Skill frontmatter was parsed/checked with safe Ruby YAML because the bundled Python
validator's PyYAML dependency is unavailable. Markdown links and whitespace were
checked separately.

## Scope and remaining limits

This version supports ignored filesystem ticket trees. Tracked ticket folders and
server-native storage fail explicitly before mutation. Ruby is an additional
requirement for real YAML parsing; the base runner remains Python/Git. Project
validation commands must be included deliberately in the quality policy. The
adapter does not execute arbitrary `validate:` shell strings automatically.

The canonical artifact names and statuses are supported, but native feature
flow/build resumption and the new JSON/Git resume contract differ. Do not interleave
them on an active run. Native feature sync's per-ticket title lookup may not discover
the shared epic PR; post-merge synchronization is not implemented. No live GitHub
delivery, native Goal compaction/continuation, server storage, or production epic
was exercised. The files remain uncommitted and the prototype is not installed.
