---
name: tidy-setup
description: "Prepare a repository for the Tidy Loop: probe its commands and hotspots, verify the worktree prerequisites actually hold, provision the dedicated loop clone, and write a committed .tidyloop.yaml profile. Run once per repo, before the first survey. Use when the user wants to enable, configure, re-verify, or onboard a project to the tidy loop."
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - TodoWrite
  - AskUserQuestion
---

# Tidy Setup

One-time onboarding for a repository joining the Tidy Loop. Interactive by design: profile
authoring needs judgement about what is off-limits in this codebase, and the prerequisite
checks are worth watching the first time.

This skill **hardcodes no project facts**. Everything it learns about the repo it learns by
probing, and everything it decides it writes into the consuming repo's `.tidyloop.yaml`. The
schema, field semantics, and validation rules are
[`references/profile.md`](references/profile.md), and the queue this skill seeds is
[`references/queue.md`](references/queue.md) — of which §1 is the part this skill needs, the
location and the header line it writes; the rest is what the two loops read. Consume both
contracts as written; never restate or redefine them here.

Two counterpart skills read what this one writes. `tidy-survey` reads the profile and appends
candidates to the queue. `tidy-execute` reads both, and refuses to start if any validation
rule in profile.md §3 fails.

## What this skill will and will not do

It **will** write three things: `.tidyloop.yaml` at the repo root, a seeded queue file, and
(with permission) a `.worktreeinclude` if the repo has none. It will clone a dedicated loop
checkout outside the repo.

It **will not**:

- read, print, or copy the contents of any `.env` or secrets file — see §0
- add a secret-bearing path to `.worktreeinclude` to make a gate pass
- write `execute: true`
- modify the repo's source, tests, `.gitignore`, or CI
- commit anything

---

## §0 Standing rules

**Secrets.** The loop must run unattended, which means it must run without secrets. Treat
every `.env*`, credentials file, and token store as opaque: never `cat`, `grep`, `sed`, or
otherwise read one, and never interpolate one into a command. A gate that needs secrets is
recorded as `null` in the profile, trading gate coverage for honesty (§5 step 4). The
consuming environment may also refuse such commands outright — some setups hook and block
any shell command referencing `.env`, so an attempt fails the setup rather than merely
being unwise.

**Fail closed, report, never repair silently.** Every check below has a remedy line. When a
check fails, print the finding and the remedy, and stop or degrade explicitly. Do not edit
the repo to make a check pass — the user decides whether the repo changes.

**One repo per run.** A multi-repo workspace is onboarded one child repo at a time, each with
its own profile and its own loop clone.

**Re-runs are safe.** An existing `.tidyloop.yaml` is read, not clobbered: re-verify against
it and present a diff of proposed changes before writing (§6).

Track the seven sections below with `TodoWrite` — the prerequisite probe (§5) is long enough
that a resumed session needs to know which checks already passed.

---

## §1 Bind the repository

Resolve the target repo root and confirm it before probing:

```bash
git -C "<target>" rev-parse --show-toplevel
git -C "<target>" remote get-url origin
git -C "<target>" symbolic-ref --short HEAD
git -C "<target>" branch -r --list 'origin/*'
```

- Not a git repository, or no `origin` remote → **stop.** The loop delivers through pull
  requests; there is nothing to deliver to.
- The repo root is itself a git worktree of another checkout → **stop** and name the main
  checkout. Onboard the main checkout instead.
- An existing `.tidyloop.yaml` → read it now and announce that this is a re-verify run.

Determine `base`: the repo's default branch as it exists on `origin`. Confirm it with the
user in §4 rather than assuming — a repo whose default is `master`, `develop`, or a release
line is common enough that guessing wastes the whole setup.

---

## §2 Probe the repo (read-only)

Gather facts. Everything here is inference from files, and every inferred value is shown
back to the user in §4 for confirmation.

**Manifest and commands.** Read the project manifest and lockfile to determine the package
manager and the available scripts. Map them onto `commands.install`, `lint`, `typecheck`,
`test`, `build`. A script that does not exist maps to `null`, never to a guess.

