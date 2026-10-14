# The dispatcher contract

Authoritative surface for `dispatch.mjs`, the deterministic half of the night dispatcher.
The contract fixes the verbs, their flags, the configuration keys, the selection and cap
rules, the output documents, the exit codes, the lock, and the state layout. The
implementation behind it is private and may change without changing this file.

The division of labour: the dispatcher owns **decisions that need no model** — which
tickets are eligible tonight, whether a cap or a lock says no, what gets recorded. The
sessions that build the admitted tickets own everything else. The dispatcher never
judges a ticket's content.

---

## §1 Invocation

```text
node <plugin-root>/scripts/dispatch/dispatch.mjs plan --project-root <abs-path>
node <plugin-root>/scripts/dispatch/dispatch.mjs run  --project-root <abs-path>
node <plugin-root>/scripts/dispatch/dispatch.mjs --self-test
```

| Part | Meaning |
|---|---|
| `<plugin-root>` | The installed `feature` plugin's root directory. |
| `plan` | §9. Answers what a run would do, acquiring nothing and writing nothing. |
| `run` | §10. Takes the lock, decides, records the run and writes its report. |
| `--project-root` | The project to dispatch for: an absolute path to an existing directory inside a git repository. |
| `--self-test` | §13. Takes no verb and no other flag. |

Only `dispatch.mjs` is a command. Everything under `lib/` is private to the implementation
and may change shape without changing this contract.

The dispatcher is invoked directly with `node`, with an argument vector. It is never
sourced, never wrapped in a shell string, and never given arguments assembled by string
concatenation.

**Runtime.** Node 22 or newer. The dispatcher has no dependency of any kind beyond Node's
standard library.

**Storage mode.** The dispatcher serves server-native projects only: it reads tickets from
the personal server, never from a ticket folder tree. A project whose configuration does
not select server-native storage exits 1 (§5).

**One project, one run at a time.** A run works one project, and its admitted items are
taken in order, one after another. Concurrent runs on the same repository are excluded by
the lock (§11).

## §2 Output rules

Every run prints **exactly one JSON document** on stdout, followed by a newline, and
nothing else. Output of the processes the dispatcher starts (`git`, `gh`) is captured,
never passed through to stdout.

- **Object keys are sorted recursively**, ascending, by code unit.
- **Arrays are in a stated order** — every array-valued key below names its ordering.
- Two-space indentation, one trailing newline.

No document, report or record ever carries the server credential, the content of the
credential file, or a URL with userinfo in it (§6).

## §3 Exit codes

| Code | Meaning | Document |
|---|---|---|
| `0` | An answer was computed. This includes **nothing to dispatch**: no eligible ticket, a cap already met, or a failed precondition. | The verb's document from §9–§10. |
| `1` | The answer could not be computed: the project is not server-native, the configuration is invalid, the server is unreachable or rejects the request, the project root is not in a git repository, the lock is held by a live run, the state directory cannot be written, `gh` cannot list the open pull requests during `run`, or the process was interrupted by a signal. | `{"error": "<reason>"}` |
| `2` | The invocation was wrong: no verb or an unknown verb, an unknown or repeated flag, a missing or empty `--project-root`, a relative path, a path that is not an existing directory, or `--self-test` with anything beside it. | `{"error": "<reason>"}` |

A caller distinguishes "nothing to do tonight" from "the dispatcher is broken" by the exit
code alone. Both non-zero paths print the same `{"error"}` shape, so stdout always parses.
`<reason>` is one line. Everything that is wrong with an invocation is detected before
anything runs: an exit 2 never follows a lock acquisition, a request or a write.

## §4 Flags and filesystem discipline

Long flags only. Both `--flag value` and `--flag=value` are accepted. A flag given twice, a
flag the verb does not take, or a positional argument exits 2.

**Every path flag is absolute.** `--project-root` must be an absolute path to an existing
directory; anything else exits 2. There is no working-directory resolution to reason about.

**What the dispatcher reads.** `claudedocs/tickets/config.yaml` under the project root
(§5); the environment and the credential file (§6); the state directory (§12).

**What it writes, and where.** The lock directory inside the repository's git common
directory (§11) and the state directory under `$HOME/.feature-pipeline/dispatch/` (§12).
`run` writes both; `plan` writes neither. It never writes into the project's working tree.

**What it executes.** `git rev-parse` (to find the git common directory) and `gh pr list`
(to count open pull requests, §8), each with an argument vector and the project root as its
working directory. Nothing else.

