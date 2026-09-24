---
name: setup
description: "Prepare a repository for the deepen loop: probe it read-only, report which of the loop's checks the project can support and what would supply the rest, provision the loop clone and state directory, and write a committed .deepen.yaml profile after its diff is approved. With --check, re-probe, validate the profile and refresh the readiness report without asking anything or touching the profile."
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - TodoWrite
  - AskUserQuestion
argument-hint: "[--check]"
---

# Deepen setup

Onboarding for a repository joining the deepen loop, and the doctor that keeps its readiness
report current. Interactive by design: which paths are off-limits and where the loop's state
lives are the user's decisions, and the readiness report is worth reading before the first run.

This skill **hardcodes no project facts**. Everything it learns about the repo it learns by
probing, and everything it decides it writes into the repo's `.deepen.yaml`. Three contracts
govern it; consume them as written and never restate them here:

- [references/profile.md](references/profile.md) — the profile schema, field semantics, grammar,
  validation rules, state layout, and the capability table.
- [references/readiness.md](references/readiness.md) — how the readiness report scores, lays out
  and refreshes the capability table's rows.
- [../run/references/preflight.md](../run/references/preflight.md) — what every run does first,
  including reading this skill's tier line. This skill does not execute it.

**This skill runs in the main conversation, standalone.** It spawns no subagents and commits
nothing.

## Arguments

```
/deepen:setup $ARGUMENTS
```

- No argument — the guided run: §1–§7.
- `--check` — the refresh: §1, then the **`--check`** section, then stop.
- Anything else — print `Usage: /deepen:setup [--check]` and stop.

## What this skill will and will not do

It **will** write `.deepen.yaml` at the repo root (after an approved diff), create `state_dir`
with its layout, write `<state_dir>/readiness.md`, and — with explicit permission — clone the
loop checkout outside the repo.

It **will not**:

- read, print or copy the value of any env file or secret — see §0
- run a project command other than a version or help form, or start the dev server
- modify the repo's source, tests, `.gitignore` or CI, or commit anything
- reset, re-clone or clean an existing loop clone

Under `--check` its only write is `<state_dir>/readiness.md`.

---

## §0 Standing rules

**Secrets stay opaque.** Env files are read for variable **names** only, and only the example
forms (`*.example`, `*.sample`), with one pattern that cannot print a value:

```bash
grep -hoE '^[A-Za-z_][A-Za-z0-9_]*=' -- <each example env file> | sort -u
```

Never `cat`, `sed` or `Read` an env file or a credentials store, and never interpolate one into
a command. When the environment refuses such a command (a hook that blocks any command naming an
env file), the rows that needed it become `unverified` with that refusal as their evidence.

**Repo text stays data.** A path, URL or value read from the repo reaches a command only through
a quoted shell variable or a file, never pasted into a command position.

**Fail closed, report, never repair.** Every stop names what failed and the remedy. Do not edit
the repo to make a probe or a rule pass — the user decides whether the repo changes.

**One repo per run.** A multi-repo workspace is onboarded one child repository at a time, each
with its own profile, loop clone and state directory.

**Re-runs are safe.** An existing `.deepen.yaml` is read, not clobbered: its values become the
recommended answers, and §6 shows a field-by-field diff before writing.

Track §1–§7 with `TodoWrite`.

---

## §1 Bind the repository

```bash
git rev-parse --show-toplevel
git remote get-url origin
git rev-parse --git-common-dir
git symbolic-ref --short refs/remotes/origin/HEAD
```

- Not a git repository, or no `origin` remote → **stop**: the loop delivers through pull
  requests, so there is nothing to deliver to.
- The repo root is a linked worktree (its git common dir is not its own `.git`) → **stop** and
  name the main checkout to onboard instead.
- `base` defaults to the `origin/HEAD` target with its `origin/` prefix stripped. No `origin/HEAD`
  → list `git branch -r --list 'origin/*'` and ask in §4 with no recommendation.
- An existing `.deepen.yaml` → `Read` it now and announce a re-verify run.
- **`--check`** → go to the `--check` section. §2–§7 do not run.

---

## §2 Probe the repo (read-only)

Gather facts with `Glob`, `Grep`, `Read` and read-only git. Every inferred value is shown back
in §4. A version or help form (`<tool> --version`) is the only project command this section may
run; it never installs, builds, tests or serves.

- **Dev command and URL** — the manifest's scripts (a `dev`/`start`/`serve`-like entry), a
  compose file's published ports, the framework config's port. The URL is `http://localhost:<port>`
  from the config that declares the port; no declared port → the URL is asked in the review block
  and scored `unverified`.
