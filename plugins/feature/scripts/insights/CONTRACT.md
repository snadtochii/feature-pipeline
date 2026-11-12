# The session-insights extractor contract

Authoritative surface for `insights.mjs`, which reduces every Claude Code session on this
machine to one small cached digest. The contract fixes the verb, the transcript store it
reads, how a session is mapped to a project, the digest schema, the recognition rules, the
cache and its reuse rules, the summary document, the exit codes and the privacy rules. The
implementation behind it is private and may change without changing this file.

The extractor is generic session plumbing: it knows Claude Code's transcript layout and
nothing of the pipeline's own formats. Recognizing tickets, stages, roles and verdicts, and
weighting token counts, is the job of the code that reads the digests.

---

## §1 Invocation and exit codes

```text
node <plugin-root>/scripts/insights/insights.mjs extract
node <plugin-root>/scripts/insights/insights.mjs --self-test
```

| Part | Meaning |
|---|---|
| `<plugin-root>` | The installed `feature` plugin's root directory. |
| `extract` | Scans the store (§2), brings the cache (§6) up to date and prints the summary (§7). Takes no flags: every path derives from `HOME`. |
| `--self-test` | §9. Takes no verb and no other flag. |

Only `insights.mjs` is a command. Everything under `lib/`, and the modules under `../lib/`
that the plugin's scripts share, is private.

**Output.** Exactly one JSON document on stdout, keys sorted recursively by code unit,
two-space indent, one trailing newline, and nothing on stdout besides it. There is no
progress output.

| Exit | Meaning | Document |
|---|---|---|
| 0 | The run finished, malformed lines included. | §7 summary, or the self-test's `{"cases": <n>, "ok": true}`. |
| 1 | Could not compute: `HOME` unset or empty, the store unreadable, the cache root not creatable, a digest not writable, or a self-test case failing. | `{"error": "<reason>"}`, naming the path where one is involved. |
| 2 | Bad invocation: no verb, an unknown verb, any argument after `extract`, or `--self-test` with company. | `{"error": "<reason>"}`. |

**Runtime.** Node 22 or newer, no dependency beyond Node's standard library. `git` on `PATH`
is used for worktree resolution (§3) and its absence is not an error.

## §2 The store and what is skipped

The store is `$HOME/.claude/projects`, opened read-only. A missing store holds zero sessions
and is not an error.

| Path under the store | Read as |
|---|---|
| `<slug>/<session-id>.jsonl` | A main session's transcript. |
| `<slug>/<session-id>/subagents/agent-<agent-id>.jsonl` | One subagent's transcript in that session. |
| `<slug>/<session-id>/subagents/agent-<agent-id>.meta.json` | That subagent's metadata, of which `agentType`, `toolUseId`, `spawnDepth` and `parentAgentId` are read. |

- `<slug>` and `<session-id>` match `^[A-Za-z0-9_-][A-Za-z0-9._-]*$`; `<agent-id>` matches
  `^[A-Za-z0-9_-]+$`. A name that does not is skipped.
- Only regular files and real directories are read. A symlink is never followed.
- **Counted in `skipped_entries`:** every other entry directly under the store, every other
  entry directly under a `<slug>/` (the `memory/` directory, stray files, a symlink), a
  `<session-id>/` directory with no matching main transcript, a `subagents` entry that is not
  a real directory, every other entry under `subagents/`, and a file that vanishes or cannot
  be listed between scan and stat.
- Entries of a `<session-id>/` directory other than `subagents/` (`custom-title.json`,
  `*.txt`, tool-result spill files), and the `agent-<agent-id>.prefix.json` files under
  `subagents/`, are ignored and not counted.
- A subagent `.jsonl` with no `.meta.json` becomes an agent with null metadata fields
  (`anomalies.orphan_jsonl`). A `.meta.json` with no `.jsonl` is counted only
  (`anomalies.orphan_meta` on the session, `subagents.orphan_meta` in the summary).

