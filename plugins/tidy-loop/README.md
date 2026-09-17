# Tidy Loop

A pair of scheduled loops that keep a codebase's **structure** healthy without ever changing its
**behavior**. A weekly survey proposes candidates; a human approves one; a daily run builds that
one line behind behavior-preservation gates and opens a draft pull request. Zero merges.

Ships zero project facts. Everything project-specific lives in the consuming repo's
committed `.tidyloop.yaml`. Claude Code only.

## The invariant

> A Tidy Loop run changes structure and never behavior.

That is checkable, not aspirational. A structure-only change has an oracle: the project's own
tests, moved rather than weakened. The `spec-patch` gate proves the test suite is *symmetric*
evidence — the same tests before and after — and the write fence makes that evidence mean
something, because the agent making the change can neither read nor edit the tests it is judged
against. "The tests pass" is only evidence if weakening them was never reachable — and if quietly
shaping the source to fit them was never reachable either.

Second invariant: **the loop never merges.** It opens draft pull requests. A human merges, or
closes them.

## The two loops and the queue

| Skill | When | Shape |
| --- | --- | --- |
| `tidy-setup` | once per repo, before anything is scheduled | interactive — probes the repo, previews its hotspots, verifies the worktree prerequisites actually hold, provisions the dedicated loop clone, writes `.tidyloop.yaml` |
| `tidy-survey` | weekly, on a schedule | unattended — ranks hotspots, has an architect judge the best candidates, writes `proposed` lines into the queue and a report explaining every one. Changes nothing outside `state_dir`: no worktree, no branch, no commit. |
| `tidy-execute` | daily, on a schedule | unattended — builds the first `approved` line in the queue, runs the gates, opens a draft pull request or records why it could not |

Between them sits **the queue**, `<state_dir>/queue.md`: one candidate per line, four
pipe-separated fields, `<id> | <status> | <summary> | <note>`. A human's edit is the only thing
that moves a line to `approved`, and order in the file is the human's priority control.
Approving a line is a judgement about payoff, not about safety — every `proposed` line already
carries an architect's verdict.

| Status | Written by | Meaning |
| --- | --- | --- |
| `proposed` | `tidy-survey` | A candidate the survey found and the architect judged worth offering. Awaiting a human. |
| `approved` | the human | Build this. The note names the next change it makes cheaper. |
| `declined` | the human | Do not build this, now or later. The note carries the reason. |
| `stale` | `tidy-survey` on a `proposed` line; `tidy-execute` on the `approved` line it picked | A file or symbol in the finding no longer exists; the shape the candidate described is gone. |
| `blocked` | `tidy-execute` | The change was built and a gate failed. The note carries the gate and the evidence path. |
| `opened` | `tidy-execute` | A draft pull request is open for this change. The note carries its URL. |

The full contract — line grammar, the `approved` note's `amend:` and `caps:` keys, terminality —
is [`skills/tidy-setup/references/queue.md`](skills/tidy-setup/references/queue.md).

## The writing spawns

`tidy-execute` delegates its writes to three agents, each a fresh instance, each confined to one
kind of file:

- **`tidy-characterizer`** — writes characterization tests that pin current behavior, on an
  untouched tree, and commits them alone. Runs only when the target files are not already covered.
  Writing test files is its job, so no hook constrains it.
- **`tidy-implementer`** — makes the one declared structural change to source files. A
  `PreToolUse` hook declared in its own frontmatter refuses every **read and every write** of a
  path matching the project's test globs. Both halves are load-bearing: the write block is why
  "the tests pass" cannot be reached by weakening them, and the read block is why it cannot be
  reached by shaping the source to specs the agent was never shown.
- **`tidy-spec-mover`** — applies the declared rename map to the spec files. The same hook in the
  opposite mode refuses every write *outside* those globs.

Every one of the three is checked again after the fact: the run asserts which paths each commit
touched, and a breach ends the run rather than downgrading to a warning. That assertion is the
characterizer's only confinement, and a backstop for the other two.

Two read-only agents complete the roster of five: `tidy-scanner` proposes structural findings as
data during the survey and never edits, and `tidy-architect` delivers the verdict on whether a
diff genuinely deepened the module or merely moved code.

