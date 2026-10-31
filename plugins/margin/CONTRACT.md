# The margin contract

Authoritative surface between `server/cli.mjs`, the `annotate` skill and the human who
reviews code in the viewer. The contract fixes the verbs, their flags, the stdout and stderr
output, the exit codes, resume, the notes-file schema, the anchor rule, the HTTP routes and
their guards, the file-listing and reading rules, the seam between the skill and the
server, the self-test, the overview document, the overview data verbs that produce it, and the
diagram document with the `diagram` verb that checks it. The implementation under `server/` and `ui/` is private and may change without
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
node <plugin-root>/server/cli.mjs annotate [--root <dir>] [--scope <path>]... [--out <file>] [--overview <file>] [--port <n>] [--token <token>] [--no-open]
node <plugin-root>/server/cli.mjs wait <url> [--after <n>]
node <plugin-root>/server/cli.mjs measure --root <dir> [--scope <path>]... --out <file> --hotspots <file>
node <plugin-root>/server/cli.mjs assemble --measurements <file> [--roles <file>] [--explorer <file> | --explorer-unavailable <reason>] --out <file>
node <plugin-root>/server/cli.mjs diagram --check <file>
node <plugin-root>/server/cli.mjs --self-test
```

| Part | Meaning |
|---|---|
| `<plugin-root>` | The installed `margin` plugin directory. The skill runs it as `${CLAUDE_PLUGIN_ROOT}`. |
| `annotate`, `wait`, `measure`, `assemble`, `diagram` | The five verbs. `wait`, `measure`, `assemble` and `diagram` are recognised only as the first argument, and their positional arguments must be exactly the verb — `wait <url>` for `wait`, `diagram <file>` for `diagram`. Otherwise the first positional argument must be `annotate`; further positional arguments are ignored. |
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
resolves the root and scope, lists the files (§10), reads and checks the overview file when
`--overview` names one (§13), binds the port, writes the notes file as
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

`measure` validates its arguments (§3), lists the files under the scope (§10), measures each
(§14), and writes the measurement document to `--out` and the hotspot table to `--hotspots`.
It then prints the measure document (§2) and exits 0. It binds no port and reads only the
listed files, the `tsconfig.json` files at or below the root with the configs they extend, and
`git`'s output.

`assemble` validates its arguments (§3), reads the measurement document `measure` wrote and
the roles file and the explorer output when given — or takes the reason `--explorer-unavailable`
gives in place of the explorer output — builds the overview document of §13 from them (§14),
checks it, and writes it to `--out`. It then prints the assemble document (§2) and
exits 0. The file it writes is the one `annotate --overview` reads.

`diagram --check` validates its arguments (§3), reads and checks the diagram file (§15),
prints the diagram document (§2) and exits 0. It binds no port and writes nothing.

## §2 Output rules

**stdout** carries exactly one JSON document on every handled exit, with two-space
indentation and one trailing newline, and nothing else. It has one of seven shapes.

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

The measure document, on exit 0 from `measure`, with its keys in this order:

| Key | Value |
|---|---|
| `status` | `ok`. |
| `out` | The absolute path of the measurement document written (§14). |
| `hotspots` | The absolute path of the hotspot table written (§14). |
| `files` | The number of files measured. |
| `churn` | `git` when the root is in a git repository, so churn was counted from it; `null` when it is not, so every `churn` is `null` (§14). |

The assemble document, on exit 0 from `assemble`, with its keys in this order:

| Key | Value |
|---|---|
| `status` | `ok`. |
| `out` | The absolute path of the overview document written (§13). |
| `files` | The number of file entries. |
| `candidates` | The number of candidates kept. |
| `dropped` | The number of explorer blocks dropped (§14). |
| `notices` | The number of notices. |

The diagram document, on exit 0 from `diagram --check`, with its keys in this order:

| Key | Value |
|---|---|
| `status` | `ok`. |
| `file` | The absolute path of the diagram file checked. |
| `canonical` | `true` when the file's text is exactly the canonical form of its document (§15), `false` otherwise. |
| `groups`, `boxes`, `arrows`, `walkthroughs` | The number of entries in each. |

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

`measure` and `assemble` print no stderr block either. On exit 0, after their files are
written, they print one line per warning, `margin: <verb>: <warning>` — a skipped or
unparseable `tsconfig.json` for `measure`, a dropped explorer block or a roles field set to
`null` for `assemble` (§14). The lines are for the human; a caller may show them but does not
parse them. A refused run prints none. `diagram` prints nothing on stderr.

## §3 Exit codes

| Code | Meaning | Document |
|---|---|---|
| `0` | `annotate`: the run ended — Finish (`finished`), Cancel (`cancelled`), or `SIGINT` / `SIGTERM` after the port was bound (`interrupted`). `wait`: a round was sent or the run ended. `measure` and `assemble`: their files were written. `diagram --check`: the file passed the check (§15). Or every self-test case passed (§12). | Result, wait, measure, assemble, diagram, or self-test |
| `1` | The run could not proceed: the `--out` file is refused on resume (§5), no files are listed under the scope (§10), the `--overview` file is refused (§13), the port cannot be bound (`could not listen on port <n>: <code>`), or the end of the run cannot save the notes file. `wait`: the server is unreachable — the connection is refused, or it drops before the reply ends (`server unreachable at <origin>: <code>`) — or it answers with an error (`wait: <status> <error>`). `measure`: no files are listed under the scope (`no files under <scope>`), or an output cannot be written (`could not write <file>: <code>`). `assemble`: the measurement file is refused (§14), the assembled document fails the shape check of §13 (`assembled overview: <violation>`), it is above 2 MiB once serialised (`overview <out>: <x.y> MB is above the 2 MB overview limit`), or `--out` cannot be written. `diagram`: the file is refused (§15). Or a self-test case failed (§12). | Error |
| `2` | The invocation is wrong: an unknown flag, a flag missing its value or given a value it does not take, a missing or different verb, `--self-test` given with any other argument, a `--port` whose `Number()` value is not an integer from 0 to 65535 (§4), a `--token` outside its class (§4), an empty `--overview` (§4), or a scope path — given by `--scope` or read from a resumed file — that resolves outside the root. For `wait`: no URL or another positional argument, a URL that is not a run URL (§4), or an `--after` that is not a whole number of decimal digits. For `measure`: another positional argument, a missing or empty `--root`, `--out` or `--hotspots` (`measure needs --<flag>`, `bad --<flag>: empty`), a `--hotspots` that names the same file as `--out`, or a `--scope` outside the root. For `assemble`: another positional argument, a missing or empty `--measurements` or `--out`, an empty `--roles` or `--explorer`, or an `--explorer-unavailable` given together with `--explorer` (`--explorer and --explorer-unavailable are exclusive`), holding a control character such as a line break (`bad --explorer-unavailable: not one line`), or blank once trimmed and stripped of one trailing `.` (`bad --explorer-unavailable: empty`). For `diagram`: no `<file>` or another positional argument, `--check` absent (`diagram needs --check`) or given a value, or an empty `<file>` (`bad <file>: empty`). | Error |

`annotate`'s checks run in this order, and the first failure is the one reported: arguments
and verb, then `--port`, then `--token`, then an empty `--overview`, then the resumed file's
JSON and its `annotations` array (§5), then the scope paths, then the listing, then the resumed
rounds, the agent's overall replies and notes (§5), then the overview file (§13), then the port
binding. Every one of them happens before the first save, so a refused run
writes nothing: an existing `--out` file is left exactly as it was.

`wait`'s checks run in this order: its arguments parse, its positional arguments are exactly
`wait <url>`, the URL is a run URL, then `--after`. Every one of them happens before its one
request.

`measure`'s checks run in this order: its arguments parse, its positional arguments are
exactly `measure`, `--root`, `--out` and `--hotspots` are each given and non-empty, `--hotspots`
is not `--out`, then the scope paths, then the listing. Every one of them happens before the
first write. It writes `--out` before `--hotspots`, so a failure writing `--out` leaves
`--hotspots` unwritten.

`assemble`'s checks run in this order: its arguments parse, its positional arguments are
exactly `assemble`, `--measurements` and `--out` are each given and non-empty, `--roles` and
`--explorer` are non-empty when given, `--explorer-unavailable` is not given with `--explorer`,
is one line and is not blank, then the measurement file, the shape check and the size limit.
Every one of them happens before its one write, so a refused run leaves an existing `--out`
file exactly as it was. A roles file or explorer output that is missing or unreadable
is not a refusal (§14).

`diagram`'s checks run in this order: its arguments parse, its positional arguments are
exactly `diagram` and one `<file>`, `--check` is given, `<file>` is non-empty, then the read —
not found, not a regular file, the size limit, the read itself, the JSON — and then the shape
check (§15). It writes nothing, so a refused file is left exactly as it was.

## §4 Flags

Long flags only. Both `--flag value` and `--flag=value` are accepted for a flag that takes a
value. A flag other than `--scope` given twice keeps its last value.

| Flag | Default | Meaning |
|---|---|---|
| `--root <dir>` | see meaning | The directory the scope is resolved against and served from. The flag applies when given, else the resumed file's `root` when it is a string (§5), else the working directory. A relative value resolves against the working directory; the result is absolute. |
| `--scope <path>` | none | Repeatable. A file or folder, relative to the root (an absolute path inside the root is accepted). Each is normalised to a root-relative path, and the root itself becomes `.`. A path outside the root exits 2; the check compares path text and resolves no symbolic link (§10). With no `--scope`, a resumed file's `scope` applies when it is an array; otherwise the scope is empty and the whole root is listed. |
| `--out <file>` | `<root>/claudedocs/margin/<stamp>.json` | The notes file. `<stamp>` is the start time in UTC as `YYYY-MM-DDTHH-MM-SS`. A relative value resolves against the working directory. When the file exists, the run is a resume (§5). Missing parent directories are created on the first save. |
| `--overview <file>` | none | An overview document (§13), served at `GET /api/overview` (§8). A relative value resolves against the working directory. The file is read and checked once, when the run starts and before the port is bound; a refused file exits 1 and writes nothing (§3), and an empty value exits 2. The file is never listed (§10). It applies on a fresh run and on a resume alike, and the notes file does not record it. |
| `--port <n>` | `0` | An integer from 0 to 65535 after the value is converted with JavaScript's `Number()`: an empty or all-whitespace value becomes `0`, and `1e3` and `0x10` are accepted as `1000` and `16` (§16). `0` lets the operating system assign a free port; the bound port is the one in the stderr URL. |
| `--token <token>` | minted | 16 to 128 characters from `[A-Za-z0-9_-]`. When absent, the server mints 32 lowercase hexadecimal characters (16 random bytes). Setting it lets a caller know the viewer URL's fragment before the server prints it. |
| `--no-open` | off | Do not open the viewer. Without it, the server opens the URL with the platform opener (`open` on macOS, `start` on Windows, `xdg-open` elsewhere). An opener that starts and fails is ignored, since the URL is on stderr; an opener command that is not installed ends the run with exit 1 and no stdout document, after the draft is saved and the stderr block is printed (§16). |

**`wait`** takes one positional argument and one flag:

| Argument | Default | Meaning |
|---|---|---|
| `<url>` | required | The run URL: the URL on the stderr block's first line (§2), `http://127.0.0.1:<port>/#<token>`, fragment included. A URL with another host or scheme, no explicit port, a path other than `/`, a query, credentials, or a fragment outside the `--token` class above is refused with exit 2 before any request is made; the refusal does not echo the URL, since it carries the token. The token is sent only in the `x-margin-token` header, and only to that origin. |
| `--after <n>` | the round count the run started with | The last round the caller has seen, as a whole number of decimal digits. The wait returns at once when the run has sent more rounds than `<n>` or its end has begun, and holds otherwise. The default is `0` on a fresh run and the restored count on a resume (§5), so a first wait on a resumed file does not return for rounds an earlier run sent. |