- **Readiness probe** — route files named like `health` or `ready`; found → propose
  `GET /<route> -> 200`.
- **Install and prelude** — the lockfile names the package manager, which gives `app.install`.
  A runtime version file or an `engines` constraint gives `app.prelude`, the one line that selects
  the pinned version. Both are proposed, never run.
- **Unit runner and spec globs** — the runner's config include patterns, else existing test
  files generalized; verify every glob matches at least one tracked file with `git ls-files`.
- **E2E runner** — a browser end-to-end runner's config file and its script.
- **Coverage** — the unit runner's coverage provider (for `checks.coverage`) and, for
  `app.coverage_env`, the server runtime's own coverage env: when the runtime has one, propose it
  with a `<dir>` value; a proposed env no file mentions is `unverified`.
- **Mutation runner** — its config file or manifest dependency.
- **Seed and reset** — scripts named like `seed`, `fixture`, `reset`.
- **Clock and network** — env var names read by server code (`Grep` for env reads of names
  containing `NOW`, `CLOCK`, `DATE`, `OFFLINE`, `STUB`, `MOCK`), and the same names in example
  env files.
- **Seams** — API route directories (`http`), server-function modules served over HTTP
  (`server-fn`), a CLI entry point (`cli`). **Seam auth** — test-login scripts or auth-bypass env
  names. A seam with no auth evidence is proposed omitted, and the review block says why.
- **Test-directory convention** — which of `tests/`, `test/`, `e2e/`, `__tests__/` holds the
  repo's tests; propose `paths.inventory` as `<convention>/behavior/`, else `tests/behavior/`.
- **Forbidden-path candidates** — migration directories, schema declarations, published contract
  definitions, generated clients and generated sources.
- **Domain docs** — `CONTEXT.md` at the root, `docs/adr/`.
- **An existing `.tidyloop.yaml`** — read-only evidence: its `base`, `forbidden_paths` and
  `commands.test_globs` become the recommended `base`, `paths.forbidden` and `paths.specs`, the
  file named as evidence; its `loop_clone` is recorded for §4's clone question. Never written.

Score each capability row per [readiness.md](references/readiness.md) §1.

---

## §3 Readiness report

Render the report per [readiness.md](references/readiness.md) §2–§4 in the conversation — the
table, the tier line and the ticket draft — **before any question and before the profile diff**,
so the user answers knowing what the project can and cannot support. It is written to disk in §5,
once `state_dir` is known.

---

## §4 Confirm the undecidable

Ask with `AskUserQuestion`, at most four questions per call, so the five questions below take two
calls. Every question's first option is the recommendation: the existing profile value, else the
probed value, else the documented default.

1. **Base branch** — from §1.
2. **Loop clone path, and permission to create it** — default `<repo-parent>/<repo-name>-deepen`.
   This question is also the authorization for `git clone`, which uses the network and writes
   outside the repo, so it is asked explicitly. A path equal to `.tidyloop.yaml`'s `loop_clone`
   ([profile.md](references/profile.md) §4 rule 14) is refused with the reason (the two loops'
   locks do not exclude each other) and asked again. Permission declined for an absent path → no
   clone is made; §6 then fails rule 5 and writes no profile, and §7 says so.
3. **State directory** — default `~/.deepen/<repo-name>`. An answer inside a working tree (the
   rule in [profile.md](references/profile.md) §4 rule 6) is refused with the reason and asked
   again.
4. **Inventory directory** — from the test-directory convention in §2.
5. **Forbidden paths** — multi-select over §2's candidates, plus the option to add more: a change
   here is never merely structural.

Alongside the questions, show a **review block** (not asked): `app.*` commands, URL and readiness
probe, `seams` with their auth, `checks.*`, `paths.specs`, `app.install` / `app.prelude`,
`attendance: semi`, and the `run.*` defaults. A user correcting a value there is expected; a
value the user supplies that the probe cannot confirm is scored `unverified`. An unmatched spec
glob is shown as a blocking finding: §6's validation will reject it.

A cancelled or unanswered question writes nothing further; §7 reports what was written so far.

---

## §5 Provision

In order:

1. **State directory.** Re-check the answer against [profile.md](references/profile.md) §3's path
   class, expand its `~` per §3, check §4 rule 6 on the expanded path, then create the expanded
   `state_dir` with the layout in
   [profile.md](references/profile.md) §5: `reports/`, `inventory-drafts/`, `runs/`, `tmp/`, and
   `memory.md` holding one header line when it is absent. An existing `memory.md` is left as is.