## §5 Configuration

Read from `<project-root>/claudedocs/tickets/config.yaml`.

| Key | Required | Meaning |
|---|---|---|
| `mode` | yes | Must be `server-native`. A missing file, a missing key, or any other value exits 1 with `fs-native projects are not dispatched`. |
| `project` | yes | The server project's UUID — the `project_id` the pipeline routes take. A missing or non-UUID value exits 1 naming the key. |
| `dispatch.tag` | no | The tag that marks a ticket for dispatch. Default `agent-ready`. Compared case-sensitively. An empty value exits 1. |
| `dispatch.max_age_days` | no | A ticket whose `updated_at` is older than this many days is skipped as `stale`. Default `14`. |
| `dispatch.max_tickets_per_run` | no | Tickets one run may build (§8). Default `2`. |
| `dispatch.max_open_prs` | no | Open pull requests from dispatched work allowed at once (§8). Default `3`. |

The three numeric keys must be positive integers; anything else exits 1 naming the key.

**Defaults.** A missing `dispatch:` block takes every default, with one line in `notes`
saying so. A partial block takes the default for each missing key, with one line in `notes`
per defaulted key. An unknown key under `dispatch:` is ignored with a line in `notes`.

**The reader.** The dispatcher reads only the keys above. It understands top-level
`key: value` scalars and one level of nested mapping, strips one matched pair of quotes,
and skips blank lines, full-line comments and ` #` inline comments outside quotes. Deeper
nesting, sequence items and every other block (`test:`, `git:`, `worktree:`) are skipped
without being interpreted. A byte-order mark and CRLF line endings are accepted.

The effective values are echoed under `config` in every document.

## §6 Server access

The dispatcher reaches the personal server the way the `personal-server` CLI does.

| Source | Name |
|---|---|
| Base URL | `PERSONAL_SERVER_URL` in the environment, else the credential file's value, else `http://localhost:7717`. Trailing slashes are dropped and `/api` is appended. |
| Token | `PERSONAL_SERVER_CLIENT_TOKEN` in the environment, else the credential file's value. An empty value counts as unset. |
| Credential file | The absolute path in `PERSONAL_SERVER_CLI_CONFIG` (a relative one exits 1), else `$HOME/.config/personal-server/cli.env`. A missing file is not an error. |

A base URL that is not an absolute `http:` or `https:` URL, or that carries userinfo, a
query or a fragment, exits 1 before any request, naming where it came from but not the
value.

The credential file is read only when the URL or the token is missing from the environment.
It is held to the CLI's rules: a regular file, no group or other permission bit (mode
0600), at most 64 KiB, every non-blank, non-comment line `NAME=value` with an optional
`export ` prefix, one matched pair of quotes stripped, and a value for one of the read
names free of whitespace and control characters. Only `PERSONAL_SERVER_URL` and
`PERSONAL_SERVER_CLIENT_TOKEN` are taken from it; the server project comes from `project`
in the configuration (§5), never from the environment or the file. A file that breaks a
rule exits 1 naming the path and, for a malformed line, its number — never its content.

**Token binding.** A token taken from the file is sent only to the origin of the file's own
`PERSONAL_SERVER_URL`, or `http://localhost:7717` when the file names none. A base URL from
the environment naming another origin exits 1 before any request. A token from the
environment is not bound.

**The request.** `GET <base>/api/pipeline/tickets?project_id=<project>`, with
`Authorization: Bearer <token>` only when a token is set, a 10-second timeout, and no
redirect followed. The list is the reachability probe.

| Outcome | Exit |
|---|---|
| A JSON array | Rows (§7). An empty array adds a `notes` line naming the project id, so a wrong id is visible. |
| No response (refused, timed out, DNS) | 1, `server unreachable at <origin>`. |
| A non-2xx status | 1, `server rejected the request: HTTP <status> (token source: <env\|file\|none>)`. |
| A body that is not a JSON array | 1. |

Messages name the server by origin only. A row missing a field the dispatcher needs (`id`,
`status`, `kind`, `tags`, `blocked_by`, `created_at`, `updated_at`) is dropped with a line in
`notes`.

## §7 Selection

Selection works over the project's whole ticket list, with `now` the time of the run.

- **Tagged** means the row's `tags` contains `dispatch.tag`.
- **Terminal** means a status of `done` or `cancelled`.
- **Fresh** means `now − updated_at ≤ max_age_days` days.

