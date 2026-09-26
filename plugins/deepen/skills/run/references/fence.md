# The write fence

Authoritative contract for the fence that confines every writing role of a `deepen:run` to its
own paths: the fence file, its two roots, the glob grammar, the named sets, how the run derives
and rewrites them, the self-test before every fenced spawn, and what counts as a violation.

- **Written by the run skill only.** The run skill writes the fence file before every fenced
  spawn. No spawned role ever writes or edits the fence file or the hook script, and no role's
  writable set can reach either: the file sits in the clone's git common directory, outside both
  roots, and the hook ships inside the plugin, outside every worktree.
- **Read by `hooks/fence.sh`.** The hook is one plugin-level `PreToolUse` command, bound in
  `hooks/hooks.json` as `${CLAUDE_PLUGIN_ROOT}/hooks/fence.sh` on
  `Write|Edit|MultiEdit|NotebookEdit` — the only binding Claude Code honors for a plugin's agents,
  which ignore `hooks:` in their own frontmatter. A plugin hook fires inside subagents too, with
  the subagent's `agent_type` in the payload, so the script dispatches on it (§3): a `deepen:`
  agent is fenced in its row's `<mode> <set>`, and every other call — the main conversation's, any
  other plugin's agent's — passes untouched. It is a pure decision function over this file: it
  reads the file, decides, and prints a denial or nothing. It never writes.
- **Run by the run skill as the matcher.** The self-test (§6), stage 4's pre-spawn target check
  and the commit-path assertion (§7) pipe payloads to `"<plugin-root>/hooks/fence.sh"`, each
  carrying the role's `agent_type`, so the run's checks go through the same dispatch as a live
  write. The run skill binds `<plugin-root>` once, as the path `${CLAUDE_PLUGIN_ROOT}` resolves
  to — the root `hooks/hooks.json` names. A reference loaded with Read expands no variable, so
  every run-side call uses the bound path, never `${CLAUDE_PLUGIN_ROOT}` or a bare `fence.sh`.
- **Cited by** the run skill's stage 2 ([stage-2-characterize.md](stage-2-characterize.md)), stage 4
  ([stage-4-implement.md](stage-4-implement.md)) and stage 5
  ([stage-5-verify.md](stage-5-verify.md) — verify, and the fix round) bodies,
  and by [worktree.md](worktree.md) for clearing the file. Each cites the section it needs and
  never restates it.

---

## §1 The fence file

**Path.** `<common-dir>/deepen-fence.json`, where

```bash
git -C "<CLONE>" rev-parse --path-format=absolute --git-common-dir
```

binds `<common-dir>` — the directory the run lock lives in
([preflight.md](preflight.md) §2). The fence sits beside the lock so it has the lock's scope:
every worktree of the clone shares one common dir, so one file covers the clone and every run
worktree hanging off it, while a run in a different clone cannot see it. The hook derives the
location from the payload's `cwd` — the spawn's own clone or run worktree — and from the target's
directory only when `cwd` lies in no repository, never from a fixed path of its own. `cwd` comes
first so a write aimed into another clone is judged by this run's fence, whose roots it lies
outside, and is refused.

**Shape.**

```json
{
  "run_id": "<run-id>",
  "repo_root": "<WT>",
  "run_dir": "<state_dir>/inventory-drafts/<run-id>",
  "sets": {
    "implementer": ["…"],
    "specs": ["…"],
    "qa": ["…"],
    "new-specs": ["…"]
  }
}
```

- **`repo_root`** — the run worktree `<WT>` ([worktree.md](worktree.md) §1), absolute, in the
  same spelling every agent brief carries. Containment is textual (§8), so the spelling the agent
  writes to must be the spelling written here.
- **`run_dir`** — `<state_dir>/inventory-drafts/<run-id>`, absolute: the QA role's slot in the
  state layout ([profile.md](../../setup/references/profile.md) §5). It is never
  `<state_dir>/runs/<run-id>/`, which holds the command scripts the run executes, nor
  `<state_dir>/reports/<run-id>/`, which holds the decision record and the stage reports — so no
  fenced role can alter what the run later executes or the record it implements.
- **`sets`** — one entry per row of §3, each a list of globs in §2's grammar.
- **`run_id`** — written for a human reading a file that outlived its run; the hook ignores it.

---

## §2 Roots and globs

**Two roots.** A write is considered only when its normalized absolute target lies under
`repo_root` or under `run_dir`. A write outside both is always refused, in both modes and for
every set. Relative targets are resolved against the payload's `cwd` first.

**Which root a glob speaks for.**

