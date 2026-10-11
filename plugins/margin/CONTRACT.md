# The margin contract

Authoritative surface between `server/cli.mjs`, the `annotate` skill and the human who
reviews code in the viewer. The contract fixes the verb, its flags, the stdout and stderr
output, the exit codes, resume, the notes-file schema, the anchor rule, the HTTP routes and
their guards, the file-listing and reading rules, and the seam between the skill and the
server. The implementation under `server/` and `ui/` is private and may change without
changing this file. Header comments in `server/` and `ui/` explain mechanics only; where one
restates a fact this file fixes and disagrees with it, this file governs.

The division of labour: the server owns **mechanics** (listing the files, serving the viewer,
guarding requests, saving the notes file); the skill owns **judgment** (what the notes mean
and what to do about them). The server never reads the skill's state, and the skill never
reads the notes file while the server runs.

---

## §1 Invocation

```text
node <plugin-root>/server/cli.mjs annotate [--root <dir>] [--scope <path>]... [--out <file>] [--port <n>] [--token <token>] [--no-open]
```

| Part | Meaning |
|---|---|
| `<plugin-root>` | The installed `margin` plugin directory. The skill runs it as `${CLAUDE_PLUGIN_ROOT}`. |
| `annotate` | The only verb. The first positional argument must be `annotate`; further positional arguments are ignored. |
| flags | §4. |

Only `cli.mjs` is a command. Everything under `server/lib/` is private to the implementation
and may change shape without changing this contract.

**Runtime.** Node 22 or newer, standard library only. `git` is optional: it makes the listing
git-aware and fills `revision` (§6, §10).

**Lifecycle.** The process validates its arguments, reads the notes file when resuming (§5),
resolves the root and scope, lists the files (§10), binds the port, writes the notes file as
`draft`, prints the stderr block (§2) and opens the viewer unless `--no-open` is given. It then
runs until the human presses Send or Cancel in the viewer, or the process receives `SIGINT` or
`SIGTERM`. A run lasts as long as the review.

## §2 Output rules

**stdout** carries exactly one JSON document on every handled exit, with two-space
indentation and one trailing newline, and nothing else. It has one of two shapes.

The result document, on exit 0, with its keys in this order:

| Key | Value |
|---|---|
| `status` | `submitted`, `cancelled` or `interrupted` (§6). |
| `out` | The absolute path of the notes file. `null` only when a cancelled run had no notes and a blank `overall`, so no file remains (§6). |
| `annotations` | The number of notes in the file — a count, not the notes. |
| `root` | The absolute root. |
| `scope` | The scope as root-relative paths, `.` for the root itself; `[]` when no scope was given and the whole root is listed. |

The error document, on exit 1 or 2: `{"status": "error", "error": "<reason>"}`. `<reason>` is
for humans and may span lines: an argument-parse failure appends the usage line after a
newline.

The notes themselves never appear on stdout; the reader opens `out` (§11).

**stderr** carries one block, written once, after the port is bound and the first draft is
saved:

```text
margin: http://127.0.0.1:<port>/#<token>
  root:  <root>
  scope: <scope paths joined by ", ", or "."> (<N> files)
  notes: <out>
```

The block is for the human. It is not a parsing surface.

## §3 Exit codes

| Code | Meaning | Document |
|---|---|---|
| `0` | The review ended: Send (`submitted`), Cancel (`cancelled`), or `SIGINT` / `SIGTERM` after the port was bound (`interrupted`). | Result |
| `1` | The run could not proceed: the `--out` file is refused on resume (§5), no files are listed under the scope (§10), or the port cannot be bound (`could not listen on port <n>: <code>`). | Error |
| `2` | The invocation is wrong: an unknown flag, a flag missing its value or given a value it does not take, a missing or different verb, a `--port` that is not an integer from 0 to 65535, a `--token` outside its class (§4), or a scope path — given by `--scope` or read from a resumed file — that resolves outside the root. | Error |

Checks run in this order, and the first failure is the one reported: arguments and verb, then
`--port`, then `--token`, then the resumed file's JSON and its `annotations` array (§5), then
the scope paths, then the listing, then the resumed notes (§5), then the port binding. Every one of them happens before the first save, so a refused run
writes nothing: an existing `--out` file is left exactly as it was.

## §4 Flags

Long flags only. Both `--flag value` and `--flag=value` are accepted for a flag that takes a
value. A flag other than `--scope` given twice keeps its last value.