**`measure`** takes four flags:

| Flag | Default | Meaning |
|---|---|---|
| `--root <dir>` | required | The directory measured. |
| `--scope <path>` | none | Repeatable, as for `annotate`: normalised the same way, a path outside the root exits 2, and with no `--scope` the whole root is measured. |
| `--out <file>` | required | Where the measurement document (§14) is written. |
| `--hotspots <file>` | required | Where the hotspot table (§14) is written; not the same file as `--out`. |

**`assemble`** takes five flags:

| Flag | Default | Meaning |
|---|---|---|
| `--measurements <file>` | required | The measurement document `measure` wrote. |
| `--roles <file>` | none | The roles JSON (§14). When it is not given, missing or unreadable, every role field is `null` and a notice says why. |
| `--explorer <file>` | none | A deepen explorer's text output (§14). When it is not given, missing or unreadable, there are no candidates and a notice says why. |
| `--explorer-unavailable <reason>` | none | One line of text: why there is no explorer output, such as an explorer that is not installed or that failed. There are no candidates, and the notice gives this reason (§14). Exclusive with `--explorer`. |
| `--out <file>` | required | Where the overview document (§13) is written. It may name the `--measurements` file, which is read in full first. |

For both verbs a relative path resolves against the working directory, missing parent
directories are created, and each output is written to a temporary file in its directory and
renamed over the target, as the notes file is (§6), so a reader never sees a partial file. A
`measure` run never lists its own two outputs (§14), but a later run lists them when they lie
under its root and scope, so they belong outside the root.

