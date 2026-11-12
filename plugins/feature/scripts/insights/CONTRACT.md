# The session-insights extractor contract

Authoritative surface for `insights.mjs`, which reduces every Claude Code session on this
machine to one small cached digest and reports on the cached runs as one offline HTML page.
The contract fixes the verbs, the transcript store it reads, how a session is mapped to a
project, the digest schema, the recognition rules, the cache and its reuse rules, the ticket
outcomes joined to the runs, the summary document, the report, the exit codes and the
privacy rules. The implementation behind it is private and may change without changing this
file.

The extractor knows Claude Code's transcript layout and recognizes the pipeline's runs in
it: each agent's role, ticket and stage, the close stage's result line and the validation
check runs (§5), with the rules `scripts/measure-session.py` in this repository applies
wherever it has one. Token counts are stored raw and weighted on read, by `lib/runs.mjs`
(§6). For each fs-native project the runs belong to, it reads the fixed lines of every
ticket's artifacts and joins each ticket's outcome to its runs, on read (§7).

---

## §1 Invocation and exit codes

```text
node <plugin-root>/scripts/insights/insights.mjs extract
node <plugin-root>/scripts/insights/insights.mjs report [--project <name>|all] [--since YYYY-MM-DD] [--compare X.Y.Z] [--cwd <abs-dir>]
node <plugin-root>/scripts/insights/insights.mjs --self-test
```

| Part | Meaning |
|---|---|
| `<plugin-root>` | The installed `feature` plugin's root directory. |
| `extract` | Scans the store (§2), brings the cache (§6) up to date, joins the cached runs to the ticket trees of the projects the digests name (§7) and prints the summary (§8). Takes no flags: every path derives from `HOME` and from those project paths. |
| `report` | Does what `extract` does, in process, then writes one HTML report and prints the report document (§9). |
| `--project <name>` | `report` only. `all` for every project a digest names; else one project, by its absolute path or its directory base name. Without it, the project `--cwd` maps to (§3). |
| `--since YYYY-MM-DD` | `report` only. The window's first day, a real calendar date, from 00:00 UTC, inclusive. Default: 00:00 UTC of the day 30 days before the run's UTC date. |
| `--compare X.Y.Z` | `report` only. The `feature` plugin version the comparison splits at; each part a decimal integer. |
| `--cwd <abs-dir>` | `report` only. The directory whose project the report covers when `--project` is absent; an absolute path. Default: the process's working directory. |
| `--self-test` | §11. Takes no verb and no other flag. |

A `report` flag takes its value as the next argument, appears at most once, and its value
may not be empty or start with `--`; `--flag=value` is not accepted.

Only `insights.mjs` is a command. Everything under `lib/`, and the modules under `../lib/`
that the plugin's scripts share, is private.

**Output.** Exactly one JSON document on stdout, keys sorted recursively by code unit,
two-space indent, one trailing newline, and nothing on stdout besides it. There is no
progress output.

| Exit | Meaning | Document |
|---|---|---|
| 0 | The run finished, malformed lines and unreadable ticket trees included; for `report`, an extract failure too, which the report explains (§9). | §8 summary, §9 report document, or the self-test's `{"cases": <n>, "ok": true}`. |
| 1 | Could not compute: `HOME` unset or empty; for `extract`, the store unreadable, the cache root not creatable or a digest not writable; for `report`, the reports directory not creatable or the report not writable; or a self-test case failing. | `{"error": "<reason>"}`, naming the path where one is involved. |
| 2 | Bad invocation: no verb, an unknown verb, any argument after `extract`, a `report` argument that is not one of its flags, a repeated flag, a missing value or a value failing its shape (a `--project` value over 4096 characters included), `--self-test` with company; for `report`, a working directory that maps to no project with no `--project`, or a `--project` name matching no project or several. | `{"error": "<reason>"}`. No report is written. |

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
an object. Every walk up an agent tree — this one, a run's stage head and plugin versions
(§6) and friction's skill (§9) — is the one walk of `lib/agents.mjs`; only this one also
stops at an agent without a readable meta file. Another `/feature:<skill> <ID>` command attributes no `ticket`, because
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
├── digests/                                 mode 0700
│   └── <slug>/                              mode 0700
│       └── <session-id>.json                mode 0600, one per main session
└── reports/                                 mode 0700, the reports (§9)
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

