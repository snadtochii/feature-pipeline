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
attendance: semi                    # required — only `semi` is accepted

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
  network: "<ENV_NAME>=<value>"     # required, nullable — env that stubs external calls
  coverage_env: "<ENV_NAME>=<dir>"  # required, nullable — env that makes the server write coverage

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
```

---

## §2 Field semantics

### `attendance`

How much of a run waits for a human. `semi`: the human pins the candidate and answers the
decide stage's questions inline; every other stage runs without them, and a `needs-decision`
line pauses the run for an inline answer. `semi` is the only accepted value. `unattended` is a
named value that validation rejects with a "not yet supported" line (§4 rule 2), so a profile
cannot opt into a mode the run does not implement.

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
fixture's ISO-8601 timestamp when it starts `dev`. `null` → the frozen-clock row applies.

### `app.network`

`NAME=value` — an env assignment that makes the server answer external calls from local stubs.
A run adds it to the dev server's environment. `null` → the stubbed-network row applies.

### `app.coverage_env`

`NAME=value` — an env assignment passed to the dev server so it writes runtime coverage to a
directory, which a run reads to measure how much of the candidate's touched functions the
inventory's checks exercised. The value may contain the literal placeholder `<dir>`, which the
run replaces with a directory under `<state_dir>/runs/<run-id>/`. `null` → coverage is
estimated by seam-call tracing and labelled as an estimate.

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
- **`mutation`** — the mutation runner. `null` → the mutation row applies.

### `paths`

- **`inventory`** — the directory, repo-relative with a trailing `/`, where the behavior
  inventory and its checks are committed. Setup proposes `<convention>/behavior/` after probing
  the repo's test-directory convention (`tests/`, `test/`, `e2e/`, `__tests__/`), defaulting to
  `tests/behavior/`. Only the QA role writes here.
- **`forbidden`** — globs a run never changes: migrations, schema declarations, published
  contracts, generated sources. Setup proposes candidates from what it finds and asks; the
  consequences are project knowledge, so it never invents the list silently.
- **`specs`** — the project's spec files. Existing specs change only through the rename map a
  run's decision record declares. An empty list is permitted only for a repo with no spec files,
  and setup states that conclusion explicitly rather than defaulting to it.

### `run`

- **`split_above`** — advisory, never a rejection: when the decide stage's diff estimate exceeds
  it, the run proposes a sequence of independently verifiable pull requests for the human to
  confirm or override. There are no size caps.
- **`retries`** — implementer attempts per failing check round.
- **`max_wall_time`** — wall-time bound on the implementer.
- **`coverage_threshold`** — the touched-function coverage percentage below which a run extends
  the inventory once, then leads the evidence pack with the gap.

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
| `attendance` | exactly `semi` | the only implemented mode |
| `base` | `^[A-Za-z0-9._/-]+$`, no leading `-`, no `..` — checked without a shell; then passes `git check-ref-format --branch` | it becomes a ref argument |
| `loop_clone`, `state_dir` | absolute or `~/`-prefixed; characters `[A-Za-z0-9._/~-]`; no `..` segment | they become path arguments and `cd` targets |
| `app.install`, `app.prelude`, `app.dev`, `app.seed`, `app.reset`, `checks.runner`, `checks.e2e`, `checks.coverage`, `checks.mutation` | one line: no newline, carriage return or NUL | each is written verbatim into one script file; `prelude` is prefixed to others |
| `app.ready` (command form), `seams[].auth` (command form), `seams[].base` for `cli` | same one-line class | same |
| `app.ready` (probe form) | `GET /<path> -> <status>`; path `^/[A-Za-z0-9._~/-]*$`; status three digits | the path is appended to `url` |
| `app.url`, `seams[].base` for `http`/`server-fn` | `^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$` | requested by the run; no query, credentials or fragment |
| `app.clock` | `^[A-Z_][A-Z0-9_]*$` | an env var name the run assigns |
| `app.network`, `app.coverage_env` | `NAME=value`; `NAME` as `app.clock`; `value` `^[A-Za-z0-9._/:,+@%=-]*$` — no quotes, `$`, backtick, `;`, `&`, `\|`, `<`, `>` or whitespace — except the literal `<dir>` placeholder, allowed in `coverage_env` only | an env assignment the run adds to the dev server's environment |
| `seams[].kind` | `http`, `server-fn` or `cli` | selects how checks call the seam |
| `paths.inventory` | repo-relative, trailing `/`, characters `[A-Za-z0-9._/-]`, no `..` segment, no leading `/` | a fence root and a commit path |
| `paths.forbidden[]`, `paths.specs[]` | repo-relative gitignore-style globs, characters `[A-Za-z0-9._/*?{},\[\]-]`, no `..` segment, no leading `/` | fence patterns; resolved matches are containment-checked against the repo root |
| `run.split_above`, `run.retries`, `run.coverage_threshold` | non-negative integers | compared numerically |
| `run.max_wall_time` | `^[0-9]+[mh]$` | a duration the run converts to seconds |

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
2. `attendance` is `semi`. The value `unattended` fails with
   `profile: attendance — unattended is not yet supported — set attendance: semi (run /deepen:setup)`;
   any other value fails as an unknown mode.
3. Every present field matches its §3 class.
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

A failed rule names the field and the remedy. Rules 4–6, 12 and 14 describe the machine and the
repository rather than the file; setup checks them at write time and a run re-checks them in
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
<state_dir>/reports/<run-id>/              # one run's stage reports
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

Rows 1 and 2 are required: their absence is a validation failure, not a degradation. Row 4
covers both parts: a seam without a usable auth is left out of `seams`, so the same line applies.

**Run-only rows.** These describe the run's environment rather than the project, so
`deepen:setup` does not render them:

| capability | effect if missing |
|---|---|
| `feature` reviewers absent | `reviewer pass skipped — feature plugin reviewer agents not installed` |
| browser tools absent | `tier 1 unavailable — browser tools not installed` |

---

## §7 What never goes in this file

- **No secret values.** The file is committed. It names commands, env var names and paths,
  never tokens, passwords or connection strings; `seams[].auth` is a command that obtains a
  credential, never the credential.
- **No per-run state.** Candidates, reports, drafts and memory live in `state_dir`. The profile
  is configuration, and a run never writes to it.
- **No `attendance` change by a run.** Only setup writes the field, on a human's answer.
