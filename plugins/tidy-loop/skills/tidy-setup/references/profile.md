# The `.tidyloop.yaml` contract

Authoritative schema for a consuming repo's Tidy Loop profile. Written by `tidy-setup`,
read by `tidy-run`. Committed at the repo root.

The plugin ships **zero project facts**. Every command, path, glob, and cap the loop needs
lives here. A repo with no `.tidyloop.yaml`, or with `version` other than `1`, is not
eligible and the run refuses rather than guessing.

---

## §1 Full schema

```yaml
version: 1                   # required, must be 1

tier: 0                      # required — 0 observe | 1 single-pr | 2 graduated
base: main                   # required — the branch every run forks from
loop_clone: "~/Projects/myrepo-tidy"   # required — the dedicated checkout the loop owns
main_checkout: "~/Projects/myrepo"     # optional — the user's own checkout, read-only, for busy-file detection
state_dir: "~/.tidy-loop/myrepo"       # required — run state, OUTSIDE every repo working tree

scan:
  window: 120d               # churn window for the hotspot score
  include: []                # globs the loop may propose changes in (required, non-empty)
  exclude: []                # never scanned, never touched
  top_n: 10                  # how many hotspot files the scanner actually reads

forbidden_paths: []          # a finding touching any of these is dropped at any tier
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
    delete-dead-code: { max_diff_lines: 400 }
    split-file-by-concern: { max_diff_lines: 600, max_files: 10 }

allowlist: []                # categories permitted at the current tier (required, non-empty)

commands:
  prelude: null              # nullable — prefixed to every command below; how a scheduled run gets the toolchain
  install: "…"               # required — makes a fresh worktree buildable
  lint: "…"                  # nullable
  typecheck: "…"             # nullable
  test: "…"                  # required — G1 and G2 have no meaning without it
  build: "…"                 # nullable
  test_globs: []             # required, non-empty — the files G1 restores from base
  mutation: null             # nullable, tier 2+
  smoke: null                # nullable

surface_oracle: []           # artifacts that must be byte-identical after build; empty disables G4

ticket_adapter: none         # none | github-issues | feature-pipeline-fs
ledger: docs/tidy-ledger.md  # required
pr_label: tidy-loop
tier0_report: file           # file | issue
```

---

## §2 Field semantics

### `tier`

| Value | Loop produces | Caps | Categories |
| --- | --- | --- | --- |
| `0` | a report only — no branch, no PR | — | all, for visibility |
| `1` | one draft PR per run | as declared | `allowlist` only |
| `2` | one draft PR per run, raised caps for proven categories | per-category | widened; `commands.mutation` expected |

No tier auto-merges. `tidy-setup` writes `0` and never higher — graduation is a human
decision informed by the ledger.

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

Where a run keeps everything that is not a repository artifact: tier-0 reports, the patch and
output of a blocked run, and the pending-ledger set. It **must sit outside every repository
working tree**.

This is not a stylistic preference. A run aborts at preflight when the loop clone is dirty, so
state written *inside* the clone would appear as untracked files and every subsequent run would
abort on residue the previous run created. State under the repo is a loop that disables itself
after one execution.

Under `state_dir` the run owns three things:

```
<state_dir>/reports/<ISO-date>.md      # tier-0 reports
<state_dir>/blocked/<run-id>.patch     # the diff of a gate-aborted run
<state_dir>/blocked/<run-id>.md        # the deciding gate output
<state_dir>/briefs/<run-id>.md         # the pull request body — see ledger.md §7
<state_dir>/pending-ledger.md          # rows not yet carried onto a branch — see ledger.md §7
```

The brief lives here rather than on the branch for a specific reason: it is the *only* copy of
the gate evidence and the ranked candidate table, and neither is reconstructable after the run
ends. A pushed branch carries the change and the ledger row but not the brief, so without a
durable copy an orphan branch cannot have its pull request opened at all.

### `scan.include` / `scan.exclude`

Gitignore-style globs. `include` bounds what the loop may *propose changes in*; a finding
touching a file outside it is dropped. `exclude` wins over `include`.

`exclude` must cover, at minimum: test files, build output, and generated sources. Generated
files are the sharpest trap — a "tidy" of a generated file is reverted by the next codegen
run, and the diff looks legitimate.

### `scan.window`

Churn window, e.g. `120d`. Feeds `score = churn × lines`. Too short and the ranking is noise;
too long and it reflects a codebase that no longer exists. `120d` is the default.

### `forbidden_paths`

Dropped at **every** tier, including a finding the scanner rates highly. This is the list of
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
answer.** The behavior oracle restores the files matching `test_globs` from the base commit and
runs them. It therefore assumes the *harness* those specs run against is fixed. A test double
is not a spec file, so it is not restored — meaning a run that refactored a fake would execute
the base specs against its own modified fake. An altered stub can then mask exactly the
regression the gate exists to catch.

Adding them to `test_globs` instead looks tempting and is worse: restoring a file the diff
modified means the gate never exercises the modified version, so the change ships unverified.
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
aborts the run at gate G5. Never split-and-do-part-one: a partial structural change leaves the
codebase worse than either end state.

**`max_open_prs`** — the churn budget. With the cap reached, the run aborts at preflight. The
single most important number in the file: it is what keeps the loop from becoming a review queue
nobody reads.