| Flag | Default | Meaning |
|---|---|---|
| `--root <dir>` | see meaning | The directory the scope is resolved against and served from. The flag applies when given, else the resumed file's `root` when it is a string (§5), else the working directory. A relative value resolves against the working directory; the result is absolute. |
| `--scope <path>` | none | Repeatable. A file or folder, relative to the root (an absolute path inside the root is accepted). Each is normalised to a root-relative path, and the root itself becomes `.`. A path outside the root exits 2; the check compares path text and resolves no symbolic link (§10). With no `--scope`, a resumed file's `scope` applies when it is an array; otherwise the scope is empty and the whole root is listed. |
| `--out <file>` | `<root>/claudedocs/margin/<stamp>.json` | The notes file. `<stamp>` is the start time in UTC as `YYYY-MM-DDTHH-MM-SS`. A relative value resolves against the working directory. When the file exists, the run is a resume (§5). Missing parent directories are created on the first save. |
| `--port <n>` | `0` | An integer from 0 to 65535. `0` lets the operating system assign a free port; the bound port is the one in the stderr URL. |
| `--token <token>` | minted | 16 to 128 characters from `[A-Za-z0-9_-]`. When absent, the server mints 32 lowercase hexadecimal characters (16 random bytes). Setting it lets a caller know the viewer URL before the server prints it (§11). |
| `--no-open` | off | Do not open the viewer. Without it, the server opens the URL with the platform opener (`open` on macOS, `start` on Windows, `xdg-open` elsewhere). An opener that starts and fails is ignored, since the URL is on stderr; an opener command that is not installed ends the run with exit 1 and no stdout document, after the draft is saved and the stderr block is printed (§12). |

## §5 Resume

A run is a resume when `--out` names a file that exists. A `--out` that does not exist is a
fresh run whose notes file is created at that path.

1. **Refusals.** Each exits 1 and writes nothing (§3):
   - the file is not valid JSON;
   - the parsed value has no `annotations` array (including a value that is not an object);
   - any stored note is malformed by the annotation rules of §7. The reason names the count
     and the indices: `<out>: <k> of <n> notes are malformed (indices <i>, ...)`.
2. **Root and scope.** The file's `root` (when a string) and `scope` (when an array) apply
   unless `--root` or `--scope` is given. The two are independent: `--root` given alone keeps
   the stored scope, resolved under the new root.
3. **Notes.** Every stored note is checked for shape by §7 with the anchor check against the
   listing skipped, so a resumed note keeps its anchor (§7). An accepted note is normalised:
   a missing or non-string `id` gets a fresh UUID, an `intent` outside the two values becomes
   `change`, a missing `createdAt` becomes the current time, a `range` excerpt is truncated to
   the cap or set to `""` when absent, and unknown fields are dropped.
4. **Kept and replaced.** The run keeps `createdAt` (when a string, else the current time),
   `overall` (when a string, else `""`) and the notes. Every other stored field is dropped;
   `version`, `status`, `root`, `scope`, `out`, `revision` and `updatedAt` are written fresh
   for this run (§6).
5. **First write.** The file is rewritten with `status: "draft"` as soon as the port is bound.

## §6 Notes file

One JSON object, UTF-8, two-space indentation, one trailing newline. Readers must not depend
on the order of its keys.

| Field | Value |
|---|---|
| `version` | `1`. |
| `status` | One of four values. `draft`: written when the port is bound and on every save while the viewer is open — a file read while the server runs, or left by a process that died without a signal, says `draft`. `submitted`: the human pressed Send. `cancelled`: the human pressed Cancel. `interrupted`: the process received `SIGINT` or `SIGTERM`. |
| `root` | The absolute root of the run that wrote the file. |
| `scope` | The scope, as in §2. |
| `out` | The absolute path of this file. |
| `revision` | `{"head": "<commit sha>", "dirty": <boolean>}` read from git in the root when the run starts — `dirty` is `true` when `git status --porcelain` lists anything — or `null` when the root is not in a git repository or git is unavailable. |
| `createdAt` | ISO 8601 UTC timestamp of the run that created the file; kept across resumes. |
| `updatedAt` | ISO 8601 UTC timestamp of the last save. |
| `overall` | The human's framing text for the whole scope. A string; may be empty. |
| `annotations` | The notes (§7), in the order they were created. The viewer sorts them for display only. |

`status: "error"` never appears in a notes file; it exists only in the stdout document (§2).

**Writes.** The server rewrites the whole file on every change: when the port is bound, on
every save from the viewer (§8), and when the run ends. Each write overwrites the file in
place, not through a temporary file, so a reader that races a write may see a partial file —
which is why the skill reads it only after the process exits (§11). One exception: a run that
ends `cancelled` with no notes and an `overall` that is empty or whitespace deletes the file
instead, and its result document carries `out: null`. This holds on a resume too.

