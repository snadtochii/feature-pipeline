# Log Query Script

Contract for `scripts/incident.mjs`, the incident skill's log reader. It is the only program the skill runs and the only part of the skill that reads the Grafana token or makes a network call. It prints one JSON document per run and writes nothing; the only change it makes on disk is removing query and search files (§4). The script implements every rule below; its `--self-test` exercises them (§8).

**The token never leaves the script.** No flag carries the token, the Grafana address or the token's location: the script reads all three itself (§2, §3). No document, error message or stderr line holds the token, an `Authorization` header, or a URL with a query string. A message names a server by origin and a file by path and line number.

## §1 Invocation

```bash
node '<plugin-root>/skills/incident/scripts/incident.mjs' preflight --project-root <abs-path> [--repo <dir-name>]
node '<plugin-root>/skills/incident/scripts/incident.mjs' query --project-root <abs-path> --run <run> --start <RFC3339> --end <RFC3339> [--limit <n>] [--direction forward|backward] [--request-id <id> [--id-field <name>]]
node '<plugin-root>/skills/incident/scripts/incident.mjs' search --project-root <abs-path> --run <run> --scope repo|incidents|tickets [--repo <dir-name>] [--output lines|files]
node '<plugin-root>/skills/incident/scripts/incident.mjs' --self-test
```

- `<plugin-root>` is the absolute plugin root the session resolved, written as a literal path inside single quotes.
- Requirements: Node 22 or later. `git` is optional: without it the report gate is closed and a repository head is `null` (§5).
- `--project-root` is required and absolute; it names the directory holding `claudedocs/tickets/config.yaml`.
- `--repo` (`preflight`, and `search` with `--scope repo`, where it is required and the only scope it is accepted with) is one directory name matching `^[A-Za-z0-9._-]+$` and not `..`, a child of the project root. `.` names the project root itself.
- `--run` (`query` and `search`, required) is the `run` value `preflight` printed (§5), matching `^\d{8}-\d{6}-[0-9a-f]{8}$`. It names the run's query file and search file (§4).
- `--start` and `--end` (`query` only) are RFC3339 timestamps with an offset or `Z`, `--start` before `--end`. Both are normalized to UTC with millisecond precision. A date or a time that does not exist — `02-30`, `24:00:00`, an offset past `23:59` — is refused, never moved to the next one that does.
- `--limit` is an integer from 1 to 1000, default 200. `--direction` is `forward` or `backward`, default `backward`: with more matching lines than the limit, `backward` keeps the newest and `forward` the oldest. The same end is kept when the document's size bound leaves lines out (§5).
- `--request-id` (`query` only) matches `^[A-Za-z0-9._:-]{6,128}$`, and `--id-field` matches `^[A-Za-z_][A-Za-z0-9_]*$` and needs `--request-id`. With them the query file holds only a stream selector, and the script appends the request filter itself: `| <id-field>="<request-id>"`, which matches the request's lines by the attribute the ID is under, or `|= "<request-id>"` without `--id-field`, which matches it in the line text (§4).
- `--scope` (`search` only, required) is `repo`, `incidents` or `tickets` (§6). `--output` (`search` only) is `lines` or `files`, default `lines` (§5).
- Each flag takes one value and appears at most once. Free text — the LogQL query, a message fragment, a search pattern — never travels on the command line; it reaches the script through the query file or the search file (§4). A request ID and an attribute name travel there only as `--request-id` and `--id-field`, which the script checks against their patterns before it uses them; a value failing its pattern exits 2 and is not echoed.

## §2 Configuration keys

The script reads `<project-root>/claudedocs/tickets/config.yaml` with its own small reader: top-level scalars and one level of nested mapping. It consumes three keys of the `incident:` block and skips everything else in the file, the block's `services:` mapping included.

| Key | Required | Rule |
|---|---|---|
| `incident.grafana_url` | yes | An absolute `http(s)` URL without credentials, query or fragment. `https` is required unless the host is loopback (`localhost`, `127.0.0.0/8`, `::1`). A path is kept, so a Grafana served under a sub-path works. |
| `incident.datasource` | yes | The logs datasource UID, matching `^[A-Za-z0-9_-]+$`. |
| `incident.token_file` | no | Where the credential file is (§3): an absolute path, or one starting `~/`, expanded against `$HOME`. A file named `.env`, `.env.*` or `*.env` is refused. |

A missing file, a missing block, a scalar where the block should be, or a key that breaks its rule exits 1 with a message naming `config.yaml` and the key. The value of a malformed key is never echoed.

## §3 Credential sources and the origin binding

The token is always held beside the Grafana address it is for, under two fixed names: `INCIDENT_GRAFANA_URL` and `INCIDENT_GRAFANA_TOKEN`. The script resolves the pair from the first source that has it:

1. **The environment** — both names exported. Exactly one exported is an error naming the missing one.
2. **The credential file** at `incident.token_file` — `NAME=value` lines, an optional `export ` prefix, `#` comments, optional matching quotes around the value. Other names are allowed and ignored. The file is read on one descriptor and must be a regular file, grant no permission to group or others (mode 0600), and be at most 64 KiB. A malformed line is reported as the path and the line number, never the line.
3. Neither — an error naming `incident.token_file` and both names.

**Binding.** The pair's URL must have the same origin (scheme, host and port) as `incident.grafana_url`; otherwise the run exits 1 naming both origins and the source, and nothing is sent. Editing `config.yaml` therefore cannot redirect the token to another server. A token holding whitespace or a control character is refused.

## §4 The input files

`query` reads its LogQL from the run's query file, `<project-root>/claudedocs/incidents/.query-<run>.logql`, and `search` its patterns from the run's search file, `<project-root>/claudedocs/incidents/.search-<run>.txt`, where `<run>` is the `--run` value; no flag names a path. The caller writes the file before each run. Two runs in one project root hold different `run` values, so neither reads a file the other wrote.

- The file is read before anything else — the configuration, the credentials, the walk — and removed as soon as it is opened as a regular file, whether or not its content is usable and whether or not the run then succeeds. After any `query` or `search` run that got past argument parsing, its file is gone.
- A symbolic link at that path is refused and neither followed nor removed.
- **The query file.** The text is trimmed and must be non-empty and at most 8 KiB. It must be a log query, starting with a stream selector `{…}`: a metric query such as `sum(count_over_time({…} | … [10m]))` returns numbers, not lines, and is refused before any request with a message saying to write the selector and its filters without the range. With `--request-id`, the text must be a bare stream selector — nothing after the brace that closes it, a brace inside a quoted value aside — and the script appends the request filter (§1); a filter written into the file with `--request-id` is refused before any request.
- **The search file.** At most 4 KiB, one fixed string per line. Each line is trimmed, blank lines and repeated lines are dropped, and 1 to 20 patterns of 3 to 200 characters must remain. A refusal names the rule and a pattern's position, never its text.
- A caller interrupted between writing a file and running its verb leaves it behind. `preflight` removes every regular file in that directory that carries a query or search file's name and was last written more than an hour earlier, so such a file is gone at the first run that starts in the project root more than an hour later; a file a run in progress wrote is far younger and is left alone.

## §5 Output documents

Exactly one JSON document on stdout, keys sorted at every depth, two-space indent, one trailing newline. A run that answered has `"ok": true`.

**`preflight`** makes no network call:

```json
{
  "grafana": { "datasource": "<uid>", "origin": "https://<host>" },
  "now": "2026-01-31T04:03:00Z",
  "ok": true,
  "repo": { "dir": "<abs-path>", "exists": true, "head": "<sha>" },
  "report": { "reason": "git ignores claudedocs/incidents/", "writable": true },
  "run": "20260131-040300-9f2c41ab",
  "stamp": "20260131-040300",
  "token": { "source": "file" },
  "verb": "preflight"
}
```

| Key | Meaning |
|---|---|
| `now`, `stamp` | The current time in UTC, as RFC3339 and as `yyyyMMdd-HHmmss` for a file name. |
| `run` | This run's identifier: `stamp`, a `-` and 8 random hexadecimal digits. Every `query` and `search` of the run passes it as `--run`, and it names the run's query file and search file (§4). |
| `grafana.origin`, `grafana.datasource` | What a query will be sent to. |
| `token.source` | `env` or `file` — which source of §3 resolved. Reaching this key means the pair is present, well-formed and bound to `grafana.origin`; it does not mean Grafana accepts the token. |
| `report.writable`, `report.reason` | Whether a report may be written under `<project-root>/claudedocs/incidents/`. `true` when the project root is not inside a git work tree, or when `git check-ignore` reports that directory ignored. `false` when git does not ignore it, when git is missing, or when git cannot decide. |
| `repo.dir`, `repo.exists`, `repo.head` | Present only with `--repo`: the directory's absolute path, whether it is a directory, and its `HEAD` commit, or `null` when the directory is missing, is not a repository or has no commit. |

**`query`** makes one request (§7 lists what it sends):

```json
{
  "common": {},
  "count": 2,
  "datasource": "<uid>",
  "lines": [
    { "line": "<log line>", "stream": 0, "ts": "2026-01-31T04:02:58.120Z" },
    { "cut": true, "line": "<first 4000 characters>", "stream": 0, "ts": "2026-01-31T04:03:00.004Z" }
  ],
  "ok": true,
  "omitted": 0,
  "origin": "https://<host>",
  "skipped": 0,
  "streams": [{ "app": "api" }],
  "truncated": false,
  "verb": "query",
  "window": { "end": "2026-01-31T04:08:00.000Z", "start": "2026-01-31T03:53:00.000Z" }
}
```