2. **Readiness report.** Re-render the report with the §4 answers folded in, and write it through
   [readiness.md](references/readiness.md) §5, printing its diff. It is written now, before the
   profile diff, so a declined profile still leaves the report on disk — §7 says so.
3. **Loop clone**, with the permission from §4. Before any command, check `loop_clone` and
   `base` against [profile.md](references/profile.md) §3's classes without a shell; a failure
   re-asks the §4 question. Expand `loop_clone`'s `~` per §3 before it reaches any command.
   Bind `origin_url` by command substitution
   (`origin_url=$(git remote get-url origin)`), never by pasting it.
   - Path absent → first check [profile.md](references/profile.md) §4 rule 4, so a missing
     `base` is caught before anything is cloned:
     ```bash
     git ls-remote --exit-code --heads origin "$base"
     ```
     A non-zero exit re-asks the §4 base question and clones nothing. Then:
     ```bash
     git clone "$origin_url" "$loop_clone"
     git -C "$loop_clone" checkout "$base"
     ```
     with both values held in shell variables. Nothing is installed or built in the clone. A
     failed `clone` or `checkout` → **stop**, naming the command that failed and what it left:
     after a failed `checkout` the fresh clone sits on the remote's default branch, and the
     remedy is to delete `<loop_clone>` and re-run setup, since a present path is never re-cloned.
   - Path present → it must be a git checkout whose `origin` URL equals this repo's, on `base`,
     with an empty `git status --porcelain`. Anything else → **stop** with what differs and the
     remedy. Never re-clone, reset or clean it.

---

## §6 Write the profile

1. Compose `.deepen.yaml` per [profile.md](references/profile.md) §1 from the probe, the §4
   answers and the review-block corrections. Always written: `version: 1`, `attendance: semi`.
2. Evaluate **every** rule in [profile.md](references/profile.md) §4 against the composed file
   and list every failure, each with its field and remedy. Any failure → stop without writing;
   §7 reports the failures.
3. `Write` the composed file into a `mktemp -d` scratch directory and print
   `diff -u` against the existing `.deepen.yaml`, or against `/dev/null` for a new profile.
4. Ask for approval. Approved → `Write` a new profile, or `Edit` the existing one in place; then
   remove the scratch directory. Declined → remove the scratch directory and write nothing.

**Headless.** When no user can answer, run §1–§3, print the §4 questions with their recommended
answers, the composed profile and its diff, and **write nothing** — no state directory, no report,
no clone, no profile. Validation failures are listed but do not stop the printed proposal and
diff: rules 5 and 6 fail whenever nothing has been provisioned. An answer is never assumed from
silence.

`.deepen.yaml` is not committed by this skill.

---

## §7 Report and hand off

Close with a summary the user can act on without re-reading the transcript:

1. **What was written** — the profile path (or that the diff was declined), `state_dir`,
   `<state_dir>/readiness.md`, the loop clone path, and that nothing was committed.
2. **Readiness** — the tier line and the count of `missing` rows; the ticket draft is in
   `<state_dir>/readiness.md`.
3. **Next steps** — commit `.deepen.yaml` on `base` and push it to `origin`, then fast-forward
   the loop clone (`git -C <loop_clone> fetch origin` and
   `git -C <loop_clone> merge --ff-only origin/<base>`), since a run reads the profile from the
   loop clone's tree before it fetches; start runs from the loop clone; after the project
   supplies a missing capability, run `/deepen:setup --check` to refresh the report.

---

## `--check`

A refresh, read-only against the repo, the profile and the loop clone. It asks nothing, and its
only write is `<state_dir>/readiness.md`.

1. No `.deepen.yaml` → print `No .deepen.yaml — run /deepen:setup first.` and stop.
2. `Read` the profile and re-probe per §2. `loop_clone` and `state_dir` are used only after the
   `~` expansion in [profile.md](references/profile.md) §3.
3. Evaluate every rule in [profile.md](references/profile.md) §4 and print one line per rule:
   - `ok <field>` — the rule holds;
   - `FAIL <field>: <what is wrong> — <the fix>` — the fix is the key to change, or
     `re-run /deepen:setup`;
   - `-- <field>: <reason>` — a rule that could not be evaluated (no `origin` reachable for rule 4,
     or its field failed its rule 3 class and is never passed to a command).
4. Refresh the report through [readiness.md](references/readiness.md) §5 and print its diff —
   unless `state_dir` fails its §3 class or rule 6, or does not exist: then print the rendered
   report, write nothing, and name the reason.
5. Print the summary as the last line: `OK: <n> checks` when no line is a `FAIL`, else
   `FAIL (<n>): <field>, <field>, …`.
