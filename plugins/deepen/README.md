# Deepen

A manually triggered loop, attended or unattended, that takes **one** deep-module refactor candidate to a
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
| `run` | from the loop clone, once per candidate | attended or unattended, per the profile's `attendance` — validates the profile, takes the run lock, then dispatches the stages in order and asks the human at each decision (`semi`) or takes the stop's default or aborts (`unattended`). `--pin <candidate-id \| hint>` names the candidate, or where to look for one; without it, discover stops for a pick from the top three — unattended, it takes the top-ranked candidate memory does not exclude. |

Stage 1 (discover) ranks candidates with the read-only `explorer` agent, starting from a
churn × indentation hotspot table and filtering on what the loop already did with each candidate
(`<state_dir>/memory.md`).

Stage 2 (characterize) creates the run worktree at the base commit, has the fenced
`qa-characterizer` agent write the behavior inventory against the running app without seeing any
plan, replays every check itself, measures how much of the candidate's functions the checks reach,
and commits the inventory alone as the run branch's first commit, before any source change.

Stage 3 (decide) asks one question at a time — the interface shape, what sits behind the
seam, which existing tests survive and which are deleted, the rename map, which new spec files the
change adds, the glossary terms, and
which inventory statements are expected to change — each with a proposed default, answered by the
human (`semi`) or by that default (`unattended`). It reads the
inventory's summary and never its checks, and writes to no working tree: the answers become the
run's decision record, with `CONTEXT.md` and ADR edits carried in it as proposed diffs
that the implementer applies in stage 4. The read-only `architect` agent then judges the record
against the named next change; a fail is revised, overridden or declined by the human, or, unattended,
handled by `decisions.architect_fail`.
When the estimated diff exceeds `run.split_above`, the architect proposes a sequence of
independently verifiable pull requests, confirmed or overridden by the human or by
`decisions.split`.

Stage 4 (implement) has the fenced `implementer` agent make the change the decision record
describes, in the run worktree, and gates it on the project's check runner; a red gate is another
attempt, bounded by `run.retries` and `run.max_wall_time`. The fenced `spec-mover` agent applies
the record's spec moves and deletions and nothing else; the fenced `spec-author` agent writes the
new spec files the record declares and nothing else. None of the three can write the inventory.

Stage 5 (verify) replays the inventory against the changed tree and classifies every statement
`preserved`, `changed` or `unverifiable`: a `changed` statement the record predicted is intended,
and one it did not is a regression the human rules on — or, unattended, one accepted under policy
that heads the evidence pack. It runs the mutation pass over the changed
lines when the profile names a runner, has the `architect` judge the diff against the named next
change, and has the `feature` plugin's four reviewers report findings; the accepted ones go to one
fenced fix round.

Stage 6 (deliver) re-checks stage 5's gate — an empty verification table or a missing coverage
line fails the run, pushes nothing, and keeps the branch diff as `abort.patch` — then renders the
evidence pack and opens it as the body of a draft pull request: under `unattended`, the mode and
every decision the run took by default, ahead of everything else; the candidate and its named next
change; the verification table, with every `changed` statement's before and after; touched-function
coverage, the uncovered functions and the mutation result; the architect's verdict on the diff and
the reviewers' findings; the decision record; the degradations that applied; and the run's cost.
It records the candidate in `<state_dir>/memory.md` — `opened` with the pull request's URL, or
`declined` with the reason — the human's, or, unattended, the architect's `one_line` or the decide
stage's own bound reason — when
stage 3 ended declined, plus a suggested ADR when that
reason states a rule — removes the worktree, and keeps the branch. The pack stays in the run's
report directory whether or not the pull request opened.

## Configuration

The profile contract — schema, field semantics, grammar, validation rules and state layout — is
[skills/setup/references/profile.md](skills/setup/references/profile.md). `/deepen:setup` is its
only writer; a run validates it and stops on the first failure, and never repairs it.

The profile's `attendance` field takes one of two values, switched with `/deepen:setup`:

- `attendance: semi` — the human pins the candidate and answers the decide stage's questions
  inline; any other decision pauses the run for an inline answer.
- `attendance: unattended` — no human is in the conversation: the run takes every decision from a
  stage default or the profile's `decisions:` block, and a stop with neither aborts.

The optional `decisions:` block holds the standing answers an unattended run takes in place of a
human; a semi run ignores it, and an absent key takes its default. `defaults` maps a decide field
to a one-line answer, permitted only for a field with no stage default — every field has one, so
the map is `{}`. `architect_fail` is `revise-once` (the default: the first architect fail reopens
its questions once, a second fail declines) or `decline` (the first fail declines); a fail the
architect escalates declines whatever the policy. `split` is `confirm` (the default: the run builds
slice 1 of the proposed split) or `override` (the whole record as one pull request).
`infra_stop` is `abort`: an infrastructure stop ends the run with its remedy instead of pausing.
`changed_statements` is `head-pack`: an unpredicted `changed` statement never pauses the run and
heads the evidence pack instead. The contract is
[profile.md §2](skills/setup/references/profile.md).

Run `semi` first, and make the first unattended run on a `worth-exploring` candidate pinned with
`--pin <id>` from an earlier discover report — unpinned, the rank rule takes a `strong` one first.

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
| 13 | secrets provisioning | secrets provisioning unverified — the dev server may not start in a fresh worktree; the run copies no secrets file |
| 14 | browser session | no browser session — manual-browser statements behind a sign-in use a test login the repo documents, else are recorded unverifiable and listed |

**Tier-2 collectability.** The inventory's tier-2 checks are files under `paths.inventory` that
`checks.runner` must collect and no `paths.specs` glob may match; they carry the token `check`
where the runner's convention puts its test token (`<name>.check.ts` beside `<name>.spec.ts`).
A runner whose include list equals the spec globs collects none of them, so the project adds an
inventory include — for vitest, `tests/behavior/**/*.check.ts?(x)` in `test.include`.
`/deepen:setup` fails on the missing include and names the line to add. A candidate's checks share
one seam helper at `<inventory><slug>/tier2/lib/`, whose name carries no `check` token; an include
pattern broad enough to collect it (such as `**/*.ts`) makes the runner fail it as a file with no
tests, which turns the implement stage's gate red, so keep the inventory include on the `check`
token. Where the include collects every file under the inventory, the checks keep their seam
client inline instead.

**Secrets.** Project commands read project secrets; the run never copies, sources or reads them.
A run's worktree gets no env or secrets file: its `.worktreeinclude` copy skips every pattern and
path that names one, and reports each skip. A project whose dev server needs a secret therefore
supplies a start path that works without a copied file — a test-mode start that runs on throwaway
data and needs no secrets at all, or a start script that resolves its secrets from the OS keychain
at launch (for example, one that reads a token with the platform's keychain CLI and exports it
into the server's own process only). `/deepen:setup` scores the row from file names alone.

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
  Missing → `tier 1 unavailable — browser tools not installed`. A profile with
  `app.browser_session` also needs the Playwright MCP's storage-state tool, enabled with
  `--caps=storage`, and file access to `<state_dir>`, which sits outside the workspace roots and
  so takes `--allow-unrestricted-file-access`. Without the tool →
  `browser session unused — the browser storage-state tool is not available in this session`.

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
