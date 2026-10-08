---
name: setup
description: "Configure a project for headless UI verification: install and check the browser driver, generate or merge the committed feature map from the repository, write the driver and feature_map keys into the project's test: entry, and prove the loop once with a two-step drive. With --refresh, regenerate the mechanical fields of every configured feature map without asking anything, installing anything or touching the config."
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - AskUserQuestion
argument-hint: "[--refresh] [--map <path>]"
---

# Verify setup

One command that gives agents a map of the app's UI and turns the browser driver on for the
project. It installs and checks the driver, writes the committed feature map, writes two keys
into the project's `test:` entry, and drives the app once to prove the loop: a generated map
that was never driven is a draft, so the run reports done only after the proof.

Two contracts govern it; consume them as written and never restate them here:

- [../../references/feature-map.md](../../references/feature-map.md) — the map's grammar, how a
  map is generated from the repository, and how an existing map is merged.
- [../../drivers/browser/CONTRACT.md](../../drivers/browser/CONTRACT.md) — the driver's verbs,
  flags, documents and exit codes.

**This skill runs in the main conversation, standalone.** It spawns no subagents, calls no MCP
tool and commits nothing. It asks one question at most — which `test:` entry to configure,
and only when more than one qualifies (§2) — and every other decision has a stated default,
named in the report.

## Arguments

```
/verify:setup $ARGUMENTS
```

- No argument — the first run: §1–§6, then the §8 report.
- `--map <path>` — the same, with the map written at `<path>` (§2).
- `--refresh` — §1, then §7, then the §8 report.
- Anything else, or `--refresh` together with `--map` — print
  `Usage: /verify:setup [--map <path>] | --refresh` and stop.

## What this skill writes

- The driver's install at `~/.feature-pipeline/verify/` (§3).
- The feature map at `<entry-root>/<map-path>` (§4) — the one file it writes inside the
  project's repositories.
- Two keys, `driver` and `feature_map`, in one entry of `claudedocs/tickets/config.yaml` (§5).
- The proving run's scratch — `entry.json`, `steps.json` and the evidence directory — under
  `~/.feature-pipeline/verify-setup/<run-key>/` (§6), overwritten by the next run.

There is no per-write approval: invoking `/verify:setup` is the consent, and the report shows
every config change as a diff. Under `--refresh` the only write is the maps.

---

## Process

### 1. Bind roots

- `<project-root>` — the current working directory, which holds
  `claudedocs/tickets/config.yaml`: the repository itself, or, in a multi-repo workspace, the
  folder holding the child repositories.
- `<plugin-root>` — the parent of the `skills/` directory that holds this skill, the plugin's
  root; on Claude Code, the path `${CLAUDE_PLUGIN_ROOT}` resolves to. The driver and the
  references resolve against `<plugin-root>`, never against the project.
- `<plugin-driver>` — `<plugin-root>/drivers/browser/cli.mjs`. It runs §3's `install` and
  `doctor`: only the plugin copy can install, and only its `doctor` sees a lagging install.
- `<installed-driver>` — `<installed_path>/cli.mjs`, from §3's `install` document. It runs
  every verb of the proving run (§6), so the proof exercises the copy the pipeline runs.
  No plugin-cache path is ever written into the config or the map.

**Shell discipline.** Bash runs two things only: the driver, as
`node '<driver>' <verb> [flags]`, and `git -C '<dir>' check-ignore -q -- '<path>'`. Every path
on those lines is single-quoted as data, and a path containing `'` stops the run, named in the
report. Nothing else is assembled into a command line: the app's `start` command reaches the
driver only as a value inside `entry.json` (§6), which the driver runs from a file of its own.

`--refresh` → continue at §7.

### 2. Read the config and choose the entry

`Read` `<project-root>/claudedocs/tickets/config.yaml`. The file is model-read — never `yq` or
`jq` — and its text is what §5's edits match against.

- **No entry to configure** — the file is missing, has no `test:` block, or offers no
  candidate below → stop with
  `No test entry to configure — run /feature:setup first to declare test.url (and test.start).`
  A `url` or `start` is never invented.