- A glob that begins with `/` is **absolute**: it matches the normalized absolute target path.
  The run writes every `run_dir` entry this way — `<run_dir>/**` with `<run_dir>` expanded.
- Any other glob is **repo-relative**: it matches only a target under `repo_root`, taken relative
  to it. A target under `run_dir` never matches a repo-relative glob.

**Grammar.** Gitignore-style, as the profile's `paths.*` classes allow
([profile.md](../../setup/references/profile.md) §3):

- `{a,b}` brace alternation, nesting-aware, expanded before matching; an unbalanced brace is
  matched as written.
- bash extglob forms (`?(…)`, `*(…)`, `+(…)`, `@(…)`, `!(…)`).
- A leading `./` is stripped from a repo-relative glob.
- A `**` path segment matches zero or more directories, each one independently: every such
  segment is either kept or dropped, so `**/tests/**/*.ts` matches `tests/root.ts`,
  `a/tests/root.ts` and `tests/unit/root.ts` alike, and `a/**/b/**/c` matches `a/b/c`.
  [`lib/glob.sh`](../../../lib/glob.sh) is the one implementation — `hooks/fence.sh` and
  [`hotspots.sh`](../scripts/hotspots.sh) both source it, and its `--self-test` pins these cases
  under both case settings, and the literal-path escape §4 writes for the `new-specs` set.
- `*` spans `/`. Over-matching is the tolerable direction for a fence: a spurious denial is loud,
  a spurious allowance is silent.
- Under `deny-match` a glob matches case-insensitively, for the same reason; under `allow-only` it
  matches case-sensitively. The root test is always an exact prefix.

**Modes.** Both modes govern writes only — `Write`, `Edit`, `MultiEdit`, `NotebookEdit`.

- `deny-match` — a write whose target matches the named set is refused.
- `allow-only` — a write whose target does not match the named set is refused.

**Fails open for reads, closed for writes.** No fence file, no `jq`, no repository to locate it
from, a missing or empty set, `repo_root` or `run_dir` absent, or a malformed binding (an unknown
mode, a set name outside `[a-z][a-z0-9-]*`) → a read is allowed and a write is refused. A fence
that cannot tell what it governs refuses to be worked behind.

**Denial.** A refusal is `hookSpecificOutput.permissionDecision: "deny"` with a reason, printed
on stdout, and exit 0. The hook never blocks by exit code.

---

## §3 Sets

The fixed table of set names, modes and the agent each binds. `fence.sh` carries the same rows
as its `FENCE_MAP` — `<agent> <mode> <set>`, `<agent>` the name after `deepen:` — and dispatches
on the payload's `agent_type`: `deepen:<agent>`, or `plugin:deepen:<agent>` with the `plugin:`
stripped. A `deepen:` agent with no row has every write refused; an `agent_type` outside the
`deepen:` namespace, or none, is not governed at all. `scripts/check-deepen-contract.sh` holds
this table and the map in lockstep, and requires a row for every deepen agent that can write.

| Set | Mode | Bound by | Contents |
| --- | --- | --- | --- |
| `implementer` | `deny-match` | `deepen:implementer` | `<inventory>**`, every `paths.specs` glob, `.deepen.yaml`, every `paths.forbidden` glob, `<run_dir>/**` |
| `specs` | `allow-only` | `deepen:spec-mover` | every `paths.specs` glob |
| `qa` | `allow-only` | `deepen:qa-characterizer` (stage 2 characterize, stage 5 verify) | characterize: `<inventory><slug>/**` and `<run_dir>/**`; verify: `<run_dir>/**` alone |
| `new-specs` | `allow-only` | `deepen:spec-author` | each path the decision record's `New specs` section declares, as a literal glob (§4) |

- **`implementer`** — everything the change is judged against, plus the QA directory. The
  implementer changes the source until the checks pass as written; it can never touch the checks.
  `.deepen.yaml` is in the set even when `paths.forbidden` is empty. `<run_dir>/**` is in it
  because `deny-match` allows every path outside the set, and `run_dir` is the second root: without
  the entry the implementer could write the QA drafts that stage 5 verifies the change against.
- **`specs`** — the spec-mover writes spec files and nothing else. An empty `paths.specs` leaves
  this set empty, and the spec-mover is then skipped, never spawned (§5).
- **`qa`** — one binding serves both QA modes; the run writes the mode's contents before each QA
  spawn. In verify mode the set holds `<run_dir>/**` alone, so verification can never touch the
  oracle it verifies.
- **`new-specs`** — the spec-author writes exactly the new spec files the decision record
  declares. The set is never all of `paths.specs`, so it cannot reach an existing spec. A
  `New specs` section of `none` leaves it empty, and the spec-author is then skipped, never
  spawned (§5).