**`diagram`** takes one positional argument and one flag, in any order after the verb:

| Argument | Default | Meaning |
|---|---|---|
| `<file>` | required | The diagram file (§15). A relative path resolves against the working directory. |
| `--check` | required | Check the file and print the diagram document (§2). It takes no value. |

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
| `annotations` | The notes (§7), in the order they were created, except that a Send moves the notes it withholds after the notes it stamps (§7). The viewer sorts them for display only. |

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
| `id` | A string. A note that arrives without one gets a fresh UUID when the server accepts it; the viewer mints UUIDs for the notes it creates. It is the identity a later write revises the note by. Ids are not checked for uniqueness: a write or a resumed file may hold two notes with one id, and both are kept; a later write then revises each note carrying that id from the last stored note with it (§16). |
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
| `candidate` | `kind`, `name` | A deepening candidate of the run's overview (§13), named by its `name`, which follows §13's name rule. |

`path` is root-relative with `/` separators, as the listing writes it (§10). An anchor of any
other kind, a `folder`, `file` or `range` anchor without a string `path`, or a `candidate`
anchor whose `name` is not a string that follows §13's name rule, is rejected. A `candidate`
anchor carries no `path`.

**The anchor rule.** An anchor is checked against the listed paths (§10) and the names of the
run's overview candidates (§13) once, when the server first accepts the note — one rule per
kind:

- `scope` always passes.
- `folder` passes when at least one listed file lies beneath `<path>/`. A `path` of `.`, an
  empty `path` or one ending in `/` therefore never passes; a remark about the whole scope is
  a `scope` note.
- `file` and `range` pass when `path` is itself a listed file.
- `candidate` passes when `name` is the `name` of a candidate in the run's overview; a run
  without an overview has none, so no `candidate` anchor passes.

A note whose anchor fails is rejected. The anchor never changes afterwards:

- A write from the viewer that carries the `id` of a stored unsent note revises that note's
  `intent` (when it is one of the two values) and `body` (when it is a string) only. Its
  anchor and `createdAt` stay as stored, whatever the write sends.
- A note loaded from a resumed file is checked for shape only (§5) and keeps its anchor even
  when its file has moved, been deleted or fallen outside this run's scope, or its candidate
  is not in this run's overview.

A range's `excerpt` is fixed with its anchor, so a reader compares it with the file as it is
now to detect drift.

**Saves carry the whole list.** A write that includes `annotations` replaces the list of
unsent notes: a stored unsent note whose `id` is absent from the write is deleted, and a note
whose `id` matches no stored note is a new note and goes through the checks above. A new note
that fails them is left out of the list, and the write still answers `{"ok": true}` (§16) —
except a new `candidate` note whose `name` is not the `name` of a candidate in the run's
overview, a `name` that is missing, not a string or breaks §13's name rule included: it
refuses the whole write, which answers 400 `{"error": "<problems joined by '; '>"}`, one
problem per such entry, `entry <i>: <name> is not a candidate of this run's overview` — `<i>`
the entry's index in `annotations`, `<name>` the name as JSON, `null` when it is missing — and
applies and saves nothing. A new `candidate` note that names a candidate of the overview but
fails another check, such as a `body` that is not a string, is left out like any other.

**Sent notes are locked.** No write revises or deletes a note that carries `round`: a write
entry carrying a sent note's `id` is ignored, and a sent note absent from the write is kept,
so a write never changes a note's `replies` either. Every note present at a Send is stamped,
except a withheld note — an unsent `candidate` note whose candidate the run's overview does not
name, as when a file is resumed under another overview or none. A withheld note stays unsent, does
not count as something to send (§8), and moves after the notes the Send stamps, so sent notes
all predate unsent ones; the list otherwise stays in creation order, sent notes first.

## §8 HTTP routes

The server listens on `127.0.0.1` only, at the bound port. Every response carries
`cache-control: no-store`; JSON responses are `application/json; charset=utf-8`. Every
request passes the guards of §9 first. Eleven routes:

| Route | Token | Request | Response |
|---|---|---|---|
| `GET /` | no | — | The viewer page. Its static assets, `GET /app.js`, `/syntax.js`, `/rounds.js`, `/overview.js`, `/overview-view.js`, `/vendor/highlight.min.js`, `/vendor/dockerfile.min.js` and `/style.css`, are served the same way and belong to this route. |
| `GET /api/overview` | yes | — | 200 with the overview document as checked (§13). 404 `{"error": "no overview"}` when the run has none. Served until the process exits. |
| `GET /api/session` | yes | — | 200 `{"session": <the notes file object, §6>, "files": [<the current listing, §10>], "changes": <the run's change count>}`. The change count is `0` when the process starts, is kept in memory only, and goes up by one on every accepted reply post. |
| `GET /api/file?path=<p>` | yes | — | `<p>` not in the current listing: 404 `{"error": "<p> is not in scope"}`. A listed path that no longer exists — removed, or a parent folder replaced by a file: 404 `{"error": "<p> no longer exists"}`. Otherwise 200 with `{"path", "text"}` or a refusal `{"path", "binary": true, "reason"}` (§10). |
| `GET /api/changes?after=<n>` | yes | — | `after` absent or not a whole number of decimal digits: 400 `{"error": "bad after: <value>"}`, `<value>` empty when absent. Once the end of the run has begun: 200 `{"status": <the end's status>, "changes": <count>}`, at once. When the change count exceeds `<n>`: 200 `{"status": "changed", "changes": <count>}`, at once. Otherwise the reply is held until an accepted reply post brings the count above `<n>`, which answers it `changed` with the new count, or the end of the run answers it. |
| `GET /api/wait?after=<n>` | yes | — | `after` present and not a whole number of decimal digits: 400 `{"error": "bad after: <value>"}`. Without `after`, `<n>` is the round count the run started with (§4). Once the end of the run has begun: 200 with that end's wait document (§2), at once. When the round count exceeds `<n>`: 200 `{"status": "sent", "round": <count>, "out"}`, at once. Otherwise the reply is held until a Send brings the round count above `<n>`, which answers it with `sent` and the new round, or the end of the run answers it. |
| `PUT /api/session` | yes | `{"overall"?, "annotations"?}` | Applies the edits (§7), saves the file, 200 `{"ok": true, "updatedAt"}`. A new `candidate` note that names no candidate of the run's overview answers 400 `{"error"}` with nothing applied or saved (§7). |
| `POST /api/submit` | yes | as `PUT` | Applies the edits, refused like `PUT`, and sends a round: every note without `round` except a withheld note (§7) is stamped with the next round number, the round is appended to `rounds` with the current `overall`, the file is saved, the reply is 200 `{"ok": true, "round": <n>}`, and every held wait whose `<n>` is below the new round is answered `sent`. The server keeps serving. With nothing to send — no unsent note other than withheld ones, and an `overall` that, trimmed, equals the `overall` the last round sent, trimmed (`""` before any round) — the edits are still saved, the round count does not move, no wait is answered, and the reply is 409 `{"error": "nothing to send"}`. |
| `POST /api/reply` | yes | `{"round": <n>, "replies"?: [{"id", "body"}], "overall"?: "<text>"}` | The agent's replies for sent round `<n>`; it carries no viewer edits. The whole request is checked before anything is applied: `round` is an integer from 1 to the round count (`bad round: <value>`, `none` when absent); `replies`, when present, is an array (`replies is not a list`); `overall`, when present, is a string that is not blank (`overall reply is blank or not a string`); there is at least one entry or an `overall` (`nothing to reply`); and each entry `i` has a string `id` (`entry <i>: id is not a string`), a string `body` that is not blank (`entry <i>: body is blank or not a string`), and at least one stored note carrying that `id` that was sent in round `<n>` or earlier (otherwise `entry <i>: no note <id>`, `entry <i>: note <id> is not sent`, or `entry <i>: note <id> was sent after round <n>`). The request-level checks — `round`, `replies`, `overall`, at least one entry or an `overall` — run in that order, and the first that fails is the whole error; once they pass, each entry reports its first problem, in the order listed. Any problem answers 400 `{"error": "<the request-level problem, or every entry's first problem, joined by '; '>"}` and applies nothing. Otherwise each entry appends a reply `{"body", "round": <n>, "createdAt"}` (§7) to every stored note carrying its `id` that was sent in round `<n>` or earlier — an `id` given twice appends twice, and an unsent note sharing the `id` gets none — and `overall` appends one to `overallReplies` (§6), all with one `createdAt`. Then the file is saved, the listing is recomputed (§10), the change count goes up by one, the reply is 200 `{"ok": true, "replied": <the number of note replies appended>}`, and every held change wait is answered `changed`. A save that fails appends nothing and answers 500 `{"error"}`. |
| `POST /api/cancel` | yes | as `PUT` | Applies the edits, refused like `PUT`, without sending a round and ends the run as `cancelled`, with the deletion rule of §6; once the notes file has taken its final status, answers 200 `{"ok": true, "status": "cancelled"}`. |
| `POST /api/finish` | yes | as `PUT` | Applies the edits, refused like `PUT`, without sending a round and ends the run as `finished`; once the notes file has taken its final status, answers 200 `{"ok": true, "status": "finished"}`. Unsent notes stay in the file without `round`. |

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
  files beneath it even when they lie outside the root (§16). Reading still refuses them.
- The run's own notes file (§6) and the overview file `--overview` names (§13) are never
  listed, whatever their paths, so the notes file's first save under the root leaves the
  listing unchanged. The exclusion compares root-relative path text, so a file outside the
  root never matches.
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
   user gave, which then resolve under the recorded root. A fresh overview run also passes
   `--out <root>/claudedocs/margin/<stamp>.json`, a path that does not exist yet, so the run
   is fresh and its notes file is created there (§5), and `--overview` naming the overview
   file assembled beside it, `<stamp>.overview.json`. A resume passes `--overview` with the
   notes file's sibling — its path with the trailing `.json` replaced by `.overview.json` —
   when that file exists. It passes `--port` only when the
   user gave one, so the server otherwise binds a free port, and no `--token`, so the server
   mints the token.
3. **Read the URL.** It waits, bounded, for the stderr block's first line (§2), `margin:
   http://127.0.0.1:<port>/#<token>`. A process that exits before writing it has its error
   document on stdout (§2, §3), which the skill reports; a port that cannot be bound is not
   retried. A process still running when the wait ends has not bound yet — it lists the files
   before it listens — so the skill waits once more before it stops the process.
4. **Announce.** Once that line has appeared, it tells the user the URL exactly as printed,
   and the notes file the block names. The last round it treats as handled is `0` on a fresh
   run; on a resume, it is the number of `rounds` in the notes file it passes as `--out`, read
   before step 2 starts the server, since the viewer can send a round as soon as it opens.
   The server keeps those rounds as stored and resumes from their count (§5).
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
   again, since a repeat appends twice (§16, retried replies). A 409 means the run has ended
   → step 9. Otherwise step 5, with `<n>` that round.
8. **Finish.** When the human ends the review in the session rather than in the viewer, the
   skill calls `POST /api/finish` (§8) with the run's token, and starts no further wait.
9. **Read after exit.** It waits for the process to exit, without polling, and parses the one
   stdout document (§2). Unless `status` is `error` or `out` is `null`, it reads the notes
   file at `out` for the run's summary.

The server never reads the skill's state: its whole input is its argument vector, the files
under the root, the overview file `--overview` names (§13), and the requests of the viewer and of the skill (Finish, replies). The skill's
whole input from the server is the stdout result document, the wait documents, the answers to
its reply and Finish requests, the URL on the stderr block's first line, and the notes file —
between rounds and after exit; the rest of the stderr block is for the human.