- **Unparseable** — a file that does not read as a YAML mapping → stop and report it; it is
  never overwritten.

**Candidates.**

- The flat block, when `test:` holds `url` as its own key. A flat block holding only `auth`
  (or only `start`) is not a candidate.
- Each `test.repos.<dir>` entry whose key matches `^[A-Za-z0-9._-]+$` and is neither `.` nor
  `..`, whose key names an existing directory under `<project-root>` (`Glob`), and which holds
  `url`. An entry failing any of these is not offered, and the report names it with the
  reason.

Zero candidates → the "no entry" stop above. One → it is selected. Two or more → ask once:

> Which test entry should `/verify:setup` configure?

Each candidate is labelled `test — <url>` for the flat block and `test.repos.<dir> — <url>` for
an entry, none marked recommended. Up to four candidates → one option each. Five or more →
the question text lists every label, the first three are options, and the free-text answer
takes any listed `test` or `test.repos.<dir>`; an answer matching no listed label is asked
again. On Claude Code, ask with `AskUserQuestion`. On Codex, ask
with a user-input tool when the surface has one, else as one concise conversational question
listing the options, then wait for the reply. A cancelled or unanswered question ends the run
before any write. When no user is reachable — a headless run, or a surface with neither a
question tool nor a conversational channel — stop before any write, listing the candidates
and stating that an interactive run picks one. An answer is never assumed.

**The selected entry.**

- It already holds `driver:` with a value other than `browser-cli` → stop, naming the value.
  It is never overwritten.
- Bind `<entry-label>` — `test` for the flat block, `test.repos.<dir>` for an entry.
- Bind `<entry-root>` — `<project-root>` for the flat block, `<project-root>/<dir>` for an
  entry. The map's path, the repository interview (§4) and the `start` launch directory (§6)
  all resolve against it.
- Bind `<map-path>` — the `--map` argument when given; else the entry's existing
  `feature_map` value; else `docs/verification/feature-map.md`. The value bound must match
  `^[A-Za-z0-9._/-]+\.md$`, be relative, carry no empty, `.` or `..` segment, and sit under
  neither `.git/` nor `claudedocs/`. A `--map` argument that fails → the usage line plus the
  rule it broke, and stop. An existing `feature_map` value that fails → stop, naming the key
  and the rule; it is never rewritten silently, and passing a valid `--map` replaces it.

### 3. Driver gate

Nothing is written to the project before this gate passes. Run, one after the other:

1. `node '<plugin-driver>' install`
   - Exit `0` → bind `installed_path`, `version` and `replaced_version` from its document.
   - Exit `1` (`HOME` unset, or no plugin manifest beside the driver) or `2` → stop, quoting
     the document's `error`.
2. `node '<plugin-driver>' doctor`
   - `ok: true` → bind `installed_version` and continue.
   - `ok: false` → stop, with one line per failing field and its fix:

     | Field | Fix |
     |---|---|
     | `chrome_missing: true` | Install Google Chrome, or set `CHROME_PATH` to a Chrome executable; `chrome_path` names the path checked. |
     | `node_ok: false` | Run with Node 22 or newer. |
     | `install_missing: true` | Re-run `/verify:setup`; the install did not land at `installed_path`. |
     | `version_lag: true` | Re-run `/verify:setup`; the installed `<installed_version>` is older than the plugin's `<plugin_version>`. |

   - Exit `1` or `2` → stop, quoting the `error`.

### 4. Feature map

Generate the map for the selected entry per
[feature-map.md](../../references/feature-map.md) §3–§7, every read scoped to `<entry-root>`,
and write it to `<entry-root>/<map-path>`:

- **No file there** → `Write` a new map in the §2 grammar. Missing parent directories are
  created by the write.
- **A file there** → merge it per §8, then `Write` the merged text. A merge that stops for
  this map (an unclosed manual block) stops the run: the map is left untouched and no config
  key is written.
- **Ignore check** → `git -C '<entry-root>' check-ignore -q -- '<map-path>'`. Exit `0` means
  the map is git-ignored → a warning in the report: the map must be committed to be shared.
  Exit `1` is the expected answer. Any other exit (not a git repository) → a report note that
  the ignore status is unknown.

