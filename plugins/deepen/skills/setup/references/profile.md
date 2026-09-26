# The `.deepen.yaml` contract

Authoritative schema for a consuming repo's deepen profile. Written by `deepen:setup`, read
by every run. Committed at the repo root.

- **Setup is the only writer.** A run reads the profile, validates it, and stops on a
  failure. **A run never repairs the profile** — not a typo, not a stale path, not a missing
  key. The remedy for every failure is `/deepen:setup`.
- **Model-read.** The file is read with `Read`, never parsed with `yq` or `jq`; the rules in
  §3 and §4 are what the reader checks.
- **Zero project facts in the plugin.** Every command, URL, path and glob the loop needs lives
  here. A repo with no `.deepen.yaml`, or with `version` other than `1`, is not eligible and a
  run refuses rather than guessing.

The capability table in §6 is the single source for two renderings: a run prints its
`effect if missing` lines as degradations, and `deepen:setup` renders the same rows as the
readiness report ([readiness.md](readiness.md)). Neither restates the table, so the two can
never disagree.

---

## §1 Full schema

Placeholder values only. Each key is marked **required**, **required, nullable** (the key
must be present; `null` is a stated absence), or **optional** (the key may be omitted, and
omitted means the same as `null`).

```yaml
version: 1                          # required, must be 1
attendance: semi                    # required — semi | unattended

base: main                          # required — the branch every run forks from
loop_clone: "~/<path>/<repo>-deepen"    # required — the dedicated checkout the loop owns
state_dir: "~/.deepen/<repo>"       # required — run state, OUTSIDE every working tree

app:
  install: "<command>"              # required, nullable — makes a fresh worktree runnable
  prelude: null                     # optional — prefixed to every command; toolchain selection
  dev: "<command>"                  # required — serves the app locally
  url: "http://localhost:<port>"    # required — where `dev` serves it
  ready: "GET /<path> -> 200"       # required, nullable — readiness probe
  seed: "<command>"                 # required, nullable — loads one fixture file
  reset: "<command>"                # required, nullable — returns the app to its empty state
  clock: "<ENV_NAME>"               # required, nullable — env var the server reads for "now"
  now: null                         # optional — the run's frozen instant; ISO-8601 with Z or ±hh:mm
  network: "<ENV_NAME>=<value>"     # required, nullable — env that stubs external calls
  coverage_env: "<ENV_NAME>=<dir>"  # required, nullable — env that makes the server write coverage
  browser_session: null             # optional — a command, or the literal `none`; writes a browser session to $1

seams:                              # optional — absent and [] both mean "no seam"
  - kind: http                      # required per seam — http | server-fn | cli
    base: "http://localhost:<port>/<prefix>"   # required per seam
    auth: none                      # required per seam — a command, or the literal `none`

checks:
  runner: "<command>"               # required, nullable — the existing unit/spec runner
  e2e: "<command>"                  # required, nullable — the project's browser e2e runner
  coverage: null                    # optional — informational unit-runner coverage command
  mutation: null                    # required, nullable — mutation runner

paths:
  inventory: "<dir>/behavior/"      # required — where committed inventory + checks live
  forbidden: []                     # required — globs a run never changes
  specs: []                         # required — the project's spec files

run:
  split_above: 600                  # optional, default 600 — diff lines; advisory
  retries: 3                        # optional, default 3 — implementer attempts per failing round
  max_wall_time: "90m"              # optional, default 90m — implementer wall-time bound
  coverage_threshold: 80            # optional, default 80 — touched-function coverage, percent

decisions:                          # optional — read only when attendance is unattended
  defaults: {}                      # optional, default {} — <decide field>: <one-line answer>, only for a field stage 3 states no default for
  architect_fail: revise-once       # optional, default revise-once — revise-once | decline
  split: confirm                    # optional, default confirm — confirm | override
  infra_stop: abort                 # optional, default abort — the only value
  changed_statements: head-pack     # optional, default head-pack — the only value
```

---

## §2 Field semantics

### `attendance`

How much of a run waits for a human. Two values:

