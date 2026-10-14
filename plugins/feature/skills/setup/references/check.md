# Setup Check

Procedure for `/feature:setup --check`, the read-only doctor: it verifies a configured project against the contracts the stages apply and prints one line per check with its fix. Read only when setup runs with `--check` — the guided run never needs this file. Referenced by setup's [`SKILL.md`](../SKILL.md), which enters it from Process step 1 with `<project-root>` and `<plugin-root>` bound. Two checks take lines from the storage mode's own file — check 2's line and check 3's shape lines — and those live in `§5` and `§6` of the detected mode's file, [`storage-fs.md`](storage-fs.md) / [`storage-server.md`](storage-server.md).

## §1 Rules

- **Read-only end to end.** No project file is written, no server is mutated, and `test.start` is never booted. Two programs run beyond the shell probes, each only when its config is present: check 6's driver `doctor`, when a test entry declares `driver`, and check 8's `node` script, when the config holds a `dispatch:` block in server-native mode. Each reads the local environment and starts nothing of its own. The only files created are check 4's pattern and match lists, in a `mktemp -d` directory that each check 4 run creates and removes on exit, whatever it found.
- **Asks nothing.** No question, no approval, no default taken from silence. The run is the same with a user present and in a headless run.
- **Calls.** One server call: check 2's read-only round-trip, which only the server-native `§5` makes. One network probe per declared test URL: check 3's `curl` of the flat `test.url` and, in an fs-native multi-repo workspace, of the `url` of each `test.repos` entry whose key passes both of check 3's key checks. Two local calls, neither of which makes a network call: check 6's driver `doctor`, when a test entry declares `driver`, and check 8's dispatch probe, when the config holds a `dispatch:` block in server-native mode — `command -v`, `git rev-parse` and a `node` script that reads the dispatch lock and checks the state directory's write permission, creating nothing. Nothing else leaves the machine.
- **Never stops.** A problem is a `FAIL` line with its fix; a check that does not apply or cannot run is a `--` line with the reason; the run always reaches the summary. A probe that errors — `git` absent, `curl` missing — becomes that check's `FAIL` or `--` line.
- **Names only.** A `.worktreeinclude` match is reported by its path. No dotenv-family file or other secret is opened, read or printed.
- **Repo text stays data.** A URL is held in a shell variable (check 3); a pattern reaches `git` through a file (check 4). No value read from the project is pasted into a command position.
- **Calls go out batched, in two messages:**
  1. The `config.yaml` `Read` and one `Bash` probe, run from `<project-root>`, which prints the facts checks 4, 5, 6 and 7 need:
     ```bash
     command -v jq >/dev/null 2>&1 && echo "jq: yes" || echo "jq: no"
     printf 'home: %s\n' "$HOME"
     if [ -e .git ]; then echo "shape: single-repo"; else
       for d in */; do [ -e "${d}.git" ] && echo "repo: ${d%/}"; done
     fi
     if ! command -v git >/dev/null 2>&1; then echo "git: no"
     elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
       git check-ignore -q claudedocs/; echo "claudedocs: $?"
     else echo "claudedocs: not a repository"; fi
     for f in .worktreeinclude */.worktreeinclude; do [ -f "$f" ] && echo "include: $f"; done
     ```
     The shape lines follow setup's workspace-shape predicate ([detection.md](detection.md) §4), which reads `.git` entries alone, independent of the git test. No `repo:` line and no `shape:` line means a single-repo workspace with no `.git` of its own. One or more `repo:` lines is a multi-repo workspace: each named child is a repository, and check 4 runs once per child.
  2. Everything else, built from the first message's results, as parallel calls: the storage file check 1 loads, check 3's URL probes — one call per URL, each held as data — check 2's round-trip, check 4's run for each repository with an `include:` line, check 6's driver `doctor` when a test entry declares `driver`, and check 8's dispatch probe when check 1's file holds a `dispatch:` block and its detected mode is server-native.

  Checks 2 and 6 also look at the session's tool list — which tools are exposed, deferred tools included — a fact in hand, not a call.

## §2 Report

Print one block, the lines in check order, the summary last:

```
## Setup check — <project-root>
ok config: mode fs-native
ok storage: fs-native — local ticket store
FAIL test.url: http://localhost:5173 unreachable (HTTP 000) — start the app, or declare test.start (re-run /feature:setup)
-- .worktreeinclude: none — a fresh worktree gets no gitignored file copied
...
FAIL (1): test.url
```