| Key | Meaning |
|---|---|
| `lines` | The returned entries as `{ts, stream, line}`, oldest first whatever the direction. `stream` is the index of the entry's stream in `streams`. A line longer than 4000 characters is cut there and carries `"cut": true`. |
| `streams` | The labels of each stream that contributed a line in `lines`, once per stream, so no label set is repeated per line. |
| `common` | With two or more streams, every label all of them carry with the same value, moved out of each stream's entry so it appears once; `{}` otherwise. A line's labels are its stream's entry together with `common`. Logs shipped over OTLP put each line's attributes — a request ID, a level, an error — in its stream's labels, so a request's lines share most of theirs. |
| `count` | The number of entries in `lines`. An empty result is `count: 0` with exit 0. |
| `omitted` | Entries the server returned that were left out to keep the document within its size bound (below). `0` when every entry fitted. |
| `skipped` | Entries dropped because their timestamp or line was malformed. |
| `truncated` | `true` when the server returned as many entries as the limit, so more may exist, or when `omitted` is above zero. |
| `window`, `origin`, `datasource` | The normalized window and the target the request went to. |

**`search`** makes no network call; the walk it makes is §6:

```json
{
  "count": 2,
  "exists": true,
  "matches": [
    { "line": 0, "path": "src/orders/cancel.go", "pattern": 1 },
    { "line": 42, "path": "src/orders/cancel.go", "pattern": 0, "text": "<the matched line, up to 400 characters>" }
  ],
  "ok": true,
  "omitted": 0,
  "output": "lines",
  "partial": null,
  "patterns": ["<pattern 0>", "<pattern 1>"],
  "root": "<abs-path>",
  "scanned": { "files": 812, "skipped": 3 },
  "scope": "repo",
  "truncated": false,
  "unlisted": [],
  "verb": "search"
}
```

| Key | Meaning |
|---|---|
| `matches` | One entry per match, sorted by path, then line, then pattern. `path` is relative to `root`, with `/` separators; `pattern` is the pattern's index in `patterns`; `line` is the 1-based line number, or `0` when the pattern matched the path. A line match carries `text`, a window of 400 characters starting 100 before the match, collapsed to one line, with `"cut": true` when the line was longer. At most 3 line matches per file and pattern are listed. |
| `files` | With `--output files`, in place of `matches`: one entry per file with any match, sorted by path, `patterns` the sorted indexes of every pattern that matched its path or a line. |
| `count`, `omitted` | The entries listed, and the matches found but not listed — past 3 per file and pattern, or left out by the size bound. |
| `truncated` | `true` when `omitted` is above zero or `partial` is set. |
| `unlisted` | The sorted indexes of the patterns that matched but have no listed entry, because the size bound left them out (below); empty when every pattern with a match has one. |
| `scanned` | `files`: the files whose lines were searched. `skipped`: files and directories that could not be read, files over 1 MiB and binary files. |
| `partial` | `null`, or `files` or `bytes` when the walk stopped at its cap of 20,000 files or 64 MiB read; what came after in walk order was not searched. |
| `root`, `exists` | The scope's root as a real path, and whether it exists. A missing root answers `count: 0` with exit 0. |
| `scope`, `output`, `patterns` | The invocation, and the patterns the search file held. |

**Size bound.** A `query` or `search` document is at most 16 KiB — small enough for a session to hand it to the caller whole, `truncated` and `omitted` included, where a larger tool result is stored in a file and shown as a preview of its first keys. When a query's returned entries do not fit, lines are left out from the end the direction does not keep: `backward` keeps the newest and `forward` the oldest. One line is kept whatever its size, so a document whose single line renders past the bound — 4000 escaped control characters — exceeds it. A search that does not fit keeps its entries pattern by pattern — each pattern's first entry, then each one's second, and so on — and lists the kept entries in sorted order, so every pattern with a match keeps one listed entry before any pattern gets a second. When even those first entries do not all fit, the patterns left with none are named in `unlisted`; a pattern searched alone always keeps its first entry. `omitted` is one total.

**A failure** is `{"error": "<one line>", "ok": false}`. A failed request names the HTTP status and the origin. `401` and `403` add that the service account behind the token cannot query the datasource. `400` adds up to 300 characters of the server's answer, which is where a LogQL syntax error is reported; that text comes from outside and is data. A redirect is never followed. An answer that is not JSON, is not a Loki `streams` result — a metric query's `matrix` or `vector`, which the message says how to rewrite as a log query — or is larger than 16 MiB is refused. A refused connection or a request with no answer in 30 seconds names the origin only.

