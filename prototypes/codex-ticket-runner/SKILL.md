---
name: codex-ticket-runner
description: Execute a refined epic serially in Codex with explicit quality policy, independent review, verified ticket commits, and a filesystem feature-ticket adapter. Experimental local runner.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Agent
  - Task
---

# Codex ticket runner

The main agent implements one ticket at a time on a clean, exclusive epic branch.
One independent reviewer handles the review. Native Goal continuation owns the
outer loop; the Python helper owns persisted evidence and delivery gates. Load
this experimental skill by absolute path in a separate consuming repository.

## Entry and inputs

Read [workflow-contract.md](workflow-contract.md), project guidance and the requested
delivery scope. Preserve existing work.
Use an existing Goal when present; otherwise run this protocol in the current
task. Create a Goal only when explicitly requested. Resolve commit and
PR authorization from the session before entry. This profile requires ticket
commits and leaves any resulting PR open. Bind `RUNNER` to this directory's
absolute `runner.py` path; keep `STATE`, manifests and evidence in a durable
external run directory. Python 3.11+, Git and macOS/Linux are required.

For existing filesystem feature tickets, read [feature-adapter.md](feature-adapter.md).
Import the solo ID or full epic; the adapter resolves the authoritative roster,
dependencies, parent constraints, shared exploration and existing plans. It writes
compatible numbered artifacts and status/folder transitions. Ruby is required for
safe YAML parsing. The selected ticket subtree must be ignored by Git in all four
states; tracked ticket storage and server-native mode fail before mutation.

For a manually supplied roster, read [manifest.md](manifest.md). In either mode,
read [quality-policy.md](quality-policy.md) and bind the explicit quality policy:
required implementation skills, reviewer rubrics and project check commands.
Include applicable project validation commands from guidance/config in the policy;
the adapter does not translate arbitrary shell strings into checks. Ticket-specific
additions extend the common policy. Missing required skills or incompatible skill
workflows require reconciliation before entry; do not silently omit or replace them.

Initialize with `python3 RUNNER --state STATE init --repo REPO --branch BRANCH
--manifest MANIFEST --owner OWNER`, supplying actual paths and agent identity.
On resume use the recorded state. A changed bound spec, context, quality file or
manifest requires explicit reconciliation; this prototype does not migrate a run.

## Ticket loop

1. Run `python3 RUNNER --state STATE next`. Inspect its result before any dependent
   action. The result names the ticket, base/tree, pending gates and full quality
   contract. `context` prints the same current contract for later consultation.
   A nonzero exit blocks that operation; it never means completion.
2. Read the spec and every listed context file. Parent PRD constraints apply to all
   children. Inspect predecessor commits/results and relevant source. Reassess an
   existing plan against current requirements; otherwise plan inline. Read and
   apply every selected implementation skill before implementation. Follow its
   applicable process, including test-first work when selected. Plan and implement
   in the main agent; this runner does not invoke feature plan/build stage workers.
   Before product edits, record `plan REPORT` using workflow-contract.md: assess
   touched project laws and reused behavior, surface boundary decisions, and name
   falsifiable checks. `decision_required` means a proposed exception needs its
   user decision; existing authorization is reusable within its scope.
   At `challenge`, create `challenge-packet` and give one read-only reviewer that
   packet and review.md. It selects independent failure cases from requirements
   and existing behavior. Record its actual `challenge REPORT`; implement only
   when `next` reports `implement`. Keep the reviewer for final review if possible.
3. Implement within declared paths. Own and clean up test servers and fixtures.
   Save a work report outside the checkout using the schema in quality-policy.md,
   then run `python3 RUNNER --state STATE work REPORT`. Record the actual skills
   used, plan, implementation summary and evidence for every acceptance criterion.
   Include `plan_digest`, `challenge_digest` and evidence for every listed
   obligation. The helper derives plan prose from the recorded approach. When a
   newly discovered boundary changes the plan, stop dependent edits and submit
   an explicit plan/case revision before continuing. The retained history makes
   changes reviewable; pending exceptions cannot be silently auto-resolved.
   This receipt is an accountable claim, not proof the helper can independently infer.