Set names match `[a-z][a-z0-9-]*`.

---

## §4 Derivation

Every set except `new-specs` is derived from the profile as re-read by
[preflight.md](preflight.md) §4 — never the copy read before the clone moved. `new-specs` is
derived from the decision record.

- `paths.inventory` (`dir/`, trailing slash guaranteed by its class) → the repo-relative glob
  `dir/**`, written `<inventory>**` in §3; with the run's `<slug>`
  ([candidates.md](candidates.md) §6 — `[a-z0-9-]` characters only, so no glob syntax) the repo-relative
  glob `dir/<slug>/**`, written `<inventory><slug>/**`.
- `paths.specs` and `paths.forbidden` globs → copied verbatim. They are already class-checked,
  repo-relative, with no leading `/` and no `..` segment
  ([profile.md](../../setup/references/profile.md) §3).
- `.deepen.yaml` → the literal repo-relative path.
- `<run_dir>/**` → the absolute glob, `run_dir` expanded as in §1.
- The decision record's `New specs` section ([decision-record.md](decision-record.md) §2,
  section 12) → each path as a literal repo-relative glob. Each `[`, `]`, `(`, `)`, `@` and `+`
  in the path is written as a one-character bracket expression — `[[]`, `[]]`, `[(]`, `[)]`,
  `[@]`, `[+]` — so the glob matches exactly the declared path and nothing else:
  `app/[id]/x.test.ts` → `app/[[]id[]]/x.test.ts`. Written verbatim, `[id]` would match `i` or
  `d` and never itself, and `@(x)` would match `x` — another, possibly existing, spec. The
  spec-path class the decide stage checks the paths against
  ([decision-record.md](decision-record.md) §3) admits no `*`, `?`, `{`, `}` or `!`, so no other
  character needs escaping. The record lives in `<state_dir>/reports/<run-id>/`, outside every
  fenced role's write set (§1). A shell write outside `<WT>` still passes the fence unseen (§8),
  so the implement stage digests the record at its pre-spawn target check and checks the digest
  before it derives this set and after the spec-author returns
  ([stage-4-implement.md](stage-4-implement.md) §2, §4 step 4a).

Nothing else enters a set: no project fact lives in the plugin, and no set is widened for a
convenience. The decision record is the one source outside the profile.

---

## §5 The per-spawn rewrite rule

Before **every** fenced spawn — implementer, spec-mover, spec-author or QA, first attempt or
retry — the run skill:

1. Writes the whole file with `Write`: `run_id`, `repo_root`, `run_dir`, and all four sets. The
   `qa` set is written in characterize form only when the next spawn is a characterize-mode QA
   spawn; every other spawn sees it in verify form — least privilege by default. The characterize
  form reaches this run's own inventory folder only, so an earlier run's kept net under
  `<inventory>` stays unwritable. The `new-specs` set holds the declared paths (§4) only when the
  next spawn is the spec-author, or when the write is stage 4's pre-spawn target check
  ([stage-4-implement.md](stage-4-implement.md) §2); every other write holds it empty, and the
  stage 2 writes, before any record exists, always do.
2. Refuses to write a set that is empty for the role about to be spawned. An empty set in
   `allow-only` mode denies every write, which is a fence that cannot be worked behind. For
   `specs`, an empty `paths.specs` means the spec-mover is skipped with a report line, not
   spawned. For `new-specs`, a `New specs` section of `none` means the spec-author is skipped
   with a report line, not spawned.
3. Records the file's digest: `shasum -a 256 "<common-dir>/deepen-fence.json"`.
4. Runs the self-test (§6). A failure aborts before the spawn.
5. After the spawn returns, re-hashes the file. A different digest is a violation (§7) — a role
   rewrote the fence through a shell.

The file is cleared on every abort and at teardown ([worktree.md](worktree.md) §7 and §8). A fence
file in a clone whose lock is free is residue.

---

## §6 Self-test before each spawn

Every documented failure mode of a command hook fails **open** and looks identical to a healthy
run from the outside, so the fence is never assumed live. Before each fenced spawn:

1. `jq` is on `PATH`. Without it the hook refuses every write, so the run aborts naming it
   rather than spawning a role that cannot write.
2. `<plugin-root>/hooks/fence.sh` exists and is executable — the script `hooks/hooks.json`
   names through `${CLAUDE_PLUGIN_ROOT}`.
