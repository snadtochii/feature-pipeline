---
name: insights
description: "Report where tokens, time and friction go across pipeline runs, from Claude Code sessions and ticket artifacts, as one offline HTML file."
disable-model-invocation: true
allowed-tools:
  - Read
argument-hint: "[--project <name>|all] [--since YYYY-MM-DD] [--compare X.Y.Z]"
---

# Insights — where pipeline runs spend tokens, time and friction

Report, for one project or all of them, where the pipeline's runs spend weighted tokens, wall-clock time and friction, how they end, and — with `--compare` — whether a `feature` plugin version moved those figures. One script does the work: it brings the session-insights cache up to date from this machine's Claude Code sessions, joins each run to its ticket's artifacts, and writes one self-contained HTML report. The skill prints the script's summary of at most ten lines, the report's absolute path last.

**This skill runs in the main conversation, standalone** — not a pipeline stage. It spawns no subagents, starts no browser and no server, and runs only when the user asks for it. It reads Claude Code sessions only; a machine with no `~/.claude/projects` gets the empty report.

## Arguments

```
/feature:insights $ARGUMENTS
```

- `--project <name>` — a project's directory base name, or its absolute path; `--project all` covers every project with a recorded session. Without it the report covers the project the current working directory belongs to.
- `--since YYYY-MM-DD` — the window's first day, from 00:00 UTC, inclusive. Without it the window starts 30 days before today's UTC date.
- `--compare X.Y.Z` — set the runs since that plugin version against the same number of runs before it. Without an explicit `--since`, the comparison draws on every run of the scope.

Each flag appears at most once, its value the next word. Before any command runs, each value is checked against its shape — `--project`: `all` or `^[A-Za-z0-9._/-]+$`; `--since`: `^\d{4}-\d{2}-\d{2}$`; `--compare`: `^\d+\.\d+\.\d+$`. Any other word, a repeated flag, a missing value or a value failing its shape stops the run with one line and runs nothing: `Insights stopped: <the word at fault> — usage: /feature:insights [--project <name>|all] [--since YYYY-MM-DD] [--compare X.Y.Z]`. The script checks every value again.

## Tool rule — closed world

Call only `Read`, the one tool in `allowed-tools`, and `Bash`, which it leaves out on purpose. `Bash` runs one program only, the command below, once per run: no other command, and no pipe, redirect, `&&` or `cd` around it. `Read` reads back that command's result only when the session stored it in a file instead of returning it; it never opens the report or anything the report is built from. Never called: `Write`, `Edit`, `Agent`, `Task`, `WebFetch`, `WebSearch` and every MCP tool. `Bash` is absent from `allowed-tools` because a listed tool is granted whole — any command — for the run; left out, the call is decided by the session's permission rules, which can admit this one command and nothing else.

**No network, one place written.** The script reads the session store and the projects' ticket trees, fetches nothing and sends nothing, and writes only under `~/.feature-pipeline/insights/`: the digest cache and the report under `reports/`. The report and the summary hold counts, closed tokens, ticket IDs, dates, versions, project paths and command and stage names, never transcript text ([CONTRACT.md](../../scripts/insights/CONTRACT.md) §10).

## Roots and the command

- `<project-root>` — the current working directory, as an absolute path.
- `<plugin-root>` — the parent of the `skills/` directory that holds this skill, the plugin's root; on Claude Code, the path `${CLAUDE_PLUGIN_ROOT}` resolves to.
- **The command** — `node '<plugin-root>/scripts/insights/insights.mjs' report --cwd '<project-root>'`, followed by each flag the user passed with its value single-quoted (`--since '2026-10-01'`), with `<plugin-root>` written out as the literal absolute path inside single quotes, exactly in that form every time. With `--project`, `--cwd '<project-root>'` is left out. Without `--project`, a `<project-root>` holding a single quote stops the run: `Insights stopped: the working directory's path holds a quote; pass --project <name> or --project all.` The verb, its flags, its document and its exit codes are [CONTRACT.md](../../scripts/insights/CONTRACT.md) §1 and §9.

## Process

### 1. Check the arguments

Check `$ARGUMENTS` per Arguments.

**Done when** every flag and value has passed its check, or the run has stopped.

### 2. Run the report

Run the command once, with the shell tool's longest allowed timeout: a first run parses every session in the store and can take minutes, and later runs reuse the cached digests. A timeout stops the run: `Insights stopped: the report timed out — rerun it; the digests already written are kept.`

- Exit `0` → the result is one JSON document holding `summary`, `report`, `state`, `compare` and `extract_error`. Its JSON is model-read.
- Exit `1` or `2` → stop: `Insights stopped: <the document's error text, as printed>.` A usage error (exit 2) names the flag or the project at fault. The command is never retried with altered flags.

**Done when** the document is bound, or the run has stopped.

### 3. Print the summary

Print the `summary` lines verbatim, one per line, and nothing else: no figure, path or line from the report beyond them. The last line is `report: <absolute path>`. The skill never opens the report; the user opens the file.

An `extract_error` is already in the summary's second line: the report was still written, from the digests cached before the failure, and its status panel says what failed.

**Done when** the summary is printed — it is the run's last output.

## Error handling

Every stop is one line starting `Insights stopped:`; nothing is guessed and nothing is asked.

| Condition | Outcome |
|---|---|
| An argument that is no flag, a repeated flag, a missing value or a value failing its shape | Stop before any command (step 1) |
| No `--project`, and the working directory's path holds a single quote | Stop before any command (Roots and the command) |
| The working directory belongs to no project and no `--project` is given | Exit 2 — stop with the script's error (step 2) |
| An unknown or ambiguous `--project` name | Exit 2 — stop with the script's error (step 2) |
| `HOME` unset, or the reports directory not creatable | Exit 1 — stop with the script's error (step 2) |
| The extract fails partway | Exit 0 — the report explains the failure; the summary names it (step 3) |
| The command times out | Stop; a rerun keeps the digests written so far (step 2) |