The overview file `--overview` names is produced by `measure` and then `assemble` (§14), each
run as its own command before `annotate` starts; `annotate` never runs them. Between the two,
the skill has the files described and the candidates found from `measure`'s outputs, and
passes the returns to `assemble` as `--roles` and `--explorer`, or `--explorer-unavailable`
with the reason there is no explorer output.

## §12 `--self-test`

```text
node <plugin-root>/server/cli.mjs --self-test
```

Exercises the rules a browser session does not, without a browser: the vendored highlight.js
loading in Node and the viewer's colouring seam on a fixed TSX sample (a block comment and a
template literal coloured on every line they span, a file with no matching language rendered
plain, a `Dockerfile` coloured by its name), and the viewer's static routes of §8; the viewer's
round controller in Node against a fake server — the anchor rule of §7 against the listing and
the overview's candidate names, and the Send rule of §8 with withheld candidate notes left out
and Send held while the overview could not be loaded and a candidate note is unsent, writes
sent one at a time each carrying the session as it stands when it starts, the server's copy
merged by ownership after a change (sent notes and round fields from the server, unsent notes and the overall text from the viewer, an unsent note whose anchor left
the listing removed), Send, Finish and Cancel with each refusal and the end raised once, and the
change wait's backoff from 1 s doubling, its reconnection check and its end; the viewer's
outline model in Node — rows grouped by scope entry and folder from an overview document
(§13), imported-by, candidate membership, bars scaled per reading with unmeasured files left
empty, each row's anchor rule against the listing, and note counts per file, folder and
candidate; the diagram model of §15 in Node — a document accepted with its keys rebuilt in
canonical order, each refusal (an unknown key at every level, a duplicate id or walkthrough
name, a dangling `from`, `to`, `group` or step arrow, a bad kind, id, label or diagram path, a
non-integer position and a position given half), the canonical text of a fixed document and
its byte-identical round trip, a layout that is deterministic and places every box when none
is positioned, never moves a positioned box and keeps placed boxes clear of it, ranks through
cycles and self-loops, keeps each group's members contiguous with frames that are their
members' bounds and never overlap, and leaves its input unchanged — and the diagram file's
reading refusals and size limit; the anchor rule of §7 for every kind — a `candidate` anchor kept for a name of the
run's overview, dropped for any other name or a name that breaks §13's rule, and checked for
shape only when read back — a new candidate note outside the overview, a name that breaks
§13's rule or is missing included, refusing the write with each failing entry named, while a
revision, a sent id or a known candidate with a malformed body does not, range
validity and the excerpt cap; resume (§5) — a stored note
keeps its anchor through a write, a new note outside the listing is dropped, rounds and note
rounds restore, a file without `rounds` resumes as round 0, an absent `--out` starts fresh, and
each refusal; the atomic save of §6, which leaves no temporary file behind, and a failed save;
the sent-note lock of §7, and a Send withholding the candidate notes the overview does not name;
replies (§7) kept through a viewer write that echoes or forges them
and through a save and a resume, a file without them resuming with none, each resume refusal
for them (§5), and a reply post whose save fails leaving the session as it was; the scope
check (§4); a listing that never lists a symbolic link, on both the git and the walk path,
nor the run's notes file or overview file (§10); the reading refusals and limits (§10); the
overview document of §13 — a document accepted with its unknown fields dropped, each shape
refusal, each reading refusal and the size limit; the overview data of §14 — the import scan
over every form, past comments inside an import, with commented-out imports ignored and
comment markers inside strings kept, resolution against the listing with the extension, `index` and `.js`-to-`.ts`
probes, `tsconfig.json` `paths` with and without `baseUrl`, through `extends`, past comments
and trailing commas, with an `extends` cycle, an `extends` outside the root (a symbolic-link
folder included) and an unparseable config warned; the line count, the
indent width, a half-length on a stray line or under doc-comment lines left unhalved, and the
indentation sum; churn counted from dated commits in a temporary
repository with a commit older than six months left out, a root below the repository's top
level, a root outside git and a repository without commits; the hotspot table; explorer
blocks parsed, a block with its fields out of order included, and dropped for a malformed site
line, a file outside the scope, a tier the shape check refuses, a repeated name, a
non-numeric `est_diff_lines`, a site outside the block's files, a missing field, and a name
field written capitalised, bulleted or in bold; roles merged, with wrong-typed fields set to `null` and
unknown paths ignored; each notice; the measurement-file refusals for a missing file, invalid
JSON, a non-object, and a bad `version`, `root` or `files` entry; the overview size limit; and,
against a server on port 0 inside the
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
on Finish, held past a refused reply post, and refusing a missing or malformed `after`, the
overview route of §8 behind the token, with its 404 without an overview, and candidate notes
against the run's overview — a known one accepted and sent, an unknown one beside valid notes
refused 400 on `PUT /api/session`, submit, cancel and finish with nothing applied or saved and
the run still serving, and every candidate note refused on a run without an overview. A few cases run
`cli.mjs` itself: each refusal of §5, the scope check and each `--overview` refusal of §13 exit
with the error document and leave an existing `--out` file byte for byte as it was, and an
empty `--overview` exits 2; `wait`'s invocation
refusals exit 2, and a `wait` child, let go once the server holds its request, returns on a
Send and on Finish; one run serves a Send, keeps serving, and ends on Finish with exactly one
result document; another run ends `interrupted` on `SIGTERM`; a run given `--overview`
serves the document, keeps the file out of the listing, after a reply post included, and
sends a candidate note;
`measure` refusals of §3 (a missing or empty flag, an extra positional, `--hotspots` equal to
`--out`, a scope outside the root or listing no file) and `assemble` refusals (a missing or
empty flag, and a measurement file that is missing, not JSON or holds a dangling import) exit
with the error document and write nothing, the last two leaving an existing `--out` file byte
for byte as it was; and `measure` then `assemble` on a
temporary repository write the measurement document, the hotspot table and an overview the
shape check of §13 accepts, with the dropped block's warning on stderr, and an `assemble`
given neither roles nor explorer output writes an overview with both notices; an `assemble`
given `--explorer-unavailable` writes its reason as the candidates notice, with roles merged
beside it, and its refusals — an empty or blank reason, a reason with a line break, and the
flag given with `--explorer` — exit 2 before the measurement file is read, leaving an existing
`--out` file byte for byte as it was; and `diagram --check` exits 0 with the diagram document
for a valid file, 1 with the error document for a missing or refused one, and 2 for each
invocation refusal of §3, leaving the file byte for byte as it was.