3. Build a `PreToolUse` payload with `jq -n` — `agent_type` the spawn's own agent
   (`deepen:<agent>`, §3), `tool_name: "Write"`, `tool_input.file_path` the probe path as the
   absolute `<WT>/<path>`, `cwd` = `<WT>` — and pipe it to the script.
   Two probes per spawn, one in each direction, so a fence that denies everything cannot pass:
   one must print `permissionDecision: "deny"`, the other must print nothing.

| Spawn | Must be denied | Must be allowed |
| --- | --- | --- |
| implementer (`deepen:implementer`, `deny-match implementer`) | a real inventory file, and a real spec file | a real tracked source file matching no set |
| spec-mover (`deepen:spec-mover`, `allow-only specs`) | a real tracked source file, and a real inventory file | a real spec file |
| QA (`deepen:qa-characterizer`, `allow-only qa`) | a real tracked source file; in verify mode also a real inventory file; in characterize mode also a real inventory file outside `<inventory><slug>/`, when one exists | `<run_dir>/fence-probe`; in characterize mode also `<inventory><slug>/fence-probe` |
| spec-author (`deepen:spec-author`, `allow-only new-specs`) | a real tracked source file, a real inventory file, and a real spec file | every declared path, as the literal `<WT>/<path>` |

**Probe paths are real files** from `git -C "<WT>" ls-files -z`, read per §7's path-set rule, never a glob's own text and never a
path invented to look like one: a probe built from a glob can match it trivially while no real
file does. Two kinds of path are the exception, and they are only named in a payload; nothing is
written to either. The two `fence-probe` paths are one — the inventory may not exist yet, and
`run_dir` holds no tracked files. The spec-author's declared paths are the other — absent by
construction, since each was absent at `<BASE_SHA>` ([decision-record.md](decision-record.md)
§3); the probe is the literal path while the set holds its escaped glob (§4), so the allowed
probe tests the escaping itself.

- Non-empty `paths.specs` globs that select zero tracked files → abort. A glob set that selects no
  file cannot fence anything, and this is where a spelling the matcher cannot handle surfaces.
- Empty `paths.specs` → the spec probes are skipped, with a report line.
- The inventory is the oracle every set protects, so each spawn that must not write it probes a
  real inventory file for its denial. No real inventory file exists yet only before the first
  characterize spawn, which is the one spawn allowed to write it; the implementer, the
  spec-mover, the spec-author and a verify-mode QA spawn all run after the inventory commit, so a
  missing inventory file for one of them aborts.
- A missing fence file at this point is the run skill's own bug and aborts.

**What it does not prove.** It proves the script is present, runnable, dispatches the spawn's
`agent_type` to its row, and decides as it should in that row's mode. It does not prove the
binding fires: whether Claude Code loaded `hooks/hooks.json`, and spells the spawn's `agent_type`
as §3 expects, cannot be observed from outside a spawn. §7's assertions close that gap, and they
are mandatory for that reason.

---

## §7 Violations

A **fence violation** is a write that landed outside the role's allowed set.

**Path sets are read NUL-delimited.** Every git command that lists paths for the fence — here, in
§6, in [stage-2-characterize.md](stage-2-characterize.md), [stage-4-implement.md](stage-4-implement.md),
[worktree.md](worktree.md) and [dev-server.md](dev-server.md) — runs with
`-z`, and its output is read one path at a time with `while IFS= read -r -d '' p; do …; done`.
Without `-z`, git C-quotes a path holding a non-ASCII or control byte (`core.quotePath`), so
`inv/é.md` arrives as `"inv/\303\251.md"`; a quoted path matches no glob, and under `deny-match`
it would be allowed. A `status --porcelain -z` record is `XY <path>`, so its path is `${p:3}`, and
`--no-renames` keeps each record to one path. Every path reaches a payload as the absolute
`<WT>/<p>`.

**Untracked paths are listed file by file.** Every `status` read of `<WT>` runs with
`--untracked-files=all`. Without it, git folds a directory holding only untracked files into one
`?? <dir>/` record: that record matches no per-file exclusion-list path, so an excluded copy
under a new directory reads as a violation, fails the clean-tree assertion and blocks teardown;
and a file added inside a directory that was already untracked leaves the record unchanged, so a
before/after snapshot misses the write.

After every agent return — with a commit or without — the run asserts the list below; a
characterize-mode QA return takes the characterize clause after it instead, and a verify-mode QA
return takes the list plus the verify clause:

- **Commit paths** — every path in
  `git -C "<WT>" diff -z --name-only --no-renames "<prev>..HEAD"`, piped through
  `"<plugin-root>/hooks/fence.sh"` as a `Write` payload carrying the role's own `agent_type`
  (§6 shape). Any denial is a violation. Using the
  hook as the matcher keeps one glob implementation: what the fence refuses and what the
  assertion checks can never diverge. `--no-renames` lists a rename's source and destination
  both, so a move out of a fenced path is seen.
