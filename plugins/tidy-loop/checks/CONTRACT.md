# The checks-script contract

Authoritative surface for the mechanical questions the Tidy Loop's gates ask about a
repository. The contract is **stack-neutral**: it fixes command names, inputs, output
documents, and exit codes. An implementation is **stack-specific**: one directory per
stack under `checks/`, each answering §5–§8 for the toolchain it knows.

A gate never parses a tool's human output and never shells out to a project command of
its own. It invokes a command from this contract and reads one JSON document. That is
what makes a gate mechanical, and what makes a second stack a second directory rather
than a rewrite.

---

## §1 Invocation

```text
node "${CLAUDE_PLUGIN_ROOT}/checks/<stack>/<command>.mjs" --repo <abs-path> [command flags]
```

| Part | Meaning |
|---|---|
| `<stack>` | The implementation directory, taken from the consuming profile. `ts-vitest` is the one shipped here. |
| `<command>` | One of the four names in §5–§8. |
| `--repo <abs-path>` | Required, absolute, an existing directory: the repository under test. Every subprocess a command spawns runs with this directory as its working directory, and the toolchain is resolved from it. The command process itself does not change directory — see §4 for how other path flags resolve. |

Only top-level `<command>.mjs` files inside a stack directory are commands. Anything in a
subdirectory (`lib/`, fixtures, notes) is private to the implementation, is not a command,
and may change shape without changing this contract.

A command is invoked directly with `node`. It is never sourced, never wrapped in a shell
string, and never given arguments that were assembled by string concatenation.

## §2 Output rules

Every run prints **exactly one JSON document** on stdout, followed by a newline, and
nothing else. Subprocess output the command captured stays on stderr or inside an `error`
string; it never reaches stdout.

The document is written so two runs on two machines compare byte-for-byte:

- **Object keys are sorted recursively**, ascending, by code unit.
- **Arrays are in a stated order** — every array-valued key in §5–§8 names its ordering.
- **No timestamps**, durations, process ids, or other run-varying values.
- **No absolute paths.** Every path is repo-relative and uses `/` separators on every
  platform. A path the command cannot express relative to `--repo` is an error (§3), not
  an absolute path in the document.
- Two-space indentation, one trailing newline.

## §3 Exit codes

| Code | Meaning | Document |
|---|---|---|
| `0` | An answer was computed. This includes a **negative** answer — `covered: false`, an empty `tests` array, a symbol declared in two files. | The command's document from §5–§8. |
| `1` | The answer could not be computed: the toolchain is unresolvable from `--repo`, a required package is missing, a subprocess crashed, a compilation could not emit. | `{"error": "<reason>"}` |
| `2` | The invocation was wrong: an unknown flag, a missing required flag, a relative `--repo`, an unreadable or malformed input file. | `{"error": "<reason>"}` |

A caller distinguishes "the repository says no" from "the check is broken" by the exit
code alone, never by inspecting the document. Both non-zero paths print the same
`{"error"}` shape, so a caller can always parse stdout.

`<reason>` is a single line of human-readable text. When it quotes a subprocess, it
quotes a bounded tail of that subprocess's stderr.

## §4 Shared flags and filesystem discipline

| Flag | Required | Meaning |
|---|---|---|
| `--repo <abs-path>` | yes | §1. |
| `--prelude "<line>"` | no | A shell line that must run before any subprocess the command spawns — how a scheduled run puts a version manager's toolchain on `PATH`. |

Long flags only. Both `--flag value` and `--flag=value` are accepted. An unknown flag
exits 2 rather than being ignored.

**How relative path flags resolve.** A flag naming something *inside* the repository
resolves against `--repo`. A flag naming one of the caller's own files — an input document
it wrote, an output directory it wants written — resolves against the caller's working
directory. Each flag in §5–§8 states which it is, and passing an absolute path is always
unambiguous.

