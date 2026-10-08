# Test Pre-flight

The close stage uses this reference at its test checkpoint in two places. [Entry selection](#entry-selection) decides which entry or entries the ticket is tested against, and it is decided **before** the skip-detection scan, so its "no testable repo in ticket" skip lands without the scan. §1–§6 then run once per selected entry on the path where a `ui-tester` spawn was about to happen — i.e. **after** the skip-detection scan has decided the plan has UI signals, but **before** the `ui-tester` `Task` call. They run a cheap reachability gate so the browser subagent is never spawned against an app that can't be reached, and they hand the agent a declared auth recipe instead of letting it guess. Ship's end-of-run browser pass reuses Entry selection, Multi-pass results and §1–§5 per pass, as [`ui-verification.md`](../../ship/references/ui-verification.md) describes.

`--no-ui-testing` bypasses this reference entirely, Entry selection included. The no-UI-signal skip bypasses §1–§6 — neither resolves a URL, curls, nor boots a `start` command. Pre-flight only runs when a spawn was actually going to happen (this is what keeps the cheap gate ahead of the expensive spawn).

The close stage reads the `test:` block by **model-reading** it from `claudedocs/tickets/config.yaml`, in either of its two forms below; it does **not** shell out to `yq`/`jq`.

## The `test:` block (all keys optional)

**Single-repo form** — the flat block:

```yaml
test:
  url: http://localhost:4200          # pre-flight curls this
  start: "npm start"                  # run (backgrounded) only if url is down
  start_timeout: 60                   # seconds the start poll waits (default 60, max 540)
  auth:
    storage_state: .auth/admin.json   # Playwright saved session — gitignored, never committed
    attach_tab: true                  # fallback: attach to a running authenticated tab
  driver: browser-cli                 # drive through the installed browser driver, not the browser MCP tools
  feature_map: docs/verification/feature-map.md   # the project's feature map, read by the tester under a driver
```

Absent block, or any absent key → that part of the gate degrades to today's behavior (URL discovery falls through to the CLAUDE.md → port-probe path; no `start` boot; the agent's own auth fallback applies). Backward compatibility is the absence of every key.

**Multi-repo form** — one `test.repos.<dir-name>` entry per repository the workspace tests:

```yaml
test:
  repos:
    big-leaves-admin:
      url: http://localhost:4200
      start: "exec npx ng serve --port 4200"
      start_timeout: 240
      auth:
        attach_tab: true
    big-leaves-astro:
      url: http://localhost:4321
      start: "npm run dev"
      driver: browser-cli
      feature_map: docs/verification/feature-map.md
```

