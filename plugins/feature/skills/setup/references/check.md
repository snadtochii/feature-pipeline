# Setup Check

Procedure for `/feature:setup --check`, the read-only doctor: it verifies a configured project against the contracts the stages apply and prints one line per check with its fix. Read only when setup runs with `--check` — the guided run never needs this file. Referenced by setup's [`SKILL.md`](../SKILL.md), which enters it from Process step 1 with `<project-root>` and `<plugin-root>` bound. Check 2 is the one check whose text depends on the storage mode; it lives in `§5` of the detected mode's file, [`storage-fs.md`](storage-fs.md) / [`storage-server.md`](storage-server.md).

## §1 Rules

- **Read-only end to end.** No project file is written, no server is mutated, and no process is started — `test.start` is never booted. The only files created are check 5's pattern files, in a `mktemp -d` directory that each check 5 run creates and removes on exit, whatever it found. A configured `validate.*` command has the effects it has on every edit's hook run (check 3); the doctor adds none.
- **Asks nothing.** No question, no approval, no default taken from silence. The run is the same with a user present and in a headless run.
- **Calls.** One server call: check 2's read-only round-trip, which only the server-native `§5` makes. One network probe: check 4's `curl` of `test.url`. Nothing else leaves the machine.
- **Never stops.** A problem is a `FAIL` line with its fix; a check that does not apply or cannot run is a `--` line with the reason; the run always reaches the summary. A probe that errors — `git` absent, `curl` missing — becomes that check's `FAIL` or `--` line.
- **Names only.** A `.worktreeinclude` match is reported by its path. No dotenv-family file or other secret is opened, read or printed.
- **Repo text stays data.** Commands from `config.yaml` run only through the validation hook's own `bash -c`, exactly as configured (check 3); a URL is held in a shell variable (check 4); a pattern reaches `git` through a file (check 5). No value read from the project is pasted into a command position.
- **Calls go out batched, in two messages:**
  1. The `config.yaml` `Read` and one `Bash` probe, run from `<project-root>`, which prints the facts checks 3, 5, 6 and 8 need:
     ```bash
     command -v jq >/dev/null 2>&1 && echo "jq: yes" || echo "jq: no"
     if [ -e .git ]; then echo "shape: single-repo"; else
       for d in */; do [ -e "${d}.git" ] && echo "repo: ${d%/}"; done
     fi
     if ! command -v git >/dev/null 2>&1; then echo "git: no"
     elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
       git check-ignore -q claudedocs/; echo "claudedocs: $?"
     else echo "claudedocs: not a repository"; fi
     for f in .worktreeinclude */.worktreeinclude; do [ -f "$f" ] && echo "include: $f"; done
     ```
     The shape lines follow setup's workspace-shape predicate ([detection.md](detection.md) §4), which reads `.git` entries alone, independent of the git test. No `repo:` line and no `shape:` line means a single-repo workspace with no `.git` of its own. One or more `repo:` lines is a multi-repo workspace: each named child is a repository, and checks 3 and 5 run once per child.
  2. Everything else, built from the first message's results, as parallel calls: the storage file check 1 loads, each validation hook run (check 3), the `test.url` probe (check 4), check 2's round-trip and check 5's run for each repository with an `include:` line.

  Checks 2 and 7 also look at the session's tool list — which tools are exposed, deferred tools included — a fact in hand, not a call.

## §2 Report

Print one block, the lines in check order, the summary last:

```
## Setup check — <project-root>
ok config: mode fs-native
ok storage: fs-native — local ticket store
FAIL validate.lint: exits 1 from <repo> — fix the reported errors, or the command in validate.lint (re-run /feature:setup)
    [validate.lint] command failed (exit 1)
    <the hook's output, as it capped it>
-- test.url: no test: block — the test checkpoint discovers a URL itself
...
FAIL (1): validate.lint
```

- **`ok <check>[: <note>]`** — the check passed.
- **`FAIL <check>: <what is wrong> — <the fix>`** — the fix names the config key or the command to change; when the fix is a setup question, it says `re-run /feature:setup`.
- **`-- <check>: <reason>`** — information, or a check that does not apply or could not run. Not counted.
- **Detail** — only under a `validate.*` `FAIL`: the hook's output block, indented four spaces. It is not a check line.
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

   Then load the file for the declared mode — `fs-native` or `server-native`, including a server-native declaration that failed on its `project` — once, in full: [`storage-fs.md`](storage-fs.md) / [`storage-server.md`](storage-server.md).