Tagged tickets whose own status is terminal are omitted entirely. Every other tagged row is
either a **candidate** or a **skip**:

| Row | Candidate when | Otherwise skipped as (first that applies) |
|---|---|---|
| A solo ticket, or a child whose epic is not tagged | status `backlog`, every `blocked_by` entry names a terminal ticket, fresh. | `not backlog`, `blocked`, `stale` |
| A child whose epic is tagged | never — the epic covers it. | `covered by epic <EPIC-ID>` |
| An epic | at least one child is `backlog`; every blocker of the epic itself, and every blocker of a `backlog` child that names a ticket outside the epic, is terminal; the epic row is fresh. The epic row's own status does not decide it: it follows its most advanced child. | `no backlog children`, `blocked`, `stale` |

A `blocked_by` entry that names no ticket in the list counts as not terminal. A blocker
between two children of the same epic is the epic walk's concern, not selection's. An
unparseable `updated_at` is `stale`, with a line in `notes`.

An epic candidate is one item whose `tickets` are its `backlog` children. Every other
candidate's `tickets` is the ticket itself.

**Order.** Candidates, and separately skips, are ordered by `created_at` ascending, ties by
`id`. `tickets` inside an epic item is ordered by ticket number.

## §8 Caps and admission

Admission walks the candidates in order and admits a prefix of them.

**Open pull requests.** `open_prs` is the number of open pull requests in the project's
repository that are either recorded in `runs.json` (§12) as opened by a dispatched item, or
titled `<ID>:` for a tagged ticket's id (an epic's id included), counted once each by URL.
Both come from one `gh pr list --state open --limit 1000 --json number,title,url` call,
run in the project root, so at most 1000 open pull requests are seen.

**Weights.** Every admitted item takes one pull-request slot: a solo ticket opens one pull
request, and an epic opens one integration pull request. Its ticket weight is the length
of its `tickets`.

**Rules, in order, for each candidate:**

1. When `open_prs` plus the items already admitted reaches `max_open_prs`, admission stops:
   this and every later candidate is not admitted, reason `pr cap`.
2. The first candidate is admitted whatever its ticket weight — an epic with more `backlog`
   children than `max_tickets_per_run` is admitted alone and fills the run.
3. Any later candidate whose weight would take the admitted ticket count past
   `max_tickets_per_run` stops admission: this and every later candidate is not admitted,
   reason `ticket cap`. A younger candidate never jumps ahead of an older one that did not
   fit.

When `gh` cannot list the open pull requests, `open_prs` is `null`, nothing is admitted,
and every candidate is not admitted with reason `open PRs unknown` (in `plan`; `run` exits
1 instead, §10).

**The `caps` object:**

| Key | Meaning |
|---|---|
| `open_prs` | The count above, or `null` when it could not be computed. |
| `max_open_prs`, `max_tickets_per_run` | The configured caps. |
| `tickets_admitted` | Sum of the admitted items' ticket weights. |
| `reason` | Why admission stopped or could not start — `max_open_prs reached (<n>/<max>)` (also when the cap is already met and there is no candidate), `max_tickets_per_run reached (<n>/<max>)`, `max_tickets_per_run has no room for <ID> (<n>/<max>, needs <weight>)`, `open PRs could not be counted` — or `null` when no cap stopped admission. |

## §9 `plan`

```text
node dispatch.mjs plan --project-root <abs-path>
```

Answers what `run` would do now. It acquires no lock, creates no directory, writes no file,
and starts nothing beyond `git rev-parse` and `gh pr list`.

**Order of work.** Resolve the git common directory and project name → read the
configuration → list the tickets → list open pull requests → select → admit → check the
preconditions → print.

