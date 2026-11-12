# The session-insights extractor contract

Authoritative surface for `insights.mjs`, which reduces every Claude Code session on this
machine to one small cached digest. The contract fixes the verb, the transcript store it
reads, how a session is mapped to a project, the digest schema, the recognition rules, the
cache and its reuse rules, the summary document, the exit codes and the privacy rules. The
implementation behind it is private and may change without changing this file.

The extractor knows Claude Code's transcript layout and recognizes the pipeline's runs in
it: each agent's role, ticket and stage, the close stage's result line and the validation
check runs (§5), with the rules `scripts/measure-session.py` in this repository applies
wherever it has one. Token counts are stored raw and weighted on read, by `lib/runs.mjs`
(§6).

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
| `<slug>/<session-id>/subagents/agent-<agent-id>.meta.json` | That subagent's metadata, of which `agentType`, `toolUseId`, `spawnDepth`, `parentAgentId` and `description` are read; `description` only in memory, to derive the role and ticket (§5). |

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
| `schema_version` | integer | `2`. Part of the cache key (§6). |
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
| `role` | string or null | §5 Roles; null for a subagent whose meta file is absent or not an object. |
| `ticket` | string or null | §5 Tickets: `^[A-Z][A-Z0-9]*-\d+$`, at most 40 characters. `measure-session.py`'s attribution. |
| `run_ticket` | string or null | §5 Run tickets, same vocabulary: the ticket of the pipeline run the agent belongs to. |
| `stage` | string or null | `plan`, `implement`, `review` or `close` (§5 Stages). |
| `close_result` | object or null | `{ending, verdict}` from a close stage head's result line (§5 Close results); null on every other agent and when none was printed. |
| `check_runs` | object | `total` and `failed` validation check runs (§5 Check runs). |

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

The pipeline-run rules below are `scripts/measure-session.py`'s wherever it has one — the
roles, the tickets, the slash-build rule, the check pattern and its read-only words, and the
stage roles `build-stage`, `review-stage` and `close-stage` — and `lib/recognize.mjs` holds
each beside the name of its Python counterpart. The heredoc strip, the `plan` stage, the
stage inherited down the parent chain, the root's stage from its commands, the run ticket, the
close results and the failure count are this extractor's own and have no Python counterpart.
Every value they store passes its vocabulary check; one that does not is stored as null and counted
`anomalies.bad_recognition`.

**Roles.** The root is `root-session`. A subagent whose `agentType` is not `general-purpose`
takes its type verbatim. A `general-purpose` subagent takes the first role, in this order,
whose pattern matches its meta `description`, else `general-purpose (other)`:

| Role | Description pattern |
|---|---|
| `build-stage` | `^Build stage for ` |
| `plan-stage` | `^Plan stage for ` |
| `review-stage` | `^Review stage for `, or `^\S+ review stage$` |
| `close-stage` | `^Close stage for `, or `^\S+ close stage$` |
| `finalize-child` | `^Finalize ` |
| `ship-implementer` | ` implementer via flow$` |
| `ship-review` | `^Independent review of ` |
| `ship-address` | `^Address review on ` |

**Tickets.** An agent's own ticket is the first `[A-Z][A-Z0-9]*-<digits>` token of its meta
`description` whose prefix is not a standard's name (`UTF`, `SHA`, `RFC`, `ISO` and the rest
of `NON_TICKET_PREFIXES`). The token is bounded as Python's Unicode-aware `\b` bounds it, with
no letter, number or underscore of any script on either side, and `<digits>` are any decimal
digits, as Python's `\d` reads them; a token with non-ASCII digits then fails the vocabulary
check. Failing that, it is the slash-build ticket: the first `user` record whose content is a
string holding `<command-name>/feature:build</command-name>` fixes it from
its `<command-args>`, and no later record replaces it, a ticket-less one included. An agent
with no own ticket takes its nearest ancestor's, walking `parent_agent_id` (absent means the
root) and stopping at a missing parent, a cycle, or an agent whose meta file is absent or not
an object. Another `/feature:<skill> <ID>` command attributes no `ticket`, because
`measure-session.py` has no rule for it; its IDs stay in `commands[]`, and the run ticket reads
them.

**Run tickets.** `run_ticket` is the ticket of the pipeline run an agent belongs to. `ticketRuns`
(§6) groups on it; the per-session totals that `scripts/check-insights-parity.mjs` compares
group on `ticket` and never read it. It is the agent's `ticket` when that is set. Otherwise the
root's run ticket is its command ticket: the first ID, not a standard's name, of its first
`feature:plan`, `feature:review-stage`, `feature:close-stage` or `feature:flow` command carrying
one, slash command or `Skill` call alike. Any other agent without a `ticket` takes its nearest
ancestor's run ticket through the same walk. A main session started as
`/feature:close-stage FP-5` therefore keeps a null `ticket`, as `measure-session.py` reports it,
while it and every agent under it without a ticket of its own carry run ticket `FP-5`.

**Stages.** A stage head is a subagent whose role gives a stage — `plan-stage` → `plan`,
`build-stage` → `implement`, `review-stage` → `review`, `close-stage` → `close` — or the root
when it has a stage of its own: `implement` under a ticketed slash build, else the stage of
its first `feature:plan`, `feature:review-stage` or `feature:close-stage` command. Every other
agent takes its nearest ancestor's stage through the same walk.