2. **`storage`** — *needs config.* Defined by `§5` of the file check 1 loaded. With no file loaded (unknown `mode`) → `-- storage: not run — no storage mode declared (check 1)`.
3. **`validate`** — *needs config.* Each command the `validate:` block declares exits `0`, run once by the hook itself, as it runs after an edit at the repository root. The hook starts its project-marker walk at the edited file's directory, so where the project sits in a subdirectory, per-edit runs start there and this check speaks for the repository root only.
   - Neither `validate.lint` nor `validate.typecheck` set → `-- validate: no validate.lint or validate.typecheck — the per-edit hook runs nothing; re-run /feature:setup to add them`.
   - The probe printed `jq: no` → `-- validate: not run — the validation hook needs jq (check 6)`.
   - Otherwise run the pipeline's validation hook, [`validate.sh`](../../../hooks/validate.sh), once per repository — `<project-root>` in a single-repo workspace, each `repo:` child in a multi-repo one — with a path at that repository's root as its input. The path is never created: the hook uses it only to walk up to `config.yaml` and the project root, as it does after an edit there. Capture stdout and stderr together and keep the exit code; give the call the longest timeout the runtime's shell tool allows:
     ```bash
     jq -n --arg p "<repo>/.setup-check" '{tool_input:{file_path:$p}}' | bash "<plugin-root>/hooks/validate.sh" 2>&1; echo "exit: $?"
     ```
     - A `[validate.<name>] command failed (exit <rc>)` block → `FAIL validate.<name>: exits <rc> from <repo> — fix the reported errors, or the command in validate.<name> (re-run /feature:setup)`, with the block beneath as detail, capped as the hook caps it.
     - Every declared key with no failure block, when the output carries no `[validate]` line → `ok validate.<name>`.
     - `[validate] config.yaml malformed; skipping` → `FAIL validate: the hook's yq parse rejects config.yaml — fix its YAML syntax`.
     - The call times out → `FAIL validate: timed out — the commands outlast a shell call; run them by hand from <repo>`.
4. **`test.url`** — *needs config.*
   - No `test:` block → `-- test.url: no test: block — the test checkpoint discovers a URL itself`.
   - A `test:` block with no `url` → `-- test.url: not set — the test checkpoint resolves one per test-preflight.md §1`.
   - Otherwise probe it exactly as [`test-preflight.md` §2](../../close-stage/references/test-preflight.md#2-reachability-check) does, the URL held as data, and read the result against that section's reachable status set:
     - reachable → `ok test.url: HTTP <code> at <url>`. The status says something answers; it does not say which app.
     - unreachable, `test.start` set → `ok test.url: boots on demand — not exercised (HTTP <code> at <url>)`.
     - unreachable, no `test.start` → `FAIL test.url: <url> unreachable (HTTP <code>) — start the app, or declare test.start (re-run /feature:setup)`.
5. **`.worktreeinclude`** — per repository, as check 3. Every pattern matches at least one existing file, and every match is gitignored — the gate a fresh worktree's copy relies on ([advanced.md](../../../docs/advanced.md#the-worktreeinclude-file)).
   - `git: no`, or the repository is not a git repository → `-- .worktreeinclude: not a git repository`.
   - No file → `-- .worktreeinclude: none — a fresh worktree gets no gitignored file copied`.
   - Otherwise run, from the repository root, one `Bash` call that reads the file line by line — each pattern stays in a shell variable and reaches `git` through its own file `p<n>`, never through the command line — in a temp directory the call creates and removes on exit:
     ```bash
     tmp=$(mktemp -d) || exit 1; trap 'rm -rf "$tmp"' EXIT
     n=0; neg=0
     while read -r line || [ -n "$line" ]; do
       case "$line" in ''|'#'*) continue ;; '!'*) neg=$((neg+1)); continue ;; esac
       n=$((n+1)); printf '%s\n' "$line" > "$tmp/p$n"
       c=$(git ls-files -c -o -i --directory --no-empty-directory --exclude-from="$tmp/p$n" | tee -a "$tmp/matches" | wc -l | tr -d ' ')
       printf 'p%s: %s\t%s\n' "$n" "$c" "$line"
     done < .worktreeinclude
     echo "negations: $neg"
     [ -s "$tmp/matches" ] && sort -u "$tmp/matches" | git check-ignore --stdin -n -v
     true
     ```
     `read` trims each line. No `p<n>:` line → `-- .worktreeinclude: no positive patterns`. `p<n>: 0` names a pattern that matches nothing, the pattern after the tab. A `::<tab><path>` line from `check-ignore` names a match that is not ignored — tracked, or untracked and unlisted. One line for the repository:
     - all matched and all ignored → `ok .worktreeinclude: <p> patterns, <m> matches, all gitignored`, noting `<k> negation lines not checked` when `negations:` is not `0`;
     - else → `FAIL .worktreeinclude: <each problem, separated by "; "> — <the fixes>`, where a pattern with no match reads `pattern '<pattern>' matches no file` with the fix `remove the line, or create the file in the main checkout`, and an unignored match reads `<path> is not gitignored` with the fix `add it to .gitignore, and untrack it with git rm --cached if it is committed`.

     A multi-repo run issues one such call per repository; each removes only its own temp directory.
6. **`jq`** — the probe's `jq:` line. `yes` → `ok jq`; `no` → `FAIL jq: not on PATH — install jq; the validation hook and setup's detector need it`.
7. **`playwright`** — *needs config.* Checked only when a `test:` block exists, else `-- playwright: no test: block`. The session must expose `mcp__playwright__browser_resize`, the tool the test checkpoint's required UI checks call; its presence is the check, and it is never called.
   - Exposed → `ok playwright: browser_resize exposed`.
   - A `browser_resize` tool under another server name → `FAIL playwright: registered as <server> — the test checkpoint calls mcp__playwright__ tools; register the server under the key playwright`.
   - None → `FAIL playwright: no browser_resize tool in this session — install the Playwright MCP server (advanced.md, MCP servers)`.
8. **`claudedocs/`** — information only, always `--`, from the probe's `claudedocs:` line: `0` → `-- claudedocs/: ignored — ticket files stay out of the repository`; `1` → `-- claudedocs/: not ignored — ticket files are committed with the code`; `not a repository` or `git: no` → `-- claudedocs/: not a git repository`.