**Toolchain and the command prelude.** Determine whether the repo pins a runtime version — a
version file at its root, or an `engines` constraint in the manifest — and whether the machine
uses a version manager to satisfy it. If both, compose a `commands.prelude`: the one-line prefix
that loads the version manager and selects the pinned version.

This key exists because a scheduled run starts from a minimal environment. A version manager
loaded by an interactive shell profile is simply absent there, so without the prelude every gate
command fails in a way that looks like a finding. Probe it, propose it in §4's review block, and
verify it in §5 step 4 — do not leave it to be discovered by the first scheduled run.

**Existing worktree contract.** The feature pipeline may already have solved this. Check for:

- a committed `.worktreeinclude` at the repo root
- a `worktree.setup` key in the ticket-system config, if the repo has one

When both exist, reuse them verbatim — `commands.install` becomes the declared setup
command. A repo already onboarded to the pipeline usually needs nothing new here, which is
the cheapest possible path through this skill.

**Test globs.** Derive `commands.test_globs` from the test runner's own config where it
declares an include pattern; otherwise glob the repo for existing test files and generalize.
Then verify the globs match at least one real file — an unmatched glob leaves the symmetric
test patch with nothing to compare, and that is the single most damaging misconfiguration
available.

**Source layout.** Derive `scan.include` from where source actually lives. Derive
`scan.exclude` to cover, at minimum: test files, build output, and generated sources.
Generated files matter disproportionately — a tidy of a generated file is undone by the next
codegen run while the diff looks entirely legitimate. Look for generator output by name
(`*.gen.*`, `*.generated.*`), by directory (build, dist, output, codegen targets), and by
header comments announcing the file is generated.

**Import fan-out.** Resolve the repo's import graph — honouring any path alias its build config
declares, or the count will come back as zero — and record how many files import each module.
Report the median, the 90th percentile, the maximum, and the fan-out of the top hotspots
specifically.

This calibrates `caps.max_import_update_files`, and it is worth doing properly because the
number decides whether the loop can touch its own highest-ranked targets. Moving a symbol out of
a module means repointing every importer, so a cap below the hotspots' fan-out blocks exactly
the work the ranking says matters most.

**Test-support paths.** Find the test harness that is *not* a spec file, because the behavior
oracle compares a run against a symmetric test patch and assumes the harness those specs run
against is identical on both sides of the comparison. Two signals, both mechanical:

1. The runner's configured setup and global-fixture files, read from its config.
2. **Every module whose importers are all test files.** This finds the ones no naming convention
   reveals — fakes, stubs, builders, fixtures, temp-database helpers.

**Signal 2 generates candidates; it does not decide.** It over-fires badly, and confirming each
hit is not optional. Plenty of *production* code is imported only by specs: a CLI wired through
a package script, a framework entry point, a server handler reached by routing rather than by an
import, anything the build discovers by convention. Measured on one real repo, the signal
returned fifteen modules and only five were test support — the rest included the app's entry
point and a production invite CLI. Forbidding that set would have put real code permanently
beyond the loop's reach while looking rigorous.

Confirm each candidate by **role**, and keep it only when the answer is yes:

- Does it exist to serve tests? A fixture, fake, stub, builder, or harness helper does; a
  feature module does not, however few things import it.
- Is it named as such — `*.fake.*`, `*-fixture.*`, `*-stub.*`, `*-mock.*`, a `test` directory,
  a test-database helper?
- Is it referenced by the test runner's configuration?
- And the disqualifier: is it wired into production by any non-import path — a package script, a
  framework entry, a route convention, a deployment command? If so it is production code that
  merely happens to lack importers, and it stays in scope.

Report the candidates you rejected and why, alongside the ones you kept. An over-broad
`test_support_paths` is quieter than a hole but costs the loop exactly the work it exists to do.

These become `test_support_paths`, which the loop treats as forbidden. Say why in the §7 report,
because the reasoning is not obvious: the symmetric patch moves the specs, but the harness those
specs run against must be identical on both sides of the comparison, and a run that refactored a
fake would be comparing specs running against two different fakes. An altered stub can then mask
exactly the regression the comparison exists to catch.

