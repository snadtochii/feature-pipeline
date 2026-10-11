# Driver Pass

Canonical logic for a test pass whose `test:` entry declares `driver`. Read when a selected entry declares `driver` — a pass without it runs [`test-preflight.md`](test-preflight.md) §1–§6 as written and never needs this file. Referenced by the close stage's test checkpoint, ship's end-of-run pass ([`ui-verification.md`](../../ship/references/ui-verification.md)) and ship's driver decision ([`driver-decision.md`](../../ship/references/driver-decision.md)). Every §N in this file is a section of [`test-preflight.md`](test-preflight.md).

An entry that declares `driver` is a **driver pass**: the close stage's test checkpoint drives it through the installed browser driver instead of the browser MCP tools, and the rules below take the place of the pre-flight's §3 boot, §4 teardown and §5 recipe for that pass, while §1, §2 and §6 apply as written. An entry without `driver` runs §1–§6 exactly as written. Each pass takes its path from its own entry, so driver and MCP passes can mix in one multi-pass run, and each pass's spawn prompt carries only its own block. Ship's end-of-run pass applies this reference per pass, with the substitutions its own reference states.

- **Value** — `browser-cli` is the one recognized value. Any other value is the pass's [driver-unavailable result](#skip-artifact-browser-driver-unavailable), naming the value.
- **Driver location** — read the home directory once per checkpoint with `printenv HOME`. The value must be an absolute path holding no `'`; an empty, relative or quoted value, or a failed call, is the driver-unavailable result. Then `<driver>` is `<home>/.feature-pipeline/verify/cli.mjs` and `<contract>` is `<home>/.feature-pipeline/verify/CONTRACT.md` — the copy the `verify` plugin installs at `~/.feature-pipeline/verify/`, the only driver location this pipeline names. Every driver call is written `node '<driver>' <verb> …`, the validated path single-quoted in place and never held in a shell variable, so a Bash allow rule for that exact prefix matches it; every session id and path is single-quoted, as §2 holds the URL.
- **Feature map** — `feature_map` names the project's feature map, a path relative to the entry's base. It is valid when it matches `^[A-Za-z0-9._/-]+\.md$`, is relative, has no empty, `.` or `..` segment, and does not lie under `.git/` or `claudedocs/`. It resolves against the launch directory ([Launch directory and path base](test-preflight.md#launch-directory-and-path-base)) — `<wt-path>/<feature_map>` with a worktree bound — because the map describes the code being served, where `auth.storage_state` deliberately stays on the main checkout. With a worktree bound and no file there, the main checkout's copy is used — the entry's repository root, or the project root for the flat block, the root `verify:setup` writes the map under — so a map not yet on the worktree's base branch still reaches the tester. The resolved file is checked with `Glob`. An absent key, an invalid value or a missing file is never a skip: the driver block reads `Feature map: none (<reason>)`, and `05-tests.md` carries a `## Caveat` line naming the reason.
- **Per-pass files** — fixed paths keyed by `<pass-key>`, as §3's are, so separate `Bash` calls reconstruct them literally. They live in `<pass-dir>`, which is `<home>/.feature-pipeline/close-stage/<pass-key>/`: a user-owned directory with mode 0700, kept out of the shared `/tmp` because its files carry a command the driver runs and steps it executes in a possibly authenticated session. `<home>/.feature-pipeline/close-stage/` is the pre-flight's scratch directory — the close stage's and ship's end-of-run pass's — not a driver location. Lifecycle step 4 creates `<pass-dir>` and the driver teardown removes it.
  - `<pass-dir>/entry.json` — the entry file, written with `Write`.
  - `<pass-dir>/session` — the session id alone, written with `Write` and checked against `^[a-f0-9]{12}$` on every read.
  - `<pass-dir>/steps/` — `<step-dir>`, the one directory the tester writes step files into; its own `Write` creates it.
- **Quoted paths** — every path a driver shell line or the driver block single-quotes is built from the home directory, `<pass-key>`, or the pass's evidence home. `<pass-key>` is checked before lifecycle step 1, since `<pass-dir>` reaches `rm -rf`: it must match `^[A-Za-z0-9._-]+$` and be neither `.` nor `..`, so `<pass-dir>` is one segment below `<home>/.feature-pipeline/close-stage/` and holds no `'`. The evidence home is checked as the home directory is, before lifecycle step 3: it must be an absolute path holding no `'`. A value that fails its check is the driver-unavailable result, naming it, and nothing under `<pass-dir>` is touched.

## Driver lifecycle

In order, for a driver pass:

1. **Leftover session** — a session file for this `<pass-key>`, left by an interrupted run → run the [driver teardown](#driver-teardown) first.
2. **§1 and §2 as written**, the duplicate-URL guard included. No URL resolved, or unreachable with no `test.start` → §6, and nothing is launched.
3. **Environment check** — `node '<driver>' doctor`, with no session. A non-zero exit, or `ok: false` → driver-unavailable, naming each failing field (`install_missing` or `chrome_missing` true, `node_ok` false, `version_lag` true) or the error.
4. **Pass directory and entry file** — create `<pass-dir>` fresh in one `Bash` call, holding it as data:

   ```bash
   d='<pass-dir>'                                   # literal data value — never pasted into a command position
   rm -rf "$d" && mkdir -p "${d%/*}" && mkdir -m 700 "$d" \
     && [ -d "$d" ] && [ ! -L "$d" ] && [ -O "$d" ] && echo ok
   ```

   No `ok` → driver-unavailable, naming the pass directory. Then `Write` one JSON object to the entry file, its values as JSON strings and numbers:
   - `url` — the §1-resolved URL.
   - `start` and `cwd` — `test.start` and the absolute launch directory, when `test.start` is set and the launch directory exists. A missing launch directory leaves both out, so the driver boots nothing — §3's "boots nothing" case.
   - `start_timeout` — §3's validated integer, when `start` is written.
   - `auth` — `{"storage_state": "<absolute path>"}`, the path resolved as §5 resolves it, when the key is declared and `Glob` finds the file. A declared file that is missing is left out: print one line saying the session runs unauthenticated, and `05-tests.md` carries the same line under `## Caveat`. `auth.attach_tab` is never written — the driver has no tab attach.

   The `test.start` command reaches the driver only as content of this file, never as part of a command line.
5. **Launch** — `node '<driver>' launch --entry '<pass-dir>/entry.json'`, its shell call given a timeout of at least `(<start_timeout> + 60)` seconds — the runtime reference's Tool results section names the parameter:
   - Exit 0 → check `session` against `^[a-f0-9]{12}$` and `Write` it to the session file. A non-empty `stale_sessions` → one printed line naming them; they are never touched.
   - Exit 1 with an error beginning `app unreachable` → §6, its reason "No test.start declared." when no `start` was written, else "test.start was booted but did not respond within the <start_timeout>s poll ceiling."
   - Any other exit → driver-unavailable, naming the error's first line; a quoted `server.log` or `chrome.log` tail stays out of `05-tests.md`. Exit 2 is a defect in the entry file the close stage wrote.
   - A failed `launch` has already torn down whatever it started, so no session file is written.
6. **Session check** — `node '<driver>' doctor --session '<id>'`. A non-zero exit, or `cdp_reachable` or `url_reachable` false → the driver teardown, then driver-unavailable naming the field. `auth` `expired` or `unreadable` → the unauthenticated line under `## Caveat`, and the pass continues.
7. **Worktree caveat** — with a worktree bound, the close stage's fixed-port caveat applies unchanged: a `launch` reporting `server: already-running` booted nothing, exactly as §2's `curl` answering does.

A pass that clears step 6 composes the [driver block](#driver-block) and spawns `ui-tester`.

**Fix-loop reuse.** The pass that ran last keeps its session into the close stage's fix loop for as long as the next pass the loop re-verifies is that same pass. Before any other pass's pre-flight starts, the kept session's driver teardown runs, so that pre-flight never finds this pass's app ([Entry selection](test-preflight.md#entry-selection), Sequential passes). Before each re-spawn of the pass whose session is kept, run `node '<driver>' doctor --session '<id>'`: `cdp_reachable` and `url_reachable` both true → the session is reused, so an expired `auth` alone never relaunches, and `rm -rf '<step-dir>'` runs before the spawn, so the fresh tester's `Write` never meets a step file it has not read. Otherwise run the driver teardown and this lifecycle again from step 1. A pass whose session was torn down launches anew, and the session still kept when the fix loop ends is torn down then.

## Driver teardown

Runs for a driver pass at the close stage's teardown step — **even if the checkpoint errored** — after a failed session check, for a leftover session, and for a kept session before another pass's pre-flight ([Fix-loop reuse](#driver-lifecycle)). One `Bash` call, with a timeout of at least 60 seconds, reconstructing the fixed paths literally:

```bash
d='<pass-dir>'                                            # same literal path the lifecycle created
if [ -f "$d/session" ]; then
  id=$(cat "$d/session")
  if printf '%s\n' "$id" | grep -Eq '^[a-f0-9]{12}$'; then
    node '<driver>' cleanup --session "$id"                # <driver> is the validated literal path, quoted in place
  fi
fi
rm -rf "$d"
```

Best-effort: a `cleanup` that exits non-zero or reports `ok: false` gets one printed line advising `node '<driver>' cleanup --session '<id>'`. `cleanup --all` is never run — it also stops every other session this user owns, a concurrent run's included.

## Driver block

What the close stage injects on a driver pass in place of §5's recipe, every placeholder resolved to a concrete value:

```
## Browser driver (use this instead of the browser MCP tools)

- Driver: `node '<driver>'`. Read `<contract>` §7 (the step file) and §11 (screenshot names) before writing a step file.
- Session: `<id>`, serving <url>, starting viewport 1280×800, <signed in from the declared storage state | unauthenticated>. The pre-flight owns this session: never launch, clean up or install.
- Step files: write them in `<step-dir>/` and nowhere else.
- Run: `node '<driver>' drive --session '<id>' --steps '<step-dir>/<file>.json' --evidence '<evidence-home>'`, with a shell timeout of <the runtime's drive timeout>. The only other verbs allowed are `node '<driver>' evidence --session '<id>'` and `node '<driver>' doctor --session '<id>'`.
- Feature map: <`<absolute map path>` — read it first to plan navigation. Each `## <name>` section is one live feature: its `route:` line says where to navigate, its `testids:` line names targets, and the block between `<!-- manual -->` and `<!-- /manual -->` says how a person reaches the screen and what it needs. A `## Removed` heading and everything after it is not live. | none (<reason>).>
- Required UI checks: ui-checks.md §2–§3 above name the MCP resize and capture tools. In this session a resize is a `viewport` step — 1280×800 desktop, 390×844 mobile — and a capture is a `screenshot` step whose `name` is the §3 file name, written into the evidence home by `--evidence`; captures are full-page. Confirm suspected clipping by reading the PNG and with `expect` steps; there is no snapshot verb.
- Mechanics: after every `goto`, `wait` on text the page renders before asserting or capturing. The viewport persists across `drive` calls, so set 1280×800 before every desktop capture — the driver refuses a `-desktop` name at any other width and a `-mobile` name at any width but 390. Console errors, failed requests and auto-accepted dialogs come back in each `drive` result; use them for the console check. A `drive` exit 1 → run `doctor --session`; if the session is gone, report the remaining criteria as not verified.
```

## Skip artifact (browser driver unavailable)

When a driver pass cannot run, the close stage writes `<ticket-folder>/05-tests.md` and proceeds to the verdict **without** spawning `ui-tester`, **without** any prompt or hard-pause, and without falling back to the browser MCP tools — a project declares a driver because those tools do not reach its test runs. What the `skipped` label means for the verdict is defined at the close stage's `SKILL.md`, test checkpoint step c:

```
verdict: skipped (browser driver unavailable)

## Reason
The browser driver declared<" (repo <repo>)" — a test.repos pass only> could not run: <cause — the failing doctor fields, the launch error's first line, an unrecognized driver value, or an unusable home directory>.
The ui-tester subagent was not spawned. Browser-level acceptance-criteria verification is deferred.

## Manual steps to verify
1. Run `/verify:setup` to install the driver and check its environment.
2. Re-run `/feature:close-stage <ticket-id>`.

## Acceptance Criteria
- [ ] AC 1 — not-tested (browser driver unavailable)
- [ ] AC 2 — not-tested (browser driver unavailable)
...
```

A run of two or more passes writes this variant only when no pass spawned a tester and at least one ended driver-unavailable: one Reason line per repo, in pass order, each naming its own cause — an unreachable pass's line keeps §6's wording. When every pass ended unreachable, §6's variant applies. When at least one pass ran, a driver-unavailable pass is a per-repo result inside the `05-tests.md` the passes write, not this artifact.

## Boundaries

- **Driver sessions** — a driver pass starts only what its `launch` starts and stops only its own session; `cleanup --all` is never run.
- **bash-3.2 / macOS-default portable** — the pass-directory and teardown snippets use POSIX tests, `printf`, `grep -E` and `rm`; no associative arrays, no `mapfile`.