**Test files never count toward any cap.** They are evidence, not churn. Charging them would
create the worst possible incentive — the cheapest way under a cap would be to skip the
characterization tests that make the change safe. A file matching `commands.test_globs` is
excluded from every measurement below.

**`max_files` counts substantive files only** — files whose logic actually changed.

**`max_import_update_files`** is a separate, far looser allowance for files touched *only* to
repoint an import at a moved symbol. These carry no behavioral risk and the typechecker is very
nearly a total oracle for them: a wrong path fails the typecheck every time, with the base-test
gate behind it. Capping them at the same number as substantive files caps the one thing already
fully verified, and on a real codebase it blocks the highest-value work outright — moving a
symbol out of a widely-imported module means repointing every importer, which is routinely
twenty files or more.

How the two are told apart, mechanically and fail-closed: gates.md §2.

**`max_diff_lines` is measured as insertions plus deletions**, which double-charges every moved
line — a relocated function body is added in its new home and deleted from its old one. A
90-line extraction therefore costs about 180. Set the numbers with that doubling in mind, or the
cap silently permits only trivial work.

**`per_category`** exists because the categories have wildly different natural sizes. Deleting
300 lines of dead code is charged at 1× and is trivially reviewable; extracting a 200-line
function is charged at 2×; splitting a large module can legitimately produce several new files.
One flat number is the wrong shape. Any category absent from `per_category` uses the top-level
defaults, and a per-category block may override `max_diff_lines`, `max_files`, or both.

A note on what the caps are *for*, since it is easy to over-weight them. The safety in this
system comes from the gates, not from the caps. The caps keep one run to one coherent change and
catch an implementation that wandered outside its declared files. Tightening them past that
point buys no safety and forfeits the value.

### `allowlist`

Categories the loop may act on. Mechanical categories only at tier 1:

```
extract-function
extract-type-to-file
literal-to-named-constant
dedupe-identical-block
split-file-by-concern
rename-for-clarity
delete-dead-code
```

A finding whose category is absent is dropped, not deferred. Widening the list is a
graduation decision, not a setup decision.

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

`test_globs` selects the files gate G1 restores from the base commit. Get these wrong and G1
silently checks nothing.

### `surface_oracle`

Build artifacts that must be **byte-identical** before and after. A repo publishing a typed
boundary (emitted `.d.ts`, an OpenAPI document, a generated schema) gets a strong,
near-free behavior check here. Empty list disables G4, and the project is correspondingly
less protected — state that plainly rather than inventing an oracle.

### `ticket_adapter`

- `none` — the branch, the PR, and the ledger line are the whole record. The default, and
  correct whenever the loop runs from a dedicated clone.
- `github-issues` — one issue per run, labelled `pr_label`.
- `feature-pipeline-fs` — a real pipeline ticket. **Only valid when the loop runs in the same
  checkout as the user's own work.** From a separate clone this is unsafe: the ticket
  contract prevents duplicate IDs by rescanning every path from `git worktree list`, a
  separate clone never appears in that listing, and the ticket tree is gitignored, so two
  allocations can collide and corrupt the tree.

### `ledger`

Path, repo-relative, to the committed append-only ledger. One line per run. Created by
`tidy-setup` if absent.

### `tier0_report`

- `file` — the tier-0 report is written to `<state_dir>/reports/<ISO-date>.md`
  and its path is printed. No commits, no network. The default.
- `issue` — the report is opened as a GitHub issue labelled `pr_label`. Requires `gh`.

---

## §3 Validation rules

`tidy-run` refuses to start unless all of these hold. `tidy-setup` checks them before writing.

1. `version` is `1`.
2. `tier` is `0`, `1`, or `2`.
3. `base` exists on `origin`.
4. `loop_clone` resolves to a directory containing `.git`, whose current branch is `base`.
5. `scan.include` is non-empty.
6. `allowlist` is non-empty.
7. `commands.install`, `commands.test`, and `commands.test_globs` are all present and non-empty.
8. `commands.test_globs` matches at least one file in the repo.
9. `ledger` is a path inside the repo.
10. `ticket_adapter` is `feature-pipeline-fs` only if `loop_clone` is the repo itself.
11. `main_checkout`, when present, resolves to a directory containing `.git` and is not
    `loop_clone`.
12. `commands.prelude`, when present, is a single line with no newline — it is prefixed to other
    commands, so a multi-line value would break every one of them.
13. `state_dir` is present and resolves **outside** every configured repository working tree —
    not inside `loop_clone` and not inside `main_checkout`. A state directory inside the clone
    makes every run after the first abort on its predecessor's residue.
14. `test_support_paths` is present. An empty list is permitted only for a project with no test
    harness beyond its spec files, and `tidy-setup` states that conclusion explicitly rather
    than defaulting to it.

A failed rule is reported with the field name and the remedy, and nothing runs.

---

## §4 What never goes in this file

- **No secret values.** The file is committed. It names paths and commands, never tokens,
  passwords, or connection strings.
- **No per-run state.** Findings, scores, and outcomes live in the ledger. The profile is
  configuration, and a run never writes to it.
- **No tier promotion by the loop.** Only a human edits `tier`.
