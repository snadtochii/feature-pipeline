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