## §7 Annotations and the anchor rule

Each note has exactly these fields; any other field on a note or on its anchor is stripped.

| Field | Value |
|---|---|
| `id` | A string. A note that arrives without one gets a fresh UUID when the server accepts it; the viewer mints UUIDs for the notes it creates. It is the identity a later write revises the note by. |
| `anchor` | Where the note sits, by kind (below). |
| `intent` | `change` or `question`. Any other value becomes `change`. |
| `body` | The human's text. Required: a note without a string `body` is rejected. The server accepts an empty string; the viewer does not create empty notes. |
| `createdAt` | ISO 8601 UTC timestamp. When missing, the time the server accepted the note. |

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

- A write from the viewer that carries the `id` of a stored note revises that note's `intent`
  (when it is one of the two values) and `body` (when it is a string) only. Its anchor and
  `createdAt` stay as stored, whatever the write sends.
- A note loaded from a resumed file is checked for shape only (§5) and keeps its anchor even
  when its file has moved, been deleted or fallen outside this run's scope.

A range's `excerpt` is fixed with its anchor, so a reader compares it with the file as it is
now to detect drift.

**Saves carry the whole list.** A write that includes `annotations` replaces the list: a
stored note whose `id` is absent from the write is deleted, and a note whose `id` matches no
stored note is a new note and goes through the checks above. A new note that fails them is
left out of the list, and the write still answers `{"ok": true}` (§12).

## §8 HTTP routes

The server listens on `127.0.0.1` only, at the bound port. Every response carries
`cache-control: no-store`; JSON responses are `application/json; charset=utf-8`. Every
request passes the guards of §9 first. Six routes:

| Route | Token | Request | Response |
|---|---|---|---|
| `GET /` | no | — | The viewer page. Its static assets, `GET /app.js`, `/highlight.js` and `/style.css`, are served the same way and belong to this route. |
| `GET /api/session` | yes | — | 200 `{"session": <the notes file object, §6>, "files": [<listed paths, §10>]}`. |
| `GET /api/file?path=<p>` | yes | — | `<p>` not a listed path: 404 `{"error"}`. Otherwise 200 with `{"path", "text"}` or a refusal `{"path", "binary": true, "reason"}` (§10). |
| `PUT /api/session` | yes | `{"overall"?, "annotations"?}` | Applies the edits (§7), saves the file, 200 `{"ok": true, "updatedAt"}`. |
| `POST /api/submit` | yes | as `PUT` | Applies the edits, answers 200 `{"ok": true, "status": "submitted"}`, then ends the run as `submitted`: saves, prints the result document (§2), exits 0. |
| `POST /api/cancel` | yes | as `PUT` | As submit, with `status: "cancelled"` and the deletion rule of §6. |

**Request bodies.** `overall` is applied only when it is a string and `annotations` only when
it is an array; other keys are ignored. An empty body counts as `{}`, so a `PUT` without one
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
   `Host` — is refused with 421 `{"error": "wrong host"}`. This defeats DNS rebinding: a
   foreign page whose hostname resolves to `127.0.0.1` still sends its own hostname.
2. **Origin.** A request carrying an `Origin` header other than `http://127.0.0.1:<port>` is
   refused with 403. A request without an `Origin` header passes.
3. **Token.** Every path beginning with `/api/` needs the header `x-margin-token` equal to the
   run's token (§4); missing or different, it is refused with 403. The viewer page and its
   assets need no token.

The token is in the URL the server printed (§2), with the caller that set it (§11) and, when
`--token` sets it, on the process command line, where other local processes can read it. It
guards against pages on other origins, not against local processes. The viewer reads it from the URL fragment (`#<token>`) and sends it on every API call.
Opened without the fragment, the viewer cannot load the session.

## §10 File listing and reading

**Listing.** The listing is computed once, when the run starts, and is fixed for the run: a
file created later is neither listed nor served.

- When `git ls-files` succeeds in the root, the listing is the tracked files plus the
  untracked files the repository's ignore rules do not exclude, under the scope
  (`git ls-files --cached --others --exclude-standard -- <scope>`). Ignored files never appear.
- Otherwise — the root is not in a git repository, or git is unavailable — it is a walk of
  each scope path that skips directories named `.git`, `node_modules`, `dist`, `build`,
  `coverage`, `.next`, `.turbo` and `target`.