It opens no browser, sends requests to `127.0.0.1` only, and binds no fixed port. It prints
`{"cases": <n>, "ok": true}` and exits 0 when every case passes; otherwise it prints
`{"status": "error", "error": "self-test: <case> — <detail>"}` for the first failing case and
exits 1. Unlike a review, it needs `git` on `PATH`: the listing and measurement cases build
repositories, and the measurement cases commit to them. It runs on every change in the
repository's validation workflow.

## §13 Overview document

A run given `--overview <file>` (§4) carries one overview document: a JSON object, UTF-8,
describing the run's files and the refactoring candidates found in them. The server reads it
once, when the run starts, and serves it unchanged for the whole run at `GET /api/overview`
(§8); it is a snapshot, and nothing refreshes it. The file is at most 2 MiB (2,097,152 bytes).

**Top level.** Every key below is required; a key that is present with a wrong value and a key
that is missing are both refused.

| Field | Value |
|---|---|
| `version` | `1`. |
| `root` | An absolute path: the root the overview was made for. It is not compared with the run's root. |
| `scope` | An array of `.` or overview paths (below); may be empty. |
| `generatedAt` | An ISO 8601 UTC timestamp, `YYYY-MM-DDTHH:MM:SSZ` with an optional fraction of a second before the `Z`, as JavaScript's `Date.prototype.toISOString` writes it; a string of that form that `Date.parse` cannot read, such as month `13`, is refused. |
| `files` | An array of file entries (below); may be empty. |
| `candidates` | An array of candidate entries (below); may be empty. |
| `notices` | An array of non-empty strings, shown in the viewer as they are — why there are no candidates, for example; may be empty. |

**A `files[]` entry.** Each measurement field and each of the four role fields is nullable on
its own: a field the producer could not measure or describe is present as `null`, whatever the
entry's other fields hold.

| Field | Value |
|---|---|
| `path` | An overview path, unique across `files`. |
| `lines`, `churn`, `indentation` | A non-negative integer, or `null`. |
| `kind`, `role` | A non-empty string, or `null`. |
| `exports`, `mixes` | An array of non-empty strings, or `null`. |
| `imports` | An array of the overview paths this file imports; each is the `path` of a `files` entry, and none appears twice. |
| `outside` | An array of non-empty strings: import specifiers that name nothing in `files`. |

**A `candidates[]` entry.**

| Field | Value |
|---|---|
| `name` | Lowercase letters, digits and hyphens, starting with a letter or digit; unique across `candidates`. A `candidate` note (§7) names one. |
| `tier` | `strong`, `worth-exploring` or `speculative`. |
| `category` | `in-process`, `local-substitutable`, `remote-owned` or `true-external`. |
| `files` | A non-empty array; each is the `path` of a `files` entry, and none appears twice. |
| `next_change` | A non-empty string: the change this candidate would make cheaper. |
| `next_sites` | An array, may be empty, of `{"path", "line", "what"}`: `path` one of this candidate's `files`, `line` an integer of at least 1, `what` a non-empty string. |
| `est_diff_lines` | A non-negative integer. |
| `deletion_test` | A non-empty string. |
| `friction` | A non-empty string. |

**Overview paths.** Root-relative with `/` separators, as the listing writes them (§10): a
non-empty string with no `\`, not starting with `/`, and with no empty, `.` or `..` segment.

**Unknown fields** are dropped at every level, and only the checked fields reach
`GET /api/overview`. Numbers are never read from strings.

**Refusals.** The first violation refuses the run with exit 1 and writes nothing (§3). The
reason begins `overview <file>:`, `<file>` the absolute path, and goes on with one of
`not found`, `not a regular file`, `<x.y> MB is above the 2 MB overview limit`,
`could not be read (<code>)`, `not valid JSON (<detail>)`, or the violation itself, named by
its location in the document — `missing key <location>`, `<location> is not <what it must be>`,
`<location> duplicates <location>`, `<location> is not an overview file`.

## §14 Overview data

`measure` and `assemble` (§1) produce the overview document of §13 in two steps with files
between them: `measure` writes the measurement document and the hotspot table, which a deepen
explorer reads, and `assemble` merges the measurements with a roles JSON and the explorer's
output. The measurements are mechanical; the roles and the candidates are model-written and
reach `assemble` as files.

**Listing.** `measure` lists the files under its root and scope by the rule of §10, with its
own `--out` and `--hotspots` files left out. Every listed file has one entry.

**Measurements.** Per file:

| Field | Value |
|---|---|
| `lines` | The viewer's line count: the text split on `\n`, an unterminated last line counted, an empty file `0`. |
| `churn` | The number of commits in the last six months that touch the file, from `git log --since="6 months ago" --no-renames --relative -- <scope>` run in the root: the window is on committer date, and a renamed file counts only the commits since the rename. `0` in a repository with no commits; `null` for every file when the root is not in a git repository. |
| `indentation` | The sum, over the file's non-blank lines, of its leading tabs plus its leading spaces divided by the indent width, rounded down. |
| `imports` | The listed files the file imports (below), root-relative, each once, in the order first imported; never the file itself. |
| `outside` | The import specifiers, exactly as written, each once in the order first seen, that resolve to no listed file: a package, a `node:` builtin, a relative path that names no listed file or leaves the root, or a file outside the scope. |

The **indent width** is detected once over every listed text file: the most frequent length of
a leading run of spaces on a non-blank line, the smaller length on a tie, halved while it is
even and its half starts at least half as many lines as that most frequent length does, so a
few stray lines never narrow it; `1` when no line starts with a space. A file the reading rule
of §10 refuses — binary, larger than 2 MiB, or no longer a regular file inside the root — has
`lines` and `indentation` `null` and empty `imports` and `outside`, and keeps its `churn`.

**Imports.** Only a file ending in `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.mts` or
`.cts` is scanned; every other file has empty `imports` and `outside`. The scan is a heuristic
over the source text, not a parser. It first removes `//` and `/* */` comments, skipping over
`'`, `"` and `` ` `` strings, a `'` or `"` string ending at the end of its line; then it takes
the string literal of `import … from`, `export … from`, a bare `import '<x>'`, `import('<x>')`
and `require('<x>')` wherever they appear, so `import type` counts and an import inside a
comment does not. A specifier is
resolved with any `?…` or `#…` suffix removed:

- A relative specifier (`.`, `..`, `./…`, `../…`) is joined to the importing file's folder.
- Any other specifier goes through the `paths` of the nearest `tsconfig.json`, looked up from
  the importing file's folder up to the root and never above it; a config that cannot be
  parsed counts as absent, so the lookup goes on upward. A config is read with `//` and
  `/* */` comments and trailing commas removed outside strings. Its `extends`, a string or an
  array whose entries start with `.`, is followed with `.json` appended when missing, later
  entries winning; an entry that resolves outside the root, forms a cycle, lies more than 8
  levels deep or is not found is skipped. A package `extends` and `references` are not read.
  A `paths` pattern is an exact string or holds one `*`: an exact match wins, else the
  matching pattern with the longest prefix, and its targets are tried in order with no
  fallback to a shorter pattern. Targets resolve against the effective `baseUrl` when one is
  set, else against the folder of the config that declares `paths`; a config's own `paths`
  replaces an inherited one whole. A target outside the root never matches. A specifier no
  pattern matches is not resolved through `baseUrl`, and `jsconfig.json` is not read.
- The resolved base is then probed against the listing, never the disk: for a `.js`, `.jsx`,
  `.mjs` or `.cjs` base, first its TypeScript sibling (`.ts` then `.tsx`, `.tsx` then `.ts`,
  `.mts`, `.cts`); then the base itself; then the base with `.ts`, `.tsx`, `.mts`, `.cts`,
  `.js`, `.jsx`, `.mjs` and `.cjs` added; then `<base>/index` with each of them. The first
  listed path wins.

**The hotspot table** is tab-separated text: the header line
`path churn lines indentation churn_x_lines churn_x_indentation`, tab-separated, then one row
per listed file with text, sorted by `churn_x_indentation` descending and then by path in
code-unit order, every line ending in `\n`. A `null` churn is written `0`, so every column
after `path` is an integer. A path holding a tab or a newline is left out of the table. There
is no row cap.

**The measurement document** is one JSON object, two-space indentation, one trailing newline:

| Field | Value |
|---|---|
| `version` | `1`. |
| `root` | The absolute root. |
| `scope` | The scope as root-relative paths, `["."]` when none was given. |
| `prefix` | The root's path inside its repository (`git rev-parse --show-prefix`): `""` at the top level, `null` outside git. |
| `files` | One `{"path", "lines", "churn", "indentation", "imports", "outside"}` per listed file, in listing order. |

**Assembly.** `assemble` refuses a measurement file that is missing, not a regular file, larger
than 2 MiB, not valid JSON, or not an object with `version` `1`, an absolute `root`, a
`scope` array and a `files` array of objects with a string `path`; the reason begins
`measurements <file>:`. It builds each file entry from the measured fields and the four role
fields only, writes `generatedAt` as the current time in `toISOString` form, and checks the
document by §13 twice: first with no candidates, so a fault in the measured files refuses the
run as `assembled overview: <violation>`, then complete. It writes the checked document, which
must be at most 2 MiB.

**Paths in model-written input.** A path from the roles file or the explorer output is taken
with any leading `./` removed and, when it is not a listed path and begins with the
measurement's `prefix`, with that prefix removed, so a repository-relative path names the same
file as a root-relative one. It is accepted only when it then equals a listed path.

**Roles.** The roles file is one JSON object, optionally inside one fenced code block, mapping
a path to `{"kind", "role", "exports", "mixes"}`. `kind` and `role` must be non-empty strings,
`exports` and `mixes` arrays of non-empty strings, each kept once. A field of another type
becomes `null` with a warning; an absent field is `null`. An entry that is not an object, and
a path that is not listed, is ignored with a warning. A listed file with no entry has `null`
role fields.

**Explorer output.** The deepen explorer's return format: candidate blocks of
`<field>: <value>` lines separated by blank lines, then optional `pin:` and `notes:` lines.
Lines that open or close a code fence are dropped, and `\r\n` reads as `\n`. A chunk is a
block when one of its lines names a block field — `name`, `tier`, `category`, `files`,
`structural_key`, `next_change`, `next_sites`, `est_diff_lines`, `deletion_test`, `friction` or
`adr_conflict` — followed by `:`, in any case and behind an optional list marker or `*`/`_`
emphasis. Only a line that reads exactly `<field>: <value>`, the field in lowercase, gives the
block a field, so a block written in another case or decorated is dropped for the field it
lacks. Fields may come in any order. Its fields `name`, `tier`, `category`, `files`
(comma-separated, each path kept once), `next_change`, `est_diff_lines` (decimal digits),
`deletion_test` and `friction` each appear exactly once, and each `next_sites` line reads
`<path>:<line> — <what>`, where a hyphen or an en dash also separates. `structural_key`,
`adr_conflict`, `pin` and unknown fields are ignored, and fewer than two `next_sites` lines are
accepted. A block is dropped, with the warning
`dropped explorer block "<name>": <reason>` (`block <n>` when its name is empty), when a field
is missing or repeated, a `next_sites` line does not read as above, a file is not listed,
`est_diff_lines` is not decimal digits, the block on its own fails §13's candidate rules, or
an earlier block kept the same name.

**Notices**, in this order:

- `File roles are unavailable: <reason>.` — the roles file is not given, cannot be read, is
  not valid JSON, or is not a JSON object.
- `No deepening candidates: <reason>.` — the explorer output is not given or cannot be read,
  or holds neither a block nor a `notes:` line (`the explorer output holds no candidate block
  and no notes: line`), or `--explorer-unavailable` gives the reason, trimmed and with one
  trailing `.` removed.
- `Explorer: <notes>` — the output holds no block and its `notes:` is neither empty nor `none`.
- `<n> explorer candidate dropped as malformed.` (`candidates` when `<n>` is above 1) — the
  output holds blocks and every one was dropped.