- **`ok <check>[: <note>]`** — the check passed.
- **`FAIL <check>: <what is wrong> — <the fix>`** — the fix names the config key or the command to change; when the fix is a setup question, it says `re-run /feature:setup`.
- **`-- <check>: <reason>`** — information, or a check that does not apply or could not run. Not counted.
- **Multi-repo** — a per-repository check labels each line `<check> (<repo>)`.
- **Summary** — the final line: `OK: <n> checks`, with `<n>` the `ok` lines, when no line is a `FAIL`; else `FAIL (<n>): <check>, <check>, …`, naming every `FAIL` line. A headless `claude -p` or `codex exec` run has no exit code a skill sets, so this line is the machine-readable result: grep the last line for `^OK:`.

## §3 Checks

In this order. A check marked *needs config* prints `-- <check>: not run — config.yaml not read` when check 1 could not read the file as a mapping.

1. **`config`** — `claudedocs/tickets/config.yaml` present, and the storage mode detected from it per [`../../flow/references/storage.md`](../../flow/references/storage.md) §Mode detection, whose config errors are reported with that contract's substance: the key, the value seen and the fix.
   - Missing → `FAIL config: claudedocs/tickets/config.yaml not found — re-run /feature:setup`.
   - Not a YAML mapping → `FAIL config: not a YAML mapping — fix its syntax by hand; setup never overwrites it`.
   - `mode` other than `fs-native` or `server-native` → `FAIL config: unknown mode '<value>' — set mode to fs-native or server-native, or re-run /feature:setup`.
   - `mode: server-native` with no `project` key → `FAIL config: mode: server-native without a project key — add project: <registry UUID>, or re-run /feature:setup`.
   - Otherwise → `ok config: mode <mode>`, with `(no mode key — the default)` when the key is absent. A `project` that is not a UUID is the other config error of that contract; check 2 reports it, once.

   Then load the file for the detected mode — `fs-native`, which a config with no `mode` key detects as, or `server-native`, including a server-native declaration that failed on its `project` — once, in full: [`storage-fs.md`](storage-fs.md) / [`storage-server.md`](storage-server.md).
