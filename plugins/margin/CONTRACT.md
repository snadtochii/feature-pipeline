# The margin contract

Authoritative surface between `server/cli.mjs`, the `annotate` skill and the human who
reviews code in the viewer. The contract fixes the verbs, their flags, the stdout and stderr
output, the exit codes, resume, the notes-file schema, the anchor rule, the HTTP routes and
their guards, the file-listing and reading rules, the seam between the skill and the
server, and the self-test. The implementation under `server/` and `ui/` is private and may change without
changing this file. Header comments in `server/` and `ui/` explain mechanics only; where one
restates a fact this file fixes and disagrees with it, this file governs.

The division of labour: the server owns **mechanics** (listing the files, serving the viewer,
guarding requests, saving the notes file); the skill owns **judgment** (what the notes mean
and what to do about them). The server never reads the skill's state, and the skill reads the
notes file only between rounds and after the run ends; every save is atomic (§6), so each read
sees a whole file.

---

## §1 Invocation

```text
node <plugin-root>/server/cli.mjs annotate [--root <dir>] [--scope <path>]... [--out <file>] [--port <n>] [--token <token>] [--no-open]
node <plugin-root>/server/cli.mjs wait <url> [--after <n>]
node <plugin-root>/server/cli.mjs --self-test
```

| Part | Meaning |
|---|---|
| `<plugin-root>` | The installed `margin` plugin directory. The skill runs it as `${CLAUDE_PLUGIN_ROOT}`. |
| `annotate`, `wait` | The two verbs. `wait` is recognised only as the first argument, and its positional arguments must be exactly `wait <url>`. Otherwise the first positional argument must be `annotate`; further positional arguments are ignored. |
| flags | §4. |
| `--self-test` | Runs the self-test (§12) instead of a review. It takes no verb and no other argument; given with anything else it is a bad invocation (§3). |

Only `cli.mjs` is a command. Everything under `server/lib/` is private to the implementation
and may change shape without changing this contract.

**Runtime.** Node 22 or newer; the server uses the standard library only. The viewer carries
one vendored library, highlight.js 11.12.0 (BSD-3-Clause), under `ui/vendor/`, loaded only
through `ui/syntax.js`; nothing is installed, downloaded or built at runtime. Update
procedure: `README.md`, "Vendored highlight.js". `git` is optional: it makes the listing
git-aware and fills `revision` (§6, §10).

**Lifecycle.** `annotate` validates its arguments, reads the notes file when resuming (§5),
resolves the root and scope, lists the files (§10), binds the port, writes the notes file as
`draft`, prints the stderr block (§2) and opens the viewer unless `--no-open` is given. The run
then spans rounds. Each Send in the viewer (`POST /api/submit`, §8) ends a round: every note
not yet sent is stamped with the new round number, the round is recorded in the notes file
(§6), and the server keeps serving on the same port with the same token, so the human can go
on and send the next round. The run ends once, on whichever comes first: Finish
(`POST /api/finish`, from the viewer or from the skill with the same token), Cancel
(`POST /api/cancel`), or `SIGINT` / `SIGTERM`. The notes file then takes its final status,
every held wait is answered, and the process prints the result document (§2) and exits 0
(§8, "The end of the run"). A run lasts as long as the review.

`wait` validates its arguments (§3), sends one request to the run's `GET /api/wait` (§8) and
holds it open until the next round is sent or the run ends. It then prints the wait document
(§2) and exits 0. It never polls and reads nothing from disk: the run URL carries the port and
the token.

## §2 Output rules

**stdout** carries exactly one JSON document on every handled exit, with two-space
indentation and one trailing newline, and nothing else. It has one of four shapes.

The result document, on exit 0 from `annotate`, printed once, when the run ends, with its keys
in this order:

| Key | Value |
|---|---|
| `status` | `finished`, `cancelled` or `interrupted` (§6). |
| `out` | The absolute path of the notes file. `null` only when a run cancelled before any round was sent had no notes and a blank `overall`, so no file remains (§6). |
| `annotations` | The number of notes in the file, sent and unsent — a count, not the notes. |
| `rounds` | The number of rounds sent — a count, not the rounds. |
| `root` | The absolute root. |
| `scope` | The scope as root-relative paths, `.` for the root itself; `[]` when no scope was given and the whole root is listed. |

The wait document, on exit 0 from `wait`, with its keys in this order:

| Key | Value |
|---|---|
| `status` | `sent` when a round was sent; otherwise the run's end status, `finished`, `cancelled` or `interrupted`. |
| `round` | The run's round count when the server answered: the round just sent for `sent`, the number of rounds sent for an end. |
| `out` | The absolute path of the notes file; `null` when the end of the run deleted it (§6). |

The error document, on exit 1 or 2: `{"status": "error", "error": "<reason>"}`. `<reason>` is
for humans and may span lines: an argument-parse failure appends the usage line after a
newline.