**What refuses.** Only the measurement file, the shape check and the size limit exit 1.
Nothing in the roles file or the explorer output does: it degrades to `null` fields, dropped
blocks, warnings and notices.

## §15 Diagram document

A diagram file holds one diagram document: a JSON object, UTF-8, at most 2 MiB (2,097,152
bytes), describing part of a system as boxes joined by arrows. Agents write it, and the viewer
writes it back when a human edits it. `cli.mjs diagram --check` (§1) checks one. The
`.diagram.json` extension is the convention; it is not checked. The format below is fixed;
which module under `ui/` or `server/` implements it is private.

**Top level.** Exactly the four keys `groups`, `boxes`, `arrows` and `walkthroughs`, each a
required array that may be empty.

**A `groups[]` entry.** Groups store no geometry: a group's frame is computed from its members
(Layout, below).

| Field | Value |
|---|---|
| `id` | An id (below), unique across `groups`. |
| `label` | A non-empty string. |

**A `boxes[]` entry.**

| Field | Value |
|---|---|
| `id` | An id, unique across `boxes`. |
| `label` | A non-empty string. |
| `kind` | `module`, `process`, `agent`, `actor`, `store` or `concept`. |
| `files` | An array of diagram paths (below), none appearing twice; may be empty. |
| `group` | Optional. The `id` of a `groups` entry. |
| `x`, `y` | Optional, and given together or not at all. Safe integers; negative values are allowed. A box without them is placed by the layout. |

**An `arrows[]` entry.**

| Field | Value |
|---|---|
| `id` | An id, unique across `arrows`. |
| `from`, `to` | The `id` of a `boxes` entry each. They may name the same box, and two arrows may join the same pair. |
| `label` | A string; may be empty. |
| `why` | A string; may be empty. |

**A `walkthroughs[]` entry.**

| Field | Value |
|---|---|
| `name` | A non-empty string, unique across `walkthroughs`. |
| `steps` | A non-empty array of `{"arrows", "text"}`: `arrows` an array, may be empty, of the `id`s of `arrows` entries; `text` a non-empty string. |

**Ids.** A string matching `^[A-Za-z0-9][A-Za-z0-9_.-]*$`. Group, box and arrow ids are each
unique within their own collection.

**Diagram paths.** Relative to the root of the run that shows the diagram, with `/` separators:
a non-empty string with no `\`, not starting with `/` or with a drive letter and `:`, and with
no empty, `.` or `..` segment, so none ends in `/`. The form is checked as text; whether the
file exists is not.

**Unknown keys** are refused at every level — the document, every entry and every step —
unlike the overview document's (§13). Numbers are never read from strings.

**Canonical form.** Every save writes the document in one text layout, so two versions of a
diagram differ line for line by the elements that changed. The top-level object is indented
two spaces, with its keys in the order `groups`, `boxes`, `arrows`, `walkthroughs`. Each group,
box and arrow is one line: the compact JSON of the entry, with its keys in the order of its
table above and an absent optional key left out, never written as `null`. Each walkthrough is
a block with `name` on its own line and one compact line per step. An empty array is written
`[]` on its key's line. Arrays keep their order and are never sorted, and the text ends with
one newline:

```json
{
  "groups": [
    {"id":"server","label":"Server"}
  ],
  "boxes": [
    {"id":"cli","label":"cli.mjs","kind":"process","files":["server/cli.mjs"],"group":"server","x":60,"y":84},
    {"id":"skill","label":"annotate skill","kind":"agent","files":[]}
  ],
  "arrows": [
    {"id":"starts","from":"skill","to":"cli","label":"starts","why":"The skill runs the server as a background command."}
  ],
  "walkthroughs": [
    {
      "name": "Starting a review",
      "steps": [
        {"arrows":["starts"],"text":"The skill starts the server."}
      ]
    }
  ]
}
```

A document that is valid but not in canonical form is accepted; `diagram --check` reports
whether a file is canonical (§2) and never rewrites it.

**Layout.** Boxes without a position are placed; when no box has one, every box is placed. A
positioned box never moves. Ranks run left to right and follow the arrows: an arrow that closes
a cycle is reversed for ranking, and an arrow from a box to itself is ignored. When no box is
positioned, the boxes of one group occupy one contiguous band in every rank, and the bands of
two groups never overlap; in a partly positioned diagram a placed box keeps clear of every
positioned box, and group contiguity is not promised. A box's size is never stored: its height
is 46 and its width `min(230, max(120, round(n × 7.4 + 34)))`, `n` the number of code points in
its label. A group's frame is the bounds of its members' boxes plus 20 on each side and 24 more
above, for the label; a group with no members has no frame. Positions are integers, and the
same document always gives the same layout. The spacing between ranks and rows is not part of
this contract.

**Refusals.** The first violation refuses the file with exit 1 (§3). The reason begins
`diagram <file>:`, `<file>` the absolute path, and goes on with one of `not found`,
`not a regular file`, `<x.y> MB is above the 2 MB diagram limit`, `could not be read (<code>)`,
`not valid JSON (<detail>)`, or the violation itself, named by its location in the document —
`missing key <location>`, `<location> is not <what it must be>`,
`<location> has unknown key <key>`, `<location> duplicates <location>`,
`<location> names no <box|group|arrow> <id>`, or `<location>.x and <location>.y must be given
together`. The document is checked in this order, which fixes which violation is first: the
top level, then every group, every box, every arrow and every walkthrough in turn, each entry's
keys before its fields, then duplicates in each collection, then the references — every box's
`group`, every arrow's `from` and `to`, every step's `arrows`.

## §16 Open questions

What this contract leaves undecided, each as a question.

- **Folder anchors and the scope.** Should a `folder` anchor also be bounded by the scope
  roots, so that an ancestor of the scope — `src` for the scope `src/features/orders` — is
  refused rather than passing because a listed file lies beneath it?
- **A resume under another root.** When `--out` names an existing file whose `root` differs
  from `--root`, should the run refuse, warn, or re-resolve the stored scope under the new
  root?
- **Silently dropped notes.** A new `folder`, `file`, `range` or `scope` note that fails §7's
  checks, and a `candidate` note that names an overview candidate but fails another check, is
  left out of the list while the viewer receives `{"ok": true}` and keeps showing the note.
  Should the server refuse the write or report the drop?
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