**Forbidden-path candidates.** Search for the places where a structural change is never
merely structural: migration directories, table or schema declarations, published contract
definitions, generated clients. Collect candidates; the user confirms in §4.

**Checks stack.** Determine which shipped checks implementation answers this repo's toolchain
and record it as `checks.stack`: a TypeScript project whose test runner is Vitest is
`ts-vitest`. A toolchain no shipped stack answers is a **stop** — report the finding and the
toolchain you found, rather than approximating with a stack that would return wrong answers.
This value is inferred, shown in §4's review block, and not asked. The coverage-provider
prerequisite it implies is probed for real in §5 step 4.

**Domain docs for the architect's verdict.** Note whether a domain glossary and architecture
decision records exist. Their absence is not blocking, but the architect's diff verdict reads
them for the justification it asks of a change — whether the change actually reduces the
complexity the interface exposes. Without them it judges from the diff alone, and the user
should hear that now.

---

## §3 Hotspot preview

Before asking anything, show the user what the loop would actually look at. This is the
cheapest calibration available: the ranking is deterministic, needs no model, and is
reproducible, so the user can judge the selection step before granting the loop any
autonomy.

```bash
git -C "<repo>" log --since="<scan.window>" --name-only --pretty=format: -- <scan.include> \
  | sort | uniq -c | sort -rn | head -40
```

Filter out `scan.exclude` matches, then measure the survivors and rank by
`score = churn × indentation complexity` — the sum of indentation levels over the file's
non-blank lines. Measure it, do not estimate it:

```bash
awk '/[^[:space:]]/ {
       match($0, /^[ \t]*/); ind = substr($0, 1, RLENGTH)
       tabs = gsub(/\t/, "", ind)
       lvl += tabs + int(length(ind) / 2)
     } END { print lvl + 0 }' "<file>"
```

The unit is fixed rather than detected: one tab is one level, every two leading spaces are one
level. A two-line file indented one tab and four spaces scores `1 + 2 = 3`. Fixing the unit
matters because the number has to mean the same thing in the survey's own ranking as it does
here, and because the score only ever ranks files *within* one repository — where a project's
constant indent width cancels out of the comparison.

Present the top ten as a table: file, commits in window, lines, `churn × lines`, score. The
lines-based column is shown alongside because it is the intuitive reading of "big file", and
seeing where the two rankings disagree is what tells the user whether the loop is aimed at size
or at tangle.

Say plainly what the table is and is not: it is where change and size overlap, which is the
CodeScene hotspot proxy for *where refactoring pays off*. It is not a list of defects, and a
high-scoring file may be perfectly well structured.

If the user looks at the top entries and disagrees that they are the right places to spend
effort, that is a signal to fix `scan.include` / `scan.exclude` now — not a reason to proceed.

---

## §4 Confirm the undecidable

Ask with `AskUserQuestion`. Batch the questions into one pass. Every question carries a
recommended option first, drawn from §2's probe. Three questions, no more — anything else was
inferable and should have been inferred.

1. **Base branch** — the confirmed default branch on `origin`.
2. **Forbidden paths** — multi-select over §2's candidates, plus the option to add more.
   Frame it as: *a structural change here is never merely structural*.
3. **Loop clone path and permission to create it** — default
   `<repo-parent>/<repo-name>-tidy`. This question is also the authorization to run
   `git clone`, which writes outside the repo and uses the network, so it is asked
   explicitly rather than inferred from the user's general go-ahead.

Present the inferred commands, globs, caps, the inferred `checks.stack`, the proposed
`allowlist`, and the proposed `commands.prelude` alongside the questions as a review block. The user correcting an inferred
value there is expected and cheap; discovering it wrong during the first scheduled run is not.

The prelude is reviewed rather than asked, because it is derivable: §2 found the pinned version
and the version manager, and the composed line is either right or visibly wrong at a glance. The
checks stack is reviewed for the same reason — it follows from the test runner and the language,
and there is nothing for the user to decide when only one shipped stack answers the toolchain.

Do not ask about `execute` — setup always writes `false`. Do not ask about cadence — that is the
scheduler's concern in §7.

---