## §7 Ticket outcomes

`lib/tickets.mjs` reads the ticket trees and `lib/outcomes.mjs` joins them to the runs, both
on read: nothing from a ticket tree enters a digest or the cache, so an artifact rewritten
after its close is read as it now stands. Ticket reading never fails a run.

**Projects.** The projects joined are the distinct non-null `project` paths (§3) of every
digest in the cache, a digest kept without its transcript included; no other directory is
searched. Each gets a join state from `<project>/claudedocs/tickets/config.yaml`:

| Join | When |
|---|---|
| `fs` | The file is absent, it has no top-level `mode` key, or its `mode` is `fs-native`. |
| `server-native` | `mode: server-native`. The tree is never opened and nothing calls the server. |
| `unknown-mode` | Any other `mode` value. No storage mode is guessed and the tree is never opened. |
| `missing` | The project directory is gone, `config.yaml` is a symlink, is not a regular file of at most 1 MiB or cannot be read, or an `fs` project's `claudedocs/tickets/` is not a directory. |

**The tree.** For an `fs` project: the folders `<state>/<ID>/` of the four state folders
`backlog`, `in-progress`, `review` and `done`, and the children `<state>/<EPIC>/tasks/<ID>/`
of each epic. A folder name must match `^[A-Z][A-Z0-9]*-\d+$`, at most 40 characters; other
names, and the files beside the state folders such as `config.yaml` and `_lessons.md`, are
ignored. A folder holding `prd.md` is an epic, one holding `01-spec.md` a ticket. A folder
holding neither, and a state folder that is a symlink or cannot be listed, is counted in
`skipped_folders`. An ID met twice keeps the first folder in state-folder order and counts
one in `duplicates`. Inside the tree no symlink is followed: a symlinked folder is not
entered and a symlinked artifact is not read. An artifact is read only when it is a regular
file of at most 1 MiB; any other is listed unrecognized and its record is null.

**Frontmatter** — the first `---` block of `01-spec.md` or `prd.md`:

| Field | Values |
|---|---|
| `kind` | `epic` for a `prd.md` or `kind: epic`; `child` when `parent` is set; else `solo`. |
| `parent` | An ID of the folder-name shape, or null. |
| `complexity` | `S`, `M`, `L`, `XL`, or null. |
| `status` | `backlog`, `in-progress`, `in-review`, `done`, `cancelled`, `partial-completion`, or null. |
| `created` | A `YYYY-MM-DD` date, or null. |

A present value outside its set, one of these keys written twice, a missing `status` and a
missing block each list the file unrecognized and leave the field null; another absent key is
null and nothing more. `state` is the state folder the ticket sits under — a child's is its
epic's — and `epic_folder` is a child's epic ID, else null. `status` comes from the
frontmatter alone and `state` from the folder alone; neither is derived from the other.

**`04-review.md`.** Line 1, trailing whitespace trimmed, matched exactly:

| Line 1 | `label` |
|---|---|
| `verdict: skipped (trivial diff)` | `skipped-trivial` |
| `verdict: skipped (no changes)` | `skipped-no-changes` |
| `verdict: reviewed` | `reviewed` |
| `verdict: reviewed (partial — <N>/4 reviewers)`, `N` from 1 to 3 | `reviewed-partial`, with `reviewers_ok` = `N` |
| `verdict: failed (all reviewers)` | `failed-all` |
| `verdict: stuck (<pattern>)` | `stuck`; the pattern is not stored |

`fix_step` is line 2's `fix-step: pending` or `complete`, else null. `decisions` counts
`accepted`, `dismissed` and `deferred`, and `outcomes` counts `applied`, `fix_failed` and
`not_attempted`, over every `- decision: <token>` and `- outcome: <token>` line, indented or
not, on the leading token: trailing text such as `applied (touches …)` or
`deferred (conflict) — …` still counts. Any other line 1, and a marked line with any other
leading token, list the file unrecognized, the counts kept, and so does a count of
`- [F<k>]` finding lines, indented or not, other than the count of decision lines: counts
written only as prose are never read as zeros. `present` is false for an absent file.

**`05-tests.md`**, the first form that fits:

| Form | Record |
|---|---|
| No file | `state: absent` |
| Line 1 `verdict: skipped (<cause>)`, the cause one of the five below | `state: skipped`, `cause` |
| Line 1 starting `Source: ship end-of-run UI verification`, line 2 `verdict: pass` or `partial` | `state: ran`, `by: ship`, `result` |
| Line 1 starting with neither `verdict:` nor `Source:`, and a column-0 `## Pass: <repo>` or `## Screenshots` heading | `state: ran`, `by: close`, `failed_criteria`: whether a `## Failed Criteria` heading is present |

| Cause | `cause` |
|---|---|
| `no UI work in plan` | `no-ui-work` |
| `UI testing disabled by --no-ui-testing` | `no-ui-testing-flag` |
| `no testable repo in ticket` | `no-testable-repo` |
| `app unreachable` | `app-unreachable` |
| `browser driver unavailable` | `driver-unavailable` |

Any other file is unrecognized, its `state` null. No label is looked for past line 2, so one
on a later line is never found.

**`06-summary.md`.** `verdict` is line 1's `verdict: pass`, `partial` or `stuck`. `pr` comes
from the last column-0 `pr:` line: `{repo: "<owner>/<name>", number}` for
`pr: https://github.com/<owner>/<name>/pull/<number>`, `none` for `pr: none — <reason>`, the
reason not stored, and null otherwise. `has_branch` is whether a column-0 `branch: <name>`
line is present; the name is not stored. Another line 1, or a last `pr:` line of another
form, lists the file unrecognized. `summary_mtime` is the ISO time of the file's
modification time; with `created`, it dates a ticket whose sessions are gone, and neither is
merged into a session's `start` or `end`.

**The join.** `ticketDataset(digests)` reads each project once and joins on (`project`,
ticket ID), the key of `ticketRuns` (§6), so a ticket has one entry whatever its sources:

| `source` | Entry |
|---|---|
| `both` | A run ticket whose project's join is `fs` and whose project's tree holds its ID. |
| `sessions` | Every other run ticket: its project `server-native`, `unknown-mode` or `missing`, its ID in no folder of its own project's tree, or its `project` null. |
| `artifacts` | A ticket of an `fs` tree that no run names. |

An entry is a `ticketRuns` entry with `source`, `outcome`, `verdict` and `feature_versions`
added. `outcome` holds `kind`, `parent`, `complexity`, `status`, `state`, `epic_folder`,
`created`, `summary_mtime` and the `review`, `tests` and `summary` records above, each record
null for an epic or an unreadable file; `outcome` is null on a `sessions` entry. `verdict` is
the summary's. `feature_versions` is the sorted union of the entry's stage versions. On an
`artifacts` entry the plugin version is unknown: `feature_versions` and `weighted_units` are
null, and `by_role`, `sessions` and `close_results` empty. The close results stay as
`ticketRuns` reads them from the transcripts, beside the artifact verdict.

The dataset is `{counts, projects, tickets, unrecognized, without_recognition}`:

| Field | Meaning |
|---|---|
| `counts.joined`, `counts.artifacts_only`, `counts.sessions_only` | Entries by `source`, `sessions_only` counting those with a project. |
| `counts.unmapped_runs` | `sessions` entries whose `project` is null. |
| `counts.verdict_mismatch` | `both` entries whose last non-null close-result verdict differs from the artifact verdict. Counted, never resolved. |
| `counts.projects_by_join` | Projects per join state. |
| `counts.duplicates`, `counts.skipped_folders` | Summed across the trees. |
| `counts.unrecognized_total` | The length of `unrecognized`. |
| `projects` | `{join, path}` per project, sorted by path. |
| `tickets` | The entries, sorted by project, then ticket ID. |
| `unrecognized` | `{artifact, project, ticket}` per unrecognized artifact, the artifact its file name, sorted. |
| `without_recognition` | §6. |

## §8 The summary document

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
| `tickets` | §7's `counts`, plus `projects` — the first 20 `{join, path}` entries — with `projects_total`, how many there are, and `unrecognized`, §7's first 20 entries. |

The document holds counts, store-relative paths, project paths, ticket IDs and artifact file
names only, so its size is bounded whatever the store and the ticket trees hold.

## §9 The report

