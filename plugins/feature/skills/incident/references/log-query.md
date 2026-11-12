# Log Query Script

Contract for `scripts/incident.mjs`, the incident skill's log reader. It is the only program the skill runs and the only part of the skill that reads the Grafana token or makes a network call. It prints one JSON document per run and writes nothing; the only change it makes on disk is removing query files (§4). The script implements every rule below; its `--self-test` exercises them (§7).

**The token never leaves the script.** No flag carries the token, the Grafana address or the token's location: the script reads all three itself (§2, §3). No document, error message or stderr line holds the token, an `Authorization` header, or a URL with a query string. A message names a server by origin and a file by path and line number.

## §1 Invocation

```bash
node '<plugin-root>/skills/incident/scripts/incident.mjs' preflight --project-root <abs-path> [--repo <dir-name>]
node '<plugin-root>/skills/incident/scripts/incident.mjs' query --project-root <abs-path> --run <run> --start <RFC3339> --end <RFC3339> [--limit <n>] [--direction forward|backward]
node '<plugin-root>/skills/incident/scripts/incident.mjs' --self-test
```

- `<plugin-root>` is the absolute plugin root the session resolved, written as a literal path inside single quotes.
- Requirements: Node 22 or later. `git` is optional: without it the report gate is closed and a repository head is `null` (§5).
- `--project-root` is required and absolute; it names the directory holding `claudedocs/tickets/config.yaml`.
- `--repo` (`preflight` only) is one directory name matching `^[A-Za-z0-9._-]+$` and not `..`, a child of the project root. `.` names the project root itself.
- `--run` (`query` only, required) is the `run` value `preflight` printed (§5), matching `^\d{8}-\d{6}-[0-9a-f]{8}$`. It names the run's query file (§4).
- `--start` and `--end` (`query` only) are RFC3339 timestamps with an offset or `Z`, `--start` before `--end`. Both are normalized to UTC with millisecond precision. A date or a time that does not exist — `02-30`, `24:00:00`, an offset past `23:59` — is refused, never moved to the next one that does.
- `--limit` is an integer from 1 to 1000, default 200. `--direction` is `forward` or `backward`, default `backward`: with more matching lines than the limit, `backward` keeps the newest and `forward` the oldest. The same end is kept when the document's size bound leaves lines out (§5).
- Each flag takes one value and appears at most once. Free text — the LogQL query, a request identifier, a message fragment — never travels on the command line; it reaches the script through the query file (§4).

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

## §4 The query file

`query` reads its LogQL from the run's own file, `<project-root>/claudedocs/incidents/.query-<run>.logql`, where `<run>` is the `--run` value; no flag names a path. The caller writes the query there before each `query` run. Two runs in one project root hold different `run` values, so neither reads a query the other wrote.

- The file is read before the configuration and the credentials, and removed as soon as it is opened as a regular file — whether or not its content is usable and whether or not the query then succeeds. After any `query` run that got past argument parsing, the file is gone.
- The text is trimmed and must be non-empty and at most 8 KiB.
- A symbolic link at that path is refused and neither followed nor removed.
- A caller interrupted between writing the file and running `query` leaves it behind. `preflight` removes every regular file in that directory that carries a query file's name and was last written more than an hour earlier, so such a file is gone at the first run that starts in the project root more than an hour later; a file a run in progress wrote is far younger and is left alone.

## §5 Output documents

Exactly one JSON document on stdout, keys sorted at every depth, two-space indent, one trailing newline. A run that answered has `"ok": true`.

**`preflight`** makes no network call:

