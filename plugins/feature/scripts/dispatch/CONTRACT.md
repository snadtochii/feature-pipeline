# The dispatcher contract

Authoritative surface for `dispatch.mjs`, the deterministic half of the night dispatcher.
The contract fixes the verbs, their flags, the configuration keys, the selection and cap
rules, the child sessions and how their outcome is decided, the output documents, the
exit codes, the lock, and the state layout. The implementation behind it is private and
may change without changing this file.

The division of labour: the dispatcher owns **decisions that need no model** — which
tickets are eligible tonight, whether a cap or a lock says no, which sessions to start,
whether a session shipped, what gets recorded. The sessions it starts build the admitted
tickets and own everything else. The dispatcher never judges a ticket's content and never
interprets model text: it reads only the structured events of its child sessions and the
server's ticket state.

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
| `plan` | §9. Answers what a run would do, acquiring nothing, writing nothing and starting no session. |
| `run` | §10. Takes the lock, runs `sync` and one `ship` session per admitted item, records the run, writes its report and sends it to the inbox. |
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
not select server-native storage exits 1 (§5) and makes no server call.

**One project, one run at a time.** A run works one project, and its admitted items are
taken in order, one session after another. Concurrent runs on the same repository are
excluded by the lock (§11).

## §2 Output rules

Every run prints **exactly one JSON document** on stdout, followed by a newline, and
nothing else. Output of the processes the dispatcher starts (`git`, `gh`, `claude`) is
captured, never passed through to stdout; a child session's output goes to its log files
(§12).

- **Object keys are sorted recursively**, ascending, by code unit.
- **Arrays are in a stated order** — every array-valued key below names its ordering.
- Two-space indentation, one trailing newline.

No document, report, record, log name or inbox item ever carries the server credential, the
content of the credential file, or a URL with userinfo in it (§6).

## §3 Exit codes

| Code | Meaning | Document |
|---|---|---|
| `0` | An answer was computed. This includes **nothing to dispatch** — no eligible ticket or a cap already met — and a run whose items ended `stuck` (§10). For `plan`, it includes a failed precondition (`ok: false`). | The verb's document from §9–§10. |
| `1` | The answer could not be computed: the project is not server-native, the configuration is invalid, the server is unreachable or rejects the request, the project root is not in a git repository, the lock is held by a live run, the state directory cannot be written, a precondition failed during `run`, the first `sync` session failed, `gh` cannot list the open pull requests during `run`, or the process was interrupted by a signal. | `{"error": "<reason>"}` |
| `2` | The invocation was wrong: no verb or an unknown verb, an unknown or repeated flag, a missing or empty `--project-root`, a relative path, a path that is not an existing directory, or `--self-test` with anything beside it. | `{"error": "<reason>"}` |

A caller distinguishes "the night ran" from "the dispatcher could not run" by the exit code
alone; what happened to each ticket is in the document. Both non-zero paths print the same
`{"error"}` shape, so stdout always parses. `<reason>` is one line. Everything that is wrong
with an invocation is detected before anything runs: an exit 2 never follows a lock
acquisition, a request, a session or a write.

## §4 Flags and filesystem discipline

Long flags only. Both `--flag value` and `--flag=value` are accepted. A flag given twice, a
flag the verb does not take, or a positional argument exits 2.

**Every path flag is absolute.** `--project-root` must be an absolute path to an existing
directory; anything else exits 2. There is no working-directory resolution to reason about.

**What the dispatcher reads.** `claudedocs/tickets/config.yaml` under the project root
(§5); the environment and the credential file (§6); the state directory (§12); the output
of the processes it starts.

**What it requests.** The ticket list, one ticket, the project list and the inbox capture
from the personal server (§6, §10). `plan` requests the ticket list only.

**What it writes, and where.** The lock directory inside the repository's git common
directory (§11) and the state directory under `$HOME/.feature-pipeline/dispatch/` (§12),
session logs included. `run` writes both; `plan` writes neither. The dispatcher itself
never writes into the project's working tree; the sessions it starts work in the worktrees
`ship` creates.

**What it executes.** Each with an argument vector and the project root as its working
directory:

- `git rev-parse` (the git common directory), `git status --porcelain` and
  `git symbolic-ref` (the preconditions, §9);
- `gh pr list` (open pull requests, §8), `gh auth status` (the preconditions) and
  `gh pr view` (a pull request's state, §10);
- `claude`, during `run` only, with exactly the two argument vectors in §10.

Two exceptions to the working directory, both run in the dispatcher's own working
directory and only after a signal: `ps -o stat= -p <pid>`, while the signal stops a
session (§10), to tell an exited child from a live one; and the running Node binary with
the dispatcher's private inbox helper and no other argument, to send a signalled run's
inbox item (§10).

Nothing else.

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
| `dispatch.max_session_minutes` | no | Wall-clock cap for one session, in minutes, per ticket the session builds (§10). Default `180`. |
| `dispatch.max_rate_limit_retries` | no | Rate-limit retries one session may make before it is stopped (§10). Default `10`. |

The five numeric keys must be positive integers; anything else exits 1 naming the key.

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

**Requests.** Every request carries `Authorization: Bearer <token>` only when a token is
set, has a 10-second timeout, and follows no redirect.

| Request | Used for |
|---|---|
| `GET <base>/api/pipeline/tickets?project_id=<project>` | The ticket list (§7) and the reachability probe. |
| `GET <base>/api/pipeline/tickets/<id>?project_id=<project>` | One ticket's row after its session (§10). A 404 counts as a failed read. |
| `GET <base>/api/projects` | The project's registry name for the inbox item (§10). |
| `POST <base>/api/inbox` | The inbox item (§10), a JSON body. |

The ticket list's outcomes:

| Outcome | Result |
|---|---|
| A JSON array | Rows (§7). An empty array adds a `notes` line naming the project id, so a wrong id is visible. |
| No response (refused, timed out, DNS) | `server unreachable at <origin>`. |
| A non-2xx status | `server rejected the request: HTTP <status> (token source: <env\|file\|none>)`. |
| A body that is not a JSON array | An error naming the origin. |

In `plan`, each failure exits 1 with that message. In `run`, the first list is the `server`
precondition: a failure fails it, with the message as its detail (§9–§10).

Messages name the server by origin only. A row missing a field the dispatcher needs (`id`,
`status`, `kind`, `tags`, `blocked_by`, `created_at`, `updated_at`) is dropped with a line in
`notes`. A ticket row's `pr_url` is used only when it is an `https:` URL without userinfo,
query or fragment; any other value counts as no pull request.

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

**Open pull requests.** `open_prs` is the number of dispatch slots held by open pull
requests in the project's repository. An open pull request holds a slot when it is titled
`<ID>:` for a tagged ticket's id (an epic's id included) or for a child of a tagged epic,
tagged or not, or when it is recorded in `runs.json` (§12) as opened by a dispatched item.
A child's pull request holds its epic's slot, and a recorded one holds the slot of the
item that opened it, so an epic's child pull requests and its integration pull request
together hold one slot. Both come from one
`gh pr list --state open --limit 1000 --json number,title,url` call, run in the project
root, so at most 1000 open pull requests are seen.

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
starts no session, and runs nothing beyond `git rev-parse`, `git status`,
`git symbolic-ref`, `gh pr list` and `gh auth status`.

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
  "config": {
    "max_age_days": 14,
    "max_open_prs": 3,
    "max_rate_limit_retries": 10,
    "max_session_minutes": 180,
    "max_tickets_per_run": 2,
    "tag": "agent-ready"
  },
  "not_admitted": [{ "id": "ABC-20", "reason": "ticket cap" }],
  "notes": ["config.yaml has no dispatch: block — using every default"],
  "ok": true,
  "preconditions": [
    { "detail": "/usr/local/bin/claude", "name": "claude", "ok": true },
    { "detail": "server-native, project 5b0c8a52-3f0e-4c41-9a43-2f1d7f3c9e10", "name": "config", "ok": true },
    { "detail": "/usr/local/bin/gh", "name": "gh", "ok": true },
    { "detail": "on main", "name": "git_base", "ok": true },
    { "detail": "working tree clean", "name": "git_clean", "ok": true },
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
| `preconditions` | One `{name, ok, detail}` per check, sorted by `name` — the table below. |
| `project` | `id` from the configuration, `name` from §12. |
| `notes` | One line per non-fatal observation, in the order made. |
| `ok` | Every precondition passed. |

**Preconditions.** `plan` and `run` check the same list:

| Name | Passes when |
|---|---|
| `claude` | An executable `claude` is on `PATH`. |
| `config` | The configuration selected server-native storage and a project (§5); a configuration that does not exits 1 before any check. |
| `gh` | An executable `gh` is on `PATH` and `gh auth status` exits 0. In `plan`, it also fails when the open-PR listing failed. |
| `git_base` | `git symbolic-ref --short HEAD` names the branch `refs/remotes/origin/HEAD` points at, and that name matches `^[A-Za-z0-9_][A-Za-z0-9._/-]*$`, so it can be passed to `ship` as `--base`. A detached `HEAD` fails; an unset `origin/HEAD` fails with `git remote set-head origin --auto` as the fix, and there is no fallback branch. |
| `git_clean` | `git status --porcelain` prints nothing — untracked files count as changes. The detail names up to five paths. |
| `node` | Node 22 or newer. |
| `server` | The ticket list answered (§6). |
| `state_dir` | The state directory is writable — or its nearest existing ancestor, when it does not exist yet. |

## §10 `run`

```text
node dispatch.mjs run --project-root <abs-path>
```

**Order of work.** Resolve the git common directory and project name → acquire the lock
(§11) → create the state directory and the run's log directory when absent → read
`runs.json` → read the configuration and resolve the server access → list the tickets →
check the preconditions → the first `sync` session → list the tickets again → list open
pull requests → select → admit → the dispatch step → the closing `sync` session → check
the checkout again → send the inbox item → append the record to `runs.json` → write the
report → release the lock → print.

**Hard stops.** A failed precondition exits 1 with
`preconditions failed: <name> (<detail>), …`, and a failed first `sync` session exits 1
with `sync failed: <reason>`. Both happen before any `ship` session starts, so selection
never runs on blocker state the first `sync` did not refresh.

### Child sessions

Every child is the `claude` found on `PATH`, started from an argument vector — the quotes
below mark one argument; nothing passes through a shell — with the project root as its
working directory, in a process group of its own, with the dispatcher's environment
passed through unchanged:

```text
claude -p /feature:sync --output-format json --permission-prompts none
claude -p "/feature:ship <ID> --worktree --base <BASE>" --output-format stream-json --verbose --permission-prompts none --add-dir <HOME>/.feature-pipeline
```

`<ID>` is the item's id and must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`; an item whose id does
not is `stuck` with reason `invalid id` and no session starts. `<BASE>` is the base branch
the `git_base` precondition found checked out — `refs/remotes/origin/HEAD`'s branch — so
`ship` cuts and targets the branch the run checked, never its own `main` default; a base
branch whose name does not match `^[A-Za-z0-9_][A-Za-z0-9._/-]*$` fails `git_base`.
`<HOME>` is `$HOME`. The
dispatcher never passes `--merge`, `--parallel`, `--bare`, `--settings`, `--allowedTools`
or `--permission-mode`: a child loads the project's and the user's settings, plugins and
server connectors as an interactive session would, its permissions are theirs, and a tool
no allow rule covers is denied rather than prompted — it shows up as `permission_denied`
instead of being granted.

**Output.** A child's stdout is read line by line and appended to its session log; its
stderr goes to a file of its own (§12). From stdout the dispatcher reads only these
fields: `session_id` (from the first event carrying one; the `result` record's wins),
`system` events of subtype `api_retry` with `error: "rate_limit"`, `system` events of
subtype `permission_denied`, and the `result` record's `subtype`, `is_error`,
`session_id`, `total_cost_usd` and `permission_denials`. Message text and tool input are
never read. A line that is not JSON is counted and skipped; an event of another type is
left alone.

**Caps.** A session is stopped when its wall-clock time reaches `max_session_minutes`
times the item's ticket count (a `sync` session: `max_session_minutes`), or at the first
rate-limit retry past `max_rate_limit_retries`. Stopping sends `SIGINT` to the child,
`SIGTERM` 120 seconds later if it is still running, and `SIGKILL` to its process group 30
seconds after that. When a stopped child exits, every process left in its group is killed
at once. After any other exit, a process of its group still holding its output is killed
with the group after 5 seconds. A wall-clock cap longer than 2³¹−1 milliseconds (about
24.8 days) is held at that length.

**A signal to the dispatcher** while a session runs sends the child `SIGINT`, waits up to
10 seconds, sends `SIGTERM`, waits up to 2 seconds, then sends `SIGKILL` to its process
group. The session is recorded as `interrupted`, with the session id seen so far, before
the run is recorded `stopped`; the inbox item follows (Inbox item).

### The dispatch step

The admitted items run one after another; every item is first recorded `not dispatched`,
and each entry is replaced as its session ends, so a run stopped part-way keeps what
finished. Before every item but the first, the lock must still name this run and the
working tree must still be clean; otherwise that item and every later one stay
`not dispatched` with reason `lock lost` or `working tree not clean`.

After a `ship` child exits, the dispatcher re-reads the item's ticket row — the epic's own
row for an epic item — and, when the row has a `pr_url`, the pull request's state with
`gh pr view <url> --json state --jq .state`; the URL must be
`https://<host>/<path>/pull/<digits>`, or `gh` is not run. A failed read is retried once,
2 seconds later; a second failure leaves the state unknown.

The run stops at the first `stuck` item: every later item stays `not dispatched` with
reason `run stopped at <ID>`.

The closing `sync` session runs when at least one `ship` session started, except after a
stop on `rate_limit`, which adds a `notes` line instead. Its failure adds a `notes` line;
it never stops the run or changes the exit code.

After the sessions — when at least one `ship` session started — the `git_base` and
`git_clean` preconditions (§9) are checked again, since a `ship` run can end with the main
checkout on another branch. Each that fails adds a `notes` line naming its detail, so the
report says why the next run will stop. The dispatcher changes nothing in the checkout.

### Finish predicate

An item is **`shipped`** when its session exited 0 with no cap fired and a `result` of
subtype `success` that is not an error, and the re-read row's status is `in-review` with a
`pr_url` whose pull request is `OPEN`. Every other item is **`stuck`**, with the first
reason that applies:

| Reason | When |
|---|---|
| `timeout` | The wall-clock cap stopped the session. |
| `rate_limit` | The retry cap stopped the session, or it exited non-zero after at least one rate-limit retry. |
| `interrupted` | The dispatcher was signalled while the session ran. |
| `SIGTERM` | The session exited 143. |
| `exit <n>` | The session exited non-zero. |
| `no session` | The child could not be started, or printed no session id. |
| `no result` | The stream ended without a `result` record. |
| `result error` | The `result` record has `is_error: true`. |
| `result <subtype>` | The `result` record's subtype is not `success`. |
| `permission_denied` | The session ended cleanly with tools denied, and the predicate failed. |
| `state unknown` | The row or the pull request could not be read. |
| `not in review (<status>)` | The row's status is not `in-review`. |
| `pull request not open` | The row has no usable `pr_url`, or its pull request is not open. |

A `shipped` item whose session had tools denied adds a `notes` line naming them. A `stuck`
item still records the row's `pr_url` when it has one, so the next run's pull-request cap
counts it. The one exception is an `interrupted` item: a signal leaves no time to re-read
the row, so it records `pr_url: null`, and a pull request its session already opened is
counted by the next run only through its `<ID>:` title (§8). A stuck session is resumed by
hand with `claude --resume <session_id>`, from any directory; the report prints that line
for every stuck item with a session id.

### The document

```json
{
  "caps": { "max_open_prs": 3, "max_tickets_per_run": 2, "open_prs": 1, "reason": null, "tickets_admitted": 1 },
  "config": {
    "max_age_days": 14,
    "max_open_prs": 3,
    "max_rate_limit_retries": 10,
    "max_session_minutes": 180,
    "max_tickets_per_run": 2,
    "tag": "agent-ready"
  },
  "items": [
    {
      "cost_usd": 4.21,
      "exit_code": 0,
      "id": "ABC-12",
      "kind": "solo",
      "log": "/Users/me/.feature-pipeline/dispatch/my-app/logs/2026-10-14-a1b2c3/ABC-12.jsonl",
      "outcome": "shipped",
      "pr_url": "https://github.com/acme/my-app/pull/57",
      "rate_limit_retries": 0,
      "reason": null,
      "session_id": "4f0c2a1e-8b7d-4c3e-9a51-0e6d2b7c9f13",
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
  "sync": {
    "after": {
      "cost_usd": 0.18,
      "exit_code": 0,
      "log": "/Users/me/.feature-pipeline/dispatch/my-app/logs/2026-10-14-a1b2c3/sync-after.json",
      "ok": true,
      "reason": null,
      "session_id": "9d3e7b20-1c4a-4f8e-b6d2-3a5c7e9f1b04"
    },
    "before": {
      "cost_usd": 0.21,
      "exit_code": 0,
      "log": "/Users/me/.feature-pipeline/dispatch/my-app/logs/2026-10-14-a1b2c3/sync-before.json",
      "ok": true,
      "reason": null,
      "session_id": "2b8f4d61-7e3a-4c9b-a0d5-6f1e8c2b7a39"
    }
  },
  "verb": "run"
}
```

| Key | Meaning |
|---|---|
| `run_id` | `<YYYY-MM-DD>-<6 hex>`, the UTC date the run started and 3 random bytes. |
| `outcome` | `completed` (at least one item was admitted; each item carries its own outcome, stuck ones included) or `nothing to dispatch` (nothing admitted — `caps.reason` or the skips say why). Both exit 0. |
| `items` | One entry per admitted item, in admission order — the keys below. |
| `sync` | `before` and `after`, each `{ok, reason, session_id, exit_code, cost_usd, log}` for that `sync` session, or `null` when it did not run. `reason` is null when `ok`, else one of the session reasons above (`timeout`, `interrupted`, `SIGTERM`, `exit <n>`, `no session`, `no result`, `result error`, `result <subtype>`) or `permission_denied` when tools were denied. |
| `report` | Absolute path of the report written (§12). |
| `caps`, `config`, `not_admitted`, `skips`, `preconditions`, `project`, `notes` | As in `plan` (§9). `state_dir` is checked after the directory was created. |

| Item key | Meaning |
|---|---|
| `id`, `kind`, `tickets` | The admitted item (§9). |
| `outcome` | `shipped`, `stuck` or `not dispatched`. |
| `reason` | Why the item is `stuck` or `not dispatched` (`run stopped at <ID>`, `lock lost`, `working tree not clean`); `null` when shipped, and for an item the run never reached. |
| `pr_url` | The re-read row's pull request, or `null`. |
| `session_id` | The child session's id, or `null`. |
| `exit_code` | The child's exit code (`128 + n` for an exit by signal `n`), or `null`. |
| `cost_usd` | The `result` record's `total_cost_usd`, or `null`. |
| `rate_limit_retries` | Rate-limit retries the session made. |
| `log` | Absolute path of the session log, or `null`. |

### Inbox item

Every run sends one inbox item — through its normal path, a thrown error or a signal —
once the configuration selected server-native storage and the server access resolved,
unless the `server` precondition failed — then the run sends nothing and adds the `notes`
line `no inbox item: the server failed the precondition`. The item is
`POST <base>/api/inbox` with

```json
{
  "body": "Night dispatch 2026-10-14-a1b2c3: 1 shipped, 0 stuck, 2 skipped\n\n# Dispatch run 2026-10-14-a1b2c3\n…",
  "metadata": { "project_id": "5b0c8a52-3f0e-4c41-9a43-2f1d7f3c9e10", "run_id": "2026-10-14-a1b2c3" },
  "project": "my-app",
  "source": "feature:dispatch"
}
```

- `body` is one summary line, a blank line, and the report (§12). The summary line is
  `Night dispatch <run-id>: <n> shipped, <m> stuck, <k> skipped`, where `<k>` counts the
  skips, the candidates not admitted and the items left `not dispatched`.
- `project` is the registry name the server itself returns for the configured project id
  from `GET <base>/api/projects`. When that request fails or lists no such project, the key
  is left out and a `notes` line says why — the dispatcher never sends a name of its own,
  since an unknown name registers a new project.
- A failed capture adds a `notes` line to the report written afterwards; it never changes
  the exit code.

**On a signal** the run is recorded first, so a kill that follows still finds its record
and report. The item is then sent by a helper process — the running Node binary with the
dispatcher's private inbox helper, which receives the request, token included, on its
stdin — making the same two requests with a 5-second timeout each; the dispatcher waits
for it at most 12 seconds. Notes from that attempt are written into the report again. A
signal that arrives while the item is already being sent does not send a second one and
adds the `notes` line `inbox item not confirmed: <reason> while it was being sent`; one
that arrives before the server access resolved sends nothing and adds
`no inbox item: <reason> before the server access resolved`.

No inbox item is sent for a run refused by the lock, or for a project that is not
server-native — that run makes no server call at all.

### Failure after the lock

Any exit 1 after the lock was acquired — a failed precondition, a failed first `sync`, `gh`
unable to list open pull requests, `runs.json` unreadable, a signal — records the run with
outcome `stopped` and an `error` line, best effort, then releases the lock. A failure to
write that record or report is appended to the error message, never substituted for it. A
run that decided but could not write its record or report exits 1 naming what was not
written. A run refused because the lock is held writes nothing.

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
is missing or unparseable — from the lock directory's modification time. A lock is live
for 24 hours from `started`; one with an unreadable owner is live for one minute, which
covers a live run between its `mkdir` and its owner write and nothing more, so a run that
died in that moment or a corrupted `owner` blocks dispatch for a minute, not a day.

| Lock | Result |
|---|---|
| Live (a `started` or modification time in the future included) | Exit 1, `lock held by run <run-id>`, or `lock held (owner unreadable)`. |
| Older | Taken over, exclusively: `mkdir <git-common-dir>/feature-dispatch.lock.reclaim`, the reclaim marker; then, while holding it, `owner` is re-read, the lock directory removed and created again with one more `mkdir`, and the new `owner` written; then the marker is removed. A `notes` line names the run it took over from, or the unreadable owner's modification time. A marker that already exists exits 1 (`lock takeover in progress by a concurrent run — if no dispatch run is in progress, remove <marker>`). An owner (or, unreadable, a modification time) that changed since the first read, or a `mkdir` that loses to a concurrent run, exits 1 (`lock taken by a concurrent run`). |

Two runs that find the same stale lock cannot both take it over: only the holder of the
reclaim marker removes the lock directory, and it writes the new `owner` before it releases
the marker, so a second run that gets the marker afterwards finds the owner changed. A run
that dies while holding the marker — its takeover lasts milliseconds and no signal handler
runs inside it — leaves the marker behind, and the marker is never aged: it refuses every
takeover of a stale lock until it is removed by hand. It does not affect a lock that is
absent or live.

**A night's length.** The 24-hour window is also the longest a run can rely on its lock:
keep `max_tickets_per_run × max_session_minutes` well under it. Before every item but the
first, a run checks that `owner` still names it and stops dispatching when it does not
(§10).

**Release.** On normal completion, on any exit 1 after acquisition, and on `SIGINT`,
`SIGTERM` or `SIGHUP`. The directory is removed only while `owner` still names this run, so
a run whose lock was taken over never removes the new owner's lock. A signal exits 1 with
`{"error": "interrupted by <SIGNAL>"}`. A run killed with `SIGKILL` cannot release; its
lock blocks dispatch until it is 24 hours old.

## §12 State layout

```text
$HOME/.feature-pipeline/dispatch/<project-name>/
├── runs.json
├── reports/
│   └── <run-id>.md
└── logs/
    └── <run-id>/
        ├── sync-before.json
        ├── sync-before.stderr.log
        ├── <ID>.jsonl
        ├── <ID>.stderr.log
        ├── sync-after.json
        └── sync-after.stderr.log
```

`<project-name>` is the name of the directory holding the git common directory — the main
checkout's directory name, shared by its linked worktrees. It must match
`^[A-Za-z0-9._-]+$` and be neither `.` nor `..`; anything else exits 1. `HOME` unset exits
1. The state lives outside every working tree.

The name is a directory name, not a repository identity: two repositories checked out
under directories of the same name share one state directory, while each holds its own
lock (§11). Their `runs.json` records then interleave, and their runs can write it at the
same time. Dispatch one of them, or give the checkouts different directory names.

The project directory, `reports/`, `logs/` and each run's log directory are created by
`run`, mode 0700. `runs.json` and the reports are written to a temporary file beside them
and renamed into place, mode 0600; session logs are appended to as the session prints,
mode 0600. Logs are never pruned.

**Session logs.** `<ID>.jsonl` holds a `ship` session's stdout, one event per line, and
`sync-<phase>.json` a `sync` session's; each `.stderr.log` holds that session's stderr. A
log's name comes from a checked item id or the fixed `sync-before` / `sync-after`.

**`runs.json`** is a JSON array of run records, oldest first, appended to only while the
lock is held:

| Key | Meaning |
|---|---|
| `run_id`, `started`, `finished` | The run's id and ISO timestamps. |
| `outcome` | `completed`, `nothing to dispatch`, or `stopped`. |
| `error` | The one-line reason for `stopped`, else `null`. |
| `sync` | The `run` document's `sync` (§10). |
| `items` | The `run` document's `items` (§10); their `pr_url` values feed the pull-request cap (§8). |

A `runs.json` that exists but does not parse as an array exits 1 naming the file; it is
never overwritten.

**`reports/<run-id>.md`** is the run's human-readable report, with these sections in order:

- `## Outcome` — the outcome, the summary line (§10, Inbox item), and the error for a
  `stopped` run.
- `## Sync` — one line each for `before` and `after`: ok or the failure reason, session
  id, exit code, cost and log, or `not run`.
- `## Dispatched` — a table with the columns Item, Kind, Tickets, Outcome, Reason, Pull
  request, Session, Exit, Cost (USD), Rate-limit retries and Log; then one
  `Resume <ID>: claude --resume <session_id>` line per stuck item with a session id; then
  the candidates not admitted.
- `## Skips`, `## Caps`, `## Preconditions`, `## Notes`.

## §13 `--self-test`

```text
node dispatch.mjs --self-test
```

Exercises the whole deterministic surface without a model, a real server, a real `gh` or a
real `claude`: argument rejection, the configuration reader and its validation, credential
resolution and token binding, selection over a fixture ticket list (blocked, stale, not
backlog, epics, children of a tagged epic, ordering), the open-PR count, admission under
both caps, the lock (acquire, held, stale takeover, unreadable owner, two concurrent
takeovers of one stale lock, a leftover reclaim marker, release only by its owner) in a
temporary git repository, the preconditions (a dirty tree, a branch off base,
an unset `origin/HEAD`, a failing `gh auth status`), stream parsing over fixture
`stream-json` lines (`system/init`, `api_retry` rate limits, `permission_denied`, `result`
records, non-JSON lines, CRLF), the finish predicate and every stuck reason over fixture
ticket states, the `sync` status, the exact argument vectors, the session runner's caps,
escalation, group kill and timer clamp against stand-in `claude` scripts with millisecond
caps, the report sections, the inbox body's shape, the signal-path inbox helper against an
unreachable server, the sorted-key document shape, and end-to-end `plan` and `run`
invocations — shipped, stuck, a failed first `sync`, a dirty tree, a failed inbox capture,
a signal while a session runs (its inbox item included), a repository whose base branch is
`master`, and a `ship` that leaves the checkout off its base branch — against a loopback stand-in server that
routes every request in §6, a stand-in `gh` and a stand-in `claude`, with `HOME`
redirected. Prints `{"cases": <n>, "ok": true}` and exits 0 when every case passes;
otherwise prints `{"error": "self-test: <case> — <detail>"}` and exits 1. It runs on every
change in the repository's validation workflow.