The self-test document, on exit 0 from `--self-test` (§12): `{"cases": <n>, "ok": true}`, where
`<n>` is the number of cases run. A failing self-test prints the error document.

The notes themselves never appear on stdout; the reader opens `out` (§11).

**stderr** carries one block, written once, after the port is bound and the first draft is
saved:

```text
margin: http://127.0.0.1:<port>/#<token>
  root:  <root>
  scope: <scope paths joined by ", ", or "."> (<N> files)
  notes: <out>
```

The first line is written once the port is bound, so the URL it names is live, and it is the
one line a caller may parse (§11); its URL is the one `wait` takes (§4). The rest of the block
is for the human; a caller may show it but does not parse it. `wait` and `--self-test` print
no stderr block.

## §3 Exit codes

| Code | Meaning | Document |
|---|---|---|
| `0` | `annotate`: the run ended — Finish (`finished`), Cancel (`cancelled`), or `SIGINT` / `SIGTERM` after the port was bound (`interrupted`). `wait`: a round was sent or the run ended. Or every self-test case passed (§12). | Result, wait, or self-test |
| `1` | The run could not proceed: the `--out` file is refused on resume (§5), no files are listed under the scope (§10), the port cannot be bound (`could not listen on port <n>: <code>`), or the end of the run cannot save the notes file. `wait`: the server is unreachable — the connection is refused, or it drops before the reply ends (`server unreachable at <origin>: <code>`) — or it answers with an error (`wait: <status> <error>`). Or a self-test case failed (§12). | Error |
| `2` | The invocation is wrong: an unknown flag, a flag missing its value or given a value it does not take, a missing or different verb, `--self-test` given with any other argument, a `--port` whose `Number()` value is not an integer from 0 to 65535 (§4), a `--token` outside its class (§4), or a scope path — given by `--scope` or read from a resumed file — that resolves outside the root. For `wait`: no URL or another positional argument, a URL that is not a run URL (§4), or an `--after` that is not a whole number of decimal digits. | Error |

`annotate`'s checks run in this order, and the first failure is the one reported: arguments
and verb, then `--port`, then `--token`, then the resumed file's JSON and its `annotations`
array (§5), then the scope paths, then the listing, then the resumed rounds, the agent's overall replies and notes (§5),
then the port binding. Every one of them happens before the first save, so a refused run
writes nothing: an existing `--out` file is left exactly as it was.

`wait`'s checks run in this order: its arguments parse, its positional arguments are exactly
`wait <url>`, the URL is a run URL, then `--after`. Every one of them happens before its one
request.

## §4 Flags

Long flags only. Both `--flag value` and `--flag=value` are accepted for a flag that takes a
value. A flag other than `--scope` given twice keeps its last value.

| Flag | Default | Meaning |
|---|---|---|
| `--root <dir>` | see meaning | The directory the scope is resolved against and served from. The flag applies when given, else the resumed file's `root` when it is a string (§5), else the working directory. A relative value resolves against the working directory; the result is absolute. |
| `--scope <path>` | none | Repeatable. A file or folder, relative to the root (an absolute path inside the root is accepted). Each is normalised to a root-relative path, and the root itself becomes `.`. A path outside the root exits 2; the check compares path text and resolves no symbolic link (§10). With no `--scope`, a resumed file's `scope` applies when it is an array; otherwise the scope is empty and the whole root is listed. |
| `--out <file>` | `<root>/claudedocs/margin/<stamp>.json` | The notes file. `<stamp>` is the start time in UTC as `YYYY-MM-DDTHH-MM-SS`. A relative value resolves against the working directory. When the file exists, the run is a resume (§5). Missing parent directories are created on the first save. |
| `--port <n>` | `0` | An integer from 0 to 65535 after the value is converted with JavaScript's `Number()`: an empty or all-whitespace value becomes `0`, and `1e3` and `0x10` are accepted as `1000` and `16` (§13). `0` lets the operating system assign a free port; the bound port is the one in the stderr URL. |
| `--token <token>` | minted | 16 to 128 characters from `[A-Za-z0-9_-]`. When absent, the server mints 32 lowercase hexadecimal characters (16 random bytes). Setting it lets a caller know the viewer URL's fragment before the server prints it. |
| `--no-open` | off | Do not open the viewer. Without it, the server opens the URL with the platform opener (`open` on macOS, `start` on Windows, `xdg-open` elsewhere). An opener that starts and fails is ignored, since the URL is on stderr; an opener command that is not installed ends the run with exit 1 and no stdout document, after the draft is saved and the stderr block is printed (§13). |

**`wait`** takes one positional argument and one flag:

| Argument | Default | Meaning |
|---|---|---|
| `<url>` | required | The run URL: the URL on the stderr block's first line (§2), `http://127.0.0.1:<port>/#<token>`, fragment included. A URL with another host or scheme, no explicit port, a path other than `/`, a query, credentials, or a fragment outside the `--token` class above is refused with exit 2 before any request is made; the refusal does not echo the URL, since it carries the token. The token is sent only in the `x-margin-token` header, and only to that origin. |
| `--after <n>` | the round count the run started with | The last round the caller has seen, as a whole number of decimal digits. The wait returns at once when the run has sent more rounds than `<n>` or its end has begun, and holds otherwise. The default is `0` on a fresh run and the restored count on a resume (§5), so a first wait on a resumed file does not return for rounds an earlier run sent. |

## §5 Resume

A run is a resume when `--out` names a file that exists. A `--out` that does not exist is a
fresh run whose notes file is created at that path.

1. **Refusals.** Each exits 1 and writes nothing (§3):
   - the file is not valid JSON;
   - the parsed value has no `annotations` array (including a value that is not an object);
   - the file's `rounds` is present and is not an array (`<out>: rounds is not a list`), or an
     entry `i` of it is not an object whose `round` is `i + 1`, with a string `sentAt` and a
     string `overall` (`<out>: rounds entry <i> is malformed`). This is checked before the
     notes;
   - the file's `overallReplies` is present and is not an array (`<out>: overallReplies is not
     a list`), or an entry `i` of it is not a reply of §7 answering a round from 1 to the
     number of stored rounds (`<out>: overallReplies entry <i> is malformed`). This is checked
     after `rounds` and before the notes;
   - any stored note is malformed by the annotation rules of §7 — a note whose `round` is
     present and is not an integer from 1 to the number of stored rounds included, and a note
     whose `replies` is present and is not an array, sits on a note without `round`, or holds
     an entry that is not a reply of §7 answering a round from the note's `round` to the
     number of stored rounds. The reason names the count and the indices:
     `<out>: <k> of <n> notes are malformed (indices <i>, ...)`.
2. **Root and scope.** The file's `root` (when a string) and `scope` (when an array) apply
   unless `--root` or `--scope` is given. The two are independent: `--root` given alone keeps
   the stored scope, resolved under the new root.
3. **Notes.** Every stored note is checked for shape by §7 with the anchor check against the
   listing skipped, so a resumed note keeps its anchor (§7). An accepted note is normalised:
   a missing or non-string `id` gets a fresh UUID, an `intent` outside the two values becomes
   `change`, a missing `createdAt` becomes the current time, a `range` excerpt is truncated to
   the cap or set to `""` when absent, and unknown fields are dropped. A note's `round` and
   `replies` are kept (§7), with any other field on a reply dropped; an empty `replies` list is
   dropped.
4. **Kept and replaced.** The run keeps `createdAt` (when a string, else the current time),
   `overall` (when a string, else `""`), `overallReplies` (each entry's `body`, `round` and
   `createdAt`), `rounds` (each entry's `round`, `sentAt` and `overall`; any other field on an
   entry is dropped) and the notes. Every other stored field is dropped; `version`, `status`,
   `round`, `root`, `scope`, `out`, `revision` and `updatedAt` are written fresh for this run
   (§6), `round` as the number of kept rounds. A file without `rounds` resumes as round 0 with
   every note unsent, and a file without `overallReplies` or `replies` resumes with no
   replies.
5. **First write.** The file is rewritten with `status: "draft"` as soon as the port is bound.

## §6 Notes file

One JSON object, UTF-8, two-space indentation, one trailing newline. Readers must not depend
on the order of its keys.

| Field | Value |
|---|---|
| `version` | `1`. |
| `status` | One of four values. `draft`: written when the port is bound and on every save while the server runs, between rounds included — a file read while the server runs, or left by a process that died without a signal, says `draft`, and whether a note has been sent is its `round` (§7). `finished`: the run ended on Finish. `cancelled`: the run ended on Cancel. `interrupted`: the process received `SIGINT` or `SIGTERM`. |
| `root` | The absolute root of the run that wrote the file. |
| `scope` | The scope, as in §2. |
| `out` | The absolute path of this file. |
| `revision` | `{"head": "<commit sha>", "dirty": <boolean>}` read from git in the root when the run starts — `dirty` is `true` when `git status --porcelain` lists anything — or `null` when the root is not in a git repository or git is unavailable. |
| `createdAt` | ISO 8601 UTC timestamp of the run that created the file; kept across resumes. |
| `updatedAt` | ISO 8601 UTC timestamp of the last save. |
| `overall` | The human's framing text for the whole scope. A string; may be empty. One editable field for the whole run; each round records the text it sent (`rounds`), and the agent's answers to it are in `overallReplies`. |
| `overallReplies` | The agent's overall replies, oldest first, each in the reply shape of §7 — `{"body", "round", "createdAt"}`, `round` from 1 to the number of rounds. Written only through `POST /api/reply` (§8); `[]` before the first. |
| `round` | The number of rounds sent; `0` before the first Send. Always the length of `rounds`. |
| `rounds` | The sent rounds, oldest first: `{"round": <n>, "sentAt": "<ISO 8601 UTC timestamp>", "overall": "<the overall text the round sent>"}`, entry `i` holding round `i + 1`. |
| `annotations` | The notes (§7), in the order they were created. The viewer sorts them for display only. |

`status: "error"` never appears in a notes file; it exists only in the stdout document (§2).

**Writes.** The server rewrites the whole file on every change: when the port is bound, on
every save from the viewer (§8), on every Send — one refused for having nothing to send
included, since its edits are saved — on every accepted reply post (§8), and when the run ends. Every write goes to a temporary
file in the same directory, `.<name>.<pid>.<random>.tmp`, which is then renamed over the
notes file, so a reader never sees a partial file; a failed write removes its temporary file.
One exception: a run that ends `cancelled` before any round was sent, with no notes and an
`overall` that is empty or whitespace, deletes the file instead, and its result document
carries `out: null`. This holds on a resume too, where the rounds the resumed file records
count as sent.

## §7 Annotations and the anchor rule

Each note has exactly these fields; any other field on a note or on its anchor is stripped.

| Field | Value |
|---|---|
| `id` | A string. A note that arrives without one gets a fresh UUID when the server accepts it; the viewer mints UUIDs for the notes it creates. It is the identity a later write revises the note by. Ids are not checked for uniqueness: a write or a resumed file may hold two notes with one id, and both are kept; a later write then revises each note carrying that id from the last stored note with it (§13). |
| `anchor` | Where the note sits, by kind (below). |
| `intent` | `change` or `question`. Any other value becomes `change`. |
| `body` | The human's text. Required: a note without a string `body` is rejected. The server accepts an empty string; the viewer does not create empty notes. |
| `createdAt` | ISO 8601 UTC timestamp. When missing, the time the server accepted the note. |
| `round` | The round the note was sent in (§6). Set by the server at Send on every note not yet sent, and absent while the note is unsent. Never taken from a viewer write: a `round` a write carries is stripped. Kept on resume when it is an integer from 1 to the number of stored rounds (§5). |
| `replies` | The agent's replies to the note, oldest first, each `{"body": "<text>", "round": <n>, "createdAt": "<ISO 8601 UTC timestamp>"}` — the reply shape. `body` is plain text, line breaks kept; `round` is the round the agent answered, an integer from the note's `round` to the number of rounds; `createdAt` is the time the server accepted the reply. Present only on a sent note with at least one reply. Written only by `POST /api/reply` (§8), never taken from a viewer write: a `replies` a write carries is stripped. Kept on resume (§5). |

| Kind | Fields | Meaning |
|---|---|---|
| `scope` | `kind` | The scope as a whole. |
| `folder` | `kind`, `path` | A folder. |
| `file` | `kind`, `path` | A file. |
| `range` | `kind`, `path`, `start`, `end`, `excerpt` | Lines `start` to `end` of a file, inclusive and 1-based. `start` and `end` are integers with `start ≥ 1` and `end ≥ start`; a numeric string is accepted and stored as a number. `excerpt` is the text of those lines as the viewer showed them, joined with `\n`, capped at 4000 characters (UTF-16 code units) — a longer one is truncated — and `""` when absent. |

`path` is root-relative with `/` separators, as the listing writes it (§10). An anchor of any
other kind, or a `folder`, `file` or `range` anchor without a string `path`, is rejected.

**The anchor rule.** An anchor is checked against the listed paths (§10) once, when the
server first accepts the note — one rule per kind:

- `scope` always passes.
- `folder` passes when at least one listed file lies beneath `<path>/`. A `path` of `.`, an
  empty `path` or one ending in `/` therefore never passes; a remark about the whole scope is
  a `scope` note.
- `file` and `range` pass when `path` is itself a listed file.

A note whose anchor fails is rejected. The anchor never changes afterwards:

- A write from the viewer that carries the `id` of a stored unsent note revises that note's
  `intent` (when it is one of the two values) and `body` (when it is a string) only. Its
  anchor and `createdAt` stay as stored, whatever the write sends.
- A note loaded from a resumed file is checked for shape only (§5) and keeps its anchor even
  when its file has moved, been deleted or fallen outside this run's scope.

A range's `excerpt` is fixed with its anchor, so a reader compares it with the file as it is
now to detect drift.

**Saves carry the whole list.** A write that includes `annotations` replaces the list of
unsent notes: a stored unsent note whose `id` is absent from the write is deleted, and a note
whose `id` matches no stored note is a new note and goes through the checks above. A new note
that fails them is left out of the list, and the write still answers `{"ok": true}` (§13).

**Sent notes are locked.** No write revises or deletes a note that carries `round`: a write
entry carrying a sent note's `id` is ignored, and a sent note absent from the write is kept,
so a write never changes a note's `replies` either. Every note present at a Send is stamped, so sent notes all predate unsent ones; the list stays
in creation order, sent notes first.

## §8 HTTP routes

The server listens on `127.0.0.1` only, at the bound port. Every response carries
`cache-control: no-store`; JSON responses are `application/json; charset=utf-8`. Every
request passes the guards of §9 first. Ten routes:

| Route | Token | Request | Response |
|---|---|---|---|
| `GET /` | no | — | The viewer page. Its static assets, `GET /app.js`, `/syntax.js`, `/vendor/highlight.min.js`, `/vendor/dockerfile.min.js` and `/style.css`, are served the same way and belong to this route. |
| `GET /api/session` | yes | — | 200 `{"session": <the notes file object, §6>, "files": [<the current listing, §10>], "changes": <the run's change count>}`. The change count is `0` when the process starts, is kept in memory only, and goes up by one on every accepted reply post. |
| `GET /api/file?path=<p>` | yes | — | `<p>` not in the current listing: 404 `{"error": "<p> is not in scope"}`. A listed path that no longer exists — removed, or a parent folder replaced by a file: 404 `{"error": "<p> no longer exists"}`. Otherwise 200 with `{"path", "text"}` or a refusal `{"path", "binary": true, "reason"}` (§10). |
| `GET /api/changes?after=<n>` | yes | — | `after` absent or not a whole number of decimal digits: 400 `{"error": "bad after: <value>"}`, `<value>` empty when absent. Once the end of the run has begun: 200 `{"status": <the end's status>, "changes": <count>}`, at once. When the change count exceeds `<n>`: 200 `{"status": "changed", "changes": <count>}`, at once. Otherwise the reply is held until an accepted reply post brings the count above `<n>`, which answers it `changed` with the new count, or the end of the run answers it. |
| `GET /api/wait?after=<n>` | yes | — | `after` present and not a whole number of decimal digits: 400 `{"error": "bad after: <value>"}`. Without `after`, `<n>` is the round count the run started with (§4). Once the end of the run has begun: 200 with that end's wait document (§2), at once. When the round count exceeds `<n>`: 200 `{"status": "sent", "round": <count>, "out"}`, at once. Otherwise the reply is held until a Send brings the round count above `<n>`, which answers it with `sent` and the new round, or the end of the run answers it. |
| `PUT /api/session` | yes | `{"overall"?, "annotations"?}` | Applies the edits (§7), saves the file, 200 `{"ok": true, "updatedAt"}`. |
| `POST /api/submit` | yes | as `PUT` | Applies the edits and sends a round: every note without `round` is stamped with the next round number, the round is appended to `rounds` with the current `overall`, the file is saved, the reply is 200 `{"ok": true, "round": <n>}`, and every held wait whose `<n>` is below the new round is answered `sent`. The server keeps serving. With nothing to send — no unsent note, and an `overall` that, trimmed, equals the `overall` the last round sent, trimmed (`""` before any round) — the edits are still saved, the round count does not move, no wait is answered, and the reply is 409 `{"error": "nothing to send"}`. |
| `POST /api/reply` | yes | `{"round": <n>, "replies"?: [{"id", "body"}], "overall"?: "<text>"}` | The agent's replies for sent round `<n>`; it carries no viewer edits. The whole request is checked before anything is applied: `round` is an integer from 1 to the round count (`bad round: <value>`, `none` when absent); `replies`, when present, is an array (`replies is not a list`); `overall`, when present, is a string that is not blank (`overall reply is blank or not a string`); there is at least one entry or an `overall` (`nothing to reply`); and each entry `i` has a string `id` (`entry <i>: id is not a string`), a string `body` that is not blank (`entry <i>: body is blank or not a string`), and at least one stored note carrying that `id` that was sent in round `<n>` or earlier (otherwise `entry <i>: no note <id>`, `entry <i>: note <id> is not sent`, or `entry <i>: note <id> was sent after round <n>`). The request-level checks — `round`, `replies`, `overall`, at least one entry or an `overall` — run in that order, and the first that fails is the whole error; once they pass, each entry reports its first problem, in the order listed. Any problem answers 400 `{"error": "<the request-level problem, or every entry's first problem, joined by '; '>"}` and applies nothing. Otherwise each entry appends a reply `{"body", "round": <n>, "createdAt"}` (§7) to every stored note carrying its `id` that was sent in round `<n>` or earlier — an `id` given twice appends twice, and an unsent note sharing the `id` gets none — and `overall` appends one to `overallReplies` (§6), all with one `createdAt`. Then the file is saved, the listing is recomputed (§10), the change count goes up by one, the reply is 200 `{"ok": true, "replied": <the number of note replies appended>}`, and every held change wait is answered `changed`. A save that fails appends nothing and answers 500 `{"error"}`. |
| `POST /api/cancel` | yes | as `PUT` | Applies the edits without sending a round and ends the run as `cancelled`, with the deletion rule of §6; once the notes file has taken its final status, answers 200 `{"ok": true, "status": "cancelled"}`. |
| `POST /api/finish` | yes | as `PUT` | Applies the edits without sending a round and ends the run as `finished`; once the notes file has taken its final status, answers 200 `{"ok": true, "status": "finished"}`. Unsent notes stay in the file without `round`. |

**The end of the run.** Finish, Cancel and `SIGINT` / `SIGTERM` end the run once, whichever
comes first. The notes file takes its final status (§6), every held wait is answered with the
wait document for that end and every held change wait with its change document, the Cancel or
Finish request that ended the run is answered, and
the process prints the result document (§2) and exits 0 once those replies have been handed
to their sockets, or after 1000 ms, whichever is sooner. When the notes file cannot be saved,
that Cancel or Finish request is answered 500 `{"error"}` and the process exits 1 with the
error document (§3). Once
the end has begun, `PUT /api/session` and the four `POST` routes answer 409
`{"error": "the run has ended"}` and apply nothing, a request whose body was still arriving
included; a `GET /api/wait` answers the end's wait document at once, and a `GET /api/changes`
its change document. A caller other than the viewer ends the run with
`curl -s -X POST -H 'x-margin-token: <token>' http://127.0.0.1:<port>/api/finish`, and posts
replies with
`curl -s -X POST -H 'x-margin-token: <token>' -H 'content-type: application/json' --data-binary @- http://127.0.0.1:<port>/api/reply`,
the JSON body on standard input from a quoted heredoc, so no shell quoting touches it:
curl sends the `Host` the guard expects and no `Origin` (§9).

**Syntax colouring.** The viewer colours a file in the language its extension names, or its
whole file name when it has no extension (`Dockerfile`, `Makefile`), resolved through
highlight.js's own language names and aliases — never by auto-detection. A file with no match
renders plain.

**Request bodies.** On `PUT /api/session` and the `POST` routes other than `/api/reply`,
`overall` is applied only when it is a string and `annotations` only when it is an array;
other keys are ignored. An empty body counts as `{}`, so a `PUT` without one
only refreshes `updatedAt`. A body larger than 5 MiB (5,242,880 bytes) is refused and its
connection closed: nothing is applied or saved, and no status code is promised. A body that
is not valid JSON answers 500 `{"error"}` and applies nothing.

Any other method or path answers 404 `{"error": "not found"}` — under `/api/`, only once the
token check has passed. An error thrown while handling a request answers 500
`{"error": "<message>"}`.

## §9 Request guards

Three guards apply to every request, in this order; the first that fails answers:

1. **Host.** `http://<Host header>` must equal the server origin `http://127.0.0.1:<port>`.
   Anything else — `localhost:<port>`, another hostname that resolves to loopback, a missing
   `Host` on an HTTP/1.0 request — is refused with 421 `{"error": "wrong host"}`. An HTTP/1.1
   request with no `Host` header never reaches this guard: Node's HTTP server refuses it with
   400 first. This defeats DNS rebinding: a
   foreign page whose hostname resolves to `127.0.0.1` still sends its own hostname.
2. **Origin.** A request carrying an `Origin` header other than `http://127.0.0.1:<port>` is
   refused with 403. A request without an `Origin` header passes.
3. **Token.** Every path beginning with `/api/` needs the header `x-margin-token` equal to the
   run's token (§4); missing or different, it is refused with 403. The viewer page and its
   assets need no token.

The token is in the URL the server printed (§2) and, when `--token` sets it, with the caller
that set it and on the process command line, where other local processes can read it. It
guards against pages on other origins, not against local processes. The viewer reads it from the URL fragment (`#<token>`) and sends it on every API call.
Opened without the fragment, the viewer cannot load the session.

## §10 File listing and reading

**Listing.** The listing is computed when the run starts and again after every accepted reply
post (§8), each time with the run's root and scope and by the rules below. The current listing
is what `GET /api/session` returns, what `GET /api/file` reads from, and what the anchor rule
of §7 checks a new note against; a stored note is never re-checked. A file created after the
last computation is neither listed nor served until the next one. A recomputation that fails
keeps the previous listing, and one that finds no files is served as an empty listing.

- When `git ls-files` succeeds in the root, the listing is the tracked files plus the
  untracked files the repository's ignore rules do not exclude, under the scope
  (`git ls-files --cached --others --exclude-standard -- <scope>`). Ignored files never appear.
- Otherwise — the root is not in a git repository, or git is unavailable — it is a walk of
  each scope path that skips directories named `.git`, `node_modules`, `dist`, `build`,
  `coverage`, `.next`, `.turbo` and `target`.
- Either way, only regular files present on disk are listed. A symbolic link is never listed,
  and so never read, and the walk never descends into one. A scope path whose leading part is
  a linked directory is not resolved: git lists nothing beneath it, while the walk lists the
  files beneath it even when they lie outside the root (§13). Reading still refuses them.
- The run's own notes file (§6) is never listed, so its first save under the root leaves the
  listing unchanged.
- Paths are root-relative with `/` separators, without duplicates, sorted by code unit. An
  empty scope lists the whole root. A listing with no files when the run starts exits 1 (§3).

**Reading.** `GET /api/file` reads only a listed path, then:

- its real path, with every symbolic link resolved, must be a regular file inside the root's
  real path — otherwise the refusal `not a regular file inside the root`;
- a file larger than 2 MiB (2,097,152 bytes) is refused, with its size in the reason;
- a file with a NUL byte in its first 8000 bytes is refused as `binary file`;
- otherwise `text` is the file's content decoded as UTF-8.

A refusal answers 200 with `binary: true`; its `reason` is display text. A listed path that no
longer exists — removed, or a parent folder replaced by a file — answers 404
`{"error": "<p> no longer exists"}`; other read errors answer 500.

## §11 Skill–server seam

1. **Root.** On a fresh run the skill resolves the root (`git rev-parse --show-toplevel`, else
   the working directory). A resume takes the root recorded in the notes file.
2. **Start.** It starts `cli.mjs annotate` as a background command with the maximum timeout,
   since the command returns only when the run ends (§1), with stderr redirected to a file. A
   fresh run passes `--root <root>` and one `--scope` per path. A resume passes `--out
   <notes-file>` — the skill's `--resume <notes-file>` argument, as an absolute path — and no
   `--root`, so the recorded root applies (§4, §5); it passes `--scope` only for paths the
   user gave, which then resolve under the recorded root. It passes `--port` only when the
   user gave one, so the server otherwise binds a free port, and no `--token`, so the server
   mints the token.
3. **Read the URL.** It waits, bounded, for the stderr block's first line (§2), `margin:
   http://127.0.0.1:<port>/#<token>`. A process that exits before writing it has its error
   document on stdout (§2, §3), which the skill reports; a port that cannot be bound is not
   retried. A process still running when the wait ends has not bound yet — it lists the files
   before it listens — so the skill waits once more before it stops the process.
4. **Announce.** Once that line has appeared, it tells the user the URL exactly as printed,
   and the notes file the block names. It then takes the last round it treats as handled: `0`
   on a fresh run; on a resume, the `round` of the notes file it passed as `--out`, which the
   server has rewritten as `draft` before printing the block (§5).
5. **Wait for a round.** It runs `cli.mjs wait <url> --after <n>` (§1, §4) as a background
   command, with the URL from step 3 and `<n>` the last round handled, one wait at a time,
   and does not read the notes file while the wait is held. A `sent` wait document → step 6;
   an end status → step 9. A wait that exits without its document while the server still
   runs is started once more with the same `<n>`.
6. **Read the round.** It reads the notes file at the wait document's `out`. The round is
   every note whose `round` is above `<n>` and at most the wait document's `round`, which
   covers more than one Send when the human sent again before the wait was answered; notes of
   earlier rounds are context.
7. **Reply.** After acting on the round, it sends one `POST /api/reply` (§8) with that
   `round`, one entry per distinct note `id` of the round, and an overall reply. A 400 or 500
   applied nothing and may be sent again; a request whose outcome is unknown is not sent
   again, since a repeat appends twice (§13, retried replies). A 409 means the run has ended
   → step 9. Otherwise step 5, with `<n>` that round.
8. **Finish.** When the human ends the review in the session rather than in the viewer, the
   skill calls `POST /api/finish` (§8) with the run's token, and starts no further wait.
9. **Read after exit.** It waits for the process to exit, without polling, and parses the one
   stdout document (§2). Unless `status` is `error` or `out` is `null`, it reads the notes
   file at `out` for the run's summary.

The server never reads the skill's state: its whole input is its argument vector, the files
under the root, and the requests of the viewer and of the skill (Finish, replies). The skill's
whole input from the server is the stdout result document, the wait documents, the answers to
its reply and Finish requests, the URL on the stderr block's first line, and the notes file —
between rounds and after exit; the rest of the stderr block is for the human.

## §12 `--self-test`

```text
node <plugin-root>/server/cli.mjs --self-test
```

Exercises the rules a browser session does not, without a browser: the vendored highlight.js
loading in Node and the viewer's colouring seam on a fixed TSX sample (a block comment and a
template literal coloured on every line they span, a file with no matching language rendered
plain, a `Dockerfile` coloured by its name), and the viewer's static routes of §8; the anchor
rule of §7 for every kind, range validity and the excerpt cap; resume (§5) — a stored note
keeps its anchor through a write, a new note outside the listing is dropped, rounds and note
rounds restore, a file without `rounds` resumes as round 0, an absent `--out` starts fresh, and
each refusal; the atomic save of §6, which leaves no temporary file behind, and a failed save;
the sent-note lock of §7; replies (§7) kept through a viewer write that echoes or forges them
and through a save and a resume, a file without them resuming with none, each resume refusal
for them (§5), and a reply post whose save fails leaving the session as it was; the scope
check (§4); a listing that never lists a symbolic link, on both the git and the walk path,
nor the run's notes file (§10); the reading refusals and limits (§10); and, against a server on port 0 inside the
process, the three guards of §9 (the finish, wait, reply and change routes included), a Send
that keeps the server serving and sends the next round, a Send with nothing to send, Finish
with its result document and a write after the end refused, a Finish whose save fails answered
500 with the run failed, the deletion rule of §6 on an empty cancel and a cancel after a sent
round that keeps the file, `wait` returning on a Send and on Finish, held past a Send that does
not bring the round count above its `<n>`, and failing on a closed port, the reply route of §8
— replies on sent notes only, each refusal leaving the notes file byte for byte as it was with
nothing applied from a request that also holds a valid entry, an `id` given twice appending
twice, and a reply after the end refused 409 — re-listing after a reply post (§10), with a file
created mid-run listed and accepted as a `file` anchor only after it and a listed file that is
deleted, or whose parent folder becomes a file, answering 404 `no longer exists` and then
`not in scope` once a re-list drops it, and the change wait of §8 returning on a reply post and
on Finish, held past a refused reply post, and refusing a missing or malformed `after`. A few cases run `cli.mjs` itself: each refusal of §5 and the scope check exit with the
error document and leave an existing `--out` file byte for byte as it was; `wait`'s invocation
refusals exit 2, and a `wait` child, let go once the server holds its request, returns on a
Send and on Finish; one run serves a Send, keeps serving, and ends on Finish with exactly one
result document; and another run ends `interrupted` on `SIGTERM`.