Each transcript is streamed, decoded as UTF-8 with replacement, split into lines on `\n`
alone — a JSON string may hold U+2028, U+2029 or a carriage return — and never loaded
whole.

## §3 Session-to-project mapping

A session's `cwd` is the `cwd` of the root transcript's earliest-timestamped conversation
entry (`user`, `assistant`, `attachment`, `system`); file order is not time order. With no
validly timestamped entry carrying one, the first `cwd` seen is used. The raw `cwd` is
stored in the digest.

The project is found from the `cwd`, first match:

1. The `cwd` is not an absolute path → unmapped.
2. The `cwd` exists, and `git -C <cwd> rev-parse --path-format=absolute --git-dir
   --git-common-dir` reports a git dir different from the common dir, and the common dir's
   base name is `.git` → a linked worktree; the walk starts at the common dir's parent, the
   main checkout. `project_via: "worktree"`.
3. The `cwd` no longer exists, and one of its segments reads `<name>-worktrees` with a
   sibling directory `<name>` beside it → the walk starts at that sibling; the deepest such
   segment wins. `project_via: "worktree-sibling"`. This is the plugin's worktree
   directory convention, `<repo-dirname>-worktrees/<x>`.
4. Otherwise the walk starts at the `cwd`. `project_via: "cwd"`.

The walk goes from its start up to `/`; the first directory holding `claudedocs/tickets/` is
the project. None found → unmapped: `project` and `project_via` are both `null`, the
session keeps its digest, and the summary counts it under `sessions.unmapped`.

`git` missing, failing or taking over 10 seconds degrades step 2 to step 4. The mapping is
redone on every run, memoized per distinct `cwd` within the run.

## §4 The digest schema

One digest per main session. Session-level token, friction, skill, model, version,
malformed and anomaly fields are roll-ups of `agents[]`.

| Field | Type | Meaning |
|---|---|---|
| `schema_version` | integer | `1`. Part of the cache key (§6). |
| `session_id` | string | The main transcript's file stem. |
| `transcript` | string | The main transcript's path relative to the store, `<slug>/<session-id>.jsonl`. |
| `sources` | array | The cache key: `{path, size, mtime_ms}` for the main transcript and every subagent `.jsonl` and `.meta.json` read, paths relative to the store, sorted by path; `mtime_ms` truncated to whole milliseconds. |
| `cwd` | string or null | §3. |
| `project` | string or null | The project's absolute path (§3). |
| `project_via` | string or null | `cwd`, `worktree` or `worktree-sibling`; null when unmapped. |
| `start`, `end` | ISO-8601 or null | The earliest and latest conversation-entry timestamps across every agent. |
| `duration_ms` | integer or null | `end − start`. |
| `models` | array | Every model ID seen, sorted. |
| `feature_versions` | array | Every `feature` plugin version seen in a skill load path, sorted. |
| `skills` | object | Skill name → load count. |
| `tokens` | object | `input`, `output`, `cache_read`, `cache_write`: raw sums, unweighted. |
| `friction` | object | `interrupts`, `rejections`, `permission_denials`, `tool_errors`. |
| `malformed_lines` | integer | Lines that are not a JSON object, including a truncated last line, plus one per unreadable file. |
| `anomalies` | object | Name → count, only the non-zero ones (§5). |
| `agents` | array | One entry per agent, the root first, then the subagents by agent ID. |

Each `agents[]` entry:

| Field | Type | Meaning |
|---|---|---|
| `agent_id` | string | `root` for the main transcript; else the `<agent-id>` of its file name. |
| `agent_type` | string or null | The meta `agentType`, kept when it matches `^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$`. |
| `tool_use_id` | string or null | The meta `toolUseId`, kept when it matches `^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$`. |
| `spawn_depth` | integer or null | The meta `spawnDepth`, kept when it is a non-negative integer. |
| `parent_agent_id` | string or null | The meta `parentAgentId`, same shape as `tool_use_id`. |
| `cwd` | string or null | This agent's earliest `cwd` (§3's rule, on its own transcript). |
| `start`, `end`, `duration_ms` | | As above, for this agent's transcript. |
| `turns` | integer | Distinct assistant `message.id` values. |
| `turns_without_usage` | integer | Of those, the ones no record gave a `usage` object. |
| `models`, `feature_versions`, `skills`, `tokens`, `friction`, `malformed_lines`, `anomalies` | | As above, for this agent. |
| `tokens_by_model` | object | Model ID → the four token sums, for turns whose model is known. |
| `commands` | array | `{name, ids}` in file order, at most 50 (§5). |