`report` resolves its scope, runs §6–§8's extract in process without printing its summary,
reduces the cached digests and their ticket dataset (§7) to the figures below, writes them
as one HTML page and prints the report document.

**Scope.** With `--project all`, every distinct project path a digest names. With a name, the
one project whose absolute path equals it, or else whose base name equals it; none or several
matching exits 2, listing at most 20 known base names or the clashing paths. Without
`--project`, the project `--cwd` maps to under §3, checked before the extract runs; a
directory that maps to none exits 2. That project is reported even when no digest names it.

**Window.** A session is in the window when its `start` is at or after the window's first
instant, and everything recorded in it counts with it: its tokens, its duration and its
stages. A run ticket (`source` `both` or `sessions`, §7) is in scope when its project is and
one of its sessions is in the window; an `artifacts`
ticket when its project is and its `summary_mtime`, else its `created` date, falls in the
window. A session of the scope with no `start` and an artifact-only ticket with neither date
are left out and counted as undated.

**Weeks.** ISO weeks, from Monday 00:00 UTC, labelled by the Monday's date. The list runs from
the week holding the later of the window's start and the earliest in-scope session start, to
the week holding the run's time; a week in that span with no data is a row of zeros. The week
the window starts in, when it starts after that Monday, and the week holding the run's time
are marked partial. A session counts in the week of its `start`, and so does every stage it
holds.

**Figures.** Weighted units are §6's. A stage's duration is its wall-clock span, verdict-gate
waits included; a session's is its digest's `duration_ms` (§4).

| Section | Figures | Source |
|---|---|---|
| Stage time | Per stage — `plan`, `implement`, `review`, `close` — over the window and per week: stage runs, weighted units, wall-clock total and median, and the runs whose duration is unknown. | The stage entries (§6) of the in-scope run tickets' in-window sessions. |
| Project time | Per project with an in-window session, over the window and per week: sessions, weighted units, the units spent inside a recognized stage and the rest, the session wall-clock and the stage wall-clock. | The in-scope digests' token sums and durations, and their sessions' stage entries. |
| Friction | Per skill and per stage: interrupts, rejected tool calls, permission denials, tool errors and failed check runs, with the check-run total beside them. The page lists the 15 heaviest skills and folds the rest into one `other` row. | Every agent of the in-scope digests that carry recognition (§5, §6). |
| Outcomes | Verdicts `pass`, `partial`, `stuck` and `unknown`; review findings accepted, dismissed and deferred, with the number of tickets they are known for; browser passes run by the close stage or by ship, skipped per cause, absent, unrecognized, or unknown for a ticket with no artifacts. | The in-scope tickets, epics left out. |
| Coverage gaps | Unmapped sessions in the window, counted machine-wide; for the scope, artifact-only tickets, unrecognized artifacts of its tickets, sessions without recognition, and the undated items left out. | The digests and the dataset. |

A ticket's verdict is its `06-summary.md` verdict, else its last close-result verdict, else
`unknown`. Its findings are its `04-review.md` decision counts when that review is present,
labelled, not listed unrecognized and not `failed-all`; otherwise they are unknown — in no sum
and outside the coverage, never zero. A `skipped-trivial` or `skipped-no-changes` review is a
known zero.

**Friction attribution.** An agent's friction counts toward its first `commands[]` name, a
leading `/` stripped, that is a key of its own `skills` (§4) — a built-in command such as
`/clear` or `/model` loads no skill and is passed over; failing that, toward its nearest
ancestor's, through §5's walk: an absent parent means the root, and the walk stops at the
root, at a parent missing from the session or at a cycle; failing that, toward `(no skill)`. Per stage it counts toward the agent's `stage`, or `(no stage)`.
Each agent counts once in each table.

**Comparison.** With `--compare X.Y.Z` the pool is the scope's run tickets, bounded by the
window only when `--since` was given; epic runs are left out and counted. A run's versions are
its `feature_versions` (§7), each compared numerically on its leading `X.Y.Z`. A run whose
every version is at or above `X.Y.Z` is after; one whose every version is below it is before;
one spanning both, or with no version, is left out and counted. Runs are ordered by their
earliest stage start, else their earliest session start, then by ticket ID. With k =
min(after, before), the after side takes its first k runs and the before side its last k: the
runs nearest the boundary.