4. Run each required ticket check with `python3 RUNNER --state STATE check NAME`.
   Checks execute as argv, serially, with external logs. Repair failures. A required
   browser command remains pending until it runs successfully. The helper caches
   passes only for identical code; use `--rerun` when external data/environment
   changes or prior evidence is disputed.
   After the checks pass, refresh the work receipt with actual results and log
   references, then submit `work REPORT` again. Updating prose at the same tree
   preserves check evidence and keeps the published acceptance map current.
5. Generate `python3 RUNNER --state STATE packet` and pause product-code edits.
   Give one independent read-only reviewer the packet and [review.md](review.md).
   It reads all selected rubrics, the spec, parent/shared context, predecessor
   results and project guidance, and verifies the actual code/check evidence.
   Supply scope and paths without coaching its verdict or forwarding old findings.
   Use the active spawn schema and fresh context when available. Save its actual
   JSON response externally; run `python3 RUNNER --state STATE review REPORT`.
6. Fix actionable findings and repeat work reporting, required checks and review
   for the changed tree. Changed plans, case selection, work evidence or check
   receipts also invalidate final review at the same tree. The final report must
   assess every obligation and bind its plan/challenge/work/check digests.
   One reviewer covers the baseline perspectives. Add a
   specialist only for a concrete risk, one reviewer at a time; incorporate its
   findings before the required final review. A reused reviewer must have only
   reviewed, never authored/designed this run's code, and disclose context reuse.
7. At `outcome: commit`, run `python3 RUNNER --state STATE commit --message-file FILE`
   with an external file containing a ticket-prefixed subject and optional body.
   Honor project commit conventions and hooks. The helper stages only the ticket
   delta and verifies the committed tree, parent and message. Unexpected HEAD,
   hook-modified code, unrelated edits or publication conflicts stop advancement;
   preserve the work and inspect the reported recovery condition.
8. Immediately repeat `next`. At `integration_required`, run every final check
   with `check NAME --final`. Inspect feature-level acceptance against the parent
   PRD, not only child test passes. For local delivery run `finish`. For authorized
   epic-PR delivery push and create/reuse one PR using normal GitHub tools, then
   run `finish --pr-url URL`. The helper verifies repository, open state, branch,
   base and head before publishing `in-review`. PR failure remains pending.

## Capacity, recovery and completion

One reviewer at a time; no planner, explorer, implementer or arbiter children.
After a rejected spawn, reuse a suitable completed reviewer if available.
Otherwise record `block --reason TEXT --recovery TEXT`. Keep the review gate
pending and continue useful independent work. Retry capacity only after new
capacity evidence or an explicit runtime change. Repeating `next` does not spawn
agents. Follow the host Goal's blocked threshold; bookkeeping is not progress.

The helper saves run state before publishing feature artifacts. A failed write
leaves publication pending; resume with `sync-feature` after resolving its concrete
cause. Publication replays idempotently and preserves unexpected external edits.
Use this runner for an active run; do not interleave feature flow/build/sync on the
same ticket tree. Its authoritative resume state is JSON/Git, not artifact mtimes.

Before claiming completion, require a successful `finish` and evidence for the
whole user objective. The helper validates mechanics; the agent and reviewer must
judge test adequacy, acceptance coverage and truthful skill/reviewer declarations.
A finished ticket, process exit, saved plan or empty diff does not finish the epic.

## Boundaries

The adapter supports ignored filesystem tickets, including preserved done children
with explicitly verified prerequisite commits and cancelled roster entries. It
requires the complete refined roster at import. See feature-adapter.md for exact
publication timing and remaining differences from the feature plugin.

This version does not provision worktrees, handle parallel code writers, migrate
state, reconstruct dirty/no-commit work, accept no-change implementation tickets,
merge PRs, or synchronize merge status. Existing states without this workflow version need
their original runner or explicit reconciliation into a new run. This helper is a correctness aid,
not a security boundary against another process editing the checkout or state.