## Gates

Every run passes these, in order, before a pull request exists:

| id | What it proves |
| --- | --- |
| `caps` | the diff stayed inside the declared line, file, and import-update limits, and inside its scope |
| `spec-patch` | the test suite is symmetric evidence — the same tests, moved rather than weakened |
| `test-names` | the multiset of test names is unchanged, so nothing was lost or silently renamed |
| `project-checks` | the repo's own lint, typecheck, test, and build commands pass |
| `surface` | every module's exported shape is unchanged through the declared rename map |
| `declared-once` | every mapped symbol is declared exactly once after the move |
| `coverage` | the suite actually executed the files the change moved code into |
| `architect` | the change deepened a module rather than relocating code |

Four more are **configured-or-skipped**: `spec-body-identity`, `dom-golden`,
`differential-property`, and `mutation`. Those are the gate ids; the profile key is the id with
underscores, so each is configured as `checks.spec_body_identity`, `checks.dom_golden`,
`checks.differential_property`, or `checks.mutation`. Each reports `skipped (not configured)`
until a command is set for it.

A failing gate marks the queue line `blocked` and writes its evidence under `state_dir`. The
loop never edits code to turn a gate green, never weakens a test, never adds a skip. The gate
contract — what each one runs, what it writes, which failures mark `blocked` — is
[`skills/tidy-execute/references/gates.md`](skills/tidy-execute/references/gates.md).

## The checks contract

The mechanical answers behind those gates are commands the plugin ships, invoked as:

```text
node "${CLAUDE_PLUGIN_ROOT}/checks/<stack>/<command>.mjs" --repo <abs-path>
```

There are four: `test-names` (what tests exist, as a multiset), `exported-surface` (what every
module exports, and where each tracked symbol is declared), `coverage-hit` (whether the suite
executed a set of files), and `verify-spec-patch` (whether a change's test suite is symmetric
evidence).

`checks.stack` in the profile names which shipped implementation answers them — a directory under
`checks/`. **A second stack** is a new `checks/<stack>/` directory whose top-level `<command>.mjs`
files implement the same four commands for that toolchain, plus at least one fixture under
`checks/fixtures/` whose `fixture.json` names that stack. Fixtures are discovered by directory and
each is driven by the stack it declares, so adding one does not disturb the other. The command
contract — flags, output shapes, exit codes — is [`checks/CONTRACT.md`](checks/CONTRACT.md).

## Setup

```
/tidy-loop:tidy-setup
```

Run it in the repo you want to onboard. It asks three questions; everything else it probes. It
writes `.tidyloop.yaml`, a seeded queue file, and — with permission — a `.worktreeinclude` if the
repo has none.

Then enable the two schedules on your own surface (a local scheduled task, or a cron entry):

```
/tidy-loop:tidy-survey <loop_clone>     # weekly
/tidy-loop:tidy-execute <loop_clone>    # daily
```

Both take the **loop clone** as the repo path, never your own checkout. Setup writes
`execute: false`, so until you flip it the survey still runs and fills the queue — candidates and
reports accumulate for review from the first week — while `tidy-execute` reads the flag, reports
it, and exits without building.

## Why a dedicated clone

The loop owns a second checkout, always on the base branch. Three reasons: a scheduled run
cannot be blocked by a dirty working tree; the fork point is pinned rather than inferred from
whatever branch the user happens to be sitting on; and it is the only shape that generalizes
to a multi-repo workspace.

## Configuration

`.tidyloop.yaml` at the repo root, committed. The schema, field semantics, and validation
rules are the contract in
[`skills/tidy-setup/references/profile.md`](skills/tidy-setup/references/profile.md).

## Prior art

Kent Beck's *Tidy First?* (structure and behavior never share a diff), Google's Rosie and
Tricorder (independently tested chunks; churn weighed against reviewer time; review-time
flagging to prevent backsliding), CodeScene hotspots (rank by change frequency × complexity —
the survey scores `churn × indentation complexity` and reports `churn × lines` alongside),
characterization testing (record current behavior as the oracle), mutation testing (coverage
says a line ran; mutation says a test would notice if it were wrong), and Michael Nygard's ADR
shape, which the survey mirrors when a decline is worth recording as a rule.