It opens no browser, sends requests to `127.0.0.1` only, and binds no fixed port. It prints
`{"cases": <n>, "ok": true}` and exits 0 when every case passes; otherwise it prints
`{"status": "error", "error": "self-test: <case> — <detail>"}` for the first failing case and
exits 1. Unlike a review, it needs `git` on `PATH`: one listing case builds a repository. It
runs on every change in the repository's validation workflow.

## §13 Open questions

What this contract leaves undecided, each as a question.

- **Folder anchors and the scope.** Should a `folder` anchor also be bounded by the scope
  roots, so that an ancestor of the scope — `src` for the scope `src/features/orders` — is
  refused rather than passing because a listed file lies beneath it?
- **A resume under another root.** When `--out` names an existing file whose `root` differs
  from `--root`, should the run refuse, warn, or re-resolve the stored scope under the new
  root?
- **Silently dropped notes.** A new note that fails §7's checks is left out of the list while
  the viewer receives `{"ok": true}` and keeps showing the note. Should the server refuse the
  write or report the drop?
- **Duplicate note ids.** Two notes may share an id, and a later write then revises both
  from one stored note (§7). Should the server refuse a write or a resumed file that repeats
  an id, or give the repeat a fresh one?
- **Loose `--port` parsing.** `Number()` turns an empty `--port` into `0`, so the run binds a
  random port instead of exiting 2, and accepts exponent and hexadecimal forms (§4). Should
  `--port` accept decimal digits only?