## §5 Verify the prerequisites actually hold

The load-bearing section. Five checks, in order, each with a remedy. This is the difference
between a profile that looks right and a loop that runs.

### Step 1 — Provision the loop clone

With the permission from §4:

```bash
git clone "<origin-url>" "<loop_clone>"
git -C "<loop_clone>" checkout "<base>"
```

Then copy the `.worktreeinclude` matches from the main checkout into the clone, subject to
§0's secrets rule, and run `commands.install` in the clone. Verify the clone is genuinely
buildable — every non-null gate command green — before going further. A loop clone that
cannot build produces gate failures that look like findings, which is the most confusing
possible failure mode.

### Step 2 — `.worktreeinclude` exists and is committed

```bash
git -C "<repo>" ls-files --error-unmatch .worktreeinclude
```

- **Present and tracked** → read it and continue to step 3.
- **Absent** → the repo needs one. Propose the minimum set: the gitignored files a fresh
  worktree needs in order to run the gate commands, discovered from §2's probe. Ask before
  writing. Patterns only — the file is committed, so it names paths and never secret values.
  Do not list `.env`: the gates must be env-free (step 4), so carrying secrets into worktrees
  is both unnecessary and a standing hazard.
- **Present but untracked** → report and ask the user to commit it. An untracked file is
  invisible to a fresh worktree cut from `origin/<base>`, which is exactly where it is needed.

Scan each line for anything resembling a secret *value* rather than a path — an `=`
assignment, a long opaque token. Refuse to proceed on a match and name the line.

### Step 3 — Ignore rules are committed on base

The check most likely to be quietly false, and the one standing between a copied secrets file
and a public pull request.

A worktree cut from `origin/<base>` evaluates ignore rules against **the base branch's
committed** ignore file, while the patterns in `.worktreeinclude` were written against the
main checkout's working-tree ignore file. Wherever the two differ — an ignore entry added on
a feature branch and not yet merged, an ignore file written but never committed, a nested
ignore file inside an untracked directory — a file ignored in the main checkout arrives
**unignored** in the worktree, and the run's `git add -A` sweeps it into the branch.

Test it, do not reason about it. Cut a throwaway probe worktree inside the loop clone, copy
the `.worktreeinclude` matches into it, and ask git:

```bash
git -C "<loop_clone>" worktree add "<probe-path>" --detach "origin/<base>"
# copy the .worktreeinclude matches into <probe-path>, preserving relative paths
git -C "<probe-path>" check-ignore -q "<each copied relative path>" || echo "NOT IGNORED: <path>"
```

Any path reported not ignored → **report it with the remedy** (`commit its ignore entry to
<base>`) and record it as an exclusion the run must apply at every commit. Keep the probe
worktree for step 4, then remove it in step 5.

### Step 4 — Gate commands are env-free and headless

First verify the proposed `commands.prelude` on its own — it prefixes everything below, so a
broken prelude makes every result meaningless:

```bash
<commands.prelude> && <the pinned runtime's version command>
```

The reported version must match the repo's pin. A prelude that fails, or selects the wrong
version, is corrected or dropped before anything else runs.

Then run each non-null gate command inside the probe worktree, which has no secrets beyond the
`.worktreeinclude` set. Every command carries the prelude, exactly as a scheduled run will
issue it:

```bash
cd "<probe-path>" && <prelude> && <commands.install>
cd "<probe-path>" && <prelude> && <commands.lint>
cd "<probe-path>" && <prelude> && <commands.typecheck>
cd "<probe-path>" && <prelude> && <commands.test>
cd "<probe-path>" && <prelude> && <commands.build>
```

Record the result per command:

- **Green** → keep it in the profile.
- **Red for a missing secret or missing service** → set that command to `null` and tell the
  user which gate is thereby disabled and what it was protecting. Never widen
  `.worktreeinclude` to carry a secret in and make the gate pass — an unattended loop holding
  production credentials is a worse trade than a thinner gate suite.
- **Red for a real failure on base** → **stop.** The repo does not currently pass its own
  checks, so the loop could never distinguish its own damage from pre-existing breakage.
  Report the failing command and its decisive output line.

