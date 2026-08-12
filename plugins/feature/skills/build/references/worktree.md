# Worktree Lifecycle

The shared provision → work → remove procedure for every surface that isolates a ticket's code work in a git worktree. Two consumers today:

- **`build`** — via the `--worktree` flag (SKILL.md's State setup binds the inputs and runs §2; the checkpoints consume §3; the verdict gate runs §4; §5 is the manual cleanup path).
- **`ship --parallel`** — via [`../../ship/references/parallel-walk.md`](../../ship/references/parallel-walk.md) §3, per dispatched ticket.

Born in build and reused by ship, following the same precedent as [`pr-creation.md`](pr-creation.md) (born in build, reused by `sync`): the producing skill owns the rules, the consumers link them. Everything caller-specific — *when* a worktree is provisioned, *what* triggers removal, *what* a setup failure means — is a §0 input, so neither consumer forks the mechanics.

The `worktree:` config block and the `.worktreeinclude` file this procedure consumes are defined in [`../../../docs/advanced.md`](../../../docs/advanced.md) §Worktree setup. Consume that contract as written there; never restate or redefine it here.

All git work runs inline via `Bash`. Every command below is **explicitly path-bound** — `git -C …` or `cd "<wt-path>" && …` — because shell state does not persist between `Bash` tool calls (the same constraint [`test-preflight.md`](test-preflight.md) §3 documents for its fixed `/tmp` paths). There is no "cd once and stay there" mode.

---

## §0 Inputs (what the caller binds before anything here runs)

| Input | Meaning |
|---|---|
| `<TICKET-ID>` | The ticket's `id` — keys the worktree path and the `/tmp` setup script. |
| `<repo-root>` | **Absolute** path to the git repository the work happens in — the main checkout. In a single-repo workspace, the repo itself; in a multi-repo workspace, the workspace child directory the ticket's work belongs to (build: the ticket's single `repos:` entry, per §1; ship: the lane's repo, per parallel-walk §1). This procedure assumes `<repo-root>` is a main checkout, never itself a worktree. |
| `<BASE_BRANCH>` | The **short** branch name the worktree forks from (e.g. `main`, or `integration/<epic-id>` on an epic run) — never the `origin/`-prefixed remote-tracking form, which breaks `git checkout` and `gh --base`. Resolved by the caller: build uses [`pr-creation.md`](pr-creation.md) §1's short-name helper; ship passes its lane's bound base under `--parallel` (on ship's serial path there is no channel for a non-default base — which is why that path drops the flag rather than forking from the wrong trunk). |
| `<branch>` | `<type>/<TICKET-ID>-<slug>` per [`pr-creation.md`](pr-creation.md) §2 — including its mandatory slug sanitization, since the value is interpolated into shell commands. |
| `<ticket-folder>` | **Absolute** path to the ticket folder in the main checkout (fs-native). Never a relative path and never a path inside the worktree — see §3. Server-native mode has no ticket tree; the caller's own working copy applies instead. |
| **setup-failure policy** | What a failed `worktree.setup` means to this caller — §2 step 5 reports the failure and defers the decision. build: notice and continue in the worktree. ship: parallel-walk §1 degradation. |
| **removal trigger** | When §4 is allowed to run — §4 owns the safety predicate, the caller owns the trigger. build: the verdict gate's endings. ship: parallel-walk §5 (merged + revalidated) or §6 (branch pushed). |

`<wt-path>` is **derived**, not supplied: `<repo-root>/../<repo-dirname>-worktrees/<TICKET-ID>`, where `<repo-dirname>` is `<repo-root>`'s own directory name. A sibling of the repo, never inside it.

**Binding order.** `<repo-root>` and `<BASE_BRANCH>` are resolved **as part of §1** — §1 is what picks the repo from `repos:`, and its blocker check needs the base. Everything else in the table binds once §1 passes. A caller that already knows the repo (ship's lane record) supplies `<repo-root>` up front and §1 simply confirms it.

**Interpolation.** Every input above except `<ticket-folder>` reaches a shell command line. `<TICKET-ID>` and `<BASE_BRANCH>` are format-constrained by their sources; `<branch>` carries `pr-creation.md` §2's mandatory `[a-z0-9-]` slug sanitization; `<repo-root>` is ticket-derived (the `repos:` entry) and is gated by §1's must-resolve-to-a-`.git`-directory check. Any value recovered from an **artifact body** is loaded by command substitution and character-class-checked before use — never pasted into a `"…"` literal, per [`pr-creation.md`](pr-creation.md) §4's injection discipline. §1's blocker branch is the one such value here.

---

## §1 Eligibility

Cheapest-first: the `repos:` rules below are pure metadata reads, and only the blocker check touches git. Each miss is a one-line notice and an in-place build — never an error, and never a silent skip.

- **Multi-repo ticket, 2+ `repos:` entries** → **not eligible**. A single worktree cannot span repositories. Notice: `--worktree: <TICKET-ID> spans repos (<repos>); building in place.` (The `repos:` field's semantics are [`../../discover/references/multi-repo.md`](../../discover/references/multi-repo.md); it exists in fs-native mode only.)
- **Exactly one `repos:` entry** → **eligible**; `<repo-root>` is that workspace child directory. A value that does not resolve to an existing child directory containing `.git` is treated as the multi-repo miss above, naming the unresolved value.
- **No `repos:` field** → **eligible**; `<repo-root>` is the repository holding `claudedocs/tickets/`.
- **A `blocked_by` blocker's code is in neither the fork point nor the current checkout** → **not eligible**. A blocker that finished without `--pr` is `done` with its commits on a local branch that was never merged into `<BASE_BRANCH>`, so a worktree cut fresh from `origin/<BASE_BRANCH>` would not contain that code.

  Run once, before the tests below, so both compare against the real remote rather than a stale ref: `git -C "<repo-root>" fetch origin`. Then, for each `blocked_by` entry, recover its branch from that blocker's `06-summary.md` (the branch recorded by [`pr-creation.md`](pr-creation.md) §5) as **data**, never as command text:

  ```bash
  BLOCKER_BRANCH=$(sed -n 's/^branch: *//p' "<blocker 06-summary.md path>" | head -1)
  case "$BLOCKER_BRANCH" in
    ''|*[!A-Za-z0-9._/-]*) : ;;   # absent or not a plain ref name → treat as "no recorded branch" (the miss)
    *)
      git -C "<repo-root>" merge-base --is-ancestor "$BLOCKER_BRANCH" "origin/<BASE_BRANCH>"   # in the fork point?
      git -C "<repo-root>" merge-base --is-ancestor "$BLOCKER_BRANCH" HEAD                     # in the current checkout?
      ;;
  esac
  ```

  A `06-summary.md` body is model-written and, in most consumer repos, committed and therefore PR-editable — so the value is loaded by command substitution and character-class-checked before it reaches `merge-base`, per §0's interpolation rule. No recorded branch, or a value that fails the check, is itself the miss.

  - **In the fork point** → this blocker is satisfied; a worktree will carry its code.
  - **Not in the fork point but in the current checkout** → notice `--worktree: blocker <BLOCKER-ID> is not on origin/<BASE_BRANCH>; building in place, where its code is present.` and build in place.
  - **In neither** → the blocker's code is nowhere this run can reach, in a worktree *or* in place. This is the `flow --worktree` epic case: a sibling built in its own worktree, committed there, and had that worktree torn down. Notice `--worktree: blocker <BLOCKER-ID> is on branch <branch>, which is neither on origin/<BASE_BRANCH> nor in the current checkout — building in place, but merge or check out that branch first or this build will not see its code.` and build in place. Do not claim the code is present.
- **No `worktree:` block in `claudedocs/tickets/config.yaml`** → **still eligible**. The worktree is created; only §2 step 4 is skipped, with a notice. This deliberately differs from `ship --parallel`'s degrade-to-serial (parallel-walk §1): `--parallel` *needs* the contract because it provisions many worktrees unattended, whereas an explicit `--worktree` is a direct isolation request and a worktree is creatable without the setup contract — the only cost is that dependency install is manual.

---

## §2 Provision

### Step 1 — Adopt an existing worktree, if there is one

The cheapest decisive check, so it runs first — nothing below is needed when a worktree already exists.

```bash
git -C "<repo-root>" worktree list
```

- **`<wt-path>` is already registered** → **adopt it**; print one line naming the path, then run **step 4's verification only** (not its copy — the files are already there) and skip to step 6. A prior run (or a crash) provisioned it, so re-provisioning would fail and re-copying could clobber work. Adopting also skips step 2's prompt — the user answered that question when the worktree was created, and re-asking on every resume is noise on the flag's most common repeat path.

  Re-running the verification is what keeps the exclusion list alive across a resume. That list is per-run state, so a crash after provisioning but before the commit would otherwise leave a worktree holding a copied secrets file this run has never checked, and `commit.md` §1 would stage it with an empty exclusion list. Re-deriving costs one `check-ignore` per `.worktreeinclude` match — all local — and is authoritative even when the recorded list is stale or predates the field.
- **`<branch>` exists but has no worktree** (pushed pre-crash, its worktree pruned) → note it now; step 3 uses the re-attach form instead of `-b`.

### Step 2 — Preconditions on the main checkout

The worktree is cut from `origin/<BASE_BRANCH>`, so nothing sitting in `<repo-root>`'s working tree comes along. Fetch first, so "ahead of base" is judged against the real remote:

```bash
git -C "<repo-root>" fetch origin
git -C "<repo-root>" status --porcelain
git -C "<repo-root>" rev-list "origin/<BASE_BRANCH>..HEAD" --count
```

- **Uncommitted changes** (`status --porcelain` non-empty) → **pause and ask**: `provision anyway` (the changes stay in the main checkout, untouched and not carried) / `abort`. This is the one case where work can be silently left behind, and it mirrors [`pr-creation.md`](pr-creation.md) §1's "do NOT silently fork" stance for the same hazard.
- **Commits ahead of base** (`rev-list --count` non-zero) → one-line notice only, no prompt: `--worktree: <repo-dirname> is <N> commits ahead of <BASE_BRANCH>; the worktree forks from origin/<BASE_BRANCH> and will not include them.` Nothing is lost — the commits remain on their branch.

### Step 3 — Add

```bash
git -C "<repo-root>" worktree add "<wt-path>" -b "<branch>" "origin/<BASE_BRANCH>"
```

**Pre-creating the branch here is load-bearing.** `<BASE_BRANCH>` stays checked out in `<repo-root>`, and git refuses to check out one branch in two worktrees — so the branch must exist and be checked out in the worktree *before* any work starts, and the work must **reuse** it rather than fork inside the worktree. §3 and [`pr-creation.md`](pr-creation.md) §1's provisioned-branch short-circuit are what enforce that downstream.

When step 1 found a surviving branch, `-b` refuses it — re-attach instead: `git -C "<repo-root>" worktree add "<wt-path>" "<branch>"`.

Any other `git worktree add` failure → stop and report the git error verbatim. Never fall back to an in-place build here: the isolation request was explicit, and edits would land in the main checkout the caller expected to stay untouched. (§1's eligibility misses are the only in-place fallbacks, and they are decided before this section runs.)

### Step 4 — Copy, then verify the copies are still ignored

Copy every file matching a `.worktreeinclude` pattern from `<repo-root>` into `<wt-path>`, preserving relative paths — the contract's copy-then-setup order. No `.worktreeinclude` file → skip.

**Then verify, per copied path — do not assume.** The worktree was cut from `origin/<BASE_BRANCH>`, so it evaluates ignore rules against **the base branch's committed `.gitignore`**, while the patterns that selected these files were written for **the main checkout's working-tree `.gitignore`**. Whenever the two differ — a `.gitignore` written but never committed, an ignore line added on the current feature branch and not yet merged, a nested `.gitignore` inside an untracked directory — a file that is ignored in the main checkout arrives **unignored** in the worktree. `commit.md` §1's `git add -A` then sweeps it, and on `--pr` that path runs unattended through `git push` and `gh pr create`. `.worktreeinclude` exists to carry exactly the files that must not be committed, so this is the one check standing between a copied `.env` and a public PR.

```bash
git -C "<wt-path>" check-ignore -q "<rel-path>" || echo "not ignored: <rel-path>"
```

Any path that comes back **not ignored** → print one line naming the file and the remedy (`commit its .gitignore entry to <BASE_BRANCH>`), and add it to the run's **exclusion list**, which [`commit.md`](commit.md) §1 applies as `git reset -q -- "<rel-path>"` at every commit this run makes. This generalizes `commit.md` §1's single-path `test.auth.storage_state` backstop to the actual set of files provisioning moves.

Write the list to the caller's worktree record too (build: the `## Worktree` block's `excluded:` field), so a resumed run can see what a prior pass found. Treat that record as a **hint, not the source of truth** — step 1's adopt path re-derives the list, because a record can be stale, absent, or predate the field, and an empty list silently disables the guard.

### Step 5 — Setup

Run `worktree.setup` inside the worktree under the declared-command trust discipline ([`test-preflight.md`](test-preflight.md) §3): write the command **verbatim** into a fixed, ticket-keyed script file, then run it. Prefer the `Write` tool; on a Bash-only surface use a single-quoted heredoc whose delimiter is a verified-unique nonce ([`../../review/references/pr-comments.md`](../../review/references/pr-comments.md) §4).

```bash
cd "<wt-path>" && bash "/tmp/fp-worktree-setup-<TICKET-ID>.sh"
```

Never substitute the command into a shell command line; never let ticket-derived text (spec title, AC text, branch slug) near this file. `worktree.setup` is the user's own declared command — the same trust tier as `validate.lint` and `test.start`.

- **Missing `worktree:` block or missing `setup` key** → skip with one line: `--worktree: no worktree.setup declared; skipping dependency setup (install manually in <wt-path> if the build needs it).`
- **Failure** → report the exit code and the last lines of output, then apply the caller's **setup-failure policy** (§0). This is the one place the two consumers legitimately diverge, which is why it is an input rather than forked mechanics.

The `/tmp` path is fixed and ticket-keyed rather than `mktemp` for the same reason [`test-preflight.md`](test-preflight.md) §3 gives: shell variables do not survive across `Bash` tool calls, so a random path could not be reconstructed. Residue from a prior same-ticket run is overwritten by this step's write — the crash-resume rule, not a new keying scheme.

### Step 6 — Config presence

The PostToolUse validation hook locates `claudedocs/tickets/config.yaml` by walking **up** from the edited file (`hooks/validate.sh`), and storage-mode detection reads the same file. A worktree that no ancestor chain reaches would silently lose per-edit validation, and in server-native mode would misdetect fs-native.

Walk up from `<wt-path>` looking for `claudedocs/tickets/config.yaml`:

- **Found anywhere on the chain** → nothing to do. This is the normal case for a multi-repo workspace, where the worktrees sit under the workspace root alongside the repos and the walk-up reaches the workspace-level file; it is also the case for a repo that tracks `claudedocs/`, whose copy came along with the branch.
- **Not found, and `<repo-root>/claudedocs/tickets/config.yaml` exists** → copy it to `<wt-path>/claudedocs/tickets/config.yaml`. Conditional on purpose: an unconditional copy would overwrite a tracked file and dirty the worktree's tree.
- **Not found, and there is no source to copy** → nothing to do; continue. A missing `config.yaml` is a valid fs-native project — the file is optional, and its absence means fs-native with no `validate:`/`test:`/`git:`/`worktree:` config (per [`../../flow/references/storage.md`](../../flow/references/storage.md) §Mode detection) — and §1 already keeps such a project eligible. Copying a source that does not exist would fail provisioning and strand a freshly-created worktree over a configuration that is explicitly supported.

**Server-native only** — the no-source no-op above is fs-native's affordance and never server-native's: a run in this mode reached this point *because* a `config.yaml` declared `mode: server-native`, so "no source to copy" cannot arise, and an unreachable marker stays a hard stop. After the check above, assert the resolved `config.yaml` declares both `mode: server-native` and `project:` (the detection contract in [`../../flow/references/storage.md`](../../flow/references/storage.md) §Mode detection). Without them, detection resolves fs-native (missing file → fs-native) and the work stalls at bare-ID ticket resolution — a silent misdetection where the storage doctrine prescribes a loud failure. Assertion fails → stop with an error naming the fix: list `claudedocs/tickets/config.yaml` in `.worktreeinclude` so step 4 carries a marked copy.

---

## §3 Path binding — the site checklist

Once a worktree is bound, every command must be aimed explicitly. A missed site does not error; it silently diffs, commits, or serves the **wrong tree**. Enumerated rather than summarized so it can be audited site by site.

### Runs in the worktree — `git -C "<wt-path>"` or `cd "<wt-path>" && …`

| Site | Where |
|---|---|
| Lint / typecheck after each change | build SKILL.md, implement checkpoint |
| Triviality short-circuit `git diff --shortstat <base>...HEAD` | build SKILL.md, review checkpoint pre-check |
| Base detection + branch-scope `git diff` + unstaged `git diff` | build SKILL.md, review checkpoint step a |
| `git check-ignore -q claudedocs`, `git add -A`, `git reset -q -- claudedocs/` | [`commit.md`](commit.md) §1 |
| `git check-ignore -q <test.auth.storage_state>` session-state backstop | [`commit.md`](commit.md) §1 |
| `git commit -F <message-file>` — the **git half only**; the message file itself is a `/tmp` or scratchpad path | [`commit.md`](commit.md) §2, [`pr-creation.md`](pr-creation.md) §3 |
| `git fetch origin`, base resolution | [`pr-creation.md`](pr-creation.md) §1 |
| `git push -u origin "<branch>"` | [`pr-creation.md`](pr-creation.md) §4 |
| `gh pr create` — `gh` infers the repository from the working directory | [`pr-creation.md`](pr-creation.md) §4 |
| `gh pr view` / `gh pr list` / `git fetch` / `git symbolic-ref` / `git merge-base --is-ancestor` | [`pr-creation.md`](pr-creation.md) Merge predicate |
| `test.start` boot — so the server runs against the worktree's own dependencies | [`test-preflight.md`](test-preflight.md) §3 |
| `worktree.setup` | §2 step 5 above |
| **Reviewer subagent prompts** — the shared base's "Project root path" | build SKILL.md, review checkpoint step b |
| **`ui-tester` spawn prompt** — its working directory, and the target directory for any codified spec file | build SKILL.md, test checkpoint step b |

The two subagent rows are the ones a `Bash`-only audit misses. A reviewer handed the right diff and a main-checkout root reads files that do not contain the change and reports confident false findings; `ui-tester` is the one *mutating* agent, so an unbound working directory writes its codified spec outside the branch — into a tree the commit never stages, while teardown removes the tree that mattered. `parallel-walk.md` §4 solves the same problem with an explicit Workdir line per code-touching hop.

`git add -A` deserves particular care: it stages from the **repository root** regardless of the working directory, so `-C` is what selects the repository, not a cosmetic prefix. Without it the main checkout's tree is staged.

### Stays in the main checkout — absolute paths

| Site | Why |
|---|---|
| Every `<ticket-folder>/0N-*.md` read and write | The worktree's `claudedocs/` is absent (gitignored) or a stale fork-point copy; either way it is not the ticket store. |
| State transitions — folder moves under `claudedocs/tickets/` | Same. |
| The lessons log | Same. |
| `sed -n 's/^id: *//p' "<01-spec.md path>"` and the title read | [`pr-creation.md`](pr-creation.md) §4 — reads the real spec, not a fork-point copy. |
| `gh pr create --body-file "<06-summary.md path>"` | The body is the artifact just written to the main checkout. |

`<ticket-folder>` must therefore be **absolute** for the whole run, and stay bound across every state transition that moves the folder. In server-native mode this whole column is moot — artifacts are rows and `<ticket-folder>` is a session scratchpad — but §2 step 5's assertion still applies.

### Needs no binding

The PostToolUse validation hook. It derives its working directory by walking up from the **edited file**, not from an ambient cwd, so edits inside the worktree resolve correctly on their own once §2 step 5 holds.

---

## §4 Teardown

The caller supplies the **trigger** (§0); this section owns the **safety predicate** and the mechanics. The rule is that commits are repository-level: once the work is committed on `<branch>`, the worktree holds nothing the repository does not, so it is disposable. Uncommitted work is never silently orphaned.

**Predicate — remove only when both hold:**

```bash
git -C "<wt-path>" status --porcelain          # must be empty — nothing uncommitted, nothing untracked
git -C "<repo-root>" rev-parse --verify "<branch>"   # must resolve — the branch carries the work
```

A branch confirmed **pushed** satisfies the predicate equally — the work is then on the remote as well.

**Mechanics:**

```bash
git -C "<repo-root>" worktree remove "<wt-path>"
git -C "<repo-root>" worktree prune
```

`--force` is permitted **only** to clear untracked leftovers the predicate already accounted for (dependency directories installed by `worktree.setup`), never to discard unpushed commits. Remove the provisioning script too — `rm -f "/tmp/fp-worktree-setup-<TICKET-ID>.sh"` — mirroring [`test-preflight.md`](test-preflight.md) §4's cleanup of its own launcher.

**Predicate fails** → leave the worktree in place and print its path, so the work is reachable: `Work left in <wt-path> on branch <branch> — commit or push it, then remove the worktree with 'git -C <repo-root> worktree remove <wt-path>'.`

---

## §5 Recovery

Everything resumable lives on the branch and in the ticket folder; the worktree holds none of it.

1. `git -C "<repo-root>" worktree list` — the residue inventory. Every `<repo-dirname>-worktrees/<TICKET-ID>` path is a ticket whose run did not tear down.
2. Triage each: commits present but unpushed → push them (`git -C "<wt-path>" push -u origin "<branch>"`) or discard deliberately; branch pushed → only cleanup remains.
3. `git -C "<repo-root>" worktree remove "<wt-path>"` each stale path, then `git -C "<repo-root>" worktree prune`.

A worktree left deliberately by §4's failed predicate is not residue — it is where the uncommitted work lives.
