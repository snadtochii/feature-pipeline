# The `.tidyloop.yaml` contract

Authoritative schema for a consuming repo's Tidy Loop profile. Written by `tidy-setup`,
read by `tidy-survey` and `tidy-execute`. Committed at the repo root.

The plugin ships **zero project facts**. Every command, path, glob, and cap the loop needs
lives here. A repo with no `.tidyloop.yaml`, or with `version` other than `1`, is not
eligible and the run refuses rather than guessing.

---

## §1 Full schema

```yaml
version: 1                   # required, must be 1
execute: false               # required bool — `tidy-execute` is a no-op until a human flips it

base: main                   # required — the branch every run forks from
loop_clone: "~/Projects/myrepo-tidy"   # required — the dedicated checkout the loop owns
main_checkout: "~/Projects/myrepo"     # optional — the user's own checkout, read-only, for busy-file detection
state_dir: "~/.tidy-loop/myrepo"       # required — run state and the queue, OUTSIDE every repo working tree

checks:
  stack: ts-vitest           # required — names a directory under the plugin's checks/
  # Each gate below is null or a command/config string. Null means skipped, and reported as skipped.
  spec_body_identity: null
  dom_golden: null
  differential_property: null
  mutation: null

scan:
  window: 120d               # churn window for the hotspot score
  include: []                # globs the loop may propose changes in (required, non-empty)
  exclude: []                # never scanned, never touched
  neighbourhood:             # how far around a hotspot the survey reads
    max_callers: 10
    max_cochanged: 5

forbidden_paths: []          # a finding touching any of these is dropped
test_support_paths: []       # required — test harness that is not a spec file; forbidden, and why: §2

caps:
  max_open_prs: 1
  # Every cap below is measured over NON-TEST files only.
  max_files: 5                   # substantive files — logic actually changed
  max_import_update_files: 30    # files whose diff is import/export-from statements only
  max_diff_lines: 150            # default; per_category overrides it
  per_category:                  # optional; any key omitted falls back to the defaults above
    literal-to-named-constant: { max_diff_lines: 40 }
    rename-for-clarity: { max_diff_lines: 80 }
    extract-type-to-file: { max_diff_lines: 150 }
    dedupe-identical-block: { max_diff_lines: 250 }
    extract-function: { max_diff_lines: 400 }
    split-file-by-concern: { max_diff_lines: 600, max_files: 10 }
    deepen-module: { max_diff_lines: 400, max_files: 6, max_import_update_files: 30 }

allowlist: []                # required, non-empty — the categories the loop may act on (§2)

commands:
  prelude: null              # nullable — prefixed to every command below; how a scheduled run gets the toolchain
  install: "…"               # required — makes a fresh worktree buildable
  lint: "…"                  # nullable
  typecheck: "…"             # nullable
  test: "…"                  # required — the behavior gates have no meaning without it
  build: "…"                 # nullable
  test_globs: []             # required, non-empty — the project's spec files; three roles in §2

pr_label: tidy-loop
```

---

## §2 Field semantics

### `execute`

`tidy-setup` always writes `false`, and nothing in either loop ever writes this key.

While it is `false`, `tidy-survey` runs normally — it scans, proposes, and fills the queue —
and `tidy-execute` is a no-op that reports the flag and exits. This is the shape of a safe
pilot: the queue accumulates real candidates and the human reads real survey reports, with
nothing building anything, until the human has seen enough to flip one boolean.

### `base`

The **short** branch name (`main`, not `origin/main`). Must exist on `origin`. Every
worktree forks from `origin/<base>`, never from whatever branch a checkout happens to be on.

### `loop_clone`

Absolute or `~`-prefixed path to a dedicated clone the loop owns, kept on `base`. A sibling
of the working checkout, never inside it. Rationale in the workflow spec: a separate clone
decouples the run from the user's branch state and is the only shape that generalizes to a
multi-repo workspace.