Bind the generation's report counts (feature-map.md §8, Report counts) for §8.

### 5. Config keys

Write `driver: browser-cli` and `feature_map: <map-path>` into the selected entry, editing
`config.yaml` in place.

- **Order** — inside an entry: `url`, `start`, `start_timeout`, `auth`, `driver`,
  `feature_map`, and, in the flat block only, `repos`. The two keys belong to the one entry
  selected and inherit nothing: the flat block and each `test.repos` entry carry their own,
  exactly as the entry's other keys do.
- **Already equal** → no edit; reported `unchanged`.
- **A different `feature_map` value** → `Edit` replaces only that line.
- **Absent** → inserted after whichever of the entry's `url`, `start`, `start_timeout` and
  `auth` comes last in the file — for `auth`, after the last line of its sub-block, never
  between `auth:` and its children. An entry whose keys are out of documented order is
  therefore extended after its last present predecessor, and in the flat block both keys land
  before `repos:`. When both keys are absent they go in one `Edit` at that anchor, in key
  order. A `feature_map` added beside an existing `driver` goes directly after the `driver`
  line. An inserted key takes the indentation of the anchor key's own line — the `auth:`
  line itself when the anchor is `auth`, never its children's — so it lands beside the
  entry's existing keys however the file is indented.
- **Values** — written bare; `<map-path>` passed §2's pattern, so it needs no quoting.
- **Unique match** — two entries can hold identical lines (`driver: browser-cli`, a shared
  `start`), so each `Edit`'s match text carries as many of the selected entry's own lines,
  back to its `<dir>:` key line when needed, as make it unique in the file.
- **Everything else stays** — comments, blank lines and keys this skill does not know stay
  byte-for-byte; no key is ever deleted; the file is never regenerated.
- **Stale match** — an `Edit` whose match text has changed since §2's read → re-read the file
  and rebuild the edit against the new text; the entry choice stands.

Keep each changed line's before and after text for the report's diff.

### 6. Proving run

One full `launch → doctor → drive → evidence → cleanup` against the selected entry, with the
installed driver. The map and the config keys are already written; a failing proof never
undoes them — it ends the run as failed and names the failure.

**Inputs.**

- `<route>` — the first route in map order (live sections as written, each `route:` list in
  its order) that has no `:param` segment; `/` when there is none.
- `<run-key>` — `<project-root>`'s basename, plus `-<dir>` for a `test.repos` entry, with every
  character outside `[A-Za-z0-9._-]` replaced by `-`.
- `<run-dir>` — `<run-key>` under `verify-setup/` in the parent of `installed_path`: the
  absolute form of `~/.feature-pipeline/verify-setup/<run-key>/`. It is user-owned, outside
  the repository, and overwritten by the next run.
- **Auth.** When the entry declares `auth.storage_state`, resolve it against `<entry-root>`.
  A value that is absolute or carries a `..` segment is not passed, and the report says
  `auth path outside the entry root — not proven`. A file that `Glob` does not find is not
  passed, and the report says `auth declared, file absent — not proven`. A file that exists
  is passed by absolute path — only its existence is checked; the skill never reads, copies
  or prints it — and `git -C '<entry-root>' check-ignore -q -- '<storage_state>'` runs: exit
  `1` (not ignored) puts a warning in the report that the session file could be committed.
  `auth.attach_tab` is never passed; the driver takes no such key.

**Files**, each with `Write` (the first creates `<run-dir>`). A file a previous run left there
is `Read` first, so the `Write` may replace it; neither holds a secret.

- `<run-dir>/entry.json` — a JSON object: `url` from the entry; `start` and `cwd` (the absolute
  `<entry-root>`) when the entry declares `start`; `start_timeout` when it declares one;
  `auth` as `{"storage_state": "<absolute path>"}` when passed above. Values are written as
  JSON strings and numbers, escaped as JSON — the `start` command is data in this file and
  never part of a command line.