```json
{
  "admitted": [
    { "created_at": "2026-10-01T09:00:00.000Z", "id": "ABC-12", "kind": "solo", "tickets": ["ABC-12"] }
  ],
  "candidates": [
    { "created_at": "2026-10-01T09:00:00.000Z", "id": "ABC-12", "kind": "solo", "tickets": ["ABC-12"] },
    { "created_at": "2026-10-03T09:00:00.000Z", "id": "ABC-20", "kind": "epic", "tickets": ["ABC-21", "ABC-22"] }
  ],
  "caps": {
    "max_open_prs": 3,
    "max_tickets_per_run": 2,
    "open_prs": 1,
    "reason": "max_tickets_per_run has no room for ABC-20 (1/2, needs 2)",
    "tickets_admitted": 1
  },
  "config": { "max_age_days": 14, "max_open_prs": 3, "max_tickets_per_run": 2, "tag": "agent-ready" },
  "not_admitted": [{ "id": "ABC-20", "reason": "ticket cap" }],
  "notes": ["config.yaml has no dispatch: block — using every default"],
  "ok": true,
  "preconditions": [
    { "detail": "/usr/local/bin/claude", "name": "claude", "ok": true },
    { "detail": "/usr/local/bin/gh", "name": "gh", "ok": true },
    { "detail": "v22.11.0", "name": "node", "ok": true },
    { "detail": "HTTP 200, 9 tickets", "name": "server", "ok": true },
    { "detail": "/Users/me/.feature-pipeline/dispatch/my-app", "name": "state_dir", "ok": true }
  ],
  "project": { "id": "5b0c8a52-3f0e-4c41-9a43-2f1d7f3c9e10", "name": "my-app" },
  "skips": [{ "detail": "waiting on ABC-7 (in-progress)", "id": "ABC-9", "reason": "blocked" }],
  "verb": "plan"
}
```