- Either way, only regular files present on disk are listed. A symbolic link is never listed,
  and so never read, and the walk never descends into one. A scope path whose leading part is
  a linked directory is not resolved: git lists nothing beneath it, while the walk lists the
  files beneath it even when they lie outside the root (§12). Reading still refuses them.
- Paths are root-relative with `/` separators, without duplicates, sorted by code unit. An
  empty scope lists the whole root. A listing with no files exits 1 (§3).

**Reading.** `GET /api/file` reads only a listed path, then:

- its real path, with every symbolic link resolved, must be a regular file inside the root's
  real path — otherwise the refusal `not a regular file inside the root`;
- a file larger than 2 MiB (2,097,152 bytes) is refused, with its size in the reason;
- a file with a NUL byte in its first 8000 bytes is refused as `binary file`;
- otherwise `text` is the file's content decoded as UTF-8.

A refusal answers 200 with `binary: true`; its `reason` is display text. A listed file that no
longer exists answers 500.

## §11 Skill–server seam

1. **Token.** The skill resolves the root (`git rev-parse --show-toplevel`, else the working
   directory) and mints the token: 16 random bytes as 32 lowercase hexadecimal characters,
   inside the class of §4.
2. **Start.** It starts `cli.mjs annotate` as a background command with the maximum timeout,
   since the command returns only when the review ends. It passes `--root <root>`, one
   `--scope` per path, `--port 7331`, `--token <token>` and, when resuming, `--out
   <notes-file>` — the skill's `--resume <notes-file>` argument is its name for `--out`.
3. **Announce.** It tells the user `http://127.0.0.1:<port>/#<token>` straight away. It knows
   the URL before the server prints it because it set both the port and the token.
4. **Read after exit.** It waits for the process to exit, without polling and without reading
   the notes file. It then parses the one stdout document (§2) and, unless `status` is
   `error` or `out` is `null`, reads the notes file at `out`.

The server never reads the skill's state: its whole input is its argument vector, the files
under the root and the viewer's requests. The skill's whole input from the server is the
stdout document and, after exit, the notes file; the stderr block is for the human.

## §12 Open questions

What this contract leaves undecided, each as a question.

- **Folder anchors and the scope.** Should a `folder` anchor also be bounded by the scope
  roots, so that an ancestor of the scope — `src` for the scope `src/features/orders` — is
  refused rather than passing because a listed file lies beneath it?
- **A resume under another root.** When `--out` names an existing file whose `root` differs
  from `--root`, should the run refuse, warn, or re-resolve the stored scope under the new
  root? And since the skill always passes `--root`, should a stored `root` ever apply on a
  resume the skill starts?
- **The busy-port fallback.** When port 7331 is taken, the skill reruns once on 7332 after it
  has already announced a URL naming 7331. What should the user be shown, and is one retry on
  one fixed port the right fallback?
- **Silently dropped notes.** A new note that fails §7's checks is left out of the list while
  the viewer receives `{"ok": true}` and keeps showing the note. Should the server refuse the
  write or report the drop?
- **Exits without a document.** An unhandled exception — a non-string entry in a resumed
  file's `scope`, or a platform opener command that is not installed (§4) — exits 1 with a
  stack trace on stderr and nothing on stdout, and a signal before the port is bound exits
  without the `interrupted` document. Should every exit print a document?
- **Symbolic links in a scope path.** The scope check compares path text and resolves no
  symbolic link, so outside git a walk of a scope path whose leading part is a linked
  directory lists files that lie outside the root (§10). Should the scope check and the
  listing be bounded by the root's real path, as reading is?
- **Deleting a resumed file.** A resumed run cancelled with no notes and a blank `overall`
  deletes the file it resumed. Is that intended for a file that existed before the run?
- **The revision on resume.** A resume replaces the stored `revision` with the current one, so
  the file no longer says which revision its notes were written against, and drift detection
  rests on `excerpt` alone — which only `range` notes carry. Should the file keep that
  revision?
- **Usage text and code headers.** `cli.mjs`'s usage line and header comment show `--root` as
  required, the token as `<hex>` and the paths as absolute. Should they match §4, and should
  the header comments point at this file instead of restating it?
- **Note order in the skill.** The skill's plan table lists the notes "in file order", while
  the file holds them in creation order (§6). Which order does the skill mean?
- **The skill's wording.** The skill tells the user notes save under
  `<root>/claudedocs/margin/`, which is not where a resumed file saves, and that without the
  fragment every Send fails, while without it the viewer cannot load at all; and its
  notes-file shape omits `version`, `out`, `createdAt`, `updatedAt` and each note's `id` and
  `createdAt`. Should the skill's text follow §6, §7 and §9?