2. **`storage`** — *needs config.* Defined by `§5` of the file check 1 loaded. With no file loaded (unknown `mode`) → `-- storage: not run — no storage mode declared (check 1)`.
3. **`test`** — *needs config.* The `test:` block's shape, its `test.repos` keys and every declared URL, in this order. The flat block is present when the block holds at least one flat key (`url`, `start`, `start_timeout`, `auth`, `driver`, `feature_map`).
   - No `test:` block → `-- test.url: no test: block — the test checkpoint discovers a URL itself`, and nothing below runs.
   - **Shape** — the lines `§6` of the file check 1 loaded defines, for the workspace shape the probe's `repo:` lines give. With no file loaded (unknown `mode`), no shape line.
   - **Keys** — each `test.repos` key, in key order, against the close stage's key rule ([test-preflight.md](../../close-stage/references/test-preflight.md), "Entry selection"). A key is report text only; it never reaches a command line.
     - Failing that rule → `FAIL test.repos (<key>): not a valid key — rename it to the repository's exact directory name`. Its `url` is not probed.
     - In a multi-repo workspace, naming no `repo:` child → `FAIL test.repos (<key>): names no repository in the workspace — rename it to the repository's exact directory name`. Its `url` is not probed: such a key has no launch directory ([test-preflight.md](../../close-stage/references/test-preflight.md), "Launch directory and path base"), so nothing could boot it.
   - **Flat `test.url`** — skipped when the block holds `test.repos` and no flat key.
     - No `url` → `-- test.url: not set — the test checkpoint resolves one per test-preflight.md §1`.
     - Otherwise probe it exactly as [`test-preflight.md` §2](../../close-stage/references/test-preflight.md#2-reachability-check) does, the URL held as data, and read the result against that section's reachable status set:
       - reachable → `ok test.url: HTTP <code> at <url>`. The status says something answers; it does not say which app.
       - unreachable, `test.start` set → `ok test.url: boots on demand — not exercised (HTTP <code> at <url>)`.
       - unreachable, no `test.start` → `FAIL test.url: <url> unreachable (HTTP <code>) — start the app, or declare test.start (re-run /feature:setup)`.
   - **Each `test.repos` entry** whose key passes both key checks above, in key order, in an fs-native multi-repo workspace only — the one shape whose tickets carry the `repos:` an entry is selected by. In any other shape no entry is probed: the test checkpoint never reads one, and the `§6` shape line above already reports them. The same probe and status set as the flat `test.url`, with the entry's own `url` and `start`, each line labelled `test.url (<repo>)`:
     - no `url` → `-- test.url (<repo>): not set — the test checkpoint resolves one per test-preflight.md §1`;
     - reachable → `ok test.url (<repo>): HTTP <code> at <url>`;
     - unreachable, the entry's `start` set → `ok test.url (<repo>): boots on demand — not exercised (HTTP <code> at <url>)`;
     - unreachable, no `start` → `FAIL test.url (<repo>): <url> unreachable (HTTP <code>) — start the app, or declare test.repos.<repo>.start (re-run /feature:setup)`.
4. **`.worktreeinclude`** — per repository: `<project-root>` in a single-repo workspace, each `repo:` child in a multi-repo one. Every pattern matches at least one existing file, and every match is gitignored — the gate a fresh worktree's copy relies on ([advanced.md](../../../docs/advanced.md#the-worktreeinclude-file)).
   - `git: no`, or the repository is not a git repository → `-- .worktreeinclude: not a git repository`.
   - No file → `-- .worktreeinclude: none — a fresh worktree gets no gitignored file copied`.
   - Otherwise run, from the repository root, one `Bash` call that reads the file line by line — each pattern stays in a shell variable and reaches `git` through its own file `p<n>`, read with gitignore syntax as `.worktreeinclude` itself is, never through the command line — in a temp directory the call creates and removes on exit:
     ```bash
     tmp=$(mktemp -d) || exit 1; trap 'rm -rf "$tmp"' EXIT
     g() { git -c core.quotePath=false "$@"; }
     g ls-files -d > "$tmp/deleted"
     n=0; neg=0
     while IFS= read -r line || [ -n "$line" ]; do
       case "$line" in *[![:space:]]*) ;; *) continue ;; esac
       case "$line" in '#'*) continue ;; '!'*) neg=$((neg+1)); continue ;; esac
       n=$((n+1)); printf '%s\n' "$line" > "$tmp/p$n"
       c=$(g ls-files -c -o -i --exclude-from="$tmp/p$n" | grep -vxF -f "$tmp/deleted" | tee -a "$tmp/matches" | wc -l | tr -d ' ')
       printf 'p%s: %s\t%s\n' "$n" "$c" "$line"
     done < .worktreeinclude
     echo "negations: $neg"
     if [ -s "$tmp/matches" ]; then
       sort -u "$tmp/matches" > "$tmp/unique"; echo "matches: $(wc -l < "$tmp/unique" | tr -d ' ')"
       g check-ignore --stdin < "$tmp/unique" > "$tmp/ignored"; rc=$?
       if [ "$rc" -gt 1 ]; then echo "check-ignore: error $rc"
       else grep -vxF -f "$tmp/ignored" "$tmp/unique" | sed 's/^/unignored: /'; fi
     fi
     g status --porcelain -- .worktreeinclude ':(glob)**/.gitignore'
     true
     ```
     Each line is kept as written: a leading space is part of a gitignore pattern, and a line of blanks is skipped. Matches are files — tracked, or present untracked — never a collapsed directory and never a tracked file deleted from the working tree. No `p<n>:` line → `-- .worktreeinclude: no positive patterns`. `p<n>: 0` names a pattern that matches nothing, the pattern after the tab. `matches:` counts the distinct matched files. `check-ignore` lists the matches that are ignored, so an `unignored: <path>` line names a match that is not — tracked, untracked and unlisted, or re-included by a `!` rule in a `.gitignore`. `check-ignore: error <rc>` means git could not answer, and the line is `FAIL .worktreeinclude: git check-ignore failed (exit <rc>) — run git check-ignore by hand from <repo>`. A `git status` line names a `.gitignore` or the `.worktreeinclude` with uncommitted changes. One line for the repository:
     - all matched and all ignored → `ok .worktreeinclude: <p> patterns, <m> matches, all gitignored`, noting `<k> negation lines not checked` when `negations:` is not `0`;
     - else → `FAIL .worktreeinclude: <each problem, separated by "; "> — <the fixes>`, where a pattern with no match reads `pattern '<pattern>' matches no file` with the fix `remove the line, or create the file in the main checkout`, and an unignored match reads `<path> is not gitignored` with the fix `add it to .gitignore, and untrack it with git rm --cached if it is committed`.
     - Either line, when `git status` printed any path, ends `; uncommitted: <paths> — commit them before a --worktree run, which reads the base branch's committed .gitignore`. The note alone never turns `ok` into `FAIL`: build's worktree provisioning re-checks each copied file against the worktree's own ignore rules before any commit.

     A multi-repo run issues one such call per repository; each removes only its own temp directory.
5. **`jq`** — the probe's `jq:` line. `yes` → `ok jq`; `no` → `FAIL jq: not on PATH — install jq; setup's detector needs it`.
6. **`playwright` and `driver`** — *needs config.* Checked only when test config exists — a `test:` block holding a flat key or at least one `test.repos` entry — else `-- playwright: no test config`. The entries classified are the ones the test checkpoint can select: the flat block when present, and each `test.repos` entry check 3 probes — one whose key passes both key checks, in an fs-native multi-repo workspace. Any other `test.repos` entry is never selected, so it is never classified; check 3's key and shape lines already report it. With no such entry, `playwright` is checked as for an MCP entry and no `driver` line prints. Each classified entry is a **driver entry** when it holds `driver`, otherwise an **MCP entry**; the test checkpoint drives each entry by its own kind ([driver-pass.md](../../close-stage/references/driver-pass.md)). A config with no driver entry prints no `driver` line.

   **`playwright`** — checked when at least one MCP entry exists. The session must expose `mcp__playwright__browser_resize`, the tool the test checkpoint's required UI checks call; its presence is the check, and it is never called.
   - Exposed → `ok playwright: browser_resize exposed`.
   - A `browser_resize` tool under another server name → `FAIL playwright: registered as <server> — the test checkpoint calls mcp__playwright__ tools; register the server under the key playwright`.
   - None → `FAIL playwright: no browser_resize tool in this session — install the Playwright MCP server (advanced.md, MCP servers)`.

   **`driver`** — checked when at least one driver entry exists, in two independent parts, so a run can print a line from each:
   - **Value** — each driver entry whose `driver` is not `browser-cli` → `FAIL driver: unknown value '<value>' — set driver: browser-cli`, labelled `driver (<repo>)` for a `test.repos` entry. The value is report text only; it never reaches a command line.
   - **Environment** — once per run, unlabelled: the driver's environment `doctor` answers about the machine, not the entry.
     - The probe's `home:` value empty, not absolute, or holding a `'` → `FAIL driver: HOME is not a usable absolute path — set HOME to one; the test checkpoint locates the driver under ~/.feature-pipeline/verify/`.
     - Otherwise one `Bash` call, the `home:` value written in place of `<home>` inside the single quotes, never held in a shell variable:
       ```bash
       command -v node >/dev/null 2>&1 || { echo "node: missing"; exit 0; }
       node '<home>/.feature-pipeline/verify/cli.mjs' doctor
       ```
       Its output is read as data, a JSON document:
       - `node: missing`, a non-zero exit, or output that is not a `doctor` document → `FAIL driver: not installed or not runnable — run /verify:setup`;
       - `ok: true` → `ok driver: installed <installed_version>; version lag not checked here — /verify:setup compares it`. The installed copy has no plugin manifest beside it, so it reports `version_lag` as `null`: a lagging install is visible only to the `verify` plugin's own skills;
       - `ok: false` → `FAIL driver: <each failing field, separated by ", "> — <the fixes>`, the failing fields being `install_missing` and `chrome_missing` when `true` and `node_ok` when `false`; the fix is `run /verify:setup`, and `install Node 22 or later` for `node_ok`.
7. **`claudedocs/`** — information only, always `--`, from the probe's `claudedocs:` line: `0` → `-- claudedocs/: ignored — ticket files stay out of the repository`; `1` → `-- claudedocs/: not ignored — ticket files are committed with the code`; `not a repository` or `git: no` → `-- claudedocs/: not a git repository`.
8. **`dispatch`** — *needs config.* The `dispatch:` block the night dispatcher reads ([advanced.md](../../../docs/advanced.md#night-dispatch-config)) and the local facts a run of it needs, judged by the dispatcher's own contract ([CONTRACT.md](../../../scripts/dispatch/CONTRACT.md), sections "§5 Configuration", "§11 Lock" and "§12 State layout"); a change to those sections is a change to this check. Not checked here: server reachability and `gh auth status`, which reach the network; the dispatcher's REST credential, which sits in a secret file; and a clean checkout on the base branch, which is the state of the moment rather than configuration. `node <plugin-root>/scripts/dispatch/dispatch.mjs plan --project-root <project-root>` is the full preflight, and the `ok dispatch` line names it.
   - No top-level `dispatch` key → `-- dispatch: no dispatch: block — night dispatch not configured (advanced.md, Night dispatch)`, and nothing below runs.
   - No storage file loaded (unknown `mode`) → `-- dispatch: not run — no storage mode declared (check 1)`, and nothing below runs.
   - Detected mode `fs-native` → `FAIL dispatch: mode fs-native — the dispatcher serves server-native projects only; set mode: server-native (re-run /feature:setup), or remove the dispatch: block`, and nothing below runs.
   - **Shape** — the block as the dispatcher's reader takes it: `dispatch:` with nothing after the colon but an optional comment, its `key: value` lines indented under it, and each value with one matched pair of quotes stripped and a ` #` comment dropped. Key names and values are report text only; they never reach a command line. Every problem goes on one line, `FAIL dispatch: <each problem, separated by "; "> — <the fixes>`:
     - a value after `dispatch:` itself → `not a mapping`, fixed by `write dispatch: on its own line, with its keys indented under it`; no other shape problem is reported;
     - a key other than `tag`, `max_age_days`, `max_tickets_per_run`, `max_open_prs`, `max_session_minutes` and `max_rate_limit_retries` → `unknown key '<key>'`, fixed by `rename it to one of the six keys, or remove it`. The dispatcher ignores such a key with a note, so a misspelt key runs the night on that key's default; the doctor fails it;
     - an empty `tag` → `tag is empty`, fixed by `set tag, or remove the key for the default agent-ready`;
     - a numeric key — every key but `tag` — whose value is not digits with no sign and no leading zero, or is past JavaScript's safe-integer range → `<key> '<value>' is not a positive integer`, fixed by `write a whole number of 1 or more`;
     - with `max_tickets_per_run` and `max_session_minutes` both valid or defaulted, `(max_tickets_per_run + 2) × max_session_minutes` of 1440 or more → `a night of up to <n> minutes reaches the 24-hour lock window`, fixed by `lower max_tickets_per_run or max_session_minutes`. A `ship` session runs up to `max_session_minutes` per ticket it builds and each of the two `sync` sessions up to `max_session_minutes`, and the next run takes over a lock older than 24 hours. The dispatcher does not check this; the doctor fails it. An epic admitted first can still build more tickets than `max_tickets_per_run` (CONTRACT.md, "§8 Caps and admission").
     - No problem → `ok dispatch: <n> keys set, <m> defaulted — full preflight: node <plugin-root>/scripts/dispatch/dispatch.mjs plan --project-root <project-root>`, both roots written out.
   - **Environment** — one `Bash` call from `<project-root>`, whatever the shape line says. The git common directory and `$HOME` reach the script as arguments, never as script text:
     ```bash
     for t in claude gh; do if command -v "$t" >/dev/null 2>&1; then echo "$t: yes"; else echo "$t: no"; fi; done
     if command -v node >/dev/null 2>&1; then echo "node: $(node --version)"; else echo "node: missing"; exit 0; fi
     command -v git >/dev/null 2>&1 || { echo "git: missing"; exit 0; }
     common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo "git: not a repository"; exit 0; }
     node -e '
     const fs = require("fs"), path = require("path");
     const [common, home] = process.argv.slice(1);
     const say = (line) => console.log(line);
     try {
       const name = path.basename(path.dirname(common));
       if (!home) { say("state_dir: HOME unset"); }
       else if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") { say("state_dir: unusable name " + JSON.stringify(name)); }
       else {
         const dir = path.join(home, ".feature-pipeline", "dispatch", name);
         for (let p = dir; ; p = path.dirname(p)) {
           let st = null;
           try { st = fs.statSync(p); } catch {}
           if (st === null) { if (path.dirname(p) === p) { say("state_dir: no existing ancestor of " + dir); break; } continue; }
           if (!st.isDirectory()) { say("state_dir: not a directory " + p); break; }
           try { fs.accessSync(p, fs.constants.W_OK); say("state_dir: " + dir + (p === dir ? "" : " (would be created under " + p + ")")); }
           catch { say("state_dir: not writable " + p); }
           break;
         }
       }
     } catch (e) { say("state_dir: error " + e.message); }
     try {
       const lock = path.join(common, "feature-dispatch.lock");
       let st = null;
       try { st = fs.statSync(lock); } catch {}
       if (st === null) { say("lock: absent"); }
       else {
         let text = "";
         try { text = fs.readFileSync(path.join(lock, "owner"), "utf8"); } catch {}
         const id = (/^run_id: *(\S+) *$/m.exec(text) || [])[1];
         const started = (/^started: *(\S+) *$/m.exec(text) || [])[1];
         const ms = started === undefined ? NaN : Date.parse(started);
         if (id !== undefined && /^\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/.test(id) && !Number.isNaN(ms)) {
           say((Date.now() - ms < 864e5 ? "lock: live " : "lock: stale ") + id + " " + started + " " + lock);
         } else {
           say((Date.now() - st.mtimeMs < 6e4 ? "lock: unreadable-live " : "lock: unreadable-stale ") + new Date(st.mtimeMs).toISOString() + " " + lock);
         }
       }
     } catch (e) { say("lock: error " + e.message); }
     ' "$common" "$HOME"
     ```
     The script applies "§11 Lock" and "§12 State layout" as written there: the lock is `<git-common-dir>/feature-dispatch.lock`, live for 24 hours from its owner's `started` — or, with the owner missing or unparseable, for one minute from the directory's modification time, a time in the future counting as live — and the state directory is `$HOME/.feature-pipeline/dispatch/<name>`, `<name>` the directory holding the git common directory, writable when it or its nearest existing ancestor is. Its output is read as data, one line per fact; an `<id>`, a time or a path in it is report text only. The lines, each independent of the others:
     - **`dispatch.claude`** — `claude: yes` → `ok dispatch.claude: on PATH`; `no` → `FAIL dispatch.claude: not on PATH — install Claude Code's CLI; the dispatcher runs each ticket as a claude -p session`.
     - **`dispatch.gh`** — `gh: yes` → `ok dispatch.gh: on PATH; its login is not tested here — the preflight runs gh auth status`; `no` → `FAIL dispatch.gh: not on PATH — install the GitHub CLI and run gh auth login`.
     - **`dispatch.node`** — `node: missing` → `FAIL dispatch.node: not on PATH — install Node 22 or later`. A `node:` version of major 22 or later → `ok dispatch.node: <version>`; an earlier one → `FAIL dispatch.node: <version> — install Node 22 or later`.
     - **`dispatch.git`** — printed only on a problem: `git: missing` → `FAIL dispatch.git: not on PATH — install git; the dispatcher locks and reads the checkout through it`; `git: not a repository` → `FAIL dispatch.git: <project-root> is not inside a git repository — the dispatcher locks and reads the checkout through git; dispatch a repository`.
     - **`dispatch.state_dir`** — with `node: missing`, `git: missing` or `git: not a repository` → `-- dispatch.state_dir: not run — <that line's fact>`. `state_dir: <dir>` → `ok dispatch.state_dir: <dir> writable`; `state_dir: <dir> (would be created under <path>)` → `ok dispatch.state_dir: <dir> — the first run creates it under <path>`; `HOME unset` → `FAIL dispatch.state_dir: HOME is not set — set it; the state directory lives under ~/.feature-pipeline/dispatch/`; `unusable name <name>` → `FAIL dispatch.state_dir: the checkout's directory name <name> is not usable — rename the directory to letters, digits, '.', '_' and '-'; the state directory is named after it`; `not writable <path>` or `not a directory <path>` → `FAIL dispatch.state_dir: <the line's fact> — make <path> a writable directory`; `no existing ancestor of <dir>` → `FAIL dispatch.state_dir: no existing ancestor of <dir> — set HOME to the absolute path of an existing directory`; `error <message>` → `FAIL dispatch.state_dir: could not be checked (<message>) — check ~/.feature-pipeline/dispatch/ by hand`.
     - **`dispatch.lock`** — not run on the same lines as `dispatch.state_dir`, worded the same. `lock: absent` → `ok dispatch.lock: absent`; `stale <id> <started> <dir>` → `ok dispatch.lock: stale — run <id> started <started>; the next run takes it over`; `unreadable-stale <time> <dir>` → `ok dispatch.lock: stale, owner unreadable (last modified <time>); the next run takes it over`; `live <id> <started> <dir>` → `FAIL dispatch.lock: held by run <id> since <started> — wait for that run to end; if no dispatch run is in progress, remove <dir>, or let it go stale 24 hours after <started>`; `unreadable-live <time> <dir>` → `FAIL dispatch.lock: held, owner unreadable (last modified <time>) — a run is starting, or one died while starting; re-run --check after a minute`; `error <message>` → `FAIL dispatch.lock: could not be checked (<message>) — look at <git-common-dir>/feature-dispatch.lock by hand`.