Worktrees are created at `<loop_clone>/../<clone-dirname>-worktrees/<run-id>`, matching the
feature plugin's convention so the two systems produce the same directory shape.

**A scheduler passes this path to `tidy-survey` and `tidy-execute`, never `main_checkout`.**
The loop clone is always on `base`, so its committed profile always governs. The user's
checkout sits on whatever branch they are working on, which may predate the profile entirely
— a first real run was handed exactly that and found no profile to read.

### `main_checkout`

The user's own working checkout, used **read-only** so a run can see files that are busy: their
uncommitted changes and the dirty worktrees hanging off their checkout. A finding touching a busy
file is dropped.

Optional, and the loop degrades honestly without it — busy-file detection falls back to open
pull-request diffs only, and the user's local in-flight work becomes invisible to the run. Worth
declaring: without it, the loop's most likely contribution is a merge conflict in a file someone
is actively editing, which is how a tool meant to reduce friction becomes a source of it.

The run never writes here, never fetches here, and never changes its branch.

### `state_dir`

Where the loop keeps everything that is not a repository artifact. It **must sit outside every
repository working tree**.

This is not a stylistic preference. A run aborts at preflight when the loop clone is dirty, so
state written *inside* the clone would appear as untracked files and every subsequent run would
abort on residue the previous run created. State under the repo is a loop that disables itself
after one execution.

Under `state_dir` the loop owns:

```
<state_dir>/queue.md                   # the queue — seeded by tidy-setup, see queue.md
<state_dir>/queue.lock                 # transient — held by a skill writer for one queue write, see queue.md §5
<state_dir>/reports/<ISO-date>.md      # the survey report — also the id-keyed record of each
                                       # proposed finding's files and structural_key
<state_dir>/briefs/<run-id>.md         # the pull request body
<state_dir>/blocked/<run-id>.patch     # the diff of a gate-blocked run
<state_dir>/blocked/<run-id>.md        # the deciding gate output
<state_dir>/runs/<run-id>/             # one run's working files, discarded with the run
<state_dir>/runs/<run-id>/rename-map.json  # the agreed module/symbol map, in the checks
                                       # script's schema, read by the gates that follow
```

The brief lives here rather than on the branch for a specific reason: it is the *only* copy of
the gate evidence table, which is not reconstructable after the run ends. A pushed branch
carries the change but not the brief, so without a durable copy an orphan branch cannot have
its pull request opened at all.

Reports are retained for the same reason: a queue line carries a finding's id but not its
shape, so the report that proposed the id is where `files` and `structural_key` are recovered
from ([`queue.md`](queue.md) §1).

The `blocked/` pair is the target a `blocked` queue note points at
([`queue.md`](queue.md) §4), so the human can read what failed without re-running anything.

One piece of loop state deliberately sits **outside `state_dir`**, one level above it:

```
$HOME/.tidy-loop/fence.json            # transient — the live write fence for one execution run
```

It is not under `state_dir` because a hook reads it, and a hook's command string is static: it
cannot resolve `state_dir`, which is per-repo configuration. The path therefore has to be fixed,
and a fixed path is global — every repository on the machine shares this one file. What keeps
that safe lives inside the file rather than in its path: `repo_root` scopes the decisions the
fence makes, and `run_id` identifies whose control it is, so one execution run will not overwrite,
sweep, or clear a fence file belonging to another.

### `checks`

The loop's mechanical checks are commands the plugin ships, invoked by name as
`node "${CLAUDE_PLUGIN_ROOT}/checks/<stack>/<command>.mjs"`.

**`stack`** names which shipped implementation answers them — a directory under the plugin's
`checks/`. It is inferred from the repo's own toolchain, not asked. A toolchain no shipped
stack answers stops setup rather than being approximated: a check that cannot run is worth
more as an honest refusal than as a silent skip.

