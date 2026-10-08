# The browser-driver contract

Authoritative surface for `cli.mjs`, the browser driver every `verify` skill and every
pipeline caller codes against. The contract fixes the verbs, their flags, the step-file
schema, the output documents, the exit codes, the session layout, the install location and
the screenshot-name grammar. The implementation behind it — a hand-written client for the
Chrome DevTools Protocol (CDP) driving the user's installed Chrome — is private and may
change without changing this file.

The division of labour: the driver owns **mechanics** (booting the app, starting a scratch
browser, waiting, input, capture, teardown); the agent calling it owns **judgment** (which
steps to run, what a result means for a ticket). The driver never decides what to check.

---

## §1 Invocation

```text
node <driver-dir>/cli.mjs <verb> [flags]
node <driver-dir>/cli.mjs --self-test
```

| Part | Meaning |
|---|---|
| `<driver-dir>` | The installed copy, `~/.feature-pipeline/verify/`, for any caller outside the `verify` plugin. `verify`'s own skills may run the plugin copy at `<plugin-root>/drivers/browser/`. `install` (§10) runs only from the plugin copy. |
| `<verb>` | One of `launch`, `doctor`, `drive`, `evidence`, `cleanup`, `install` (§5–§10). |
| `--self-test` | §13. Takes no verb and no other flag. |

Only `cli.mjs` is a command. Everything under `lib/` is private to the implementation and
may change shape without changing this contract.

The driver is invoked directly with `node`. It is never sourced, never wrapped in a shell
string, and never given arguments assembled by string concatenation.

**Runtime.** Node 22 or newer, for the global `WebSocket`. The driver has no dependency of
any kind beyond Node's standard library. A verb that talks to the browser checks for
`WebSocket` first and exits 1 when it is absent (§3); `doctor` reports it as `node_ok`.

**Browser.** The executable is `CHROME_PATH` when that environment variable is set, else
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. No other location is
searched. Chrome always runs headless with a scratch profile (§12); the user's own profile
is never read or written.

**Transport switch rule.** If raw CDP proves unreliable on real pages, the transport is
replaced wholesale behind these same verbs, documents and exit codes — never mixed with a
second engine.

## §2 Output rules