- **Exits without a document.** An unhandled exception — a non-string entry in a resumed
  file's `scope`, or a platform opener command that is not installed (§4) — exits 1 with a
  stack trace on stderr and nothing on stdout, and a signal before the port is bound exits
  without the `interrupted` document. Should every exit print a document?
- **Symbolic links in a scope path.** The scope check compares path text and resolves no
  symbolic link, so outside git a walk of a scope path whose leading part is a linked
  directory lists files that lie outside the root (§10). Should the scope check and the
  listing be bounded by the root's real path, as reading is?
- **Deleting a resumed file.** A resumed run whose file records no sent round, cancelled with
  no notes and a blank `overall`, deletes the file it resumed. Is that intended for a file that
  existed before the run?
- **The revision on resume.** A resume replaces the stored `revision` with the current one, so
  the file no longer says which revision its notes were written against, and drift detection
  rests on `excerpt` alone — which only `range` notes carry. Should the file keep that
  revision?
- **Usage text and code headers.** `cli.mjs`'s usage line and header comment show `--root` as
  required, the token as `<hex>` and the paths as absolute. Should they match §4, and should
  the header comments point at this file instead of restating it?
- **Retried replies.** A reply post whose 200 was lost and is sent again appends its replies a
  second time (§8). Should a reply carry a client key the server de-duplicates on?
- **Re-listing between reply posts.** The listing is recomputed only after a reply post (§10),
  so a file the human creates between rounds is listed only once the agent next replies, and a
  run whose agent never replies keeps its start-time listing. Should a Send recompute it too?