## §5 Recognition rules

**Tokens.** Only `assistant` records count. Records are grouped by `message.id`; streaming
repeats one ID on several lines, and the terminal record's usage (`stop_reason` non-null)
is kept, else the last one. Only the four top-level keys are read —
`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` —
never `iterations[]` nor the nested `cache_creation` map. A turn's model is the last
non-empty `message.model` for its ID. These rules match `scripts/measure-session.py` in this
repository, so its weights apply to the raw sums unchanged.

**Skills and versions.** A skill load is a `user` record with `isMeta: true` whose text
starts `Base directory for this skill: `. Only that text's first line is read:

- `…/plugins/cache/<marketplace>/<plugin>/<version>/skills/[<group>/…]<name>` → skill
  `<plugin>:<name>`; when `<plugin>` is `feature` and `<version>` reads as a semantic
  version, the version joins `feature_versions`.
- Any other path holding `/skills/[<group>/…]<name>` at its end, or Claude Code's own
  `/bundled-skills/<cli-version>/<hash>/<name>` → skill `<name>`, no version.
- `<name>` is the path's last segment, kept when it matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`.

A versioned path anywhere else — a Read result, an Agent prompt — is not a skill load.

**Commands.** A `user` record whose text holds `<command-name>X</command-name>`, and an
assistant `Skill` tool call's `input.skill`, each add one `commands[]` entry. The name is
kept when it matches `^/?[A-Za-z0-9:._-]{1,80}$`. Its `ids` are the ticket-ID-shaped tokens
`[A-Z][A-Z0-9]*-<digits>` of `<command-args>…</command-args>` or `input.args`, deduplicated,
at most 10; the rest of the arguments is dropped. Commands are not skill loads.

**Friction.** Each `tool_result` block is classified once, first match:

1. **rejection** — its content starts `The user doesn't want to proceed with this tool use`,
   or the record's `toolUseResult` is `User rejected tool use`;
2. **permission denial** — its content starts `Permission to use … has been denied`, or
   holds `but you haven't granted it yet`;
3. **tool error** — any other block with `is_error: true`.

Only the content's first 300 characters are read. **Interrupts** count user text that is
exactly `[Request interrupted by user]`; the `… for tool use]` variant follows a rejection
and is not counted again.

**Malformed lines.** A blank line is skipped. A line that does not parse, or parses to
something other than an object, counts one malformed line and the read continues. An
unreadable file counts one malformed line and `anomalies.unreadable_file`. A record of an
unknown type is ignored, not malformed.

**Anomaly names.** `no_message_id` (an assistant record without `message.id`, its usage
excluded), `bad_timestamp` (a conversation record without a parseable timestamp),
`bad_model`, `bad_skill_path`, `bad_command_name` (a value failing its shape check, not
kept), `commands_truncated`, `bad_meta` (a `.meta.json` that is not a JSON object),
`orphan_jsonl`, `orphan_meta`, `unreadable_file`.

## §6 The cache

```text
$HOME/.feature-pipeline/insights/            mode 0700
└── digests/                                 mode 0700
    └── <slug>/                              mode 0700
        └── <session-id>.json                mode 0600, one per main session
```

Each digest is written through a temporary file beside it and renamed into place, the
moment its session is parsed, so an interrupted run keeps every digest it finished. There
is no index and no lock; two concurrent runs write equivalent content and the last rename
wins. Every digest path is checked to sit directly under `digests/<slug>/` before it is
written.

Per main session in the store, first match:

| State | Outcome | Counted |
|---|---|---|
| The digest names a source that is no longer in the store | Kept unchanged — a digest is never replaced by a less complete one. | `sessions.kept_stale` |
| Equal `schema_version` and equal `sources` | Reused without reading any transcript. The project is re-mapped (§3); when it changed, only `project` and `project_via` are rewritten. | `sessions.reused`, and `sessions.remapped` when rewritten |
| No digest, a changed or added source, or another `schema_version` | The whole session is parsed and its digest written. | `sessions.parsed` |
| A digest that does not parse | Parsed as above. | `sessions.cache_corrupt` and `sessions.parsed` |

A digest whose main transcript is gone from the store is never touched and never deleted;
the summary counts it under `sessions.kept_without_transcript`. A transcript that grows
while it is read is keyed by the size and time captured before the read, so the next run
parses it again.

`lib/cache.mjs` exports `loadDigests(cacheRoot)` for the code that reads the cache: every
digest that parses, ordered by transcript path.

## §7 The summary document

| Field | Meaning |
|---|---|
| `cache_dir` | The absolute path of `digests/`. |
| `schema_version` | §4. |
| `sessions` | `seen` (main sessions in the store), `parsed`, `reused`, `remapped`, `kept_stale`, `cache_corrupt`, `kept_without_transcript`, and `mapped` / `unmapped`, which sum to `seen`. |
| `subagents` | `parsed` (subagent transcripts read this run), `orphan_jsonl`, `orphan_meta` (across the sessions seen). |
| `malformed_lines` | The sum across the digests of the sessions seen. |
| `malformed_sessions` | The first 20 transcript paths, sorted, whose digest counts a malformed line. |
| `malformed_sessions_total` | How many there are. |
| `anomalies` | §5's counts summed across the digests of the sessions seen. |
| `skipped_entries` | §2. |

The document holds counts and store-relative paths only, so its size is bounded whatever
the store holds.

## §8 Privacy

- No message text enters a digest or the summary: no user prompt, assistant text, tool input
  or tool output. Tool-result content is read only to classify it (§5), its first 300
  characters at most, and is never stored.
- The text-derived fields are exactly these: command names passing their shape check, and
  ticket-ID-shaped tokens from command arguments. A subagent's metadata contributes only its
  shape-checked type, IDs and depth (§4); its free-text fields are never read.
- The store is read-only. Writes go only under `$HOME/.feature-pipeline/insights/`.
- No network access. `git` runs with `-C <cwd>` as one argument, never through a shell.

## §9 Self-test

`insights.mjs --self-test` runs offline over committed synthetic fixtures under
`fixtures/transcripts/`, which hold no real transcript content; every free-text field in
them carries a sentinel string. It materializes the project tree, a git repository with a
linked worktree, a scratch directory and a `memory/` directory at run time, under a
temporary `HOME`. It covers:

- argument handling;
- token deduplication and the terminal-record preference, top-level usage keys only;
- disjoint friction classification;
- skill and version detection, with versioned paths outside a skill load ignored;
- commands keeping ticket IDs only;
- malformed and truncated lines counted without stopping the run;
- start and end as the minimum and maximum timestamps;
- project mapping: a project root, a subdirectory, a live worktree, a deleted worktree and an
  unmapped session;
- an end-to-end first run, with subagents, an orphan transcript, an orphan meta file, a
  meta file that is not an object, ignored prefix files, and a symlinked transcript and a
  symlinked `subagents` directory skipped unfollowed;
- incremental reruns: everything reused, a changed project remapped without a parse, one
  changed transcript parsed, a schema change parsed, a deleted subagent kept stale even
  under a schema change, a deleted transcript kept;
- after every run: the sentinel — carried by every free-text meta field too — in no digest,
  stdout or stderr; the store unchanged; digest modes 0600 and directory modes 0700;
  nothing written outside `$HOME/.feature-pipeline/insights/`.

It runs in `.github/workflows/validation.yml` and in the check chain in `AGENTS.md`.