Below `MIN_COMPARE_RUNS` = 5 runs per side the comparison is `insufficient`: the page states
both sides' run counts, the floor and its reason, and shows no figure. The reason: at 2 to 5
runs per plugin version, 5 runs per side usually spans more than one version, and a median of
5 runs survives two outliers where one large ticket would dominate a smaller sample. A shown
comparison gives, per side, the runs compared and available, the median and total weighted
units of a run, the median stage wall-clock of a run, the verdicts, and the findings with
their coverage; the differences of the unit and time figures appear only in that table,
beside both sides' verdict and findings rows.

**The page.** One HTML document: a viewport meta, one inline stylesheet whose one
`max-width: 640px` query stacks the cards into a single column, inline SVG charts sized by
`viewBox` at full width down to a minimum of 560px, each beside a table holding its numbers,
and charts and tables in horizontally scrolling wrappers. It holds no script, no `<link>`, no `src`, no `url(`, no `@import` and no
URL, and every interpolated value is entity-escaped. The sections — `status`, `stage-time`,
`project-time`, `friction`, `outcomes`, `gaps` and `compare`, in that order — and their boxes
are emitted in every state, each box with a minimum height; a box without data holds a state
message in place of its chart or table. `<body>` carries `data-state` — `populated`, `empty`
when the scope has no session, run or artifact-only ticket in the window, or `error` when the
extract failed — and `data-compare` — `shown`, `insufficient` or `off`. A state message
carries `data-state` `empty`, `error`, `disabled` or `off`.

**An extract failure.** An extract failing for any reason `extract` exits 1 on, other than an
unset `HOME`, does not fail the report: the page is built from the digests already cached —
none when the cache root is absent — its status panel and the document's `extract_error`
give the failure's one-line reason, and the run exits 0. For a failure the extractor reports
itself, the reason is the one `extract` prints; for any other exception it is
`unexpected <class>`, with the error's code in parentheses when it has one, never the
exception's message.

**The file.** `$HOME/.feature-pipeline/insights/reports/<YYYYMMDDTHHMMSSZ>-<slug>.html`, the
time the run's own in UTC, `<slug>` either `all` or the project's base name reduced to
`[A-Za-z0-9._-]` (`project` when nothing is left); a name already taken gets `-2`, `-3` and so
on. `reports/` is a real directory of mode 0700, and each report a file of mode 0600 written
through a temporary file and hard-linked to its name, a link that fails when the name exists.
Taking a name and publishing to it are that one step, so of two runs in the same second each
gets its own name. No report is overwritten or removed.

**The report document.**

| Field | Meaning |
|---|---|
| `report` | The report's absolute path. |
| `state` | `populated` or `empty`, as the page's. |
| `compare` | `shown`, `insufficient` or `off`. |
| `extract_error` | The extract failure's one-line reason, or null. |
| `summary` | Ten lines in this order, each opening with its label: `scope:`, `sessions:` (ending `extract: ok` or `extract: failed — <reason>`), `tokens:`, `friction:`, `verdicts:`, `findings:`, `browser pass:`, `gaps:`, the comparison — its state and run counts only: `compare <version>: shown, <k> vs <k> runs — figures in the report`, `compare <version>: insufficient, <a> after, <b> before, minimum 5`, or `compare: not requested` — and `report: <absolute path>`. |

## §10 Privacy

- No message text enters a digest, the summary, the report or the report document: no user
  prompt, assistant text, tool input or tool output. Tool-result content is read only to classify it (§5), its first 300
  characters at most, and is never stored.
- The text-derived fields are exactly these: command names passing their shape check,
  ticket-ID-shaped tokens from command arguments, and §5's closed-vocabulary values — role,
  ticket, run ticket, stage and close result. A subagent's metadata contributes its
  shape-checked type, IDs and depth (§4); its `description` is read in memory to derive the role and ticket and
  is never stored. Assistant text, handback messages and `Bash` commands are scanned for §5's
  patterns and never stored either.
- From a ticket artifact only §7's values are kept: closed tokens, integer counts, ticket
  IDs, `YYYY-MM-DD` dates, an ISO modification time and a PR's owner, name and number. No
  title, reason, branch name, stuck pattern, label text or other prose is stored or printed;
  an unrecognized artifact is listed by ticket ID and file name, never quoted.
