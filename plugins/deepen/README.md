# Deepen

A manually triggered, semi-attended loop that takes **one** deep-module refactor candidate to a
**draft pull request** carrying a behavior-preservation evidence pack. One run, one candidate,
one draft pull request. It never merges.

Ships zero project facts. Everything project-specific lives in the consuming repo's committed
`.deepen.yaml`. Claude Code only.

## Invariants

In priority order:

1. **The oracle comes before the change.** The behavior inventory — statements about
   user-observable behavior, each bound to executable checks — is written and committed before any
   source change, by an agent that never sees the plan or the diff, and the agent making the change
   cannot write it.
2. **The loop never merges.** It opens draft pull requests. A human merges them or closes them.
3. **Portability.** The plugin ships zero project facts, and every capability a project lacks
   degrades visibly — a line in the run's report and in the evidence pack, never a silent fallback.

## Install

```bash
/plugin install deepen@<github-user>-feature
```

## Skills

| Skill | When | Shape |
| --- | --- | --- |
| `setup` | once per repo, and again after the project adds a capability | interactive — probes the repo read-only, renders a readiness report, provisions the loop clone and state directory, writes `.deepen.yaml` after an approved diff. `--check` re-probes and refreshes the report without asking anything or touching the profile. |
| `run` | from the loop clone, once per candidate | semi-attended — validates the profile, takes the run lock, then dispatches the stages in order and stops wherever a decision is the human's. `--pin <candidate-id \| hint>` names the candidate, or where to look for one; without it, discover stops for a pick from the top three. |

Stage 1 (discover) ranks candidates with the read-only `explorer` agent, starting from a
churn × indentation hotspot table and filtering on what the loop already did with each candidate
(`<state_dir>/memory.md`).

Stage 2 (characterize) creates the run worktree at the base commit, has the fenced
`qa-characterizer` agent write the behavior inventory against the running app without seeing any
plan, replays every check itself, measures how much of the candidate's functions the checks reach,
and commits the inventory alone as the run branch's first commit, before any source change.

Stage 3 (decide) asks the human one question at a time — the interface shape, what sits behind the
seam, which existing tests survive and which are deleted, the rename map, the glossary terms, and
which inventory statements are expected to change — each with a proposed default. It reads the
inventory's summary and never its checks, and writes to no working tree: the answers become the
run's decision record, with `CONTEXT.md` and ADR edits carried in it as proposed diffs
that the implementer applies in stage 4. The read-only `architect` agent then judges the record
against the human's named next change; a fail is the human's call to revise, override or decline.
When the estimated diff exceeds `run.split_above`, the architect proposes a sequence of
independently verifiable pull requests for the human to confirm or override.

## Configuration

The profile contract — schema, field semantics, grammar, validation rules and state layout — is
[skills/setup/references/profile.md](skills/setup/references/profile.md). `/deepen:setup` is its
only writer; a run validates it and stops on the first failure, and never repairs it.

## What a project must supply

Each row is a capability the loop uses when the project provides it. The effect is what a run
prints in its report and evidence pack when it is missing. The authoritative table, with what would
supply each capability, is [profile.md §6](skills/setup/references/profile.md); `/deepen:setup`
renders the same rows as its readiness report.

| # | capability | effect if missing |
|---|---|---|
| 1 | dev command and URL | run cannot start — profile validation fails on app.dev / app.url |
| 2 | base branch | run cannot start — profile validation fails on base |
| 3 | readiness probe | readiness probe absent — the run waited for app.url to answer and took the first answer as ready |
| 4 | seam and seam auth | tier 2 unavailable — only browser statements are checked |
| 5 | fixture seed and reset | fixtures created through the UI — fewer and slower; the pack records the fixture count |
| 6 | frozen clock | no frozen clock — statements that depend on the current date are recorded unverifiable and listed |
| 7 | stubbed network | no network stub — statements that depend on external data are recorded unverifiable and listed |
| 8 | coverage env | touched-function coverage estimated by seam-call tracing — labelled estimate |
| 9 | e2e runner | tier 1 by live browser verification — marked manual-browser |
| 10 | mutation runner | mutation pass skipped — no mutation runner |
| 11 | `CONTEXT.md` glossary | glossary matrix derived from code and routes — marked derived |
| 12 | ADR directory | no ADR filter — candidates are not checked against recorded decisions |

## Runtime dependencies

A run depends on the `feature` plugin's reviewer agents and on the `mattpocock-skills` plugin.
