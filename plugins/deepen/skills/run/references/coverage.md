# Touched-function coverage

Authoritative contract for how much of the candidate's code the inventory's checks exercise: the
touched-function list, the measured path and its script, the estimate path, the threshold and the
one extension it buys, and the known limits.

- **Measured by the run skill**, in the characterize stage's measurement round, never by the QA
  role: the role lists the functions (§1) and, when asked, traces an estimate (§3); the stage runs
  the script and writes every coverage line.
- **The script** is [`../scripts/touched-coverage.mjs`](../scripts/touched-coverage.mjs), whose
  `--self-test` reproduces §2's worked example and runs in CI through
  `scripts/check-deepen-contract.sh`.

`<run_dir>` is the fence's `run_dir` ([fence.md](fence.md) §1); `<runs>` is
`<state_dir>/runs/<run-id>`.

---

## §1 The touched-function list

The QA role writes `<run_dir>/touched-functions.tsv`: one row per function defined in the
candidate's files, four tab-separated fields, no header, LF line endings:

```
<file>	<line>	<name>	<side>
```

| Field | Value |
| --- | --- |
| `file` | repo-relative path, one of the pick's `files` |
| `line` | the 1-based line the function's definition starts on |
| `name` | the function's name as the language gives it — for an anonymous function assigned to a binding, the binding's name |
| `side` | `server` when it runs in the server process, `browser` when only the browser runs it |

The stage validates every row before use, the format first, since the fenced role wrote the file:
the row has exactly four tab-separated fields; `line` matches `^[1-9][0-9]*$`; `side` is `server`
or `browser`; `file` equals one of the pick's files, compared as a string. Only then is `name`
checked against the source — it appears on that line — in one shell loop that reads the file with
`while IFS=$'\t' read -r f l n s` and tests `sed -n "${l}p" "<WT>/$f" | grep -F -q -e "$n"`, so
every field stays a shell variable's value and is never written into a command line. A row that
fails is dropped with the report line `touched list: dropped <file>:<line> <name> — <why>`; the
rows that pass are written,
unchanged, to `<runs>/touched-functions.tsv`, the only list the script reads. The stage also writes
the pick's files, one per line, to `<runs>/touched-files`.

The list cannot shrink the denominator: the script adds every function V8 saw in a candidate file
that no row claims, as an `unlisted` server function. A function whose range lies inside another
candidate function's range in the same script — a callback, a closure — is part of the function
that encloses it: unclaimed, it is never counted on its own, so the list needs no row for it.

---

## §2 Measured path

Taken when `app.coverage_env` is set and the measurement round's coverage directory is non-empty
after the stop ([dev-server.md](dev-server.md) §7):

```bash
node "<plugin-root>/skills/run/scripts/touched-coverage.mjs" \
  --repo "<WT>" --coverage-dir "<runs>/coverage/<round>" \
  --functions "<runs>/touched-functions.tsv" --files "<runs>/touched-files"
```

