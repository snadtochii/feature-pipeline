# The dev server

Authoritative procedure for the app a `deepen:run` tests against: the wrapper scripts every
project command runs through, the port-free check, starting the dev server in the run worktree,
readiness, the files it leaves behind, seam authentication, and stopping it so runtime coverage is
written.

- **Run by the run skill only.** The characterize stage and the verify stage start and stop the
  server; the common abort stops one left running (the run skill's §6). No spawned role starts,
  stops or restarts it — a role uses the server the stage started, through the wrappers.
- **Composes** [inventory.md](inventory.md), whose check round runs the wrappers written here, and
  [worktree.md](worktree.md) §4, whose exclusion list the server's residue joins (§5).

`<WT>`, `<run-id>` and `<state_dir>` are bound as in [worktree.md](worktree.md); `<runs>` below is
`<state_dir>/runs/<run-id>`. Every command is path-bound ([worktree.md](worktree.md) §6).

---

## §1 Scripts

Every profile command reaches a shell only through a script file
([profile.md](../../setup/references/profile.md) §3): each value is class-checked, then written
**verbatim** with `Write`, the `app.prelude` line first when set. The files, all under `<runs>/`:

| File | Written when | Body after the prelude |
| --- | --- | --- |
| `dev.sh` | always | `app.dev` |
| `seed.sh` | `app.seed` set | `app.seed` followed by ` "$@"` |
| `reset.sh` | `app.reset` set | `app.reset` |
| `ready.sh` | `app.ready` is the command form | `app.ready` |
| `auth-<n>.sh` | seam `<n>`'s `auth` is a command | that command |
| `seam-<n>.base` | every seam | seam `<n>`'s `base`, one line, no prelude — data, never executed |
| `check.sh` | `checks.runner` set | the environment block below, then the redacting runner line with `checks.runner` |
| `e2e.sh` | `checks.e2e` set | the environment block below, then the redacting runner line with `checks.e2e` |

`<n>` counts seams from 1 in profile order, the numbering [inventory.md](inventory.md) §3's
environment contract uses. The environment block, one group per live seam (§6):

```bash
export DEEPEN_APP_URL='<app.url>'
DEEPEN_SEAM_<n>_BASE="$(cat '<runs>/seam-<n>.base')"; export DEEPEN_SEAM_<n>_BASE
DEEPEN_SEAM_<n>_AUTH="$(bash '<runs>/auth-<n>.sh')" || exit 3; export DEEPEN_SEAM_<n>_AUTH
```

The `_AUTH` line appears only for a seam whose `auth` is a command. `app.url` is safe inside single
quotes by its class; a seam `base` of kind `cli` may hold any character, so it travels as a file
and is read at invocation. `DEEPEN_CHECK_LOG` is set by whoever invokes the wrapper.

The redacting runner line, `<runner>` being `checks.runner` or `checks.e2e`:

```bash
set -o pipefail
{ <runner> "$@"; } 2>&1 | awk 'BEGIN { for (k in ENVIRON) if (k ~ /^DEEPEN_SEAM_[0-9]+_AUTH$/ && ENVIRON[k] != "") s[k] = ENVIRON[k] } { for (k in s) { o = ""; while ((i = index($0, s[k])) > 0) { o = o substr($0, 1, i - 1) "<" k ">"; $0 = substr($0, i + length(s[k])) } $0 = o $0 } print }'
```

A runner may print a failing request's headers, so every credential value in its output is
replaced, as a literal string, by `<DEEPEN_SEAM_<n>_AUTH>` before anything captures it; `pipefail`
keeps the runner's own exit status. The credential exists only in the environment of the process
the wrapper starts — never in a file, a brief, a report or an agent reply.

**Digests.** The QA role holds `Bash` and runs these wrappers, and `<runs>/` is outside `<WT>`,
where no git check sees a shell write. So right before every QA spawn the stage runs
`shasum -a 256` over every file above and `<runs>/exclusions`, and keeps that output as a tool
result in its own context — never in a file under `<runs>/`, which the role could rewrite along
with the wrapper. After the spawn returns it runs the same command and compares: a difference is a
fence violation ([fence.md](fence.md) §7, "Wrappers unchanged"). A file the stage itself rewrites
between spawns (§6, §5's residue) is simply hashed again before the next spawn.

---

## §2 Port free

```bash
curl -s -o /dev/null --max-time 2 "<app.url>"
```

Exit 0 means something already answers on `app.url` — a server from another checkout would answer
for the run. The stage stops:

```
needs-decision — something already answers on <app.url>
```

with options `retry — check the port again and start the server` and `abort — end the run`.

---

## §3 Start

**Environment**, assembled by the stage for this start only:

- `app.network`, when set, as written.
- `<app.clock>=<now>`, when `app.clock` is set — `<now>` the run's instant per
  [inventory.md](inventory.md) §6: the stage's computed value in characterize, the inventory
  header's `now:` in verify.
- In a **measurement round** only, `app.coverage_env` with its `<dir>` placeholder replaced by
  `<runs>/coverage/<round>` — created empty first. A server started for anything else carries no
  coverage env, so exploration traffic never enters the measurement.

**Launch**, detached from the tool call and in its own process group:

```bash
cd "<WT>" && bash -c 'set -m; runs=$1; log=$2; shift 2
  env "$@" nohup bash "$runs/dev.sh" >"$log" 2>&1 &
  echo "$!"' deepen-dev "<runs>" "<runs>/dev-<round>.log" <assignments>
```

The inner `bash` turns job control on before it forks, so the background job leads a process
group whose id is its pid — the tool call's own shell may not allow `set -m`, and a `set -m` inside
a backgrounded list would run in the child, after the fork. The printed pid is `<pid>`. Write
`pid: <pid>` and `round: <round>` to `<runs>/dev.pid` with `Write`. The assignments are the
class-checked `NAME=value` strings, each passed as one quoted argument, reaching `env` as `"$@"`.

---

## §4 Ready

Poll every 2 seconds, up to 120 seconds:

- **Probe form** `GET /<path> -> <status>` — `curl -s -o /dev/null -w '%{http_code}' --max-time 2`
  against `app.url` with `<path>` appended, until the status matches.
- **Command form** — `cd "<WT>" && bash "<runs>/ready.sh"` until it exits 0.
- **`null`** — until anything answers on `app.url`; the report carries capability row 3's line
  ([profile.md](../../setup/references/profile.md) §6).

While polling, `kill -0 <pid>` failing means `dev` exited early: stop per §7 and abort with
`dev server exited before ready` and the last 50 lines of `dev-<round>.log`.

Not ready within 120 seconds → stop per §7, then:

```
needs-decision — app not ready after 120s — <the probe>
```

with the log tail in the report and options `retry — start the server again` and `abort — end the
run`.

---

## §5 Residue

Right after ready, and again after the stop (§7) of a server no role used — a measurement round's —
read `git -C "<WT>" status --porcelain -z --no-renames --untracked-files=all` NUL-delimited
([fence.md](fence.md) §7), exclusion-list paths aside. The second read catches what a server writes
only on first use — a database created by the first request with its `-wal`/`-shm` files, an
upload directory, a log — before any clean-tree assertion reads the tree:

- **An untracked path** — a cache, a local database, a log the server writes — joins the exclusion
  list in `<runs>/exclusions` ([worktree.md](worktree.md) §4), with the report line
  `dev server residue: <path> — not ignored — add it to the committed ignore file`.
- **A modified tracked path** aborts: the untouched tree is not clean under its own server, so
  every later clean-tree assertion would fail on it.

  ```
  dev server rewrote tracked files on the untouched tree — <paths> — commit the regenerated files on <base>
  ```

A path the server first writes while a QA role is using it cannot be told apart from a write the
role made through a shell, so it is never added to the exclusion list then: the post-return check
([fence.md](fence.md) §7, characterize clause) reports it as a `fence-violation` and the run aborts.
The remedy is the same as for residue — add the path to the committed ignore file on `<base>` —
after which every later run ignores it.

---

## §6 Seam auth

**Reset first.** `app.reset` set → run it once in this round, before the first seam's command:

```bash
( cd "<WT>" && bash "<runs>/reset.sh" )
```

A fresh worktree's data store is empty or absent, and a login command needs the account the
reset provisions; without this step the first auth of every run fails on a store that no fixture
has created yet. Non-zero exit → the report line `reset-before-auth-failed: <exit code>`, and the
seams are still tried. `app.reset` null → nothing runs.

For each seam in order: `auth: none` → live. A command → run it once, output never echoed:

```bash
( cd "<WT>" && out="$(bash "<runs>/auth-<n>.sh" 2>/dev/null)" && [ -n "$out" ] )
```

The subshell's status is the auth command's exit, then the emptiness test, and the output dies with
the subshell. Non-zero exit or empty output → the seam is dropped for this run, with the report line
`seam-auth-failed: seam <n> (<kind>)`, and `check.sh` is rewritten without its group (then the
digests before the next QA spawn, §1). No live seam left → tier 2 is skipped for this run, with capability row 4's line.

---

## §7 Stop and flush

Runtime coverage is written only when the server's Node process exits normally: a process that
dies on a signal it does not handle writes nothing. So the stop asks first, then insists:

1. `kill -TERM -- -<pid>` (the whole group); wait up to 30 seconds for `kill -0 <pid>` to fail.
2. Still alive → `kill -INT -- -<pid>`; wait up to 10 seconds.
3. Still alive → `kill -KILL -- -<pid>`. In a measurement round, the report line
   `coverage lost — dev server did not exit on SIGTERM/SIGINT`.
4. Remove `<runs>/dev.pid`.

SIGTERM leads because it is the signal a dev server's own shutdown handler listens for — Vite's
dev server registers a `SIGTERM` handler that closes the server and exits normally, and no
`SIGINT` handler of its own. A server that handles only `SIGINT` dies on the `SIGTERM`, writes no
coverage, and the round takes the estimate path below.

A `dev.pid` whose process is already gone is removed and the stop is done. Every exit path of a
stage that started a server — complete, needs-decision, abort — runs this first.

A measurement round whose coverage directory is empty after the stop measured nothing; the stage
takes the estimate path with the reason `coverage lost — the dev server exited without writing
coverage` ([coverage.md](coverage.md) §3).