**How `--prelude` is composed.** The prelude is the caller's own declared command — the
same trust tier as the rest of that caller's profile — and it is treated as *file
content*, never as text substituted into a command line. The command writes

```sh
trap 'echo "prelude failed with status $?" >&2' EXIT
set -e
<prelude line>
trap - EXIT
PATH="$PATH:$1"
shift
exec "$@"
```

to a private temporary file and invokes `sh <that file> <fallback-dir> node <bin> <args…>`,
where `<fallback-dir>` is the directory of the interpreter running the command. The command
being run therefore rides as an argument vector that the shell re-executes verbatim;
nothing from the prelude, the repository, or a flag value is ever concatenated into a shell
string. There is no `eval` and no shell-string subprocess anywhere in an implementation of
this contract.

Two consequences follow from that shape. **A prelude that fails aborts the run**: `set -e`
stops the script at the failing line, the subprocess never starts, and the command exits 1
(§3) with an `error` quoting the shell's stderr — where the trap has named the prelude and
its status, since a failing command is free to print nothing of its own. A prelude is never
silently skipped. And **the prelude selects the interpreter**: the toolchain runs under
`node` as resolved on the `PATH` the prelude leaves behind, so activating a version manager
changes which interpreter runs the suite, not only its environment. The directory of the
interpreter running the command is appended last, so a prelude that sets no `PATH` still
resolves one. Without a prelude, the subprocess is the interpreter running the command.

A prelude containing a newline is accepted, because it is file content. Consumers of this
contract constrain it to one line at their own layer; that is a profile rule, not a
contract rule.

**Filesystem discipline.** A command writes only inside its own temporary directory,
created per invocation and removed when the process exits. It adds nothing to `--repo`'s
tracked tree: no build output, no coverage directory, no lockfile change. The one
exception is an explicit output flag (`--out`, §6), whose destination the caller names.
Running the repository's own tooling can still touch that tooling's own ignored caches
inside `--repo` — a test runner's cache directory, for instance — which is the toolchain
behaving normally and never reaches a gate's output or a diff.

Commands read no environment file and no credential file of their own. Beyond the flags,
what reaches a command is the contents of the repository it was pointed at.

**`--repo` must name a trusted checkout.** This is the one place the contract asks
something of the caller rather than the implementation. Answering these questions means
using the repository's own toolchain, and that has two consequences worth stating plainly:
the toolchain is resolved by walking up from `--repo`, so it may come from an ancestor
directory rather than from `--repo` itself; and a command loads and runs that toolchain —
and, for §7, the repository's entire test suite — in the invoking process's environment
and with its privileges. Pointing a command at an untrusted checkout executes that
checkout's code. No sandboxing is claimed or attempted.

## §5 `test-names`

Answers *what tests exist*, as a multiset, so two trees can be compared for a test that
was lost or silently renamed.

```text
node .../test-names.mjs --repo <abs-path> [--prelude "<line>"]
```

Document:

```json
{
  "collection": "static",
  "tests": [
    { "file": "src/math.spec.ts", "name": "clamp > clamps above the maximum" }
  ]
}
```

| Key | Meaning |
|---|---|
| `collection` | `"static"` when the names were collected by parsing the test files without executing them, `"runtime"` when the test framework had to load them to enumerate. Informational — a gate compares `tests`, not this. |
| `tests` | Every test the framework would run. `file` is repo-relative. `name` is the full name: enclosing group titles and the test title, joined with `" > "`. |

Ordering: sorted by `file`, then by `name`, both ascending by code unit.

**Duplicates are preserved.** Two tests with the same name in the same file appear twice.
A refactor that collapses two cases into one is a lost test, and the multiset is what
makes that visible.

**Skipped tests are omitted, by design.** The multiset is the set of tests that actually
execute. A test that a change turns into a skipped test therefore reads as a lost test,
which is the intended reading.