- The store and every ticket tree are read-only: nothing under a project is written,
  renamed or re-moded, no symlink inside a ticket tree is followed, and only regular files
  are read. A server-native project's tree is never opened. Writes go only under
  `$HOME/.feature-pipeline/insights/`.
- The report and its document hold §9's figures only: counts, weighted units, durations,
  closed tokens, ticket IDs, dates, versions, project paths and command and stage names. A
  page loads nothing: no script, no external asset, no URL. `report` starts no browser and no
  server.
- No network access. `git` runs with `-C <cwd>` as one argument, never through a shell.

## §11 Self-test

`insights.mjs --self-test` runs offline over committed synthetic fixtures under
`fixtures/transcripts/` and `fixtures/tickets/`, which hold no real transcript or ticket
content; every free-text field in them carries a sentinel string. It materializes the
project tree, a git repository with a linked worktree, a scratch directory and a `memory/`
directory at run time, under a temporary `HOME`, with the ticket fixtures copied into two
projects' `claudedocs/tickets/` — one fs-native, one server-native. It covers:

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
- the ticket artifacts' forms: frontmatter vocabularies, a repeated key and a missing block;
  every `04-review.md` label and its drift forms, decision and outcome tokens indented or
  carrying trailing text, unknown tokens, counts written only as prose and a finding without
  its decision line; the five skip causes, the ship and close browser
  passes, an absent `05-tests.md`, a label on line 3; the summary verdict, the last `pr:`
  line, `pr: none`, malformed PR URLs and `branch:` presence;
- the storage mode from `config.yaml`, a symlinked `config.yaml` and an unknown `mode` value
  read as no tree included, and a tree read
  with a symlinked state folder, a
  symlinked artifact, an artifact over the cap and a duplicate ID;
- the join in memory: each `source`, a verdict mismatch, an unmapped run, a server-native,
  unknown-mode or missing project and another project's ID never joined, and one tree read
  per project;
- the ticket dataset end to end: a pass with a close browser pass, a partial epic child with
  fix-failed findings and a skipped browser pass, a stuck ticket, an epic and tickets with no
  session, a ship browser pass, a ticket unrecognized in every artifact, a symlinked ticket
  folder skipped, and a server-native project's run kept without an outcome; the summary's
  `tickets` block;
- incremental reruns: everything reused, a changed project remapped without a parse, one
  changed transcript parsed, a schema change parsed, a deleted subagent kept stale even
  under a schema change, a deleted transcript kept;
- the `report` verb: its flags and their rejected forms; ISO weeks across a year boundary
  and the default window; the friction walk through an own skill command past a built-in
  one, a built-in command alone, an ancestor, a missing parent, a cycle and no skill, per
  skill and per stage; an unmapped session counted
  machine-wide and an undated one left out; the verdict rule and findings unknown, never
  zero; the comparison's nearest-boundary windows, its exclusions, ties ordered by ticket ID
  and its floor at 5 and 4 runs per side; the page escaping a project path, with one skeleton
  across the populated, empty, error and disabled-comparison states, its state markers, the
  viewport meta and narrow-width query, no script, asset or URL and no missing number;
  end-to-end reports over the fixtures for every project, one project by base name and a
  comparison, usage errors writing no report and an unset `HOME`; and in process an
  extractor failure explained in the page, an unexpected exception explained by its class
  and code without its message, a second report in the same second, a name another run
  already took left as it was with the next suffix taken, and a `reports` path that is a
  file; a session starting before the window left out with its stages, a stage
  counted in its session's week, the stage and project tables agreeing per week, and the
  session wall-clock beside the stage wall-clock;
- after every run: the sentinel — carried by every free-text meta field and ticket field
  too — in no digest, report, stdout, stderr or ticket dataset; the store and the ticket
  trees unchanged; digest and report modes 0600 and directory modes 0700; nothing written
  outside `$HOME/.feature-pipeline/insights/`.

It runs in `.github/workflows/validation.yml` and in the check chain in `AGENTS.md`, and so
does this repository's `scripts/check-insights-parity.mjs`, which holds the weighted units
of the `-ROOT-pipeline` fixture sessions equal to `scripts/measure-session.py`'s.