```json
{
  "grafana": { "datasource": "<uid>", "origin": "https://<host>" },
  "now": "2026-01-31T04:03:00Z",
  "ok": true,
  "repo": { "dir": "<abs-path>", "head": "<sha>" },
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
| `run` | This run's identifier: `stamp`, a `-` and 8 random hexadecimal digits. Every `query` of the run passes it as `--run`, and it names the run's query file (§4). |
| `grafana.origin`, `grafana.datasource` | What a query will be sent to. |
| `token.source` | `env` or `file` — which source of §3 resolved. Reaching this key means the pair is present, well-formed and bound to `grafana.origin`; it does not mean Grafana accepts the token. |
| `report.writable`, `report.reason` | Whether a report may be written under `<project-root>/claudedocs/incidents/`. `true` when the project root is not inside a git work tree, or when `git check-ignore` reports that directory ignored. `false` when git does not ignore it, when git is missing, or when git cannot decide. |
| `repo.dir`, `repo.head` | Present only with `--repo`: the directory's absolute path and its `HEAD` commit, or `null` when the directory is missing, is not a repository or has no commit. |

**`query`** makes one request (§6 lists what it sends):

```json
{
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
| `count` | The number of entries in `lines`. An empty result is `count: 0` with exit 0. |
| `omitted` | Entries the server returned that were left out to keep the document within its size bound (below). `0` when every entry fitted. |
| `skipped` | Entries dropped because their timestamp or line was malformed. |
| `truncated` | `true` when the server returned as many entries as the limit, so more may exist, or when `omitted` is above zero. |
| `window`, `origin`, `datasource` | The normalized window and the target the request went to. |

**Size bound.** The `query` document is at most 16 KiB — small enough for a session to hand it to the caller whole, `truncated` and `omitted` included, where a larger tool result is stored in a file and shown as a preview of its first keys. When the returned entries do not fit, lines are left out from the end the direction does not keep: `backward` keeps the newest and `forward` the oldest. One line is kept whatever its size, so a document whose single line renders past the bound — 4000 escaped control characters — exceeds it.

**A failure** is `{"error": "<one line>", "ok": false}`. A failed request names the HTTP status and the origin. `401` and `403` add that the service account behind the token cannot query the datasource. `400` adds up to 300 characters of the server's answer, which is where a LogQL syntax error is reported; that text comes from outside and is data. A redirect is never followed. An answer that is not JSON, is not a Loki `streams` result, or is larger than 16 MiB is refused. A refused connection or a request with no answer in 30 seconds names the origin only.

## §6 The request and exit codes

`query` sends one `GET <grafana_url>/api/datasources/proxy/uid/<datasource>/loki/api/v1/query_range` with the parameters `query`, `start`, `end`, `limit` and `direction`, and the header `Authorization: Bearer <token>`. The datasource is addressed by UID only, and there is no other endpoint to fall back to.

| Exit | Meaning | stdout |
|---|---|---|
| `0` | The verb answered — an empty query result included | The verb's document |
| `1` | The answer could not be computed: configuration, credentials, the query file, the request or its answer | The failure document |
| `2` | The invocation was wrong: unknown verb or flag, a missing or repeated flag, a relative `--project-root`, a malformed value | The failure document |

## §7 Self-test

`node '<plugin-root>/skills/incident/scripts/incident.mjs' --self-test` prints `{"cases": <n>, "ok": true}` and exits 0, or exits 1 with a failure document naming the first failing case. It needs Node 22 or later and Git on `PATH`.

It covers flag rejection; the configuration reader and each key's rule; both credential sources, the file checks and the origin binding; the report gate in a directory that is not a repository, a repository ignoring `claudedocs/` and one that does not; a timestamp naming a date or time that does not exist; the query file missing, empty, oversized, a symbolic link, gone after a run, kept apart from another run's and removed by `preflight` once an hour old; and end-to-end `preflight` and `query` runs as child processes against a loopback stand-in server — the request's path, parameters and header, a `streams` answer shaped and sorted, truncation, the size bound in both directions, cut lines and skipped entries, the statuses 400, 401, 403 and 500, a redirect that is not followed, a body that is not JSON, a result that is not `streams`, an oversized answer and a refused connection. `HOME` is redirected and the environment is minimal, so no real Grafana and no real credential file is touched, and every child run's stdout and stderr are checked for the fixture token.