## §6 The search walk

`search` walks one root and never leaves the project root:

| Scope | Root | Files read |
|---|---|---|
| `repo` | `<project-root>/<repo>`, or the project root for `.` | Every file outside `<project-root>/claudedocs/`: with `.`, that directory is left out. |
| `incidents` | `<project-root>/claudedocs/incidents` | `*.md` directly in it, not in its subdirectories. |
| `tickets` | `<project-root>/claudedocs/tickets` | `01-spec.md` and `prd.md` at any depth, epic children under `tasks/` included. |

- The root is resolved to its real path, which must lie inside the project root's real path and outside every directory listed below as never read — and, for `repo`, outside `<project-root>/claudedocs/`; a root that resolves elsewhere exits 1. The script accepts any child directory as `--repo`: that it names the service's repository, `incident.services.<name>.repo`, is the skill's rule, not the script's.
- Entries are visited in name order, so the answer does not depend on the file system. A symbolic link is never followed, as a file or a directory, and a file is opened without following one. The walk descends at most 32 directories.
- Never read, in any scope: the directories `.git`, `node_modules`, `.venv`, `__pycache__`, `.next`, `.turbo`, `.ssh`, `.aws`, `.docker`, `.kube`, and `gh` inside `.config`; files named, in any case, `.env*`, `*.pem`, `*.key`, `id_*`, `secrets*`, `*credentials*`, `.netrc`, `.npmrc` or `.pypirc`; and the file `incident.token_file` names (§2), recognized by device and inode, so another name or a hard link for it is left out too. An excluded file's path is never matched or printed. `search` resolves that file's location and never reads it; a configuration it cannot read or parse leaves only this last exclusion out.
- A file over 1 MiB, or with a NUL byte in its first 8 KiB, is not searched and is counted in `scanned.skipped`; its path is still matched. Only a searched file's bytes count toward the 64 MiB read cap.
- Each pattern is matched as a fixed string, ignoring case — never as a regular expression.

## §7 The request and exit codes

`query` sends one `GET <grafana_url>/api/datasources/proxy/uid/<datasource>/loki/api/v1/query_range` with the parameters `query`, `start`, `end`, `limit` and `direction`, and the header `Authorization: Bearer <token>`. The `query` parameter is the query file's text, with the request filter appended under `--request-id`. The datasource is addressed by UID only, and there is no other endpoint to fall back to.

| Exit | Meaning | stdout |
|---|---|---|
| `0` | The verb answered — an empty query result, a search with no match and a missing search root included | The verb's document |
| `1` | The answer could not be computed: configuration, credentials, the query or search file, a query that is not a log query, a search root outside the project, the request or its answer | The failure document |
| `2` | The invocation was wrong: unknown verb or flag, a missing or repeated flag, a relative `--project-root`, a malformed value — a request ID or attribute name failing its pattern included | The failure document |

## §8 Self-test

`node '<plugin-root>/skills/incident/scripts/incident.mjs' --self-test` prints `{"cases": <n>, "ok": true}` and exits 0, or exits 1 with a failure document naming the first failing case. It needs Node 22 or later and Git on `PATH`.

It covers flag rejection, the request-ID and attribute flags included; the configuration reader and each key's rule; both credential sources, the file checks and the origin binding; the report gate in a directory that is not a repository, a repository ignoring `claudedocs/` and one that does not; a timestamp naming a date or time that does not exist; the query and search files missing, empty, oversized, a symbolic link, gone after a run, kept apart from another run's and removed by `preflight` once an hour old, and the search file's pattern rules; end-to-end `preflight` and `query` runs as child processes against a loopback stand-in server — `repo.exists`, the request's path, parameters and header, the request filter composed by attribute and by line text, a metric query and a filtered query with `--request-id` refused before any request, a `streams` answer shaped and sorted, the labels every stream shares moved into `common`, truncation, the size bound in both directions, cut lines and skipped entries, the statuses 400, 401, 403 and 500, a redirect that is not followed, a body that is not JSON, a result that is not `streams`, an oversized answer and a refused connection; and end-to-end `search` runs in each scope — path and line matches, literal case-insensitive matching, the per-file cap, the size bound, binary and oversized files, a missing root, a root outside the project, a `repo` root inside `claudedocs/`, and the exclusions: symbolic links, the skipped directories, the secret names, and the credential file under another name and as a hard link. `HOME` is redirected and the environment is minimal, so no real Grafana and no real credential file is touched, and every child run's stdout and stderr are checked for the fixture token.