This is the one profile value that becomes part of an executed path, and it arrives from a
committed file the loop reads unattended, so it is character-class-checked before use: a
single path segment matching `[a-z0-9-]+`, with the resolved `checks/<stack>` directory
verified to stay inside the plugin's own `checks/`. Validation enforces both (§3).

The stack's implementation runs against the **target repo's own** toolchain, so the repo must
have a coverage provider installed for the coverage check to answer at all. That is a
validation rule (§3), not a runtime surprise.

The four keys below it are **configured-or-skipped gates**. Each is `null` or a command or
config string, and `null` means the gate is skipped *and reported as skipped* — a run's
evidence table names it, so the human always knows how much of the suite actually ran.

- **`spec_body_identity`** — proves the symmetric test patch moved spec bodies rather than
  rewriting them.
- **`dom_golden`** — proves rendered output is unchanged for a repo that renders.
- **`differential_property`** — proves old and new implementations agree over generated
  inputs.
- **`mutation`** — proves the specs actually discriminate, by scoring them against injected
  faults.

A project configuring none of them still gets the always-on gates; it simply gets less
evidence, stated plainly rather than implied.

### `scan.include` / `scan.exclude`

Gitignore-style globs. `include` bounds what the loop may *propose changes in*; a finding
touching a file outside it is dropped. `exclude` wins over `include`.

`exclude` must cover, at minimum: test files, build output, and generated sources. Generated
files are the sharpest trap — a "tidy" of a generated file is reverted by the next codegen
run, and the diff looks legitimate.

### `scan.window`

Churn window, e.g. `120d`. Feeds the hotspot score. Too short and the ranking is noise;
too long and it reflects a codebase that no longer exists. `120d` is the default.

### `scan.neighbourhood`

How far around a ranked hotspot `tidy-survey` reads before proposing anything. A structural
finding is rarely visible in one file: the duplication is in the caller, the missing seam
shows up in what changes alongside it.

- **`max_callers`** (default `10`) — files importing the hotspot, most-relevant first.
- **`max_cochanged`** (default `5`) — files that repeatedly change in the same commits as the
  hotspot within `scan.window`.

Raising these widens what the survey can see and lengthens the run; the defaults are sized so
a weekly survey stays comfortably bounded.

### `forbidden_paths`

Dropped **always**, including a finding the survey rates highly. This is the list of
places where a structural change is never merely structural. Typical members:

- database migrations (rewriting an applied migration is not a refactor)
- table/schema declarations
- published contract or API-shape definitions
- generated clients

`tidy-setup` proposes candidates from what it finds and asks for confirmation. It does not
invent the list silently: the consequences are project knowledge.

### `test_support_paths`

The test harness that is **not** a spec file: the runner's setup files, in-memory or temp
database helpers, fakes and other test doubles, and shared fixtures. Treated as forbidden — a
finding touching any of them is dropped.

**Why they need naming separately from `forbidden_paths`, and why forbidding is the right
answer.** The behavior oracle compares a run against a symmetric test patch: the specs move
with the code, and the comparison is only meaningful if the *harness* those specs run against
is identical on both sides of it. A test double is not a spec file, so it is not part of the
patch — meaning a run that refactored a fake would compare specs running against two different
fakes. An altered stub can then mask exactly the regression the comparison exists to catch.

Forbidding is the coherent choice — the payoff from tidying test infrastructure is low, and
nothing tests the double itself, so its behavior preservation has no oracle at all.

`tidy-setup` finds these by reading the runner's configured setup files and by looking for
modules whose importers are *all* test files.

That second signal **generates candidates and does not decide them**. It over-fires: a CLI wired
through a package script, a framework entry point, or a handler reached by routing rather than
by an import is also imported only by specs, and forbidding those would put production code
permanently beyond the loop's reach. Each candidate is confirmed by role — does it exist to
serve tests — and disqualified by any non-import production wiring.

