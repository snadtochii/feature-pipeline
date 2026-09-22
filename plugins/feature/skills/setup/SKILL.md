---
name: setup
description: "Configure a project for the feature pipeline: detect its commands, ask what detection leaves open, check the connector and bind the project for server-native storage, and write claudedocs/tickets/config.yaml, the fs-native ticket folders, .worktreeinclude and a commands snippet, each after its diff is approved. With --check, verify a configured project read-only and print one line per check with its fix."
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
  - ping
  - pipeline_list_projects
  - mcp__plugin_server-native_ps__ping
  - mcp__plugin_server-native_ps__pipeline_list_projects
argument-hint: "[--check]"
---

# Setup — configure a project for the pipeline in one guided run

Run the detection script against the project, propose a value for every `claudedocs/tickets/config.yaml` key — the existing one on a re-run, else the detected one, else a documented default for a policy key — and ask about each value the findings leave open. For server-native storage, that includes checking that the connector answers and binding the server project the tickets live in. Then show every write as a diff and apply each one only on its own approval: `config.yaml`, the ticket folders an fs-native project needs, `.worktreeinclude`, an optional `claudedocs/` line in `.gitignore`, and an optional `## Commands` section in an existing `CLAUDE.md` / `AGENTS.md`. A re-run reads what is there, keeps it, and proposes only what is missing or differs.

**Storage mode.** Setup is the one skill where the storage mode is an output rather than an input: it does not detect the mode at entry per [`../flow/references/storage.md`](../flow/references/storage.md) §Mode detection — it asks for it, with an existing `config.yaml`'s `mode` (read at Process step 3) as the default. The mode question and the connector check before it live in this body; the pair [`storage-fs.md`](references/storage-fs.md) / [`storage-server.md`](references/storage-server.md) holds only the mechanics that follow the decision — the ticket store, the keys the mode owns, the project binding and ID allocation. The file for the chosen mode is loaded once, in full — at Process step 3 when an existing `config.yaml` fixes `mode: server-native`, at step 5 otherwise, and at step 2 in a headless run — and every later `§N` cite refers to that file. `--check` is the exception that reads the mode rather than asking it: its check 1 detects the mode per `storage.md` §Mode detection and loads the detected mode's file once, in full, for that file's `§5` ([check.md](references/check.md)).

**This skill runs in the main conversation, standalone** — **not a pipeline stage**. It spawns no subagents (no `Task`), performs no ticket transition and commits nothing. Its only MCP calls are the connector's read-only `ping` — before the mode question, and once under `--check` — and `pipeline_list_projects` once server-native is chosen in the guided run ([storage-server.md](references/storage-server.md) §1).

## Arguments

```
/feature:setup $ARGUMENTS
```

- No argument — the guided run: detect, ask, then write what you approve.
- `--check` — the read-only doctor: verify a configured project against the contracts the stages apply, printing one line per check with its fix, then an `OK` / `FAIL (n)` summary line. That final line is the machine-readable result — a headless run greps it for `^OK:`; the skill sets no exit status. It asks nothing, writes nothing and boots nothing ([check.md](references/check.md)); it does run each configured `validate.*` command once, as every edit's hook does, so those commands' own effects apply and they run as trusted code. Run it before `ship`, and after changing `config.yaml`.
- Anything else — prints `Usage: /feature:setup [--check]` and stops.

## When NOT to run