Then confirm no gate command needs a **fixed-port dev server**. The loop is headless. A
command that boots a server on a fixed port can be answered by a server already listening
from another checkout — nothing boots, the check passes, and the loop reports a green it never
earned. A false green is the worst outcome available to this system, so a gate command in this
shape is rejected outright rather than warned about.

Also verify `commands.test` actually executed tests rather than trivially succeeding on an
empty selection, and that `commands.test_globs` matched files in the probe worktree.

**The checks script answers against this repo.** The loop's mechanical checks run the repo's
own toolchain through the stack inferred in §2, so whether they can answer at all is a
property of the repo and is settled here rather than by the first run that needs them.

First the precondition, in this order: `${CLAUDE_PLUGIN_ROOT}` is non-empty; `<stack>` matches
`[a-z0-9-]+` as a single path segment; and `"${CLAUDE_PLUGIN_ROOT}/checks/<stack>"` resolves to
a directory inside the plugin's own `checks/`. The character class is checked **before** the
directory is looked for, because the value becomes part of the command path below. Any of the
three failing is a **stop** naming what was wrong — there is nothing to probe with.

Pick one target for the coverage probe: the highest-ranked file from §3 that survives
`scan.exclude` and `forbidden_paths` and does **not** match `commands.test_globs`, expressed
as one repo-relative path present in the probe worktree. A file matching `test_globs` is not a
valid target: coverage of a spec file is not the question being asked.

The target is repository content, so validate it before use: decode git's quoted output first
(`git` C-quotes paths outside its safe set), then require a plain repo-relative path — no
quote, `$`, backtick, or newline. A path that does not clear that check is not a valid target;
pick the next-ranked file rather than passing it through.

Run both commands inside the probe worktree, carrying the prelude. Every argument is a
separate, literal argv word — never a concatenated shell string — and when `commands.prelude`
is null the `--prelude` word is omitted entirely rather than passed empty:

```bash
node "${CLAUDE_PLUGIN_ROOT}/checks/<stack>/test-names.mjs" \
  --repo "<probe-path>" --prelude "<commands.prelude>"

node "${CLAUDE_PLUGIN_ROOT}/checks/<stack>/coverage-hit.mjs" \
  --repo "<probe-path>" --targets "<target>" --prelude "<commands.prelude>"
```

`<probe-path>` is absolute. Triage by exit code:

- **0** → the command computed an answer. Record the reported `provider` and whether the
  target was `covered`. **`covered: false` is an answer, not a failure** — it says this
  particular file has no test reaching it, which is information the loop uses, not a
  prerequisite it needs.
- **1 with the no-provider error** → report it with the remedy *add `@vitest/coverage-v8` as a
  devDependency and commit*, and **stop**. Without a provider the coverage check can never
  answer, and a loop that cannot tell covered from uncovered code is choosing blind.
- **any other 1** → **stop** and quote the `error` line verbatim.
- **2** → an invocation bug in this skill, not a repo problem. Quote it and stop.

This probe is the one place setup runs the repo's test suite with coverage instrumentation.
It is a single run over one target inside the probe worktree, bounded and one-time.

### Step 5 — Remove the probe worktree

```bash
git -C "<loop_clone>" worktree remove --force "<probe-path>"
git -C "<loop_clone>" worktree prune
```

`--force` is appropriate here and only here: the probe holds nothing but copied files and
installed dependencies, all of it accounted for.

---

## §6 Write the profile and seed the queue

Compose `.tidyloop.yaml` per [`references/profile.md`](references/profile.md) §1 from the
probed values, the §4 answers, and the §5 results. Then check every validation rule in
profile.md §3 against what you are about to write. A rule that fails is a bug in this run —
report the field and stop rather than writing a profile the loops will reject.

Fixed values this skill always writes, regardless of what was probed:

- `version: 1`
- `execute: false` — a new project surveys first. The queue fills with real candidates and the
  human reads real reports before anything builds, and flipping this is their decision, never a
  setup default
- `checks.stack` — the stack inferred in §2 and confirmed by the §5 step 4 probe
- the four `checks.*` gate keys as `null`. A project configuring one later is a one-key edit,
  and a null gate is reported as skipped in every run's evidence rather than quietly absent
