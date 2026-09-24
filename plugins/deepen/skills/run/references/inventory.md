# The behavior inventory

Authoritative contract for the oracle a `deepen:run` judges its change against: the statement
line, how statements bind to checks, the two check tiers and the environment every check reads,
the fixture matrix, the committed layout, and the check round that replays it.

- **Written only by the QA role.** `deepen:qa-characterizer` writes the inventory in characterize
  mode, under the fence's `qa` set ([fence.md](fence.md) §3); the stage makes the one commit that
  holds it. No other role can write under `paths.inventory`.
- **Read by** the characterize stage ([stage-2-characterize.md](stage-2-characterize.md)), which
  replays it (§7) and summarizes it; the decide stage, which reads that summary and never the
  checks; and the verify stage, which replays it against the changed tree and classifies every
  statement (§8), with a verify-mode QA spawn supplying the observed outcome of red statements and
  the behavior no statement describes.
- **Inlined, never linked,** in the QA role's brief: §1–§6 travel verbatim as data in
  characterize mode, §1 and §8 in verify mode, because a spawned role follows no reference.

`<inventory>` is `paths.inventory` (repo-relative, trailing `/`), `<slug>` the run's slug
([candidates.md](candidates.md) §6), `<run_dir>` the fence's `run_dir` ([fence.md](fence.md) §1).

---

## §1 Statement

One line per statement, five fields separated by ` | `:

```
<id> | <domain term> | <given fixture> | <when> | <then>
```

| Field | Value |
| --- | --- |
| `<id>` | `^S[0-9]{2,3}$`, unique within the inventory |
| `<domain term>` | a term from the glossary — `CONTEXT.md`, or the derived glossary (§5) |
| `<given fixture>` | a fixture id (§5), or several joined with `,` |
| `<when>` | what a user or a caller of the seam does, in domain words |
| `<then>` | what they observe, in domain words |

- **Prose free of implementation names.** No identifier, file path, function, component, table or
  column name — the statement must survive the refactor it judges. The domain words the glossary
  gives are the vocabulary.
- **Describe, never judge.** A statement records what the untouched tree does, including behavior
  that looks wrong; the QA role lists what looked wrong in its reply, never in a statement.
- A `|` inside prose is written `/`, so every line has exactly five fields.
- **Every statement is bound** to at least one check (§2), or is listed as `unverifiable` with one
  reason: `clock` (depends on "now" and `app.clock` is null, or needs a second instant), `network`
  (depends on external data and `app.network` is null), `no seam`, `no browser`, or a one-line
  other reason.

---

## §2 Bindings

One line per statement that has checks:

```
<statement-id> -> <check-id>[, <check-id>…]
```

- Check ids are `^T[12]-[0-9]{2,3}$` — the digit after `T` is the tier (§3, §4).
- Each check id names exactly one check file and belongs to exactly one fixture group (§6).
- A statement may bind checks in several fixture groups; each check still runs once per round.

---

## §3 Tier 2 — below the browser

A tier-2 check calls a profile seam against seeded state and asserts on the returned DTO — the
response body, status and headers for `http` and `server-fn`, the output and exit code for `cli`.

- **Form.** A file in the project's `checks.runner` style, named so the runner collects it and
  **no `paths.specs` glob matches it** — a file a spec glob reaches is writable by the spec-mover,
  and the characterize stage aborts on it before the commit.
