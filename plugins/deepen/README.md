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

Stage 4 (implement) has the fenced `implementer` agent make the change the decision record
describes, in the run worktree, and gates it on the project's check runner; a red gate is another
attempt, bounded by `run.retries` and `run.max_wall_time`. The fenced `spec-mover` agent applies
the record's spec moves and deletions and nothing else. Neither agent can write the inventory.

Stage 5 (verify) replays the inventory against the changed tree and classifies every statement
`preserved`, `changed` or `unverifiable`: a `changed` statement the record predicted is intended,
and one it did not is a regression the human rules on. It runs the mutation pass over the changed
lines when the profile names a runner, has the `architect` judge the diff against the named next
change, and has the `feature` plugin's four reviewers report findings; the accepted ones go to one
fenced fix round.

Stage 6 (deliver) re-checks stage 5's gate — an empty verification table or a missing coverage
line fails the run, pushes nothing, and keeps the branch diff as `abort.patch` — then renders the
evidence pack and opens it as the body of a draft pull request: the candidate and its named next
change; the verification table, with every `changed` statement's before and after; touched-function
coverage, the uncovered functions and the mutation result; the architect's verdict on the diff and
the reviewers' findings; the decision record; the degradations that applied; and the run's cost.
It records the candidate in `<state_dir>/memory.md` — `opened` with the pull request's URL, or
`declined` with the human's reason when stage 3 ended declined, plus a suggested ADR when that
reason states a rule — removes the worktree, and keeps the branch. The pack stays in the run's
report directory whether or not the pull request opened.

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

None of these is checked at install. A run looks for each one when it needs it, and a missing one
is a line in the report — never a silent fallback.

- **`mattpocock-skills`** — tested against 1.2.3 (commit `2ab9580`, from
  `github.com/mattpocock/skills`). A run invokes three of its skills, each with its own fallback
  line:
  - `codebase-design`, at discover —
    `codebase-design unavailable — explorer used its inline vocabulary summary`;
  - `grilling`, at decide —
    `grilling unavailable — inline dialogue used the stage's own question list`;
  - `domain-modeling`, at decide —
    `domain-modeling unavailable — CONTEXT.md and ADR diffs drafted from the stage's own format notes`.

  The version is not checked at runtime. If a later release changes these skills in a way the
  stages cannot use, vendor the vocabulary the stages need into this plugin rather than chase the
  upstream.
- **`feature`** — the verify stage spawns its four reviewer agents: `code-reviewer`,
  `security-engineer`, `performance-engineer` and `code-architect`. Not installed →
  `reviewer pass skipped — feature plugin reviewer agents not installed`.
- **`gh`** — the deliver stage pushes the run branch and opens the draft pull request; discover
  reconciles earlier pull requests against `memory.md`. Missing or unauthenticated → the deliver
  report's `pr: not opened — gh …` line, naming the pushed branch and the kept pack, and discover's
  `memory: gh unavailable — …` line.
- **`jq`** — the write fence parses every hook payload with it. Missing → the fence refuses every
  write, so the run aborts before it spawns a writing role.
- **`node`** — runs the touched-coverage script on the measured path. Missing → the script fails
  and coverage takes the estimate path, labelled `estimate (weak)` with the reason.
- **Browser tools** (Playwright or Chrome DevTools) — tier 1 when the profile has no e2e runner.
  Missing → `tier 1 unavailable — browser tools not installed`.

## First run — what the project must supply

A run is only as good as the checks it can run against the app. Three pieces of ordinary
test-mode infrastructure decide how many statements a run can check rather than record as
unverifiable:

- **A frozen clock** (`app.clock`) — an env var the server reads for today's date, so a statement
  about dates holds on every replay.
- **A stubbed network** (`app.network`) — an env var that makes the server answer external calls
  from local stubs, so a statement about external data does not depend on a third party.
- **Fixture seed and reset** (`app.seed`, `app.reset`) — a script that loads a fixture file into
  the development data store and one that empties it, so every check group starts from known data.

They are the project's work, not this plugin's, and a prerequisite of the first run rather than
something the run can build: the plugin ships no project facts. Until they exist, a first run's
verification is mostly `unverifiable` lines, and its success cannot be judged. `/deepen:setup`
probes for each and its readiness report says what is missing and what would supply it.