| Key | Meaning |
|---|---|
| `candidates` | Every candidate, in §7 order. Each item: `id`, `kind` (`solo`, `child` or `epic`, the row's own kind), `tickets`, `created_at`. |
| `admitted` | The admitted prefix of `candidates` (§8), same item shape. |
| `not_admitted` | `{id, reason}` for every candidate not admitted, in candidate order. |
| `skips` | `{id, reason, detail}` for every skipped tagged ticket, in §7 order. `detail` names the unfinished blockers for `blocked` and the age for `stale`, else `null`. |
| `caps` | §8. |
| `config` | The effective `dispatch.*` values (§5). |
| `preconditions` | One `{name, ok, detail}` per check, sorted by `name`: `claude` and `gh` executable on `PATH`, `node` 22 or newer, `server` answered the ticket list, `state_dir` writable — the state directory, or its nearest existing ancestor when it does not exist yet. `gh` also fails when the open-PR listing failed. |
| `project` | `id` from the configuration, `name` from §12. |
| `notes` | One line per non-fatal observation, in the order made. |
| `ok` | Every precondition passed. |

## §10 `run`

```text
node dispatch.mjs run --project-root <abs-path>
```

**Order of work.** Resolve the git common directory and project name → acquire the lock
(§11) → create the state directory when absent → read the configuration → list the tickets
→ list open pull requests → select → admit → check the preconditions → the dispatch step →
append the record to `runs.json` → write the report → release the lock → print.

**The dispatch step** takes the admitted items one after another. It starts no session:
every admitted item is recorded with `outcome: "not dispatched"` and `null` for `pr_url`,
`session_id`, `exit_code` and `cost_usd`. A failed precondition skips the dispatch step.

```json
{
  "caps": { "max_open_prs": 3, "max_tickets_per_run": 2, "open_prs": 1, "reason": null, "tickets_admitted": 1 },
  "config": { "max_age_days": 14, "max_open_prs": 3, "max_tickets_per_run": 2, "tag": "agent-ready" },
  "items": [
    {
      "cost_usd": null,
      "exit_code": null,
      "id": "ABC-12",
      "kind": "solo",
      "outcome": "not dispatched",
      "pr_url": null,
      "session_id": null,
      "tickets": ["ABC-12"]
    }
  ],
  "not_admitted": [],
  "notes": [],
  "outcome": "completed",
  "preconditions": [{ "detail": "/usr/local/bin/claude", "name": "claude", "ok": true }],
  "project": { "id": "5b0c8a52-3f0e-4c41-9a43-2f1d7f3c9e10", "name": "my-app" },
  "report": "/Users/me/.feature-pipeline/dispatch/my-app/reports/2026-10-14-a1b2c3.md",
  "run_id": "2026-10-14-a1b2c3",
  "skips": [],
  "verb": "run"
}
```

| Key | Meaning |
|---|---|
| `run_id` | `<YYYY-MM-DD>-<6 hex>`, the UTC date the run started and 3 random bytes. |
| `outcome` | `completed` (the dispatch step ran over at least one item), `nothing to dispatch` (nothing admitted — `caps.reason` or the skips say why), or `preconditions failed` (items admitted but a precondition failed, so the dispatch step did not run). |
| `items` | One entry per admitted item, in admission order: `id`, `kind`, `tickets`, `outcome`, `pr_url`, `session_id`, `exit_code`, `cost_usd`. |
| `report` | Absolute path of the report written (§12). |
| `caps`, `config`, `not_admitted`, `skips`, `preconditions`, `project`, `notes` | As in `plan` (§9). `state_dir` is checked after the directory was created. |

All three outcomes exit 0.

**Failure after the lock.** Any exit 1 after the lock was acquired — the server unreachable
or rejecting, `gh` unable to list open pull requests, `runs.json` unreadable, a signal —
records the run with outcome `stopped` and an `error` line, best effort, then releases the
lock. A failure to write that record or report is appended to the error message, never
substituted for it. A run that decided but could not write its record or report exits 1
naming what was not written. A run refused because the lock is held writes nothing.

## §11 Lock

```text
<git-common-dir>/feature-dispatch.lock/
└── owner
```

`<git-common-dir>` is `git -C <project-root> rev-parse --path-format=absolute
--git-common-dir`, so every linked worktree of a repository shares one lock. A project root
outside a git repository exits 1 (`project root is not a git repository`).

**Acquire.** `mkdir` the lock directory. On success, write `owner` through a temporary file
renamed into place:

```text
run_id: 2026-10-14-a1b2c3
started: 2026-10-14T02:00:04.512Z
```

**An existing lock.** Read `owner`. Its age is measured from `started`, or — when `owner`
is missing or unparseable — from the lock directory's modification time.

| Age | Result |
|---|---|
| Under 24 hours (a `started` in the future included) | Exit 1, `lock held by run <run-id>`, or `lock held (owner unreadable)`. |
| 24 hours or more | Taken over: `owner` is re-read, the directory removed and created again with exactly one `mkdir`, and a `notes` line names the run it took over from. An owner (or, unreadable, a modification time) that changed between the two reads, or a `mkdir` that loses to a concurrent run, exits 1 (`lock taken by a concurrent run`). |

**Release.** On normal completion, on any exit 1 after acquisition, and on `SIGINT`,
`SIGTERM` or `SIGHUP`. The directory is removed only while `owner` still names this run, so
a run whose lock was taken over never removes the new owner's lock. A signal exits 1 with
`{"error": "interrupted by <SIGNAL>"}`.

## §12 State layout

```text
$HOME/.feature-pipeline/dispatch/<project-name>/
├── runs.json
└── reports/
    └── <run-id>.md
```

`<project-name>` is the name of the directory holding the git common directory — the main
checkout's directory name, shared by its linked worktrees. It must match
`^[A-Za-z0-9._-]+$` and be neither `.` nor `..`; anything else exits 1. `HOME` unset exits
1. The state lives outside every working tree.

The project directory and `reports/` are created on first use by `run`, mode 0700. Every
file is written to a temporary file beside it and renamed into place, mode 0600.

**`runs.json`** is a JSON array of run records, oldest first, appended to only while the
lock is held:

| Key | Meaning |
|---|---|
| `run_id`, `started`, `finished` | The run's id and ISO timestamps. |
| `outcome` | `completed`, `nothing to dispatch`, `preconditions failed`, or `stopped`. |
| `error` | The one-line reason for `stopped`, else `null`. |
| `items` | The `run` document's `items` (§10). |

A `runs.json` that exists but does not parse as an array exits 1 naming the file; it is
never overwritten.

**`reports/<run-id>.md`** is the run's human-readable report, with the sections
`## Outcome`, `## Dispatched` (per item: id, kind, tickets, outcome, pull request, session
id), `## Skips`, `## Caps`, `## Preconditions` and `## Notes`, in that order.

## §13 `--self-test`

```text
node dispatch.mjs --self-test
```

Exercises the whole deterministic surface without a model, a real server or a real `gh`:
argument rejection, the configuration reader and its validation, credential resolution and
token binding, selection over a fixture ticket list (blocked, stale, not backlog, epics,
children of a tagged epic, ordering), the open-PR count, admission under both caps, the lock
(acquire, held, stale takeover, unreadable owner, release only by its owner) in a temporary
git repository, the report sections, the sorted-key document shape, and end-to-end `plan`
and `run` invocations against a loopback stand-in server and a stand-in `gh` with `HOME`
redirected. Prints `{"cases": <n>, "ok": true}` and exits 0 when every case passes;
otherwise prints `{"error": "self-test: <case> — <detail>"}` and exits 1. It runs on every
change in the repository's validation workflow.