**Parametrized tests are counted as written under static collection.** With
`"collection": "static"`, a test generated from a table (`it.each`, `test.for`, and their
kin) appears **once**, with its title template verbatim — `case %i`, not `case 1` and
`case 2` — because the table is never evaluated. A refactor that drops one row of such a
table is therefore invisible to the multiset in that mode; only `"collection": "runtime"`,
which loads the files, expands the rows into the names the run would use. A gate that
needs row-level evidence for a parametrized test takes it from an actual run of the suite
(§8 compares executed tests), not from this multiset.

## §6 `exported-surface`

Answers *what every module exports*, as a digest per module, so a move can be proven to
have preserved the public shape — and *where each tracked symbol is declared*, so a move
that copied rather than moved is visible.

```text
node .../exported-surface.mjs --repo <abs-path> --rename-map <json-path> \
     [--out <dir>] [--prelude "<line>"]
```

`--rename-map` and `--out` are the caller's own files and resolve against the caller's
working directory. A stack may accept additional flags of its own for selecting *how* it
resolves the repository's compiler; those are documented in that stack's directory, not
here, because the contract does not know what a compiler configuration looks like.

Document:

```json
{
  "declaredOnce": { "clamp": ["src/math.ts"] },
  "surface": { "src/math.ts": "9f2b…" }
}
```

| Key | Meaning |
|---|---|
| `surface` | One entry per source module: repo-relative path → hex sha256 of the declarations the repository's own compiler emits for it. Equal digests mean an identical declared surface. |
| `declaredOnce` | One entry per symbol named in the rename map: symbol name → every repo-relative file that declares it **as part of its exported surface**, sorted, deduplicated. A gate asserting a move — rather than a copy — expects exactly one. An empty array means the symbol is absent from the tree's exported surface. |

Only exports count as declarations. A module that keeps a private helper under the same
name is not a second copy of the tracked symbol and does not block a move. A re-export
(`export { x } from`, `export *`, a barrel) resolves to the file holding the declaration and
is attributed there, never counted as a declaration of its own.

The declarations are produced by the repository's **own** TypeScript-equivalent compiler,
resolved from `--repo`, with declaration emit forced in memory. No artifact is written
into the repository, and the repository's own `noEmit`-style settings do not suppress the
answer.

### Rename-map schema

`--rename-map` points at a JSON file with exactly two top-level keys:

```json
{
  "modules": { "src/format.ts": "src/text.ts" },
  "symbols": { "clamp": "clamp", "Range": "Range" }
}
```

- `modules` maps an **old** repo-relative module path to its **new** one.
- `symbols` maps an **old** symbol name to its **new** one. An identity entry
  (`"clamp": "clamp"`) is meaningful and common: it declares a symbol as *tracked* by
  `declaredOnce` without asserting a rename.
- Both keys are required; either may be empty. There is no heuristic that guesses whether
  an entry is a path or a symbol.

**The map is always applied forward** — old → new — to whichever tree the command is
pointed at. A caller compares two trees by passing the **same** map to both runs: the run
against the tree that already has the new names is a no-op by construction, and the two
documents become key-comparable.

**Module-key collision.** A module key is rewritten to its new path only when the tree
contains the old path and not the new one. When a tree contains **both**, each keeps its
own key. That surfaces the stale module as a difference, which is the correct answer.

**`--out <dir>`** additionally writes the emitted declarations under `<dir>`, mirroring
the repo-relative layout, for a human inspecting a digest mismatch. It changes no key in
the document.

**Compilation failures.** A tree with type errors is still answered — typechecking is a
separate gate. A failure of the *declaration emit itself* exits 1 naming the first emit
diagnostic, because a module missing from `surface` would read to a gate as a removed
surface.

An empty `surface` exits 1. A contract that can answer "this repository exports nothing"
successfully is a contract that false-greens a misconfigured project.

## §7 `coverage-hit`

Answers *did the test suite actually execute these files*. This is the oracle behind
"the tests cover the code that moved" — a static import graph is not.

```text
node .../coverage-hit.mjs --repo <abs-path> --targets <a,b,c> [--prelude "<line>"]
```