- **Skip unless served.** Each check skips (the runner's own skip, never a pass-by-assertion) when
  `DEEPEN_APP_URL` is unset, so a runner invoked without a dev server — the implement stage's gate —
  does not fail on it.
- **Environment contract** — the only way a check learns where the app is:

  | Variable | Value |
  | --- | --- |
  | `DEEPEN_APP_URL` | `app.url` |
  | `DEEPEN_SEAM_<n>_BASE` | the `base` of seam `<n>`, counted from 1 in profile order |
  | `DEEPEN_SEAM_<n>_AUTH` | the credential seam `<n>`'s `auth` printed, set only for a live seam whose `auth` is a command |
  | `DEEPEN_CHECK_LOG` | a file path; when set, the check appends its own check id and a newline when it runs |

- **Never prints a credential** — no logging of `DEEPEN_SEAM_<n>_AUTH`, no assertion message that
  would echo it.
- **Deterministic.** Assertions hold on fixture state, the frozen clock and the stubbed network
  alone; a value that differs between two runs (a generated id, a timestamp with no clock) is
  asserted by shape, or the statement is `unverifiable`.

---

## §4 Tier 1 — in the browser

Few, and only for what tier 2 cannot reach: rendering, navigation, form gating.

- **With `checks.e2e`** — spec files in its runner, reading the §3 environment contract, skipping
  unless `DEEPEN_APP_URL` is set, appending to `DEEPEN_CHECK_LOG`.
- **Without** — a numbered step list per statement, `tier1/manual/<statement-id>.steps.md`,
  verified live through browser tools and marked `manual-browser`. Each verified statement leaves
  two full-page screenshots at fixed names:

  ```
  <run_dir>/screenshots/<statement-id>-1280x800.png
  <run_dir>/screenshots/<statement-id>-390x844.png
  ```

- Tier 1 is kept in the commit with tier 2, as the run's regression net; `inventory.md`'s header
  records which form it took.

---

## §5 Fixture matrix

- **Every glossary term naming a state or a case gets at least one fixture.** A case the QA role
  could not create is a line of the uncovered list, with its reason — never silently absent.
- **Glossary.** `CONTEXT.md` at the repo root. Absent → terms derived from route and schema names,
  and the matrix is marked `derived`.
- **Fixture ids** are `^F[0-9]{2,3}$`. Each fixture is created one way:
  - `app.seed` and `app.reset` both set → a seed file under `fixtures/`, loaded by the seed
    wrapper with the file as its argument after the reset wrapper empties the store;
  - either null → a numbered step list, `fixtures/<fixture-id>.steps.md`, followed through the
    UI; the matrix records the fixture count, since each one costs a browser pass.
- **Matrix line**:

  ```
  <fixture-id> | <domain term> | <state or case> | seeded | ui
  ```

  the last field one of `seeded` or `ui`.

---

## §6 Layout

Everything lives under one per-candidate folder, so a kept net never collides with a later run's:

```
<inventory><slug>/
  inventory.md                 # header, statements, matrix, bindings, unverifiable, uncovered
  fixtures/<fixture-id>.*      # seed files, or <fixture-id>.steps.md
  tier2/<fixture-id>/…         # tier-2 check files, grouped by the fixture they need
  tier1/<fixture-id>/…         # e2e specs, grouped the same way
  tier1/manual/<statement-id>.steps.md    # manual-browser step lists
```

Every path under the folder uses only the characters `[A-Za-z0-9._/-]` and has no `..` segment —
the run writes these names into shell command lines, and the stage aborts on any other name.

`inventory.md` opens with three header lines:

```
candidate: <candidate-id> <name>
now: <ISO-8601 instant, UTC, Z suffix>
tier1: e2e | manual-browser
```

`now` is the run's one frozen instant — `<BASE_SHA>`'s committer date in UTC
(`git show -s --format=%cI "<BASE_SHA>"`, normalized to `Z`) — the value `app.clock` is set to for
every server this inventory runs against, in this run and any later replay. A statement needing a
second instant is `unverifiable` (`clock`).

Then the sections `## Statements` (§1), `## Fixture matrix` (§5), `## Bindings` (§2),
`## Unverifiable` (`<statement-id> — <reason>`) and `## Uncovered` (`<domain term> — <case> —
<reason>`), in this order. An empty section keeps its heading and says `none`.

A fixture group is a fixture id with every check under `tier2/<fixture-id>/` and
`tier1/<fixture-id>/`. A UI-created fixture is recreated from its step list by the QA role in
whichever stage replays the group.

---

## §7 The check round

Executed by the run skill, never by the QA role, against a dev server the run started, through
the wrapper scripts [dev-server.md](dev-server.md) §1 writes. Round `<r>` writes under `<state_dir>/runs/<run-id>/round-<r>/`.

For each fixture group, in matrix order:

1. `reset.sh`, then `seed.sh "<WT>/<inventory><slug>/fixtures/<file>"` — when the fixtures are
   seeded (§5). A UI-fixture group runs only on a server where the QA role has just recreated its
   fixture from the step list, a spawn the replaying stage owns (§6). A stage that makes no such
   spawn runs none of the group's steps and records it `not replayed — UI fixture`: a fresh
   server holds none of that state, and a store that kept it holds every fixture's state at once.
2. `check.sh <the group's tier-2 files>` — when the group has tier-2 checks, `checks.runner` is set
   and a seam is live.
3. `e2e.sh <the group's tier-1 spec files>` — when the group has e2e specs.

Each wrapper runs as `cd "<WT>" && bash "<state_dir>/runs/<run-id>/<script>" …` with
`DEEPEN_CHECK_LOG` pointed at `round-<r>/<fixture-id>.log`, emptied first. Per group, record the
exit code of each step and the last 200 lines of its output in `round-<r>/<fixture-id>.out` — the
check wrappers' output, already stripped of every seam credential by the wrapper itself.

- **Every bound check executed.** The set of ids in the group's check log must equal the group's
  bound check ids. Missing ids → the group is red with `not executed: <ids>` — a check the runner
  skipped silently is not a pass.
- **Green** — every step exit 0 and no missing id.
- **Tier-2 wall time** — the sum, over groups, of the reset, seed and tier-2 step durations
  (`date +%s` around each). Reported as `tier 2 wall time: <s>s`; over 120 seconds adds the line
  `tier 2 wall time over two minutes — <s>s`, which is a report line, never a failure.
- **Empty inventory** — zero statements leaves nothing to judge a change against, so the
  characterize stage ends aborted with `inventory: empty — <the QA role's reason>`.
- **Round names** — the characterize stage names its rounds `m<r>`; the verify stage names its
  rounds `v<k>`, so its round directories are `round-v<k>/` and never collide with the
  characterize ones.

---

## §8 Classification

What each statement does on the changed tree, recorded by the verify stage. The stage classifies
every statement mechanically from its check round (§7) and the bindings (§2); a verify-mode QA
spawn replays what the round cannot, words the observed outcome of red statements, and lists
behavior no statement describes. Both write lines of these shapes and nothing else, and the stage
validates every line against them before it reaches a report.

One line per inventory statement, fields separated by ` | `:

```
<S-id> | preserved | <evidence>
<S-id> | changed | before: <then> | after: <observed then>
<S-id> | unverifiable | <reason>
```

| Field | Value |
| --- | --- |
| `<S-id>` | a statement id of this inventory (§1) |
| `<evidence>` | the green check ids, joined with `, `; or `qa-session` — a check replayed in the QA spawn's session; or `manual-browser` — a step list replayed live |
| `before:` | the statement's `<then>`, verbatim |
| `after:` | what is observed now, in §1's prose rules |
| `<reason>` | the inventory's own reason (§1); `not replayed — UI fixture`; `seam-auth-failed`; `group not executed`; or a one-line other reason |

Then zero or more lines for behavior observed in the replayed area that no statement describes:

```
new | <domain term> | <given> | <when> | <then>
```

- **Prose rules as §1** — domain words, no implementation names, a `|` inside prose written `/`,
  one line each.
- **Class rules.** A statement is `preserved` only when every check it binds is green, and
  `changed` when any is red — a statement bound in two groups, one red and one green, is
  `changed`. A red statement is never `preserved`, whoever wrote the line.
- **A `new` line is never committed.** It is recorded in the verify report only; the inventory
  stays exactly as its commit left it.
