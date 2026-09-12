---
name: tidy-setup
description: "Prepare a repository for the Tidy Loop: probe its commands and hotspots, verify the worktree prerequisites actually hold, provision the dedicated loop clone, and write a committed .tidyloop.yaml profile. Run once per repo, before the first scheduled run. Use when the user wants to enable, configure, re-verify, or onboard a project to the tidy loop."
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
[`references/profile.md`](references/profile.md) — consume that contract as written; never
restate or redefine it here.

The counterpart run skill is `tidy-run`. It reads the profile this skill writes and refuses
to start if any validation rule in profile.md §3 fails.

## What this skill will and will not do

It **will** write three things: `.tidyloop.yaml` at the repo root, a seeded ledger file, and
(with permission) a `.worktreeinclude` if the repo has none. It will clone a dedicated loop
checkout outside the repo.

It **will not**:

- read, print, or copy the contents of any `.env` or secrets file — see §0
- add a secret-bearing path to `.worktreeinclude` to make a gate pass
- write `tier` higher than `0`
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
Then verify the globs match at least one real file — an unmatched glob makes gate G1 silently
check nothing, and that is the single most damaging misconfiguration available.

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
oracle restores spec files from the base commit and assumes the harness they run against is
fixed. Two signals, both mechanical:

1. The runner's configured setup and global-fixture files, read from its config.
2. **Any module whose importers are all test files.** This is the decisive one — a module
   imported only by specs is test support whatever it is named, which catches fakes, stubs,
   builders, and temp-database helpers that no naming convention would reveal.

These become `test_support_paths`, which the loop treats as forbidden. Say why in the §7 report,
because the reasoning is not obvious: a run that refactored a fake would execute the base specs
against its own modified fake, and an altered stub can mask exactly the regression the gate
exists to catch. Adding them to `test_globs` instead would be worse — restoring a file the diff
modified means the gate never exercises the modified version, so the change ships unverified.

**Forbidden-path candidates.** Search for the places where a structural change is never
merely structural: migration directories, table or schema declarations, published contract
definitions, generated clients. Collect candidates; the user confirms in §4.

**Surface-oracle candidates.** Determine whether the repo publishes a typed boundary whose
build output can be compared byte-for-byte — emitted declaration files for a shared package,
a generated API document, a checked-in schema artifact. Present candidates or, honestly,
none.

**Domain docs for the architecture gate.** Note whether a domain glossary and architecture
decision records exist. Their absence is not blocking, but the run's architecture gate
degrades to convention-only review without them, and the user should hear that now.

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

Filter out `scan.exclude` matches, then measure size for the survivors and rank by
`score = churn × lines`. Present the top ten as a table: file, commits in window, lines,
score.

Say plainly what the table is and is not: it is where change and size overlap, which is the
CodeScene hotspot proxy for *where refactoring pays off*. It is not a list of defects, and a
high-scoring file may be perfectly well structured.

If the user looks at the top entries and disagrees that they are the right places to spend
effort, that is a signal to fix `scan.include` / `scan.exclude` now — not a reason to proceed.

---

## §4 Confirm the undecidable

Ask with `AskUserQuestion`. Batch the questions into one pass. Every question carries a
recommended option first, drawn from §2's probe. Four questions, no more — anything else was
inferable and should have been inferred.

1. **Base branch** — the confirmed default branch on `origin`.
2. **Forbidden paths** — multi-select over §2's candidates, plus the option to add more.
   Frame it as: *a structural change here is never merely structural*.
3. **Surface oracle** — the byte-identical build artifacts, or explicitly none. When the
   answer is none, state that gate G4 will be disabled and the project is correspondingly
   less protected.
4. **Loop clone path and permission to create it** — default
   `<repo-parent>/<repo-name>-tidy`. This question is also the authorization to run
   `git clone`, which writes outside the repo and uses the network, so it is asked
   explicitly rather than inferred from the user's general go-ahead.

Present the inferred commands, globs, caps, and the proposed `commands.prelude` alongside the
questions as a review block. The user correcting an inferred value there is expected and cheap;
discovering it wrong during the first scheduled run is not.

The prelude is reviewed rather than asked, because it is derivable: §2 found the pinned version
and the version manager, and the composed line is either right or visibly wrong at a glance.

Do not ask about `tier` — setup always writes `0`. Do not ask about cadence — that is the
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

### Step 5 — Remove the probe worktree

```bash
git -C "<loop_clone>" worktree remove --force "<probe-path>"
git -C "<loop_clone>" worktree prune
```

`--force` is appropriate here and only here: the probe holds nothing but copied files and
installed dependencies, all of it accounted for.

---

## §6 Write the profile and seed the ledger

Compose `.tidyloop.yaml` per [`references/profile.md`](references/profile.md) §1 from the
probed values, the §4 answers, and the §5 results. Then check every validation rule in
profile.md §3 against what you are about to write. A rule that fails is a bug in this run —
report the field and stop rather than writing a profile `tidy-run` will reject.

Fixed values this skill always writes, regardless of what was probed:

- `version: 1`
- `tier: 0` — a new project observes first; graduation is a human decision informed by the
  ledger, never a setup default
- `caps.max_open_prs: 1` — the churn budget
- the `caps.per_category` block from profile.md §1, unless the probe found a reason to differ.
  Do not collapse it to one flat number: the categories have very different natural sizes, lines
  are charged as insertions plus deletions so every moved line counts twice, and files touched
  only to repoint an import need their own allowance or a widely imported module cannot be
  tidied at all. Measure the repo's own import fan-out during §2 and say in the §7 report what
  the busiest modules cost, so the `max_import_update_files` number is grounded rather than
  inherited
- `ticket_adapter: none` unless `loop_clone` is the repo itself
- `tier0_report: file`
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
approval before writing.

Seed the ledger at the `ledger` path if absent, with the header row and nothing else:

```markdown
# Tidy Loop ledger

Append-only. One line per run. Status: proposed | merged | rejected | reverted | escalated | blocked.

| date | finding-id | category | files | status | pr | note |
|------|-----------|----------|-------|--------|----|------|
```

Neither file is committed by this skill.

---

## §7 Report and hand off

Close with a summary the user can act on without re-reading the transcript:

1. **What was written** — the three paths, and that nothing was committed.
2. **Gate coverage** — which gates are live and which are disabled, each disabled one with
   the reason and what it was protecting. This is the honest statement of how much the loop
   is actually verified, and it belongs in front of the user before any run.
3. **Prerequisite findings** — any not-ignored paths from §5 step 3, and any command that
   failed for a missing secret.
4. **The hotspot top ten** from §3, so the first tier-0 run has something to be compared
   against.
5. **How to enable the schedule.** The loop runs weekly and locally, so that the run can see
   the loop clone on disk. Give the user the concrete next step for their own surface — a
   local scheduled task, or a cron entry invoking the run — rather than describing the
   options abstractly. Do not create the schedule from this skill: a recurring unattended job
   is the user's to switch on.
6. **The tier-0 exit criterion** — two to four weekly reports whose top pick the user agrees
   with. Then `tier: 1` is a one-field edit.

Recommend committing `.tidyloop.yaml`, the ledger, and any new `.worktreeinclude` together as
one commit, and say why: a worktree cut from base must see all three.