- `caps.max_open_prs: 1` — the churn budget
- the `caps.per_category` block from profile.md §1, including `deepen-module`, unless the probe
  found a reason to differ. Do not collapse it to one flat number: the categories have very
  different natural sizes, lines are charged as insertions plus deletions so every moved line
  counts twice, and files touched only to repoint an import need their own allowance or a widely
  imported module cannot be tidied at all. Measure the repo's own import fan-out during §2 and
  say in the §7 report what the busiest modules cost, so the `max_import_update_files` number is
  grounded rather than inherited
- `pr_label: tidy-loop`
- `allowlist` — every category in profile.md §2, unless the user narrowed the list in §4's
  review block. It is a set and not a ranking: narrowing it is a statement about what the loop
  may do in this codebase, which is the user's call and not an inference, so the default is the
  full set and the review block is where it gets cut
- `main_checkout` — the repo root this run onboarded, so a run can see the user's in-flight work
  and drop findings that touch it
- `state_dir` — `~/.tidy-loop/<repo-name>` by default, and it must resolve **outside** every
  repository working tree. A state directory inside the loop clone would leave the clone dirty,
  and a dirty clone aborts the next run at preflight, so the loop would disable itself after one
  execution. Create the directory here
- `test_support_paths` — from §2's two signals. An empty list is permitted only when the project
  genuinely has no harness beyond its spec files, and that conclusion is stated explicitly in
  the §7 report rather than arrived at by default

On a re-verify run, present a field-by-field diff against the existing profile and get
approval before writing. A key in the existing file that the current schema does not have shows
in that diff as a removal, with no commentary — the diff is a statement of what the profile will
say, not a history of what it said.

Seed the queue at `<state_dir>/queue.md` if absent, containing exactly the header line from
[`references/queue.md`](references/queue.md) §1 and nothing else. Copy that line from §1 rather
than from memory — it is the legend every later reader parses against, and a second copy of it
in this file would be a place for the two to drift apart.

`.tidyloop.yaml` is not committed by this skill; `queue.md` lives outside the repo.

---

## §7 Report and hand off

Close with a summary the user can act on without re-reading the transcript:

1. **What was written** — the profile path, the seeded queue path, any new `.worktreeinclude`,
   and that nothing was committed.
2. **Gate coverage** — which gates are live and which are disabled, each disabled one with
   the reason and what it was protecting. This covers both the project commands that came back
   green or `null` in §5 step 4 **and** the four `checks.*` gates, all of which are written
   `null` and will be reported as skipped until the user configures them. This is the honest
   statement of how much the loop is actually verified, and it belongs in front of the user
   before any run.
3. **Prerequisite findings** — any not-ignored paths from §5 step 3, any command that
   failed for a missing secret, and the coverage provider the §5 step 4 probe reported.
4. **The hotspot top ten** from §3, so the first survey report has something to be compared
   against.
5. **How to enable the schedules.** There are two, both local so the run can see the loop
   clone on disk: `/tidy-survey <loop_clone>` weekly, and `/tidy-execute <loop_clone>` daily.
   Give the user the concrete next step for their own surface — a local scheduled task, or a
   cron entry invoking each — rather than describing the options abstractly. Do not create the
   schedules from this skill: a recurring unattended job is the user's to switch on.

   Both commands must pass the **loop clone** as the repo path. Never the user's own checkout —
   it is on whatever branch they are working on, may not contain the profile at all, and would
   make every run depend on it.

   Both schedules stay manual until the user flips `execute: true`: this skill creates neither,
   and until the flag is flipped each command is the user's to run by hand or to schedule on
   their own surface. Say what each does while the flag is `false`: the survey runs and fills
   the queue regardless, so scheduling it early is harmless and lets candidates and reports
   accumulate for review from the first week; `tidy-execute` reads the flag, reports it, and
   exits without building. Nothing in the repo changes until the user decides it should.

Recommend committing `.tidyloop.yaml` and any new `.worktreeinclude` together as one commit,
and say why: a worktree cut from base must see both.