- To create a ticket → `/feature:discover`. A throwaway project needs no setup: discover's first run asks for a prefix and writes a minimal `config.yaml` itself.
- To verify the current config without changing anything — before a `ship`, or after editing `config.yaml` → `/feature:setup --check`, not the guided run.
- To change one key → edit `config.yaml` by hand; every key is documented in [advanced.md](../../docs/advanced.md#configuration-reference).

## Process

### 1. Bind roots

- `<project-root>` — the current working directory: the repository whose `claudedocs/tickets/` this run configures, or, in a multi-repo workspace, the folder holding the child repositories.
- `<plugin-root>` — the parent of the `skills/` directory that holds this skill, the plugin's root; on Claude Code, the path `${CLAUDE_PLUGIN_ROOT}` resolves to. Plugin files — the detection script and the storage pair — resolve against `<plugin-root>`, never against the consuming project.
- **`--check`** → follow [check.md](references/check.md) from here and stop after its report. Steps 2–7 do not run.

### 2. Headless check

Every write needs an answer from a person. When no user is reachable — a headless run, or a surface with neither a question tool nor a conversational channel — run steps 3 and 4 and make no server call — no `ping`, no project list. The proposed mode is the existing `mode`, else `fs-native`; load that mode's file once, in full, unless step 3 already did. A server-native proposal whose `project` is not fixed ([storage-server.md](references/storage-server.md) §3) states that binding a project needs an interactive run. Then print the proposal: the findings, each open question with its proposed answer (existing value, else detected value, else the documented default), and every write step 6 would make, as a diff. Print the step 7 report with `nothing written`, and **stop without writing**. On Codex, `AskUserQuestion` maps per [`runtime-codex.md`](../flow/references/runtime-codex.md); that mapping is cited here, not restated. An answer is never assumed from silence — not in a headless run, and not for a question the user leaves unanswered.

### 3. Read existing state

The `config.yaml` and `.worktreeinclude` reads below and step 4's root detection run are independent: issue them as one message of parallel calls. The ticket-folder Globs follow in a second message only when that read found no `prefix` and did not fix the mode as server-native.

- **`config.yaml`** — `Read` `<project-root>/claudedocs/tickets/config.yaml` when it exists, and bind every key present with its value. The file's text is what step 6's edits match against.
  - `mode: server-native` → the mode is fixed: load [storage-server.md](references/storage-server.md) now, once, in full, and apply its §3 rules for the existing `project` — a well-formed UUID fixes the project, a missing key leaves only the project question, and a value that is not a UUID stops the run. An existing server-native `mode:` / `project:` pair is never rewritten.
  - A `mode` value other than `fs-native` or `server-native` → stop and ask the user what was meant, per [`storage.md`](../flow/references/storage.md) §Mode detection. Never guess.
  - A file that does not parse as a YAML mapping → stop and report it. Never overwrite it.
- **Ticket folders** — only when the `config.yaml` read found no `prefix` and no `mode: server-native`, since an existing `prefix` is the prefix and the folders then decide nothing: `Glob` `claudedocs/tickets/**/01-spec.md` and `claudedocs/tickets/**/prd.md`, and collect the `<PREFIX>` of every parent folder name of the form `<PREFIX>-<N>`.
- **`.worktreeinclude`** — at the repository root (each child repository's root in a multi-repo workspace): `Read` it when present and bind the names it lists.

### 4. Detect

- Run `bash "<plugin-root>/skills/setup/scripts/detect.sh" "<project-root>"`. Invocation, exit codes and output schema: [detection.md](references/detection.md) §1–§3. The script is the only thing that shells out to parse the project; its JSON and `config.yaml` are model-read.
  - Exit `0` → bind the JSON document.
  - Exit `1` (`jq` missing) → report it, noting that the validation hook needs `jq` too, and continue with no detected values: every question in step 5 is asked with no detected default.
  - Exit `2`, or stdout that is not one JSON object → stop and report it as a setup error. Nothing is written.
- **`workspace_shape: multi-repo`** → also run the script once per immediate child directory holding a `.git` entry ([detection.md](references/detection.md) §4), binding each child's document by directory name. The per-child runs, with each child's `.worktreeinclude` read, go out as one message of parallel calls. The root run supplies `prefix` and `instruction_files`; the per-repository facts come from the children.
- Present the findings as one compact review block: one line per fact, `null` shown as `not detected`, and the existing `config.yaml` value beside any fact it differs from. A `.worktreeinclude` candidate is shown by name only; its content is never read or printed.

### 5. Ask

Ask with `AskUserQuestion`, in passes of up to four questions. Each question's first option — the recommended one — is the existing value on a re-run, else the detected value, else the documented default named below; a detected value that differs from an existing one is offered as the second option. An optional key offers `leave unset` (key absent) or `skip` (key present, which then stays exactly as it is), and free text is always available. There is no cap on the number of questions: each is asked only when its answer is open, and a value with nothing to decide is shown in the review block instead. On a long run, track the open questions with `TodoWrite`. A user who cancels the dialogue ends the run: nothing is written, and the report says so.

In this order:

1. **Storage mode** — asked unless step 3 fixed it as server-native.
   - **Connector check, first.** On Claude Code the check is `mcp__plugin_server-native_ps__ping`; on Codex it is `mcp__<server>__ping` of a server that also exposes `pipeline_*` tools, so an unrelated server's `ping` never unlocks the mode. Present in the session → call it once, with no arguments: a non-error result means the connector answers, and an error or timeout means it does not. Absent → no call, and the connector is unavailable — a machine without it stays offline.
   - **Options** — `fs-native` (default) and `server-native`, both always listed. The `server-native` description reads `connector answers`, or `unavailable — the connector's ping did not answer` with the install pointer: the Claude Code `server-native` connector plugin, or the Codex `config.toml` block, both in [advanced.md](../../docs/advanced.md#storage-mode-and-the-personal-server).
   - `fs-native` → load [storage-fs.md](references/storage-fs.md) now, once, in full.
   - `server-native` while the connector answers → load [storage-server.md](references/storage-server.md) now, once, in full, and ask its §3 project question. Switching a project whose `config.yaml` is fs-native, or that has local ticket folders, carries the §2 warning into the `config.yaml` diff.
   - `server-native` while the connector is unavailable → print the install pointer and stop before any write.
2. **Prefix** — fs-native only ([storage-server.md](references/storage-server.md) §4 asks none). Asked only when no prefix is fixed per §3 and §4: no `prefix` in `config.yaml`, and no ticket folders to infer one from. Default: the detector's `prefix`. A fixed prefix is shown in the review block; folder names carrying more than one prefix are listed in the question, with no default.
3. **`validate.lint`**, **`validate.typecheck`** and the **test command** — default: the detector's `validate.lint` / `validate.typecheck` / `validate.test`. The test command has no `config.yaml` key ([detection.md](references/detection.md) §7); it feeds only the commands snippet (item 11). A `validate.lint` or `validate.typecheck` answer containing `"` or `\` is re-asked with a request to rephrase, per step 6's quoting rule. Multi-repo, for each of the three: a value is proposed only when every child's detection agrees; otherwise the question carries no default and points at the repo-agnostic, manifest-sniffing command form in [advanced.md](../../docs/advanced.md#worktree-setup).
4. **`test.url`** and **`test.start`** — default: the detector's `test.url` / `test.start`. When `compose_file` is set and `test.start` is null, the recommended `test.start` is the isolated stack described in [advanced.md](../../docs/advanced.md#app-test-config), built from that file: `trap 'docker compose -f <compose_file> down' EXIT TERM; docker compose -f <compose_file> up & wait`.
5. **`test.start_timeout`** — asked only when the isolated-stack `test.start` was chosen, since a stack that builds an image can outlast the 60-second default. Default: `leave unset`; otherwise a whole number of seconds, at most 540.
6. **`git.commit`** — `prompt` (default), `always` or `never`, each with its one-line meaning from [advanced.md](../../docs/advanced.md#commit-behavior).
7. **`git.attach_screenshots`** — `false` (default) or `true`. The question states that uploads are irreversible and world-readable on a public repository, as [advanced.md](../../docs/advanced.md#commit-behavior) does.
8. **`worktree.setup`** — default: the detector's `worktree_setup`. Multi-repo: proposed as for `validate.*`.
9. **`claudedocs/` in `.gitignore`** — its own yes/no question, with neither option marked recommended, asked only when `claudedocs_ignored` is `false`. It changes a committed file every contributor shares, so it is asked explicitly and never inferred from a general go-ahead. `true` → shown as already ignored. `null` (not a git repository, or a multi-repo root) → not asked; the reason goes in the report.
10. **`.worktreeinclude` names** — one include-or-not question per detected candidate the file does not already list, plus:
    - `claudedocs/tickets/config.yaml`, in a single-repo workspace only, when `claudedocs/` is ignored (already, or by item 9's line) and it is not already a candidate: a fresh worktree has no copy of an ignored config. In a multi-repo workspace `config.yaml` sits above every child repository, where a repo-relative name cannot reach it and need not ([advanced.md](../../docs/advanced.md#worktree-setup)).
    - An optional free-text "add another name". The typed text never enters a command line: `Write` each name as the single line of a file in a temp directory whose path a prior `mktemp -d` printed, and keep the name only when `git -C <repo> check-ignore -q --stdin < <file>` exits `0`, else drop it with the reason, and remove the temp directory once the names are checked. The named file itself is never opened.

    Multi-repo: asked per child repository, for that child's root. Not a git repository → not asked; the reason goes in the report.
11. **`## Commands` snippet** — one yes/no question per instruction file the root detection reports as existing, showing the lines it would append: `- Lint:`, `- Typecheck:` and `- Test:` from the confirmed item 3 answers, each only when set. A file is not offered, and the reason goes in the report, when:
    - its `commands_section` is `true` and the matched section already lists a runnable command — read the section to tell ([detection.md](references/detection.md) §11);
    - it is `CLAUDE.md` and `AGENTS.md` exists — build reads both files whenever both exist, so a snippet in each would run every check twice, and only `AGENTS.md` is offered;
    - there are no lines to write.

    A missing instruction file is never created.

### 6. Propose and approve each write

Re-runs are safe: what exists is read, kept and extended, never clobbered. Each write below is shown as a unified diff — proposed against current, or against an empty file for a new one — and applied only on its own approval, asked as an apply-or-skip question. A skipped write is listed in the report with the reason `declined`, and the writes after it still run. When no write has anything to change, say `no changes` and go to the report.

In this order:

1. **`config.yaml`, with the ticket folders §2 creates when the mode creates any**, as one diff: the directories first, then the file. On approval, when §2 names directories, run the `mkdir -p` first — a failure stops here, is reported, and skips every write that depends on it — then write the file.
2. **`.gitignore`** — only on item 9's explicit yes: append a `claudedocs/` line with `Edit`, or `Write` a one-line `.gitignore` when none exists. Afterwards `git -C <project-root> check-ignore -q claudedocs/` must exit `0`; when it does not (a negation rule elsewhere, for example), report it, and drop the `claudedocs/tickets/config.yaml` candidate from the next write with that reason.
3. **`.worktreeinclude`** — the confirmed names only, one per line, at the repository root (at each child repository's root in a multi-repo workspace, one diff per file). Re-check the `claudedocs/tickets/config.yaml` candidate with `git check-ignore -q` first and drop it, with the reason, when it is not ignored. An existing file gains only its new names, appended with `Edit`; none is removed or reordered. An absent file is created with `Write`.
4. **Each `## Commands` snippet** — appended with `Edit` to the end of the existing instruction file, in the format of [advanced.md](../../docs/advanced.md#project-conventions-claudemd):

   ```markdown
   ## Commands
   - Lint: `<validate.lint>`
   - Typecheck: `<validate.typecheck>`
   - Test: `<test command>`
   ```

   A line whose command is unset is omitted.

**`config.yaml` write rules.** These hold in either storage mode; the keys the chosen mode owns come from §3.

- **Order** — `prefix`, `mode`, `project`, `validate` (`lint`, `typecheck`), `test` (`url`, `start`, `start_timeout`), `worktree` (`setup`), `git` (`commit`, `attach_screenshots`); sub-keys indented two spaces under their block.
- **Only answered keys** — every answered key is written explicitly, `mode` included; a key left unset is omitted. `test.auth.*` and `validate.cwd_markers` are never asked or written; the report points at [advanced.md](../../docs/advanced.md#configuration-reference) for them.
- **Quoting** — `validate.lint` and `validate.typecheck` are one-line double-quoted strings with no trailing comment, so both of the validation hook's parsers read them identically; a value containing `"` or `\` was re-asked at step 5 and never reaches this write. `test.start` and `worktree.setup` are double-quoted, or single-quoted when the value contains `"` or `\`, with each embedded `'` written `''` — so the isolated-stack `trap '…'` form survives. `project`, written only in server-native, is bare with the trailing comment [storage-server.md](references/storage-server.md) §3 defines — the one key written with a comment. Every other value is written bare.
- **New file** → `Write`, keys in the order above.
- **Existing file** → edited in place with `Edit`, one call per insertion point; the file is never regenerated. A changed value replaces only its own line. A new sub-key goes inside its existing block, after its nearest documented predecessor present; a new block goes, whole with its sub-keys, after the nearest documented block present before it. Every key and block added after the same anchor line goes into that one call's text, so a file holding only `prefix` gains all its new keys in a single `Edit`. Comments, blank lines and keys this skill does not know stay byte-for-byte. No key is ever deleted.
- **Content** — values are paths, commands and names only. No secret is read or written.

### 7. Report

Print one block:

```
## Setup — <project-root>
Mode: <fs-native|server-native>
Project: <uuid> — <name> | entered by UUID | unchanged   (server-native only)
Written:
  claudedocs/tickets/config.yaml — created | edited (<n> keys added, <m> changed)
  claudedocs/tickets/ folders — created <names> | all present   (fs-native only)
  .gitignore — claudedocs/ added
  .worktreeinclude — created with <n> names | <n> names added   (per repository in a multi-repo workspace)
  <CLAUDE.md|AGENTS.md> — ## Commands appended (<n> lines)
Skipped:
  <file> — declined | nothing to write | section already lists commands | covered by AGENTS.md | not a git repository | not ignored
  server-native — unavailable, connector not answering
Not asked: test.auth.*, validate.cwd_markers — see docs/advanced.md, Configuration reference
Local tickets under claudedocs/tickets/ are not migrated to the server and not read in server-native mode.
Commit .gitignore and .worktreeinclude before using --worktree or ship --parallel: a fresh worktree reads the committed ignore rules.
Next: /feature:discover <idea>
```

The `server-native — unavailable` line appears only when the connector check found no answering connector. The local-tickets line appears only on a switch to server-native that carried the [storage-server.md](references/storage-server.md) §2 warning. The commit line appears only when `.gitignore` or `.worktreeinclude` was written. A run that changed nothing prints `Written: no changes`. A headless run, a cancelled dialogue, or a stop before the writes prints `Written: nothing written`, with the proposal or the stop reason above the block.

## Boundaries

**Will Not:**
- Write any file whose diff was not approved, or treat silence as an answer.
- Add the `.gitignore` line without its own explicit question.
- Create `CLAUDE.md` or `AGENTS.md`.
- Read, print or copy the content of a dotenv-family file or any other secret — `.worktreeinclude` names are checked with `git check-ignore`, never opened.
- Delete or regenerate a `config.yaml` key or a `.worktreeinclude` name.
- Rewrite an existing server-native `mode:` / `project:` pair.
- Make a network call or call an MCP tool other than the guided run's connector `ping` and `pipeline_list_projects` — neither of them in a headless run — and `--check`'s connector `ping` and `test.url` probe.
- Under `--check`, write a project file, boot `test.start` or any other server, ask a question, or call `pipeline_list_projects`: `--check` writes nothing, boots nothing and asks nothing.
- Create a registry project, or resolve a project UUID from a name or look one up.
- Commit, stage or push anything.
- Allocate a ticket ID or create a ticket.

## Error Handling

- **Under `--check`** → none of the stops below applies: a check that cannot run prints a `--` line, and a problem prints a `FAIL` line with its fix ([check.md](references/check.md) §1). The run always reaches its summary line.
- **Detector exit `1`** (`jq` missing) → reported; every question is asked with no detected default.
- **Detector exit `2`, or output that is not one JSON object** → stop and report it as a setup error; nothing is written.
- **`config.yaml` present but unparseable** → stop and report it; never overwrite it.
- **An unrecognized `mode` value** → stop and ask the user what was meant.
- **The connector's `ping` not callable, or failing** → server-native is shown unavailable with the install pointer; fs-native proceeds unchanged.
- **`server-native` picked while the connector is unavailable** → print the install pointer and stop; nothing is written.
- **`pipeline_list_projects` not callable, failing or empty** → the UUID prompt ([storage-server.md](references/storage-server.md) §3).
- **A project answer that is not a UUID** → re-asked, naming the expected form.
- **An existing `mode: server-native` whose `project` is not a UUID** → stop with the config-error message of [`storage.md`](../flow/references/storage.md) §Mode detection; the value is never rewritten.
- **An `Edit` whose match text has changed** since step 3's read → re-read the file, rebuild its diff, and ask for approval again.
- **`mkdir -p` fails** → report it and skip the writes that depend on the folders.
- **`git` absent, or not a git repository** (`claudedocs_ignored` and `worktreeinclude_candidates` are null) → the `.gitignore` and `.worktreeinclude` questions are not asked; the report says why.
- **A write fails** → report the files already written and the ones not reached, and stop. A re-run reads what is on disk and proposes only the remainder.