`--targets` is a comma-separated list of repo-relative files, each of which must name an
existing **file**. A missing path, a directory, or an empty list exits 2 — a directory
exists, matches no report entry, and would otherwise answer `covered: false` at exit 0,
which is a wrong answer where the contract promises a right one or a non-zero exit.

Document:

```json
{
  "covered": true,
  "hit": { "src/math.ts": { "covered": 7, "statements": 9 } },
  "provider": "v8",
  "testsPassed": true
}
```

| Key | Meaning |
|---|---|
| `hit` | One entry per target: total instrumented statements and how many executed at least once. A target the coverage report does not mention is `{"covered": 0, "statements": 0}`. |
| `covered` | True iff **every** target has at least one covered statement. This is the gate's answer. |
| `provider` | The coverage provider that produced the report, echoed so a caller can tell which instrumentation the numbers came from. |
| `testsPassed` | Whether the suite itself was green. |

**A red suite is still an answer.** Whether a file was executed is computable whether or
not the assertions passed, so a failing suite exits 0 with `testsPassed: false`. A caller
that requires green asserts on `testsPassed`.

**A missing coverage provider is not an answer.** Coverage instrumentation is a separate
installed package in most stacks; when none is present the command exits 1 with an error
naming the package to install. Installing it is a prerequisite of the consuming loop, not
something a check silently works around.

**A target that is itself a test file** is normally excluded from a coverage report and
therefore reports `0/0` and `covered: false`. Targets are source files.

## §8 `verify-spec-patch`

Answers *whether a change's test suite is symmetric evidence*: the same tests, moved
rather than weakened. This section is the contract; the flag spellings are fixed by the
change that implements it and are deliberately not written here.

Inputs, named semantically: a **base tree**, a **candidate tree**, a **spec patch** (the
test-file-only portion of the change), and a **base revision** identifying what existed
before the change.

Document:

```json
{
  "added": ["src/range.spec.ts > clamp > clamps to the range"],
  "missingToFail": [],
  "passToFail": [],
  "verdict": true
}
```

| Key | Meaning |
|---|---|
| `passToFail` | Tests that pass on the base tree with the spec patch applied, and fail on the candidate. Each entry is a test identity in the `§5` `file > name` form. |
| `missingToFail` | Tests present on the base tree with the spec patch applied and absent from the candidate. A silently deleted test. |
| `added` | Tests present only on the candidate that are **not** evidence of a regression, because the module they exercise did not exist at the base revision. Reported for the record, never counted against the change. |
| `verdict` | True iff `passToFail` and `missingToFail` are both empty. |

Ordering: every array sorted ascending by code unit.

Exit codes follow §3 unchanged: a verdict of `false` is a computed answer and exits 0;
only an inability to run the two trees exits non-zero.

## §9 Adding a stack

A second stack is a new directory `checks/<stack>/` whose top-level `<command>.mjs` files
implement §5–§8 for that toolchain, plus at least one fixture under `checks/fixtures/`
whose `fixture.json` names that stack. Fixtures are discovered by directory and each one
is driven by the stack it declares, so adding the second stack does not disturb the first.

What a new stack must preserve: the command names, the document keys and their meanings,
the ordering rules, the exit-code split, and §4's subprocess discipline. What it is free
to choose: how it resolves its toolchain, how it collects test names, what it digests to
represent a declared surface, and which coverage instrumentation it drives.

What is deliberately **not** in this contract: any knowledge of the consuming profile,
any git operation, and any notion of a queue, a finding, or a gate. A command is given a
directory and some flags, and answers one question about it.

### Coverage of this contract by fixtures

The shipped fixtures exercise the common path of every implemented command against two
trees. They do **not** exercise: a solution-style root configuration that builds through
project references (§6), the fallback from static to runtime test collection (§5), or a
`--prelude` beyond a trivial no-op line (§4). Those paths are verified against a real
repository when they change.