Get the balance wrong in either direction and something breaks quietly. Too narrow leaves the
behavior gate with a hole. Too broad silently shrinks what the loop is allowed to improve.

### `caps`

A finding estimated over any cap is dropped at selection, and a *branch* measured over any cap
fails the caps gate. Never split-and-do-part-one: a partial structural change leaves the
codebase worse than either end state.

**`max_open_prs`** — the churn budget. With the cap reached, the run aborts at preflight. The
single most important number in the file: it is what keeps the loop from becoming a review queue
nobody reads.

**It must be `1`**, and the validation rule on `max_open_prs` enforces that. One open draft pull
request at a time is the whole review budget the loop is allowed to spend, and a loop that
outruns its reviewer has stopped being useful whatever its diffs look like.

**Test files never count toward any cap.** They are evidence, not churn. Charging them would
create the worst possible incentive — the cheapest way under a cap would be to skip the
characterization tests that make the change safe. A file matching `commands.test_globs` is
excluded from every measurement below.

**`max_files` counts substantive files only** — files whose logic actually changed.

**`max_import_update_files`** is a separate, far looser allowance for a file whose diff consists
solely of import/export-from statement changes — touched only to repoint an import at a moved
symbol. These carry no behavioral risk and the typechecker is very nearly a total oracle for
them: a wrong path fails the typecheck every time, with the behavior gates behind it. Capping
them at the same number as substantive files caps the one thing already fully verified, and on a
real codebase it blocks the highest-value work outright — moving a symbol out of a
widely-imported module means repointing every importer, which is routinely twenty files or more.

**`max_diff_lines` is measured as insertions plus deletions**, which double-charges every moved
line — a relocated function body is added in its new home and deleted from its old one. A
90-line extraction therefore costs about 180. Set the numbers with that doubling in mind, or the
cap silently permits only trivial work.

**`per_category`** exists because the categories have wildly different natural sizes. Extracting
a 200-line function is charged at 2×; splitting a large module can legitimately produce several
new files; deepening a module moves logic behind an interface and repoints every importer. One
flat number is the wrong shape. Any category absent from `per_category` uses the top-level
defaults, and a per-category block may override `max_diff_lines`, `max_files`,
`max_import_update_files`, or any combination.

An approval may raise the caps for its own pick with a `caps:` override in the queue note
([`queue.md`](queue.md) §4). That override wins for that pick alone and changes nothing in this
file — the human who read the candidate is better placed than a default to size it.

A note on what the caps are *for*, since it is easy to over-weight them. The safety in this
system comes from the gates, not from the caps. The caps keep one run to one coherent change and
catch an implementation that wandered outside its declared files. Tightening them past that
point buys no safety and forfeits the value.

### `allowlist`

The categories the loop may act on, as an unordered set. A finding whose category is absent is
dropped, not deferred. The permitted categories are exactly:

```
literal-to-named-constant   # a value gets a name; typecheck and tests see every use
extract-type-to-file        # types are erased at runtime; zero runtime behavior can change
rename-for-clarity          # typecheck sees symbol uses, but not strings, logs, or serialized keys
extract-function            # moves logic; relies on the tests exercising it
dedupe-identical-block      # merges logic, and can erase duplication that was deliberate
split-file-by-concern       # a large change and the most to review
deepen-module               # cross-file structural work: a narrower interface over more
                            # implementation, which moves logic and repoints every importer
```

Each line says what the category is and where its risk sits, so a project narrowing the list is
choosing against a known cost rather than a name.

Widening or narrowing the list is a deliberate decision about what the loop is allowed to do in
this codebase, and it is the human's to make.

### `commands`

Every gate command, project-supplied.

`prelude`, when set, is prefixed to every other command in the block. This is how a scheduled run
gets the same toolchain an interactive shell has: a cron or launchd job starts from a minimal
environment, so a version manager loaded by a shell profile is simply absent, and every gate
fails in a way that looks like a finding. A repo pinning its runtime version almost always needs
this key — for example a line that sources the version manager and selects the pinned version.
Null means the commands run as written.