Every run prints **exactly one JSON document** on stdout, followed by a newline, and
nothing else. Output of the processes the driver starts (the app's `start` command, Chrome)
goes to files in the session directory (§12), never to stdout.

- **Object keys are sorted recursively**, ascending, by code unit.
- **Arrays are in a stated order** — every array-valued key below names its ordering.
- Two-space indentation, one trailing newline.

Unlike a byte-comparable check document, these documents describe a live process tree, so
they **do** carry absolute paths, session ids and process ids. Evidence paths in particular
are absolute, because the callers that upload or attach screenshots gate on an absolute
path inside the evidence home.

## §3 Exit codes

| Code | Meaning | Document |
|---|---|---|
| `0` | An answer was computed. This includes a **negative** answer: a failed `expect` step, a failed `drive` step, a `doctor` that finds Chrome missing. Each such document carries `"ok": false`. | The verb's document from §5–§10. |
| `1` | The answer could not be computed: Chrome not found or exited early, the app unreachable and not bootable, the CDP connection lost, the session page gone or not responding, the session unknown, Node without `WebSocket`, the `drive` time cap reached, a filesystem write refused. | `{"error": "<reason>"}` |
| `2` | The invocation was wrong: no verb or an unknown verb, an unknown or repeated flag, a missing required flag, a relative path, an unreadable or malformed `--entry` or `--steps` file, a step-schema violation, a malformed session id. | `{"error": "<reason>"}` |

A caller distinguishes "the app says no" from "the driver is broken" by the exit code
alone. Both non-zero paths print the same `{"error"}` shape, so stdout always parses.
`<reason>` is one line; when it quotes `server.log` or `chrome.log` it quotes a bounded
tail of that file. Everything that is wrong with an invocation is detected before anything
runs: a step file with a bad step 7 exits 2 without executing steps 0–6.

## §4 Flags and filesystem discipline

Long flags only. Both `--flag value` and `--flag=value` are accepted for a flag that takes
a value. A flag given twice, a flag the verb does not take, or a value on a flag that takes
none (`--all=yes`) exits 2.

**Every path flag is absolute.** `--entry`, `--steps` and `--evidence` must be absolute
paths; a relative one exits 2. There is no working-directory resolution to reason about.

**Session ids** are 12 lowercase hexadecimal characters (`^[a-f0-9]{12}$`), validated
before any path is built from one; anything else exits 2.

**What the driver writes, and where.** The session directory (§12); the `--evidence`
directory passed to `drive`, and nothing else in it but the named screenshots, each written
through a temporary file beside it (§11);
`~/.feature-pipeline/` for `install` (§10). It never writes into the project, never into
the user's Chrome profile, and never deletes an evidence file.

**What it executes.** The entry's `start` command, written to a file and run as
`bash <file>` (§5) — never interpolated into a command line — the Chrome executable, with
an argument vector, and `ps`, to read a recorded process's command line or start time
before signalling it (§9). Nothing else.

## §5 `launch`

```text
node cli.mjs launch --entry <abs-path>
```

Boots the app when it is not answering, starts a scratch headless Chrome with one page,
and records a session.

**The entry file** is a JSON object, already resolved by the caller from the project's
configuration:

| Key | Required | Meaning |
|---|---|---|
| `url` | yes | Absolute `http:` or `https:` URL of the app. |
| `start` | no | The command that boots the app, as one string. |
| `cwd` | when `start` is set | Absolute directory `start` runs from. |
| `start_timeout` | no | Seconds to wait for the app after boot: an integer 1..540, default 60. Any other value falls back to 60 with a line in `notes`. |
| `auth` | no | An object with one key, `storage_state`: the absolute path of a Playwright-format storage-state file to import (§6). |

An unknown key, a relative path, `start` without `cwd`, or a missing `url` exits 2.

**Order of work.** Validate the entry → check `WebSocket` → resolve Chrome (missing → exit 1
before anything starts) → create the session directory → probe `url` → boot when needed →
start Chrome → create the session page → import `auth` → print. `state.json` is written
as each process starts — after the boot, at Chrome's spawn, once its debugging port is
known, and with the session page — so a `launch` killed partway leaves a record `cleanup`
can stop it from. A `drive` on a session whose `launch` did not finish exits 1.

**Reachability.** `url` answers when an HTTP request to it, not following redirects,
returns `200`, `301`, `302`, `401` or `403` within 3 seconds. `401`/`403` mean auth-gated
but up. The same set is the feature pipeline's reachable set for its test checkpoint.

**Boot.** When `url` does not answer and `start` is set, the driver writes `start` verbatim
to `<session-dir>/start.sh` (mode 0700), runs `bash <session-dir>/start.sh` from `cwd` in a
new process group with output to `server.log`, records that process's id, and polls `url`
once a second until it answers or `start_timeout` passes. A `start` that exits early does
not end the poll. When `url` does not answer and no `start` is set, `launch` exits 1
(`app unreachable`). A `cwd` that does not exist exits 1 with nothing booted. An app that
already answers is recorded `"server": "already-running"` and is never signalled by any
verb.

**Failure after something started.** Any exit 1 inside `launch` after the app or Chrome was
started first runs the same teardown as `cleanup` (§9) and removes the session directory.

**Document:**

```json
{
  "cdp_port": 53121,
  "chrome_pid": 41872,
  "notes": [],
  "ok": true,
  "server": "booted",
  "server_pid": 41790,
  "session": "3f9a0c1d2e4b",
  "session_dir": "/tmp/fp-verify-3f9a0c1d2e4b",
  "stale_sessions": [],
  "url": "http://127.0.0.1:7727",
  "viewport": { "height": 800, "width": 1280 }
}
```

| Key | Meaning |
|---|---|
| `server` | `"booted"` when `launch` started the app, `"already-running"` when it answered at the first probe. |
| `server_pid` | The boot process id (also its process group), or `null` when `already-running`. |
| `viewport` | The session's starting viewport, desktop 1280×800. |
| `stale_sessions` | Ids of every other session directory present under `/tmp`, sorted. Reported, never touched — `cleanup --all` removes them. |
| `notes` | One line per non-fatal adjustment (a `start_timeout` fallback), in the order made. |

## §6 `doctor`

```text
node cli.mjs doctor [--session <id>]
```

Reports readiness as distinct fields. Without `--session` it answers about the
environment only, so a caller can run it before any `launch`:

```json
{
  "chrome_missing": false,
  "chrome_path": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "install_missing": false,
  "installed_version": "0.1.0",
  "node_ok": true,
  "ok": true,
  "plugin_version": "0.1.0",
  "version_lag": false
}
```

| Key | Meaning |
|---|---|
| `chrome_missing` | No executable at the §1 browser path. `chrome_path` names the path checked. |
| `node_ok` | Node 22 or newer with a global `WebSocket`. |
| `install_missing` | `~/.feature-pipeline/verify/` does not exist. |
| `installed_version` | The content of `~/.feature-pipeline/verify/version`, or `null` when absent or unreadable. |
| `plugin_version` | The `verify` plugin manifest's version, read relative to the running `cli.mjs`; `null` when run from the installed copy, which has no manifest beside it. |
| `version_lag` | `true` when the installed version is older than the plugin version, `false` when not, `null` when either is unknown or not a `major.minor.patch` triple. |
| `ok` | `!chrome_missing && node_ok && !install_missing && version_lag !== true`, and with a session also `url_reachable && cdp_reachable && auth` is `absent` or `valid`. |

**Who can see a lagging install.** Only a `doctor` run from the plugin copy knows the plugin
version, so a stale install is detectable only by `verify`'s own skills, which may run that
copy (§1); `install` from the same copy clears it. A caller
outside `verify` runs the installed copy, which reports `plugin_version` and `version_lag` as
`null` — unknown, not healthy — and `ok` does not count that unknown against the install.

With `--session <id>` the document adds:

| Key | Meaning |
|---|---|
| `session` | The id. |
| `url_reachable` | The session's `url` answers (§5 reachability). |
| `cdp_reachable` | The session's Chrome answers on its recorded debugging port. |
| `auth` | `"absent"` (no `storage_state` declared), `"valid"` (the file parses and holds at least one unexpired cookie for the url's host or a localStorage entry for its origin), `"expired"` (it parses but holds neither — every cookie for the host has expired, or there is nothing for this app at all), or `"unreadable"`. |

**Auth import** (in `launch`): cookies go in through `Network.setCookies` (expired ones are
skipped); each `origins[].localStorage` list is set by navigating the session page to that
origin, writing the entries, and returning to `about:blank`. An unreadable storage-state
file makes `launch` tear down and exit 1. The driver reads storage-state files and never
copies or prints their contents.

`doctor` exits 0 whenever it could compute, whatever it found. An unknown session exits 1.

## §7 `drive`

```text
node cli.mjs drive --session <id> --steps <abs-path> --evidence <abs-dir>
```

Runs a step file against the session's page. The page persists across `drive` calls, so
cookies, navigation and the viewport carry over from one call to the next. One `drive` per
session at a time.

### Step file

A JSON array of one or more step objects, each with a `"step"` discriminator. The set is
closed:

| `step` | Fields | Does |
|---|---|---|
| `goto` | `url` | Navigates and waits for the load event — only that, so a client-rendered page needs a following `wait` before anything is asserted or captured. `url` is a path beginning `/` (resolved against the session `url`) or an absolute `http:`/`https:` URL. |
| `click` | exactly one of `testid`, `text` | Scrolls the target into view and clicks its centre with real mouse events. |
| `fill` | `testid`, `value` | Focuses the target, selects its content, and inserts `value` as typed text. |
| `press` | `key`, optional `testid` | Focuses `testid` when given, then presses `key`: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Space`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`, or one printable character. |
| `wait` | exactly one of `text`, `url`, `ms` | Waits until `text` is visible, until the page URL equals `url` (resolved as for `goto`), or for `ms` milliseconds (1..60000). |
| `expect` | exactly one of `text`, `testid`, `url` | Asserts `text` is visible, the `testid` element is visible, or the page URL equals `url`. |
| `viewport` | `width`, `height` | Sets the viewport (integers 1..10000) and keeps it for later `drive` calls. Desktop is 1280×800, mobile 390×844. |
| `screenshot` | `name` | Captures the full page as PNG to `<evidence>/<name>` (§11). |

Every step also accepts `timeout_ms`, an integer 1..60000 (default 5000). An unknown `step`,
an unknown field, a missing field, two targets where exactly one is allowed, or a value of
the wrong type exits 2 naming the step's 0-based index (`step 3: …`) — before any step runs.

### Targets, waiting, failure

- `testid` matches `[data-testid="<value>"]` and must resolve to exactly one visible element.
  `text` matches the innermost visible element whose whitespace-normalised text — as
  rendered (after CSS `text-transform`) or as written in the DOM — equals the value, first
  in document order. Visible means rendered with a non-empty box and not
  `visibility: hidden`.
- `click`, `fill`, `press`, `wait` and `expect` poll every 100 ms until satisfied or until the
  step's timeout. A navigation in flight during a poll is retried, not failed.
- Target values reach the page only as JSON-encoded literals, never as concatenated code.
- A failed `expect` is recorded `"status": "failed"` and the run continues. A failed `goto`,
  `click`, `fill`, `press`, `wait`, `viewport` or `screenshot` stops the run, and every later
  step is recorded `"status": "skipped"`. Both are exit 0 with `"ok": false`.
- A protocol error inside a step — the browser answering a call with an error, or not
  answering it within the call's bound — fails that step and stops the run the same way,
  whatever the step. Only a lost connection is exit 1.
- **Dialogs.** Every JavaScript dialog (`alert`, `confirm`, `prompt`, `beforeunload`) the
  page opens during a `drive` is accepted as it opens, a `prompt` with its own default text,
  and recorded in `dialogs`. Accepting is the default because a step that clicks a control
  asking for confirmation means to perform that action. A dialog the page opens while no
  `drive` is attached cannot be answered: it leaves the page blocked, and the next `drive`
  exits 1 (`session page not responding`) — `cleanup` and `launch` a new session.
- A whole `drive` is capped at 480 seconds, under a 600-second shell-call limit; reaching the
  cap exits 1.

**Document:**

```json
{
  "console_errors": [{ "step": 0, "text": "Uncaught TypeError: x is undefined" }],
  "console_errors_dropped": 0,
  "dialogs": [{ "accepted": true, "message": "Delete this item?", "step": 0, "type": "confirm" }],
  "dialogs_dropped": 0,
  "evidence_dir": "/abs/evidence",
  "failed_requests": [{ "error_text": null, "status": 404, "step": 0, "url": "http://127.0.0.1:7727/favicon.ico" }],
  "failed_requests_dropped": 0,
  "ok": true,
  "session": "3f9a0c1d2e4b",
  "steps": [
    { "error": null, "index": 0, "screenshot": null, "status": "ok", "step": "goto" },
    { "error": null, "index": 1, "screenshot": "/abs/evidence/home-empty-desktop.png", "status": "ok", "step": "screenshot" }
  ]
}
```

| Key | Meaning |
|---|---|
| `ok` | Every step is `"ok"`. |
| `steps` | One entry per step, in file order. `error` is a one-line reason on `"failed"`, else `null`; `screenshot` is the absolute path written, else `null`. |
| `console_errors` | Console `error` calls, uncaught exceptions and browser log errors raised during this `drive`, attributed to the step running when they arrived, in arrival order. |
| `failed_requests` | Requests that failed at the network layer (`error_text`, `status: null`) or completed with status ≥ 400 (`status`, `error_text: null`), attributed the same way, in arrival order. A request aborted by a navigation is not a failure. |
| `dialogs` | JavaScript dialogs the page opened during this `drive`, each with its `type`, `message` and whether it was `accepted`, attributed the same way, in arrival order. |
| `console_errors_dropped`, `dialogs_dropped`, `failed_requests_dropped` | Each list holds at most its first 50 entries; these count the entries past that cap that were not listed (`0` when nothing was dropped). |

## §8 `evidence`

```text
node cli.mjs evidence --session <id>
```

Lists every screenshot the session's `drive` calls wrote, re-reading each file from disk.

```json
{
  "evidence": [
    {
      "bytes": 48213,
      "missing": false,
      "name": "home-empty-desktop.png",
      "path": "/abs/evidence/home-empty-desktop.png",
      "sha256": "9f2b…",
      "uploadable": true,
      "viewport": { "height": 800, "width": 1280 }
    }
  ],
  "session": "3f9a0c1d2e4b"
}
```

`evidence` is sorted by `path`, one entry per path (the latest capture wins). A deleted file,
or anything but a regular file in its place (a symlink is never followed), reads
`"missing": true` with `bytes` and `sha256` `null`. `uploadable` is true when the file
exists, its size is 1 byte to 5 MiB, and its name matches `^[A-Za-z0-9-]+\.png$`. An
oversized full-page capture is still written and reported, never resized.

## §9 `cleanup`

```text
node cli.mjs cleanup --session <id>
node cli.mjs cleanup --all
```

Exactly one of the two flags. Stops only what `launch` started for that session, then
removes the session directory. Evidence is never touched.

1. Close Chrome over CDP, then signal Chrome's process group with `SIGTERM` if it is still
   alive, waiting up to 10 seconds.
2. When the session's `server` is `"booted"`, signal the boot process group with `SIGTERM`
   and wait up to 30 seconds for it to exit, so a `start` that tears its own stack down on
   the signal finishes first. An app that was `"already-running"` is never signalled.

Each process is signalled only while it is still the one `launch` started: Chrome while its
command line names the session's profile, the boot process while its start time equals the
one recorded at boot. A process id that now belongs to another process counts as exited.
3. Remove the session directory.

`SIGKILL` is never sent. A process that already exited is not an error.

```json
{
  "chrome_exited": true,
  "ok": true,
  "server": "booted",
  "server_exited": true,
  "session": "3f9a0c1d2e4b"
}
```

`server_exited` is `null` for an `already-running` app. `ok` is `chrome_exited` and
`server_exited !== false`. `cleanup --all` applies the same teardown to every session
directory under `/tmp` that this user owns (§12) and prints
`{"ok": <all ok>, "sessions": [<per-session document>]}` sorted by `session`; a session the
sweep cannot tear down is listed with `"ok": false` and an `error` reason, and the sweep
continues. An unknown session, or a directory this user does not own, exits 1.

## §10 `install`

```text
node <plugin-root>/drivers/browser/cli.mjs install
```

Copies the driver to the fixed location `~/.feature-pipeline/verify/` — `cli.mjs`, `lib/`,
`CONTRACT.md` — and writes a `version` file holding the plugin manifest's version and a
newline. The copy is staged in a sibling temporary directory and swapped into place by
rename, so an interrupted install leaves the previous copy intact; a later `install`
removes any stale staging directory. Callers outside `verify` run only the installed copy
and never name a plugin-cache path.

```json
{
  "installed_path": "/Users/me/.feature-pipeline/verify",
  "ok": true,
  "replaced_version": "0.0.9",
  "version": "0.1.0"
}
```

`replaced_version` is `null` when nothing was installed before. Run from a copy with no
plugin manifest beside it, or with `HOME` unset, `install` exits 1.

## §11 Evidence names

A `screenshot` step's `name` is the whole file name, and it must match:

```text
^(?:[A-Z][A-Z0-9]*-[0-9]+-)?(?:AC-[0-9]+|[a-z0-9]+(?:-[a-z0-9]+)*-(?:empty|error|disabled))-(?:desktop|mobile)\.png$
```

That is the feature pipeline's capture grammar (`plugins/feature/skills/build/references/ui-checks.md` §3):
`AC-<n>-<desktop|mobile>.png` for an acceptance criterion,
`<screen-slug>-<empty|error|disabled>-<desktop|mobile>.png` for a UI state, each optionally
prefixed `<ticket-id>-`. Every match also satisfies the upload rule `^[A-Za-z0-9-]+\.png$`,
and none can contain `/` or `..`. A name outside the grammar exits 2 at parse time.

The suffix is checked against the live viewport at capture time: `-desktop` requires a
viewport width of 1280 and `-mobile` a width of 390. A mismatch fails the step (it depends
on runtime state, so it is not an invocation error). The same name captured again
replaces the earlier file. A capture is written to a new temporary file in the evidence
directory and renamed onto its name, so an existing entry under that name — a symlink
included — is replaced, never written through.

## §12 Session layout

A session lives in `/tmp/fp-verify-<id>/` — a fixed root rather than the per-user temp
directory, because the processes that launch, drive and clean up a session may each see a
different `TMPDIR`. The directory is mode 0700. Because `/tmp` is shared, every verb treats
an `fp-verify-<id>` entry as a session only when it is a real directory (not a symlink)
owned by the current user with no group or other permission bits; anything else is not a
session — never read, signalled or removed, and never listed in `stale_sessions`.

| Entry | Content |
|---|---|
| `state.json` | Mode 0600. The session record: `url`, `server`, `server_pid`, `server_started` (the boot process's start time), `chrome_pid`, `cdp_port`, `browser_ws`, `target_id`, `viewport`, `entry`. Rewritten by temp-file-and-rename. |
| `profile/` | Chrome's scratch `--user-data-dir`. |
| `start.sh` | The entry's `start`, verbatim, mode 0700. Present only when the app was booted. |
| `server.log` | Output of `start.sh`. |
| `chrome.log` | Chrome's output. |
| `evidence.json` | The capture ledger `evidence` reads: one `{name, path, viewport}` per capture, in capture order. |

Chrome runs as `--headless=new --remote-debugging-port=0 --user-data-dir=<session-dir>/profile
--no-first-run --no-default-browser-check about:blank`, so its debugging port is chosen by
the system and bound to the loopback interface, and two sessions never collide.

**Who can reach the debugging port.** The port carries no authentication. A web page cannot
open it — Chrome refuses DevTools connections carrying a browser origin it was not told to
allow — but any local process can, under any local account, from `launch` until `cleanup`,
and with it gets full control of the session's browser, including the cookies an imported
`auth.storage_state` put there. Processes of the same user can already read the session
directory, so the exposure that the port adds is to other accounts on the machine. A
debugging pipe would close it, but a pipe lives only as long as the process that opened it,
and `launch`, `drive` and `cleanup` are separate processes that each reconnect; the port is
what lets them. On a machine other people log in to, do not import a storage state that
holds real credentials, and `cleanup` as soon as the run ends.

## §13 `--self-test`

```text
node cli.mjs --self-test
```

Exercises the pure rules without starting Chrome or the app: step-file parsing and every
schema rejection, the §11 name grammar, entry validation and `start_timeout` fallback,
flag parsing, the exit-code mapping, the sorted-key document shape, and — against a
stand-in for the browser connection — the step runner's protocol-error handling and its
dialog replies. Prints
`{"cases": <n>, "ok": true}` and exits 0 when every case passes; otherwise prints
`{"error": "self-test: <case>"}` and exits 1. It runs on every change in the repository's
validation workflow.