- **`semi`** — the human pins the candidate and answers the decide stage's questions inline;
  every other stage runs without them, and a `needs-decision` line pauses the run for an inline
  answer.
- **`unattended`** — no human is in the conversation. The run takes every decision from a stage
  default or from the profile's `decisions:` block, and a stop that has neither aborts with its
  stop line and remedy instead of pausing.

### `base`

The **short** branch name (`main`, not `origin/main`). Must exist on `origin`. Every run
worktree forks from `origin/<base>`, never from whatever branch a checkout happens to be on.

### `loop_clone`

Absolute or `~`-prefixed path to a dedicated clone the loop owns, kept on `base`. A sibling
of the user's checkout, never inside it; setup proposes `<repo-parent>/<repo-name>-deepen`. A
separate clone decouples the run from the user's branch state, and the committed profile on
`base` is always the one that governs.

Run worktrees are created at `<loop_clone>/../<clone-dirname>-worktrees/<run-id>`.

A `loop_clone` shared with another loop that keeps its own lock (a tidy-loop clone named in
the repo's `.tidyloop.yaml`, for example) is refused by §4 rule 14: the two locks do not
exclude each other, so two runs could position the same clone at once.

### `state_dir`

Where the loop keeps everything that is not a repository artifact. It **must sit outside every
working tree** — outside `loop_clone`, outside its worktrees directory, and outside any other
git checkout. A run aborts at preflight when the loop clone is dirty, so state written inside
the clone would appear as untracked files and every later run would abort on the residue of the
one before. The layout is §5.

### `app.install` and `app.prelude`

`install` makes a fresh worktree runnable — the dependency install the project documents,
derived by setup from its lockfile. `null` means a fresh worktree needs nothing installed.

`prelude`, when set, is prefixed to every command in the profile. A run started from a minimal
environment lacks the version manager a shell profile loads, so a pinned runtime version needs
a line that selects it; setup proposes one from the repo's version files. Absent means the
commands run as written.

Both are env-free: each must succeed in a fresh worktree that has no `.env` and no secrets.

### `app.dev` and `app.url`

`dev` is the command that serves the app; `url` is the address it serves on. A run starts
`dev` itself in the run worktree and confirms that nothing already answers on `url` before
starting it, so a server left running from another checkout never answers for the run.

### `app.ready`

How a run knows the dev server can serve requests. Either an HTTP probe written
`GET /<path> -> <status>`, requested against `url`, or a single-line command that exits 0 once
the app is ready. `null` → the capability table's readiness row applies.

### `app.seed` and `app.reset`

`seed` loads one fixture file into the app's state; a run invokes it with the fixture path as
its first positional argument. `reset` returns the app to its empty state between fixtures.
Either `null` → the fixture row applies (fixtures are created through the UI).

### `app.clock`

The **name** of an env var the server reads for the current instant. A run sets it to the
run's frozen instant `now` ([inventory.md](../../run/references/inventory.md) §6) when it
starts `dev`. `null` → the frozen-clock row applies.

### `app.now`

An ISO-8601 instant with an explicit zone — `Z` or `±hh:mm` — that replaces `<BASE_SHA>`'s
committer date as the run's one frozen instant. Set it when the project's fixtures are pinned
to a date and their loader refuses any other clock: the committer date moves with every
commit, the fixture date does not. Absent or `null` → the committer date stands.

A run converts the value to UTC with a `Z` suffix, the same conversion the committer date
gets, so an offset near midnight moves the date: `2026-03-01T00:30:00+02:00` becomes
`2026-02-28T22:30:00Z`. Write a mid-day `Z` value — `<date>T12:00:00Z` — so the date is the
same in every nearby zone.

The instant is one value for the whole run and for every replay. Stage 2 records it in the
inventory header as `now:` with `now-source: profile`
([inventory.md](../../run/references/inventory.md) §6), and a later replay uses that recorded
value, never the profile's current one — editing `app.now` after an inventory is committed
cannot change what that inventory's checks run against. Only `app.clock` carries it to the
server, so a set `app.now` with a null `app.clock` fails §4 rule 15.

### `app.network`

`NAME=value` — an env assignment that makes the server answer external calls from local stubs.
A run adds it to the dev server's environment. `null` → the stubbed-network row applies.

### `app.coverage_env`

`NAME=value` — an env assignment passed to the dev server so it writes runtime coverage to a
directory, which a run reads to measure how much of the candidate's touched functions the
inventory's checks exercised. The value may contain the literal placeholder `<dir>`, which the
run replaces with a directory under `<state_dir>/runs/<run-id>/`. `null` → coverage is
estimated by seam-call tracing and labelled as an estimate.

### `app.browser_session`

A one-line command that signs a test user in and writes a Playwright storage-state file — the
browser's cookies and local storage — to the path a run passes as its first positional
argument, `$1`. A run writes the value verbatim into its script and appends no arguments to
it ([dev-server.md](../../run/references/dev-server.md) §1), so the value places `"$1"` wherever
the project's login needs the path: `pnpm -s test:login "$1"`, or
`APP_SESSION_FILE="$1" pnpm -s test:login`. The script discards everything the command prints,
so a login that prints its cookie never reaches a report.

The literal `none` states that the app needs no sign-in. Absent or `null` → the browser session
row applies.

The file the command writes is a credential: it lives only under `<state_dir>/runs/<run-id>/`,
never in the repo, and a run names it to the QA role by path only
([dev-server.md](../../run/references/dev-server.md) §6). A run uses it only when
`checks.e2e` is null — an e2e runner's specs sign in on their own.

### `seams`

Where the inventory's tier 2 checks call the app below the browser. Each entry has:

- **`kind`** — `http` (an HTTP API), `server-fn` (server functions reached over HTTP), or
  `cli` (a command-line entry point).
- **`base`** — for `http` and `server-fn`, the URL prefix the checks call; for `cli`, the
  command the checks invoke.
- **`auth`** — a command whose stdout is the credential a check presents (a cookie or header
  line, treated as opaque and never logged), or the literal `none` when the seam needs no
  session. **`auth` is required on every seam**: an absent `auth` fails validation, so a missing
  auth is never read as "no auth needed". A seam whose auth cannot be supplied is left out of
  `seams` rather than written with a guess.

`seams` absent and `seams: []` both mean "no seam" → the seam row applies.

### `checks`

- **`runner`** — the project's existing unit/spec runner. `null` only when `paths.specs` is
  empty: a repo with no spec files has nothing for it to run.
- **`e2e`** — the project's browser end-to-end runner. `null` → the e2e row applies.
- **`coverage`** — optional and informational: the unit runner's own coverage command, recorded
  for the evidence pack. The touched-function measurement and its degradation key on
  `app.coverage_env` alone.
- **`mutation`** — the mutation runner, invoked with the environment and output contract of the
  run's verify stage ([stage-5-verify.md](../../run/references/stage-5-verify.md) §4). `null` →
  the mutation row applies.

### `paths`

- **`inventory`** — the directory, repo-relative with a trailing `/`, where the behavior
  inventory and its checks are committed. Setup proposes `<convention>/behavior/` after probing
  the repo's test-directory convention (`tests/`, `test/`, `e2e/`, `__tests__/`), defaulting to
  `tests/behavior/`. Only the QA role writes here.

  Its tier-2 checks are files `checks.runner` collects while no `paths.specs` glob matches them
  ([inventory.md](../../run/references/inventory.md) §3); they carry the token `check` where
  the runner's naming convention puts its test token. A runner whose include list is exactly the
  spec globs collects none of them, so the project's runner configuration names the inventory's
  checks too — rule 16 — and the include line to add is part of every failure of that rule.
- **`forbidden`** — globs a run never changes: migrations, schema declarations, published
  contracts, generated sources. Setup proposes candidates from what it finds and asks; the
  consequences are project knowledge, so it never invents the list silently.
- **`specs`** — the project's spec files. Existing specs change only through the rename map a
  run's decision record declares. An empty list is permitted only for a repo with no spec files,
  and setup states that conclusion explicitly rather than defaulting to it.

### `run`

- **`split_above`** — advisory, never a rejection: when the decide stage's diff estimate exceeds
  it, the run proposes a sequence of independently verifiable pull requests for the human to
  confirm or override — or, when `attendance` is `unattended`, for `decisions.split` to answer.
  There are no size caps. The estimate and this threshold share one unit, defined in
  [decision-record.md](../../run/references/decision-record.md) §4.
- **`retries`** — implementer attempts per failing check round.
- **`max_wall_time`** — wall-time bound on the implementer.
- **`coverage_threshold`** — the touched-function coverage percentage below which a run extends
  the inventory once, then leads the evidence pack with the gap.

### `decisions`

The standing answers an unattended run takes in place of a human. Optional, and read only when
`attendance` is `unattended`: a semi run ignores the block entirely, and a semi profile written by
setup carries none. An absent key takes its default.

- **`defaults`** — a map from a decide field name to a one-line answer, permitted only for a
  field [stage-3-decide.md](../../run/references/stage-3-decide.md) §5 states no default for
  (rule 18). Every §5 field states one, so the map is `{}` and setup asks nothing for it.
- **`architect_fail`** — `revise-once` (default): the first architect fail re-opens the questions
  its failing checks map to, once; a second fail declines the candidate and writes its `declined`
  memory line. `decline`: the first fail declines.
- **`split`** — answers a split the decide stage proposes past `run.split_above`. `confirm`
  (default): the run builds slice 1 of the proposed split. `override`: the whole record as one
  pull request.
- **`infra_stop`** — `abort`, the only value: every infrastructure stop aborts with its stop line
  and remedy, never pauses.
- **`changed_statements`** — `head-pack`, the only value: changed statements found by the verify
  stage never pause the run; they head the evidence pack.

---

## §3 Grammar and character classes

Every value that reaches a shell or a path is checked against its class **before any use**,
not after a lookup. Command values never reach a shell by interpolation into a command string:
a run writes each one verbatim into a script file under `<state_dir>/runs/<run-id>/` and
executes that file, passing run-supplied arguments (a fixture path) as quoted positional
parameters.

| Field | Class | Why |
|---|---|---|
| `version` | the integer `1` | the only schema this contract describes |
| `attendance` | `semi` or `unattended` | the two modes a run implements |
| `base` | `^[A-Za-z0-9._/-]+$`, no leading `-`, no `..` — checked without a shell; then passes `git check-ref-format --branch` | it becomes a ref argument |
| `loop_clone`, `state_dir` | absolute or `~/`-prefixed; characters `[A-Za-z0-9._/~-]`; no `..` segment | they become path arguments and `cd` targets |
| `app.install`, `app.prelude`, `app.dev`, `app.seed`, `app.reset`, `checks.runner`, `checks.e2e`, `checks.coverage`, `checks.mutation` | one line: no newline, carriage return or NUL | each is written verbatim into one script file; `prelude` is prefixed to others |
| `app.ready` (command form), `seams[].auth` (command form), `app.browser_session` (command form), `seams[].base` for `cli` | same one-line class | same |
| `app.ready` (probe form) | `GET /<path> -> <status>`; path `^/[A-Za-z0-9._~/-]*$`; status three digits | the path is appended to `url` |
| `app.url`, `seams[].base` for `http`/`server-fn` | `^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$` | requested by the run; no query, credentials or fragment |
| `app.clock` | `^[A-Z_][A-Z0-9_]*$` | an env var name the run assigns |
| `app.now` | `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z\|[+-][0-9]{2}:[0-9]{2})$` | an instant the run writes into the inventory header and a server env |
| `app.network`, `app.coverage_env` | `NAME=value`; `NAME` as `app.clock`; `value` `^[A-Za-z0-9._/:,+@%=-]*$` — no quotes, `$`, backtick, `;`, `&`, `\|`, `<`, `>` or whitespace — except the literal `<dir>` placeholder, allowed in `coverage_env` only | an env assignment the run adds to the dev server's environment |
| `seams[].kind` | `http`, `server-fn` or `cli` | selects how checks call the seam |
| `paths.inventory` | repo-relative, trailing `/`, characters `[A-Za-z0-9._/-]`, no `..` segment, no leading `/` | a fence root and a commit path |
| `paths.forbidden[]`, `paths.specs[]` | repo-relative gitignore-style globs, characters `[A-Za-z0-9._/*?{},\[\]-]`, no `..` segment, no leading `/` | fence patterns; resolved matches are containment-checked against the repo root |
| `run.split_above`, `run.retries`, `run.coverage_threshold` | non-negative integers | compared numerically |
| `run.max_wall_time` | `^[0-9]+[mh]$` | a duration the run converts to seconds |
| `decisions.defaults` keys | a decide field name, `^[a-z-]+$` | names the decide field the answer is for |
| `decisions.defaults` values | one line — no newline, carriage return or NUL — non-empty, no `\|`, and the named field's class in [decision-record.md](../../run/references/decision-record.md) §3 | each becomes a `decision:` line and an `A<n> \| <answer>` ledger line, where `\|` separates columns |
| `decisions.architect_fail` | `revise-once` or `decline` | selects what an architect fail does |
| `decisions.split` | `confirm` or `override` | selects how a proposed split is answered |
| `decisions.infra_stop` | exactly `abort` | the only infrastructure-stop policy |
| `decisions.changed_statements` | exactly `head-pack` | the only changed-statement policy |

**`~` expansion.** `loop_clone` and `state_dir` may start with `~/`. Every consumer expands that
leading `~/` to the absolute home directory (bound with `home=$(printf '%s' "$HOME")`) **once,
right after the class check and before any other use** — a shell command, a `Read` or `Write`
path, or a comparison. The shell never expands a `~` inside quotes, and the file tools take
absolute paths only, so an unexpanded value would name `./~/…` relative to the current directory
— inside a working tree. Everywhere else in this plugin, `<loop_clone>` and `<state_dir>` mean
the expanded path.

---

## §4 Validation rules

Every rule must hold. **Setup** evaluates all of them before writing the profile and lists every
failure. **A run** evaluates them in the order below and **stops on the first failure**, printing
one line:

```
profile: <field> — <what is wrong> — run /deepen:setup
```

Nothing runs after a failure, and the run does not edit the profile.

1. `version` is `1`.
2. `attendance` is `semi` or `unattended`. Any other value fails with
   `profile: attendance — <value> is not a mode (semi | unattended) — run /deepen:setup`.
3. Every present field matches its §3 class; the `decisions.*` fields only when `attendance` is
   `unattended`.
4. `base` exists on `origin`.
5. `loop_clone` resolves (after §3's `~` expansion) to a git checkout whose current branch is `base`
   and whose `origin` URL is the `origin` of the repo holding this profile.
6. `state_dir` is outside every working tree. Expand `~` per §3; take the nearest existing ancestor of
   `state_dir`; it must not be inside `loop_clone` nor inside
   `<loop_clone>/../<clone-dirname>-worktrees/`, and `git -C <ancestor> rev-parse --show-toplevel`
   must fail. Remedy: choose a directory outside every checkout, such as under `~/.deepen/`.
7. `app.dev` and `app.url` are present and non-empty.
8. Every key marked **required** or **required, nullable** in §1 is present; `null` is allowed
   only for the latter.
9. Every seam has `kind`, `base` and `auth`; `auth` is a command or the literal `none`.
10. `checks.runner` is `null` only when `paths.specs` is empty.
11. `paths.inventory` is present, and no glob in `paths.specs` or `paths.forbidden` matches it.
12. Every glob in `paths.specs` matches at least one tracked file.
13. `run.retries ≥ 1`, `run.split_above ≥ 1`, and `run.coverage_threshold` is between 1 and 100.
14. `loop_clone` (after `~` expansion) is not the `loop_clone` of another loop's profile at the
    repo root — `.tidyloop.yaml`'s `loop_clone`, `~` expanded the same way, when that file exists. Remedy:
    choose a separate clone path.
15. `app.now`, when non-null, is a real calendar instant — its date exists, and its time and
    offset are in range; the zone itself is rule 3's class — and `app.clock` is non-null. An
    impossible instant fails with
    `profile: app.now — <value> is not a calendar instant — run /deepen:setup`; a set `app.now`
    with a null `app.clock` fails with
    `profile: app.now — set without app.clock, so no server reads it — run /deepen:setup`.
16. When `seams` is non-empty and `checks.runner` is non-null, the runner collects a check file
    under `paths.inventory`: its configured include patterns — or its documented default when it
    configures none — match `<inventory>**/<name>.check.<ext>` (or the runner's own placement of
    the `check` token, [inventory.md](../../run/references/inventory.md) §3) for the project's
    source extension, and no `paths.specs` glob matches that path. Otherwise no tier-2 check can
    run: the stage that writes them aborts before the first commit. Fails with
    `profile: paths.inventory — checks.runner collects nothing under <inventory> outside paths.specs — add <the include pattern> to <the runner's config file>`,
    the pattern spelled in the runner's own syntax. The remedy is a repository change; setup and a
    run report it and never make it.
17. `app.browser_session`, when non-null, is the literal `none` or a command — never the path of
    a session file. A value matching `^[A-Za-z0-9._/~-]+\.json$` fails with
    `profile: app.browser_session — <value> names a session file; the field is the command that writes one — run /deepen:setup`.
18. When `attendance` is `unattended`, every key of `decisions.defaults` names one of the fields
    [stage-3-decide.md](../../run/references/stage-3-decide.md) §4's table assigns to §5, and
    that field's §5 entry states no default; and every §5 field that states no default has an
    entry. A key naming no §5 field fails with
    `profile: decisions.defaults.<key> — not a decide field — run /deepen:setup`; a key naming a
    field with a stage default fails with
    `profile: decisions.defaults.<key> — stage 3 answers it with its own default — remove the entry (run /deepen:setup)`;
    a field with no stage default and no entry fails with
    `profile: decisions.defaults — <field> has no stage default and no entry — run /deepen:setup`.

A failed rule names the field and the remedy. Rules 4–6, 12, 14 and 16 describe the machine and
the repository rather than the file; setup checks them at write time and a run re-checks them in
preflight ([preflight.md](../../run/references/preflight.md)).

When every rule is evaluated (setup and `--check`), a field that fails rule 3 is never passed to
a command: each later rule that would use it is reported as not evaluated, naming the failed
class.

---

## §5 State layout

Under `state_dir` the loop owns exactly:

```
<state_dir>/readiness.md                   # the readiness report — written by deepen:setup,
                                           # its tier line read by every run
<state_dir>/memory.md                      # one line per candidate the loop has acted on —
                                           # opened, declined or merged (run/references/
                                           # memory.md); setup creates it with its header
<state_dir>/reports/<run-id>/              # one run's stage reports and evidence — the
                                           # decision record, patches, the evidence pack
<state_dir>/inventory-drafts/<run-id>/     # the QA role's drafts and screenshots before commit
<state_dir>/runs/<run-id>/                 # one run's working files and command scripts,
                                           # removed when the run completes; kept after
                                           # an abort or a pause, for inspection
<state_dir>/tmp/<run-id>-*                 # a run's scratch files, removed before it exits
```

The listing is exhaustive: anything else under `state_dir` is residue, and anything left in
`tmp/` was left by a run that died.

The run lock deliberately sits **outside** `state_dir`, beside the loop clone's git common
directory — `<common-dir>/deepen.lock` — so its scope is the clone and every worktree hanging
off it ([preflight.md](../../run/references/preflight.md) §2).

---

## §6 Capability table

One row per capability a project supplies. **`effect if missing`** is the exact line a run
prints in its stage report and in the evidence pack's degradations section when the capability
is absent — a degradation is always both, never a silent fallback. **`what would supply it`**
is the project-neutral description `deepen:setup` shows in the readiness report, worded as
ordinary test-mode infrastructure.

| # | capability | profile field(s) | effect if missing | what would supply it |
|---|---|---|---|---|
| 1 | dev command and URL | `app.dev`, `app.url` | `run cannot start — profile validation fails on app.dev / app.url` | one command that serves the app locally, and the address it serves on |
| 2 | base branch | `base` | `run cannot start — profile validation fails on base` | a default branch on the remote that every change starts from |
| 3 | readiness probe | `app.ready` | `readiness probe absent — the run waited for app.url to answer and took the first answer as ready` | a route that answers success once the app can serve requests |
| 4 | seam and seam auth | `seams[]`, `seams[].auth` | `tier 2 unavailable — only browser statements are checked` | an HTTP API, server-function endpoint or CLI that tests can call directly, plus a scripted way to get a test session (or confirmation that none is needed) |
| 5 | fixture seed and reset | `app.seed`, `app.reset` | `fixtures created through the UI — fewer and slower; the pack records the fixture count` | a script that loads a fixture file into the development data store, and one that empties it |
| 6 | frozen clock | `app.clock` | `no frozen clock — statements that depend on the current date are recorded unverifiable and listed` | an env var the server reads for today's date |
| 7 | stubbed network | `app.network` | `no network stub — statements that depend on external data are recorded unverifiable and listed` | an env var that makes the server answer external calls from local stubs |
| 8 | coverage env | `app.coverage_env` | `touched-function coverage estimated by seam-call tracing — labelled estimate` | an env var that makes the development server write runtime coverage to a directory |
| 9 | e2e runner | `checks.e2e` | `tier 1 by live browser verification — marked manual-browser` | a browser end-to-end test runner with a command that runs one spec file |
| 10 | mutation runner | `checks.mutation` | `mutation pass skipped — no mutation runner` | a mutation-testing tool configured for the unit test runner |
| 11 | `CONTEXT.md` glossary | none — `CONTEXT.md` at the repo root | `glossary matrix derived from code and routes — marked derived` | a `CONTEXT.md` glossary naming the domain's terms and the states they can be in |
| 12 | ADR directory | none — `docs/adr/` | `no ADR filter — candidates are not checked against recorded decisions` | a `docs/adr/` directory of recorded architecture decisions |
| 13 | secrets provisioning | none — `.worktreeinclude` and the dev start path | `secrets provisioning unverified — the dev server may not start in a fresh worktree; the run copies no secrets file` | a start path that needs no copied secrets file: a test-mode fallback for throwaway data, or the project's own start script resolving its secrets from the OS keychain |
| 14 | browser session | `app.browser_session` | `no browser session — manual-browser statements behind a sign-in use a test login the repo documents, else are recorded unverifiable and listed` | a script that signs a test user in and saves the browser's cookies and local storage to a file path it is given |

Rows 1 and 2 are required: their absence is a validation failure, not a degradation. Row 4
covers both parts: a seam without a usable auth is left out of `seams`, so the same line applies.
Row 13 has no profile field: setup scores it from file names alone
([readiness.md](readiness.md)), and a run prints its line when
[worktree.md](../../run/references/worktree.md) §4 skipped a `.worktreeinclude` path.
Row 14 applies only when `checks.e2e` is null, since only then does a run hold manual-browser
statements. `none` prints no line; a command that fails in a round adds row 14's line for that
round ([dev-server.md](../../run/references/dev-server.md) §6).

**Run-only rows.** These describe the run's environment rather than the project, so
`deepen:setup` does not render them:

| capability | effect if missing |
|---|---|
| `feature` reviewers absent | `reviewer pass skipped — feature plugin reviewer agents not installed` |
| browser tools absent | `tier 1 unavailable — browser tools not installed` |
| browser session tool absent | `browser session unused — the browser storage-state tool is not available in this session` |

---

## §7 What never goes in this file

- **No secret values.** The file is committed. It names commands, env var names and paths,
  never tokens, passwords or connection strings; `seams[].auth` is a command that obtains a
  credential, never the credential, and `app.browser_session` is a command that writes a
  browser session, never a session file or its content.
- **No per-run state.** Candidates, reports, drafts and memory live in `state_dir`. The profile
  is configuration, and a run never writes to it.
- **No `attendance` or `decisions:` change by a run.** Only setup writes them, on a human's
  answer. The profile's `decisions:` block is configuration a run reads and never writes, and it
  names no secrets.