Two hard requirements on the commands themselves:

- **Env-free.** Each command must run green in a fresh worktree that has no `.env` and no
  secrets. A gate needing secrets cannot run unattended and must be set to `null`, trading
  gate coverage for honesty. Never widen `.worktreeinclude` to carry a secret into the loop
  just to make a gate pass.
- **No fixed-port server.** The loop is headless. A command that boots a dev server on a
  fixed port can be answered by a server already running from another checkout, producing a
  false green — the worst possible failure for this loop.

`test_globs` names **the project's spec files**, and three separate mechanisms key off it:

- It is the file set the symmetric test patch is computed over — the specs that move with the
  code when a run relocates what they cover.
- It is the set the run's write fences are keyed to: the implementer neither reads nor writes
  a file matching it, and the spec-mover writes nothing else.
- It is the set excluded from every cap measurement, per `caps` above.

Get these wrong and all three go quietly wrong at once, which is why §3 requires them to match
at least one real file.

---

## §3 Validation rules

Every rule below must hold. `tidy-setup` checks them all before writing the profile, and each
loop re-checks them at its own preflight and refuses to start on a failure.

Two of them — the `checks.stack` rule and the coverage-provider rule — are **environment**
rules: they describe the machine and the repo rather than the file. `tidy-setup` still checks
both, but of the two loops only `tidy-execute` re-checks them, since the survey never invokes
the checks script.

1. `version` is `1`.
2. `execute` is a boolean.
3. `base` exists on `origin`.
4. `loop_clone` resolves to a directory containing `.git`, whose current branch is `base`.
5. `checks.stack` is a single path segment matching `[a-z0-9-]+` — no path separators, no `.`
   segments, no other character — and names an existing directory whose resolved path stays
   inside the plugin's own `checks/`. The value becomes part of an executed command path, so
   the character class is checked before the directory is looked for, not after. *(environment)*
6. A coverage provider for `checks.stack` is resolvable from the repo — for `ts-vitest`,
   `@vitest/coverage-v8` or `@vitest/coverage-istanbul`. Remedy: add `@vitest/coverage-v8` as a
   devDependency and commit. *(environment)*
7. Each of `checks.spec_body_identity`, `checks.dom_golden`, `checks.differential_property`,
   and `checks.mutation` is `null` or a string.
8. `scan.include` is non-empty.
9. `allowlist` is non-empty and every entry is one of the categories in §2.
10. `commands.install`, `commands.test`, and `commands.test_globs` are all present and non-empty.
11. `commands.test_globs` matches at least one file in the repo.
12. `commands.prelude`, when present, is a single line with no newline — it is prefixed to other
    commands, so a multi-line value would break every one of them.
13. `main_checkout`, when present, resolves to a directory containing `.git` and is not
    `loop_clone`.
14. `state_dir` is present and resolves **outside** every configured repository working tree —
    not inside `loop_clone` and not inside `main_checkout`. A state directory inside the clone
    makes every run after the first abort on its predecessor's residue.
15. `test_support_paths` is present. An empty list is permitted only for a project with no test
    harness beyond its spec files, and `tidy-setup` states that conclusion explicitly rather
    than defaulting to it.
16. `caps.max_open_prs` is exactly `1`. One open draft pull request at a time is the review
    budget, and it is what keeps the loop from becoming a queue nobody reads.

A failed rule is reported with the field name and the remedy, and nothing runs.

---

## §4 What never goes in this file

- **No secret values.** The file is committed. It names paths and commands, never tokens,
  passwords, or connection strings.
- **No per-run state.** Findings, decisions, and outcomes live in `state_dir` — the queue, the
  reports, the briefs, and the blocked evidence. The profile is configuration, and a run never
  writes to it.
- **No `execute: true` from the loop.** Only a human flips it.