The script reads every `coverage-*.json` (V8's format, as `NODE_V8_COVERAGE` writes it) and locates
each function's start offset in its original source:

- a script with a `source-map-cache` entry → offset to generated line and column through the
  entry's `lineLengths`, then the map's `findEntry`; the original source is resolved against
  `sourceRoot` and the script URL, its query stripped, a dev server's `/@fs` prefix dropped, and a
  root-relative id that does not exist on disk retried under `--repo`;
- a `file://` script under `--repo` with no map → offset to line in the file itself;
- a script with no file behind it (code evaluated from a string) → counted `unmapped`;
- `node:` internals, dependencies under `node_modules/`, and paths outside `--repo` → ignored.

A row matches a V8 function in the same file on the same line, or with the same name within one
line. It is hit when a matched function's first range has a count above zero; a row V8 never saw
is a miss. Several coverage files (worker processes) merge by the highest count.

**Output** — one JSON document, keys sorted, repo-relative paths only: `browser` (count of
`browser` rows), `functions[]` (`file`, `hit` — `null` for `browser` rows, `line`, `name`,
`origin` — `listed` | `unlisted`, `side`), `hit`, `percent` (server functions, rounded to one
decimal; `null` when `total` is 0), `total` (server functions), `unmapped`.

**Exit** `0` answered; `1` could not compute — no coverage file parses, the output is not V8's, or
no covered script maps into a candidate file — with the reason on stderr; `2` a wrong invocation
(a missing or relative path, a malformed or CR-terminated row, a row naming a non-candidate file).

**Worked example**, which `--self-test` reproduces: `src/calc.ts` defines `add` (line 1) and `sub`
(line 4), served as a transformed module two lines longer with an inline map; V8 counts `add` 3,
`sub` 0, and an anonymous closure inside `add`, on its second line, 0 — folded into `add`, never
counted. `src/plain.mjs` is served untransformed and its `mul` runs twice but is not listed.
`src/widget.ts`'s `render` is listed `browser`; V8 loads it with count 0, and a V8 function a
`browser` row claims never enters the server count. One script has no file behind it. Result: `add`
hit, `sub` miss, `mul` hit as `unlisted`; `hit 2`, `total 3`, `percent 66.7`, `browser 1`,
`unmapped 1`.

**Line** in the report, on exit 0:

```
touched-function coverage: <percent>% measured (<hit>/<total> server functions)
```

`total` 0 → `touched-function coverage: no touched functions found`. A non-zero `unmapped` adds
`coverage: <n> scripts could not be remapped`.

---

## §3 Estimate path

Taken when `app.coverage_env` is null (capability row 8's line,
[profile.md](../../setup/references/profile.md) §6), when no measurement round ran because the
fixtures are UI-created, when the script exits non-zero, or when the coverage was lost at the
stop. Every characterize brief asks the QA role for a seam-call trace, so it is on
disk whichever path is taken: per
server function of §1's list, the check ids whose seam call reaches it and the call chain that
does, written to `<run_dir>/estimate.md` as `<file>:<line> <name> — <check ids | none> — <chain>`.
A function with at least one check is counted hit.

```
touched-function coverage: <percent>% estimate (weak) — <reason>
```

`<reason>` is `no coverage env`, `UI fixtures — checks not replayed by the run`, the script's
stderr line, or the stop's coverage-lost line.

**Always estimates**, on either path:

- `browser` functions — `browser functions: <h>/<n> estimate (weak) — traced from tier-1 flows`.
- Statements marked `manual-browser` are not replayed in the measurement round, so the measured
  number excludes what they exercise; with any present, the coverage line ends
  `— manual-browser statements not replayed`.

---

## §4 Threshold

`run.coverage_threshold` (default 80) against the server percentage, measured or estimated:

1. At or above → done.
2. Below → **one** extension pass: the QA role is spawned again with the uncovered functions
   (`file:line name`, never a plan or a change), extends the inventory, and the measurement round
   and this section run again.
3. Still below → the stage continues, and the line directly under the report's status line is

   ```
   coverage gap: <percent>% < <threshold>% — <n> uncovered functions
   ```

   A gap is never a stop.

---

## §5 Known limits

- **Coverage lands only on a normal exit.** V8 writes `NODE_V8_COVERAGE` output when the Node
  process exits normally; a server killed by a signal it does not handle writes nothing, and the
  estimate path takes over ([dev-server.md](dev-server.md) §7).
- **Module runners are unconfirmed.** A dev server that evaluates transformed modules from strings
  (a Vite-style SSR module runner) produces scripts with no file and no `source-map-cache` entry;
  they count as `unmapped`, and a candidate served only that way exits 1 and is estimated. Whether
  a given server's modules reach V8 as files with inline maps is confirmed on its first run.
- **Traffic no check asserts on is counted.** The measurement-round server also answers the
  readiness polls and the seam-auth commands ([dev-server.md](dev-server.md) §4, §6), `reset.sh` and
  `seed.sh` when they go through the app, and the reruns of red groups. A candidate function
  reached only by the ready route or the login seam counts as hit, so the measured number can
  overstate what the checks reach. Resetting the counters with `v8.takeCoverage()` before the check
  round would need code preloaded into the project's server, which the run does not inject.
- **Only V8.** Another coverage format exits 1.