- **Clean tree** — `git -C "<WT>" status --porcelain -z --no-renames --untracked-files=all` is empty, the worktree's exclusion list
  ([worktree.md](worktree.md) §4) aside. A write routed through a shell and left unstaged is
  caught here.
- **Ancestry** — `git -C "<WT>" merge-base --is-ancestor "<prev>" HEAD`. An amend or rebase of
  an earlier commit fails it.
- **Inventory commit unchanged** — the first commit after `<BASE_SHA>` is still `<INV_SHA>`.
- **Fence file unchanged** — the digest recorded in §5 step 3.
- **Wrappers unchanged** — for a QA return, the wrapper scripts and the exclusion list hash as
  they did right before the spawn ([dev-server.md](dev-server.md) §1, Digests).
- **No exclusion-list path committed.**

**Characterize clause.** A characterize-mode QA spawn makes no commit by design, runs before any
inventory commit exists, and leaves its files uncommitted for the stage to commit
([stage-2-characterize.md](stage-2-characterize.md) §8). After its return the run asserts:

- **No commit** — `git -C "<WT>" rev-parse HEAD` equals `<prev>`.
- **Every changed path is in the set** — each path of
  `git -C "<WT>" status --porcelain -z --no-renames --untracked-files=all` (`${p:3}`), the
  exclusion list aside, piped through `"<plugin-root>/hooks/fence.sh"` as a `Write` payload with
  `agent_type: "deepen:qa-characterizer"` while the fence file holds the characterize form. Any
  denial is a violation — a source file edited through a shell shows up here.
- **Fence file unchanged** — the digest recorded in §5 step 3.
- **Wrappers unchanged** — as in the list above; this is what keeps the exclusion list, which the
  previous bullet sets aside, from being grown by the role.

The stage's own commit is then asserted by the stage itself: it is the first commit after
`<BASE_SHA>`, every path under `<inventory><slug>/`, the tree clean.

**Verify clause.** A verify-mode QA spawn runs after the change, with the fence file holding the
verify form, and writes only under `<run_dir>/verify-<k>/`. The set allows all of `<run_dir>`, so
this clause is what holds the characterize stage's evidence there — its `characterize.md`,
touched-function list and screenshots — unchanged. After its return the run asserts the list
above, plus:

- **No commit** — `git -C "<WT>" rev-parse HEAD` equals `<prev>`.
- **Stage-2 evidence unchanged** — right before the spawn, `shasum -a 256` over every file of
  `find "<run_dir>" -type f -not -path "<run_dir>/verify-*" -print0`, read per the path-set rule
  above, the digests kept in context and never in a file; after the return, the same again. A file
  added, removed or changed →
  `fence-violation: qa-characterizer — stage-2 evidence changed — <paths>`.

Any failure prints one report line,

```
fence-violation: <role> — <assertion> — <paths>
```

and fails the run through the abort in [worktree.md](worktree.md) §7. A violation is never
retried.

A write the hook **denied** is the fence working, not a violation. The agent reports its refused
writes in its reply, and the stage records them in its report.

---

## §8 Known limits

- **Reads are not fenced.** Both modes govern writes; a role can read the inventory and the
  specs. The invariant is that what a change is judged against is unwritable by the role that
  makes the change. Rules about what a role may see stay in its brief.
- **Shell writes are not intercepted.** `Bash` redirects, `sed -i` and heredocs pass no
  `PreToolUse` write hook. §7 catches such a write only where git or the digest shows it: a
  changed tracked or untracked-unignored path in `<WT>`, or a rewritten fence file. A shell
  write that git does not report — an ignored path, an exclusion-list path, a file hidden by
  index flags or git config, or a path outside `<WT>` — passes §7 unseen.
- **Containment is textual.** Paths are normalized by collapsing `.` and `..` segments, never by
  resolving symlinks. A root spelled differently from the fence file (`/var` against
  `/private/var` on macOS) reads as outside both roots and is refused loudly. A symlink *inside*
  a root that points elsewhere is judged by its own spelling, so a write through it can land
  where its target's spelling would have been refused.
- **Case.** `deny-match` matches case-insensitively, so a differently cased spelling of a fenced
  path on a case-insensitive filesystem is still refused. `allow-only` matches case-sensitively;
  a differently cased spelling there is refused, the loud direction.
- **The live binding is unobservable** from outside a spawn (§6) — that the plugin hook fired and
  received the `agent_type` §3 names — which is why §7 runs after every return.