- `<run-dir>/steps.json` —
  `[{"step": "goto", "url": "<route>", "timeout_ms": 60000}, {"step": "screenshot", "name": "AC-1-desktop.png"}]`.
  Two steps exactly: the proof's single criterion is that the first mapped route renders, and
  the session's default 1280-wide viewport satisfies the `-desktop` suffix. `launch` only
  waits for `url` to answer, so a freshly booted dev server may still compile `<route>` on
  its first request; the `goto` takes the driver's longest timeout instead of its 5000 ms
  default.

**Run**, with `<installed-driver>`, in order:

1. `node '<installed-driver>' launch --entry '<run-dir>/entry.json'`, with a Bash timeout of
   `(start_timeout or 60) + 60` seconds, in milliseconds, capped at 600000.
   - Exit `0` → bind `session`, `server`, `stale_sessions` and `notes`.
   - Exit `1` → the proof fails at `launch` with the `error` (app unreachable and not
     bootable, Chrome missing or exited). `launch` tore down whatever it started, so there is
     no session and nothing to clean up.
   - Exit `2` → the proof fails at `launch`, reported as a defect in the entry file this skill
     wrote, with the `error` verbatim.
2. `node '<installed-driver>' doctor --session '<session>'` → bind `url_reachable`,
   `cdp_reachable` and `auth`. `ok: false` → the proof fails at `doctor`, naming each false
   field, or `auth` with its value (`expired`, `unreadable`); exit `1` or `2` fails it with
   the document's `error`. Either way, skip to step 5.
3. `node '<installed-driver>' drive --session '<session>' --steps '<run-dir>/steps.json' --evidence '<run-dir>/evidence'`,
   with a Bash timeout of 180000 ms (the `goto`'s 60 s plus the capture's own bound)
   → `ok: false` fails the proof at `drive` with the failed step's `error`; exit `1` or `2`
   fails it with the document's `error`. Either way, skip to step 5. Counts of
   `console_errors`, `failed_requests` and `dialogs` go in the report's notes; they do not
   fail the proof.
4. `node '<installed-driver>' evidence --session '<session>'` → the proof needs an entry
   named `AC-1-desktop.png` with `missing: false`; bind its `path`. No such entry fails the
   proof at `evidence`; exit `1` or `2` fails it with the document's `error`.
5. `node '<installed-driver>' cleanup --session '<session>'` — always, once `launch` returned
   a session, whatever happened in steps 2–4. `ok: false`, or exit `1`, fails the proof at
   `cleanup`, and the report advises re-running
   `node '<installed-driver>' cleanup --session '<session>'`. `cleanup --all` is named only
   as a last resort, with its cost: it also tears down every other session this user owns,
   a concurrent pipeline run's included.

**Result.** The proof passes when `launch` exited `0`, `doctor` was `ok`, `drive` was `ok`,
the screenshot is listed and present, and `cleanup` was `ok`. Otherwise it fails at the first
verb that failed, named with its field or `error`. A non-empty `stale_sessions` is a report
note; those sessions are never touched.

### 7. `--refresh`

Regenerates the mechanical lines of every configured map. It asks nothing, makes no driver
call, writes no config key and runs no proof.

1. `Read` the config as in §2. A missing or unparseable file, or no `test:` block → stop as
   §2 does.
2. Collect every `feature_map` key: the flat block's, then each `test.repos.<dir>` entry's in
   file order. An entry whose key fails §2's key rule or names no directory, or a value that
   fails §2's `<map-path>` rule, is skipped and named in the report. None left → stop with
   `No feature map configured — run /verify:setup first.`
3. For each map, with `<entry-root>` bound as in §2: an existing file is merged per
   [feature-map.md](../../references/feature-map.md) §8 and written back; a missing file is
   generated and written as a first map. A map whose merge stops (an unclosed manual block)
   is left untouched and named in the report, and the next map still runs. Run §4's ignore
   check for each map written.

### 8. Report

Print one block:

```
## Verify setup — <project-root>
Result: done | proof failed | stopped — <reason>
Entry: <entry-label> — <url> (only candidate | chosen)
Driver: <installed_version> at <installed_path> (replaced <replaced_version> | fresh install)
Map: <map-path> — created | merged | unchanged
  features: <n> (<a> new, <b> returned, <c> moved to Removed)
  skipped: <d> candidates with no route or test id, <e> computed routes, <f> templated test ids
  gaps: no router found | <root> without <package> — not routed | <section> has no source line | <name> folded into <name> | <route> linked to <name>, <name>
Config: claudedocs/tickets/config.yaml — <n> keys added, <m> changed | unchanged
  <diff of the changed lines, - before / + after>
Proof: pass | failed at <verb> — <field or error>
  route: <route>
  evidence: <path of AC-1-desktop.png>
  auth: absent | valid | expired | unreadable | declared, file absent — not proven | path outside the entry root — not proven
  notes: <launch notes>; <n> console errors, <m> failed requests, <k> dialogs; stale sessions <ids>
Defaults:
  map path — <map-path> (--map | existing feature_map | default)
  proof route — <route> (first mapped route without a parameter | / when none has one)
  proof steps — goto (60 s timeout), then screenshot AC-1-desktop.png at 1280×800; goto waits for the load event only, so a client-rendered page may be captured before it renders — open the screenshot to judge
  manual blocks — drafted only where code or CLAUDE.md / AGENTS.md shows a value; the rest left empty
Warnings:
  <map-path> is git-ignored — the map must be committed to be shared
  <storage_state> is not git-ignored — the session file could be committed
  test.repos.<dir> — not offered: <reason>
Next: review and commit <map-path>, then fill its manual blocks
```

- A line or sub-line with nothing to show is omitted: `gaps:` with no gap, `Warnings:` with
  no warning, `notes:` with no note, `Proof:` and `Next:` on a run that stopped before §6.
- `--refresh` prints `Result`, one `Map:` group per map (`<entry-label>: <map-path>`, with
  `skipped — <reason>` for a map not refreshed), `Config: untouched`, and the `Warnings:`
  group; no `Entry`, `Driver`, `Proof` or `Defaults` line.
- A stop prints the block with `Result: stopped — <reason>`, the fix, and every write made
  before the stop — `nothing written` when the stop came before §4.

## Boundaries

**Will not:**

- Ask anything other than the entry choice in §2, ask anything under `--refresh`, or assume
  an answer a user did not give.
- Read, print or copy a secret file or a storage-state file's content — a storage-state
  file's existence is checked with `Glob`, and its path is handed to the driver.
- Edit a `config.yaml` key other than `driver` and `feature_map` of the selected entry,
  overwrite a `driver` value other than `browser-cli`, invent `url` or `start`, or regenerate
  the file.
- Delete a map section, or edit, reorder or remove a manual block.
- Run anything through Bash other than the driver and `git check-ignore`.
- Write inside the project's repositories anything but the map.
- Write a plugin-cache path into the config or the map.
- Commit, stage or push anything.

## Error Handling

Every stop before §4 writes nothing to the project and ends with the report's `stopped` form.

- **Usage** — an unknown argument, `--refresh` with `--map`, or a `--map` value failing §2's
  rule → the usage line and stop.
- **No entry to configure** — `config.yaml` missing, no `test:` block, or no candidate →
  stop, pointing at `/feature:setup`.
- **`config.yaml` unparseable** → stop; the file is never overwritten.
- **Entry question cancelled, unanswered, or no user reachable** → stop before any write,
  listing the candidates.
- **A `driver` value other than `browser-cli`** → stop, naming it.
- **An existing `feature_map` value failing §2's rule** → stop, naming the key; pass a valid
  `--map` to replace it.
- **A path containing `'`** → stop, naming it.
- **`install` exit `1` or `2`** → stop with its `error`.
- **`doctor` `ok: false`** → stop with one fix line per failing field (§3).
- **A map merge that stops** → first run: stop, with the map untouched and no config key
  written; `--refresh`: that map skipped and reported, the others continue.
- **An `Edit` whose match text changed** → re-read the config and rebuild the edit (§5).
- **A proof failure** (§6) → map and config stay written; the run ends `proof failed`, naming
  the verb and its field or `error`; `cleanup` has run whenever a session existed.
- **A write fails** → report the files already written and the ones not reached, and stop.
  A re-run merges the map and finds the keys already present.