**Close results.** Read only for close stage heads, and only from their own `assistant`
records: a `SubagentHandback` tool call's `input.message` and every text block. A line
matches `^close: (<ending>)(?: (?:—|-) verdict (pass|partial|stuck))?\s*$`, `<ending>` one of
`done`, `review`, `backlog`, `caller`, `continue-with-hint`, `merged`, `pr-open`,
`already-complete` and `error`; the last match in file order is kept. `merged`, `pr-open` and
`error` carry no verdict, `already-complete` carries one or none, and any other ending without
one is not kept. A copy relayed by a parent, or carried in a `user` or `attachment` record, is
never read, so each run counts once.

**Check runs.** A `Bash` tool call is a check run when, with every heredoc body stripped, one
of its segments — split on `&&`, `||`, `;`, `|` and newlines, leading `NAME=value` words
dropped — does not start with a read-only word (`cat`, `head`, `grep` and the rest of
`READ_ONLY_COMMANDS`) and matches `check-[a-z-]+\.(sh|mjs)`, `bash scripts/`, `vitest`,
`pytest`, `npm run`, `npm test`, `npm ci`, `node `, `tsc` or `pyright`. Each counts once per
tool-call ID in `total`, and in `failed` when its result is a tool error under the friction
order above; a rejection or a permission denial is not a failure, and a call with no result
counts in `total` only.

**Anomaly names.** `no_message_id` (an assistant record without `message.id`, its usage
excluded), `bad_timestamp` (a conversation record without a parseable timestamp),
`bad_model`, `bad_skill_path`, `bad_command_name` (a value failing its shape check, not
kept), `commands_truncated`, `bad_meta` (a `.meta.json` that is not a JSON object),
`orphan_jsonl`, `orphan_meta`, `unreadable_file`, `bad_recognition` (a recognized value
failing its vocabulary, stored as null).

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

**Reading runs.** `lib/runs.mjs` turns loaded digests into figures, pure and synchronous.
Weighted units are `1 × input + 1.25 × cache_write + 0.1 × cache_read + 5 × output`,
`measure-session.py`'s default weights, applied on read and left unrounded.

- `sessionTotals(digest, key)`, `key` being `ticket` or `role`: per value, the agent count,
  turns, the four token sums and weighted units, a null value bucketed as `unattributed`,
  heaviest first — the shape of `measure-session.py report --json`'s `tickets[]` and
  `roles[]`.
- `roleTotals(digests)`: the same per role, across digests.
- `ticketRuns(digests)`: every run ticket (§5), grouped on (`project`, `run_ticket`) across
  sessions, with its weighted units in total and by role, one entry per session in start
  order, and its close results — one per close stage head, its `close_result` null when the
  head printed none — in start order. A session entry lists the ticket's stage heads in start
  order, each with its span, plugin versions, models, check runs, weighted units and close
  result. A stage entry's figures cover its head and every agent of the head's run ticket
  whose stage that head gave; an agent of another run ticket under it counts in its own
  ticket's totals only. Its versions are that subtree's, else the nearest ancestor's, else the
  session's. A root `implement` stage ends where the session's first other stage head starts.
  Each session adds its own digest's
  units, so the turns a forked or resumed root repeats from an earlier session count once per
  session in the cross-session totals; the per-session figures are unaffected. A digest of
  another `schema_version` is counted in `without_recognition` and never read.

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
- The text-derived fields are exactly these: command names passing their shape check,
  ticket-ID-shaped tokens from command arguments, and §5's closed-vocabulary values — role,
  ticket, run ticket, stage and close result. A subagent's metadata contributes its
  shape-checked type, IDs and depth (§4); its `description` is read in memory to derive the role and ticket and
  is never stored. Assistant text, handback messages and `Bash` commands are scanned for §5's
  patterns and never stored either.
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
- the pipeline-run rules: roles, tickets with standards names skipped and Unicode-aware
  boundaries, the slash-build rule, check runs with heredoc bodies stripped, the close result
  line, and the vocabulary checks;
- a main session started as a close-stage command: its run ticket on every agent while its
  `ticket` stays `measure-session.py`'s, and the ticket's close stage and close result;
- malformed and truncated lines counted without stopping the run;
- start and end as the minimum and maximum timestamps;
- project mapping: a project root, a subdirectory, a live worktree, a deleted worktree and an
  unmapped session;
- an end-to-end first run, with subagents, an orphan transcript, an orphan meta file, a
  meta file that is not an object, ignored prefix files, and a symlinked transcript and a
  symlinked `subagents` directory skipped unfollowed;
- recognition end to end on a flow session and a later session of the same ticket: each
  agent's role, ticket, stage, close result and check runs, with relayed close lines not
  counted; the run reader's per-session ticket and role totals; one ticket across both
  sessions, its stages and close results in start order; an older-schema digest counted
  without recognition;
- incremental reruns: everything reused, a changed project remapped without a parse, one
  changed transcript parsed, a schema change parsed, a deleted subagent kept stale even
  under a schema change, a deleted transcript kept;
- after every run: the sentinel — carried by every free-text meta field too — in no digest,
  stdout or stderr; the store unchanged; digest modes 0600 and directory modes 0700;
  nothing written outside `$HOME/.feature-pipeline/insights/`.

It runs in `.github/workflows/validation.yml` and in the check chain in `AGENTS.md`, and so
does this repository's `scripts/check-insights-parity.mjs`, which holds the weighted units
of the `-ROOT-pipeline` fixture sessions equal to `scripts/measure-session.py`'s.