- **Key** — the repository's exact on-disk directory name under the project root, the same string a ticket's `repos:` frontmatter carries.
- **Entry** — holds the flat block's keys (`url`, `start`, `start_timeout`, `auth.storage_state`, `auth.attach_tab`, `driver`, `feature_map`), each with the flat key's meaning and limits; `start_timeout` keeps its 1–540 range per entry. An entry is self-contained: it inherits nothing from a flat block beside it or from another entry, and a key it leaves out degrades exactly as the same flat key does when absent.
- **Coexistence** — both forms may appear in one `test:` block. A pass reads exactly one entry — the flat block or one `test.repos` entry — chosen per [Entry selection](#entry-selection); §1–§6 cover what a pass does with the entry it is given. In the sections below, `test.<key>` means that key of the entry the pass reads.

### Launch directory and path base

Two values in an entry are resolved against a root, never against the close stage's current directory:

- **Launch directory** — where `test.start` runs (§3). With a worktree bound for the entry's repository ([`worktree.md`](../../build/references/worktree.md) §3) — a `test.repos` entry whose key equals `<repo-root>`'s directory name, or the flat block in a worktree-bound run — it is `<wt-path>`, so the server runs the worktree's own dependencies. Otherwise a `test.repos` entry launches from its repository's root (`<project-root>/<dir-name>`) and the flat block from the project root (the directory holding `claudedocs/tickets/`, which is the repository itself in a single-repo workspace). A `start` therefore needs no `cd <repo> &&` prefix, and such a prefix breaks under a worktree, whose root has no `<repo>/` subfolder. A `test.repos` key that names no directory under the project root has no launch directory: nothing is booted, and the pass continues as §3's no-`test.start` case.
- **`auth.storage_state` base** — a `test.repos` entry's path is relative to its repository's root, and the flat block's to the project root — the same convention as a repo-relative `.worktreeinclude` pattern. §5 and the commit backstop resolve that one relative path against different trees, on purpose (§5). The backstop's entry is the committed repository's: its `test.repos` entry, keyed by that repository's directory name — `<repo-root>`'s with a worktree bound, never `<wt-path>`'s, whose basename is the ticket ID and matches no entry — else, in a single-repo workspace only, the flat block, whose project root is then the committed repository. The close stage resolves that entry's path inside the tree being committed (`<wt-path>` when bound, else the repository root) and hands it to the finalizer as an absolute path.

### Entry selection

The test checkpoint selects its entries once, from two inputs: the ticket's `repos:` as the close stage binds it ([`storage-fs.md`](storage-fs.md) / [`storage-server.md`](storage-server.md) §2), or as ship's end-of-run pass binds it ([ship's `storage-fs.md`](../../ship/references/storage-fs.md) / [ship's `storage-server.md`](../../ship/references/storage-server.md) §1), and the `test:` block. The flat block is **present** when the `test:` block holds at least one flat key (`url`, `start`, `start_timeout`, `auth`, `driver`, `feature_map`). The first matching row wins:

1. **`test.repos` declared and the ticket has `repos:`** — the selected entries are the ticket's `repos:` values that have a `test.repos` entry, in `repos:` order. Zero → the [no testable repo skip](#skip-artifact-no-testable-repo-in-ticket). One → one pass. Two or more → one pass per entry, run sequentially.
2. **The ticket has no `repos:` and the flat block is present** → the flat block, one pass.
3. **The ticket has no `repos:`, the flat block is absent, and `test.repos` is declared** → the no testable repo skip, its cause being that the ticket declares no `repos:`.
4. **No `test.repos` declared** → the flat block when present, else no entry, which leaves §1 the `CLAUDE.md` → port-probe path. One pass either way.

A `repos:` value matches a key only when the two strings are identical, case included — both are exact on-disk directory names. A `test.repos` key that no `repos:` value names is ignored.

- **Key validation** — a `test.repos` key is config-derived and reaches `/tmp` paths, the launch directory and the evidence-home path, so it is selectable only when it matches `^[A-Za-z0-9._-]+$` and is neither `.` nor `..`. A `repos:` value whose key fails this check is not selected and nothing is booted for it; the skip artifact, or the `05-tests.md` the passes write, names it as `invalid test.repos key <key>`. Wherever a selected key reaches a shell line it is held as data, as §2 holds the URL and §3 the launch directory.
- **Pass key** — `<pass-key>` keys every per-pass `/tmp` file in §3 and §4: `<ticket-id>-<repo>` for a `test.repos` pass, a single match included, and `<ticket-id>` for a flat-block or no-entry pass. A caller that keys its pre-flight on its own stable id substitutes that id for `<ticket-id>`.
- **Sequential passes** — each pass runs §1–§5 against its own entry and finishes its §4 teardown before the next pass's §1, so the next probe never finds the previous pass's app. Passes never boot concurrently.
- **Duplicate-URL guard** — a pass whose §1-resolved URL matches a URL an earlier pass of the same run used, and that URL answers the pass's first probe (§1's port probe or §2's `curl`, before anything is booted), is not booted or spawned. The earlier pass's §4 teardown has already finished, so a server still answering there is one that pass did not start, or a child its launcher left behind — never this repository's code. It is recorded as that repo's unreachable result naming the duplicate URL, with the advice to give its `test.repos.<repo>` entry a `url`, and a `start` that serves it, on a port no other selected entry uses. A matching URL that does not answer is not a duplicate: the pass continues to §3 and boots its own `start`, so entries may share a default port. Two URLs match when they are equal after normalizing: scheme and host lowercased, `localhost`, `127.0.0.1` and `[::1]` read as one host, an omitted port read as the scheme's default, and a trailing `/` dropped from the path. A run with one pass is never affected.

#### Skip artifact (no testable repo in ticket)

When selection finds nothing to test, the close stage writes `<ticket-folder>/05-tests.md` without running the skip-detection scan, booting anything, or spawning `ui-tester`. Ship's end-of-run pass writes no skip artifact; it records the outcome per its own reference. The artifact's first line is the skip label; what the label means for the verdict is defined at the close stage's `SKILL.md`, test checkpoint step c:

```
verdict: skipped (no testable repo in ticket)

## Reason
<"The ticket's repos (<repos values>) have no test.repos entry; configured: <test.repos keys>." | "The ticket declares no repos: and the test: block has no flat entry; configured test.repos: <test.repos keys>."> <"Invalid test.repos key not selected: <key>." — only when a repos: value named one>
Browser verification was not run, and no app was booted.

## Acceptance Criteria
- [ ] AC 1 — not-tested (no testable repo)
- [ ] AC 2 — not-tested (no testable repo)
...
```

### Multi-pass results

A run of two or more passes records every pass in one `05-tests.md`. The consumer's artifact body decides where each section sits; these rules are shared by the close stage and ship's end-of-run pass:

- **Merged criteria** — `## Acceptance Criteria` holds one line per criterion, merged across passes: failed when any pass failed it, passed when some pass passed it and none failed, `not-verified` when no pass covered it (every pass reported it not applicable, or ended without a report).
- **Combined failures** — `## Failed Criteria` combines every pass's failed entries, each carrying a `**Repo**: <repo>` line beside its `**Viewport**` line, and is present only when some pass recorded one.
- **Per-pass record** — one `## Pass: <repo>` section per pass, in pass order: that pass's report minus the failed entries moved up, or the reason the pass ended without a report — its unreachable or duplicate-URL result, or another setup gap.

With one pass, the artifact is the consumer's single-pass body.

### Browser driver

An entry that declares `driver` is a **driver pass**: the close stage's test checkpoint drives it through the installed browser driver instead of the browser MCP tools, and the rules below take the place of §3's boot, §4's teardown and §5's recipe for that pass. An entry without `driver` runs §1–§6 exactly as written. Each pass takes its path from its own entry, so driver and MCP passes can mix in one multi-pass run, and each pass's spawn prompt carries only its own block. Ship's end-of-run pass does not apply this subsection; it drives through the browser MCP tools per its own reference.

- **Value** — `browser-cli` is the one recognized value. Any other value is the pass's [driver-unavailable result](#skip-artifact-browser-driver-unavailable), naming the value.
- **Driver location** — read the home directory once per checkpoint with `printenv HOME`. The value must be an absolute path holding no `'`; an empty, relative or quoted value, or a failed call, is the driver-unavailable result. Then `<driver>` is `<home>/.feature-pipeline/verify/cli.mjs` and `<contract>` is `<home>/.feature-pipeline/verify/CONTRACT.md` — the copy the `verify` plugin installs at `~/.feature-pipeline/verify/`, the only driver location this pipeline names. Every shell line holds `<driver>` as data — `driver='<driver>'`, then `node "$driver" …` — and every session id and path is single-quoted, as §2 holds the URL.
- **Feature map** — `feature_map` names the project's feature map, a path relative to the entry's base. It is valid when it matches `^[A-Za-z0-9._/-]+\.md$`, is relative, has no empty, `.` or `..` segment, and does not lie under `.git/` or `claudedocs/`. It resolves against the launch directory ([Launch directory and path base](#launch-directory-and-path-base)) — `<wt-path>/<feature_map>` with a worktree bound — because the map describes the code being served, where `auth.storage_state` deliberately stays on the main checkout. The resolved file is checked with `Glob`. An absent key, an invalid value or a missing file is never a skip: the driver block reads `Feature map: none (<reason>)`, and `05-tests.md` carries a `## Caveat` line naming the reason.
- **Per-pass files** — fixed paths keyed by `<pass-key>`, as §3's are, so separate `Bash` calls reconstruct them literally. They live in `<pass-dir>`, which is `<home>/.feature-pipeline/close-stage/<pass-key>/`: a user-owned directory with mode 0700, kept out of the shared `/tmp` because its files carry a command the driver runs and steps it executes in a possibly authenticated session. `<home>/.feature-pipeline/close-stage/` is the close stage's own scratch directory, not a driver location. Lifecycle step 4 creates `<pass-dir>` and the driver teardown removes it.
  - `<pass-dir>/entry.json` — the entry file, written with `Write`.
  - `<pass-dir>/session` — the session id alone, written with `Write` and checked against `^[a-f0-9]{12}$` on every read.
  - `<pass-dir>/steps/` — `<step-dir>`, the one directory the tester writes step files into; its own `Write` creates it.
- **Quoted paths** — every path a driver shell line or the driver block single-quotes is built from the home directory, `<pass-key>`, or the pass's evidence home. The evidence home is checked as the home directory is, before lifecycle step 3: it must be an absolute path holding no `'`, and one that does not is the driver-unavailable result, naming it.

#### Driver lifecycle

In order, for a driver pass:

1. **Leftover session** — a session file for this `<pass-key>`, left by an interrupted run → run the [driver teardown](#driver-teardown) first.
2. **§1 and §2 as written**, the duplicate-URL guard included. No URL resolved, or unreachable with no `test.start` → §6, and nothing is launched.
3. **Environment check** — `node "$driver" doctor`, with no session. A non-zero exit, or `ok: false` → driver-unavailable, naming each failing field (`install_missing`, `chrome_missing`, `node_ok`) or the error.
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
5. **Launch** — `node "$driver" launch --entry '<pass-dir>/entry.json'`, its shell call given a timeout of at least `(<start_timeout> + 60)` seconds — the runtime reference's Tool results section names the parameter:
   - Exit 0 → check `session` against `^[a-f0-9]{12}$` and `Write` it to the session file. A non-empty `stale_sessions` → one printed line naming them; they are never touched.
   - Exit 1 with an error beginning `app unreachable` → §6, its reason "No test.start declared." when no `start` was written, else "test.start was booted but did not respond within the <start_timeout>s poll ceiling."
   - Any other exit → driver-unavailable, naming the error's first line; a quoted `server.log` or `chrome.log` tail stays out of `05-tests.md`. Exit 2 is a defect in the entry file the close stage wrote.
   - A failed `launch` has already torn down whatever it started, so no session file is written.
6. **Session check** — `node "$driver" doctor --session '<id>'`. A non-zero exit, or `cdp_reachable` or `url_reachable` false → the driver teardown, then driver-unavailable naming the field. `auth` `expired` or `unreadable` → the unauthenticated line under `## Caveat`, and the pass continues.
7. **Worktree caveat** — with a worktree bound, the close stage's fixed-port caveat applies unchanged: a `launch` reporting `server: already-running` booted nothing, exactly as §2's `curl` answering does.

A pass that clears step 6 composes the [driver block](#driver-block) and spawns `ui-tester`.

**Fix-loop reuse.** The last (or only) pass keeps its session through the close stage's fix loop. Before each re-spawn, run `node "$driver" doctor --session '<id>'`: `cdp_reachable` and `url_reachable` both true → the session is reused, so an expired `auth` alone never relaunches. Otherwise run the driver teardown and this lifecycle again from step 1. An earlier pass of a multi-pass run has already been torn down, so re-verifying it always launches anew.

#### Driver teardown

Runs for a driver pass at the close stage's teardown step — **even if the checkpoint errored** — after a failed session check, and for a leftover session. One `Bash` call, with a timeout of at least 60 seconds, reconstructing the fixed paths literally:

```bash
driver='<driver>'                                         # literal data value — never pasted into a command position
d='<pass-dir>'                                            # same literal path the lifecycle created
if [ -f "$d/session" ]; then
  id=$(cat "$d/session")
  if printf '%s\n' "$id" | grep -Eq '^[a-f0-9]{12}$'; then
    node "$driver" cleanup --session "$id"
  fi
fi
rm -rf "$d"
```

Best-effort: a `cleanup` that exits non-zero or reports `ok: false` gets one printed line advising `node '<driver>' cleanup --session '<id>'`. `cleanup --all` is never run — it also stops every other session this user owns, a concurrent run's included.

#### Driver block

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

#### Skip artifact (browser driver unavailable)

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

## §1 Resolve a candidate URL

In order, first hit wins:

1. `test.url`, if present.
2. Else a URL documented in the project `CLAUDE.md` (e.g. `npm start # http://localhost:4200`).
3. Else **probe** common dev ports — this path resolves by reachability, so it doubles as §2:
   ```bash
   for port in 4200 4321 3000 5173 8080 5000; do
     code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:$port" || echo 000)
     case "$code" in
       200|301|302|401|403) echo "http://localhost:$port"; break ;;
     esac
   done
   ```
   First port returning a reachable status is the resolved-and-reachable URL. None respond → no URL resolved → unreachable (→ §3).

## §2 Reachability check

For a URL resolved via `test.url` or `CLAUDE.md` (the port-probe path already established reachability in §1). **Hold the resolved URL as data** — assign it to `url` as a literal value and reference `"$url"` in every `curl`; never paste the resolved string directly into the `curl … <here>` command position. A URL resolved from `CLAUDE.md` prose is lower-trust than `test.url` (a consumer repo's `CLAUDE.md` is editable by anyone who can open a PR), so treat it as data — mirroring the command-substitution discipline in `pr-creation.md` §4:

```bash
url='<resolved-url>'   # literal data value — never pasted into the curl command position
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || echo 000)
case "$code" in
  200|301|302|401|403) : reachable ;;   # 401/403 = auth-gated but UP — still reachable
  *) : unreachable ;;
esac
```

Reachable status set is `200 301 302 401 403` — this reference is its single source of truth. The gate interprets reachability only; it does **not** infer auth state (a `curl` returns `200` for a client-rendered SPA shell that redirects to login in JS, so auth-gating can't be detected here — that is solved by the recipe handoff in §5, not by this curl).

- **Reachable** → go to §5 (compose recipe) and spawn `ui-tester`.
- **Unreachable** → §3.

## §3 Unreachable handling

- **`test.start` is set** → boot it and poll (bounded). Launch it from the entry's launch directory ([Launch directory and path base](#launch-directory-and-path-base)) — `<wt-path>` when a worktree is bound; that worktree caveat is surfaced by the close stage's test checkpoint. **Fixed-port hazard:** `test.url` is a fixed address — a server already listening there, from another checkout, a previous run, or a long-lived instance serving a different branch, answers §2's `curl`, so this boot never happens and the reachable app may not be the code under test. Use a **fixed path keyed by `<pass-key>`** ([Entry selection](#entry-selection)) (not `mktemp`) so the separate §4 teardown `Bash` call can reconstruct it — shell variables do not persist across `Bash` tool calls, so a random `mktemp` path would be lost and teardown would silently no-op (leaking the server). **Write `test.start` verbatim into a launch script with the `Write` tool** (not a shell heredoc): create `/tmp/fp-test-preflight-<pass-key>.sh` whose entire body is the `test.start` value. Writing it as file content — rather than substituting it into a shell command — means any quotes / `$()` / backticks in the declared command can't break out of quoting or be re-evaluated. `test.start` is the user's own declared command (same trust tier as `worktree.setup`); never put untrusted ticket text (spec title, AC text) in this file. Then launch it from the launch directory and capture the PID via `Bash`. **Hold the launch directory as data**, as §2 holds the URL — it is config-derived, so assign it to `dir` as a literal value and reference `"$dir"`; never paste it into a command position:
  ```bash
  dir='<launch-directory>'                             # literal data value — never pasted into a command position
  PIDFILE="/tmp/fp-test-preflight-<pass-key>.pid"     # fixed path — reconstructable in the §4 teardown call
  if [ -d "$dir" ]; then
    (cd "$dir" && exec nohup bash "/tmp/fp-test-preflight-<pass-key>.sh" >"/tmp/fp-test-preflight-<pass-key>.log" 2>&1) &
    echo $! > "$PIDFILE"
  fi
  ```
  The `cd` runs in a subshell, so the calling shell's working directory is unchanged — a close stage in the main conversation keeps its directory across later calls — and `exec` keeps the subshell's PID, so `$!` is the launcher §4 kills. A missing launch directory boots nothing and writes no PID file: skip the poll and continue as the no-`test.start` case below.
  Then poll the resolved URL on a bounded loop (`<start_timeout>`-second ceiling, default 60 — no unbounded wait). Resolve `<start_timeout>` model-side from `test.start_timeout`: a positive integer from 1 to 540 is used as-is; an absent key uses 60, and any other value (non-integer, zero, negative, above 540) falls back to 60 with a one-line note. Substitute only that validated integer into the command — never the raw value. Give this poll's shell call a timeout of at least `(<start_timeout> + 30)` seconds, so the runtime's default cannot cut the poll short — the runtime reference's Tool results section names the parameter:
  ```bash
  deadline=$((SECONDS + <start_timeout>))
  while [ "$SECONDS" -lt "$deadline" ]; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$url" || echo 000)
    case "$code" in
      200|301|302|401|403) echo "reachable:$code"; break ;;
    esac
    sleep 1
  done
  ```
  - First reachable response → go to §5 and spawn `ui-tester`; the captured PID is marked for §4 teardown.
  - Loop ceiling reached without a reachable response → §4 teardown, then fall through to §6 skip.
- **No `test.start`** (or no URL resolved at all) → §6 skip. No prompt, no hard-pause.

A driver pass launches through the driver instead — [Browser driver](#browser-driver).

## §4 Teardown contract

A dev server **started by pre-flight** (a PID was captured in §3) is torn down after the test checkpoint, **even if the checkpoint errors** and **including the boot-then-timeout path** (the trigger is "pre-flight started a process," not "the app became reachable" — a half-booted, timed-out server must not leak). Because §3 and §4 run in **separate `Bash` calls**, reconstruct the **same fixed path** literally — do not rely on the `$PIDFILE` variable from §3, which does not persist:

```bash
PIDFILE="/tmp/fp-test-preflight-<pass-key>.pid"     # same literal path written in §3
if [ -f "$PIDFILE" ]; then
  pid=$(cat "$PIDFILE")
  kill "$pid" 2>/dev/null || true                    # best-effort; ignore if already exited
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done
  rm -f "$PIDFILE" "/tmp/fp-test-preflight-<pass-key>.sh"
fi
```

The bounded wait (30s) lets a `test.start` that tears its own stack down on the signal (see Boundaries) finish before teardown returns, so the next probe — a later ticket's pre-flight on a multi-ticket ship pass — does not find the old stack still answering the URL. A launcher still alive after the wait is left as is.

A server that was **already running** when pre-flight first probed (no PID captured) is **never** touched. Teardown is best-effort: `kill` of the captured PID may leave orphaned child processes (e.g. a launcher that forks a server) — that is acceptable per the spec's best-effort contract.

A driver pass is torn down by the driver's `cleanup` — [Browser driver](#driver-teardown).

## §5 Compose the auth recipe + resolved URL into the spawn prompt

The close stage composes the recipe into the `ui-tester` spawn prompt (mirrors how the review stage injects the confidence scale verbatim — single source of truth, the `ui-tester` body stays recipe-schema-free). Inject:

- **Resolved URL** — the pre-flight-resolved, reachable URL. The `ui-tester` spawn prompt receives this URL directly; the agent does not re-discover it.
- **`auth.attach_tab`** (when truthy) — instruct the agent to prefer attaching to an already-authenticated same-origin tab.
- **`auth.storage_state`** (when present) — inject the path as an absolute path, resolved from its base ([Launch directory and path base](#launch-directory-and-path-base)) against the **main checkout** — the entry's repository root for a `test.repos` entry, the project root for the flat block — never against `<wt-path>`. The agent loads it with the Playwright MCP `browser_set_storage_state` tool (it restores cookies/localStorage from the file before navigating to the protected route). That tool is additive-optional: on a Playwright MCP version that exposes it, `storage_state` is the first-choice auth path; on older versions the agent falls back to `attach_tab`. The file must sit inside the project/workspace root (Playwright MCP restricts file access to the workspace root unless launched with `--allow-unrestricted-file-access`); the main checkout always does, and a session the agent saves there survives worktree teardown. Inject with it the root the path was resolved against, and instruct the agent to run its write-time gitignore check from that root — `git -C '<root>' check-ignore -q '<absolute path>'` — because its own working directory may be `<wt-path>` or a non-git project root, where the check exits 128 instead of answering; only exit 0 confirms the path is ignored. The commit backstop ([`commit.md`](../../build/references/commit.md) §1) resolves the same relative path inside the tree being committed instead — `<wt-path>` when one is bound — because that is where an un-ignored copy would be staged. The two bases differ on purpose. The `--storage-state` server-launch flag is a session-global alternative, not used here.

The agent consumes this recipe with priority `storage_state → attach_tab → existing fallback (CLAUDE.md hint → ask)`; see `agents/ui-tester.md`.

A driver pass injects the driver block instead of this recipe — [Browser driver](#driver-block).

## §6 Skip artifact (app unreachable)

When unreachable with no `start` (or `start` timed out), write `<ticket-folder>/05-tests.md` and proceed to the verdict **without** spawning `ui-tester`, **without** any mid-loop prompt or hard-pause. What the `skipped` label means for the verdict is defined at the close stage's `SKILL.md`, test checkpoint step c. The skip is recorded in `06-summary.md` / the exit summary (surfaced, not hidden):

```
verdict: skipped (app unreachable)

## Reason
The application<" (repo <repo>)" — a test.repos pass only> could not be reached by the pre-flight gate (resolved URL: <url, or "none — no test.url, no CLAUDE.md URL, no responding dev port">). <"No test.start declared." | "test.start was booted but did not respond within the <start_timeout>s poll ceiling." | "The URL was already used by the <earlier repo> pass and still answered after that pass's teardown.">
The ui-tester subagent was not spawned. Browser-level acceptance-criteria verification is deferred.

## Manual steps to verify
1. Start the app (e.g. `<test.start, or the project's dev command>`).
2. Re-run `/feature:close-stage <ticket-id>` once it is reachable, or declare <"`test.url` / `test.start`" — the flat block | "`url` / `start` on the `test.repos.<repo>` entry" — a test.repos pass> in claudedocs/tickets/config.yaml so the pre-flight can reach (or boot) it next time.

## Acceptance Criteria
- [ ] AC 1 — not-tested (app unreachable)
- [ ] AC 2 — not-tested (app unreachable)
...
```

A run of two or more passes writes this variant only when every pass ended unreachable: one Reason line per repo, in pass order, and step 2 names each repo's entry. When at least one pass ran, an unreachable pass is a per-repo result inside the `05-tests.md` the passes write, not this artifact.

## Boundaries

- **Cheap gate, always first** — a `curl` (and at most a `start` poll bounded by `test.start_timeout`) is always paid before the `ui-tester` spawn; the agent is never spawned against an unreachable, un-bootable app.
- **Boots only what is declared** — the pre-flight starts the declared `test.start` and nothing else. It never builds images, starts compose projects, creates schemas, seeds data or picks a second port. A project that needs an isolated stack declares that stack as its `test.start`, and that `test.start` tears its own stack down when signalled (e.g. `trap 'docker compose -f <file> down' EXIT TERM` before a backgrounded `up` and `wait`) — §4 kills only the launcher PID, and a stack left running keeps answering `test.url`.
- **Driver sessions** — a driver pass starts only what its `launch` starts and stops only its own session; `cleanup --all` is never run.
- **No auth detection** — reachability only; the gate never interprets `401`/`403`/a `200` SPA shell as "auth-gated." Auth-gated-with-no-recipe still spawns the agent (it's reachable), which fails fast and is recorded as a non-blocking skip by the agent's own report.
- **No literal secrets** — `config.yaml` is committed; in every entry, flat or `test.repos`, `auth.storage_state` is a path to a gitignored session file and `auth.attach_tab` is a bool. Credentials are never read from or written into `config.yaml`.
- **Model-read** — the `test:` block, in either form, is consumed by the close stage (this reference + the injected spawn prompt), never by a script.
- **bash-3.2 / macOS-default portable** — `curl`, `nohup`, `$!` PID capture, `kill`, POSIX `while`/`case`; no associative arrays, no `mapfile`, no `setsid` (absent on macOS).
