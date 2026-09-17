# The `ts-vitest` stack

An implementation of [`../CONTRACT.md`](../CONTRACT.md) for repositories whose toolchain is
TypeScript and Vitest. It carries no dependencies: `typescript` and `vitest` are resolved
from the repository named by `--repo`, by Node's ordinary walk-up, and everything else
comes from Node's standard library.

The top-level `*.mjs` files are the commands. `lib/` is private to this stack — the
contract says only top-level files are commands, and nothing outside this directory should
import from it.

## Stack-local flags

The contract fixes the flags that mean the same thing in any stack. These are the ones
that only make sense here, because they name TypeScript's own configuration:

| Command | Flag | Meaning |
|---|---|---|
| `exported-surface` | `--tsconfig <path>` | Which TypeScript configuration to compile through. Relative paths resolve against `--repo`; the default is `<repo>/tsconfig.json`. |
| `verify-spec-patch` | `--tsconfig <path>` | Same meaning, used to resolve a test file's import specifiers when deciding whether it is an addition. A missing configuration degrades to TypeScript's default options, under which relative imports still resolve. |

`verify-spec-patch`'s `--test-globs` values are matched with git's `:(glob)` semantics —
the same `**` dialect the consuming profile writes — and are repo-relative.

## How declarations are produced

`exported-surface` does not shell out to `tsc`. It loads the repository's own `typescript`
and builds a `ts.Program`, overriding the emit settings **in memory** for the run:
declaration emit on, `noEmit` / `composite` / `incremental` off, declarations addressed
into a temporary directory, and line endings normalized. That is what lets it answer a
repository configured with `noEmit: true` — the common case for an app that builds through
a bundler — without writing anything into it, and what keeps a `.tsbuildinfo` file from
appearing in the target tree.

A configuration that contributes no source files of its own but declares
`references` is treated as a solution-style root: each referenced project is compiled and
the surfaces are unioned, with a visited set guarding against a reference cycle.

## How the test suite is reached

`test-names` runs `vitest list --json=<file>` and reads the file, so the document never
depends on parsing a console stream. It asks for a static parse first and falls back to
runtime collection only when the repository's vitest does not know that option, recording
which mode answered.

`coverage-hit` probes the repository for `@vitest/coverage-v8`, then
`@vitest/coverage-istanbul`, and runs `vitest run` once with the coverage reporter writing
into a temporary directory. Neither provider installed is a "could not compute", not a
negative answer — the contract's §7 says why.

`verify-spec-patch` runs `vitest run --reporter=json` twice, once per tree, and classifies
by the identity `file > describe path > title` that `test-names` also produces. Both runs
execute the **whole** suite; the addition files are subtracted from the base-plus-patch run
with one `--exclude <file>` each, which is the only vitest mechanism that expresses "exactly
these files" (positional filters are lowercase substring matches). `--passWithNoTests` keeps
an all-excluded run an answer with no evidence rather than a false red. Because `--exclude`
takes a glob and not a path, each addition's path is escaped before it becomes one — a
wildcard in a filename would otherwise withdraw that file's siblings too, and an
all-excluded run reports green. Classification keys
on the report file, not on vitest's exit code, which is 1 for a red suite, a zero-file run
and a startup crash alike.

## How the base tree is materialised

`verify-spec-patch` produces the base-plus-patch tree itself, and never mutates `--repo`:

1. The spec patch is `git diff <base-sha> -- :(glob)<each --test-globs value>`, written
   straight to a file in the temp directory rather than buffered.
2. `git worktree add --detach` checks `<base-sha>` out at `<temp>/base`. The worktree is
   confirmed clean, then the patch is applied with `git apply --3way` — three-way matters
   because the base tree lacks the candidate's new source modules while an edit to an
   existing test file must still apply.
3. A `node_modules` symlink at the worktree root points at the nearest `node_modules`
   directory found by walking up from `--repo`. A refactor-only change shares the base
   lockfile by definition, so the two trees run the same toolchain. **Known limit:** one
   directory is bridged, so a repository whose test files resolve their toolchain from a
   nested workspace package is not covered; no `node_modules` found at all exits 1.
4. The checkout and its registration in the repository's worktree list (its common git
   directory — the main repository's when `--repo` is itself a linked worktree) are removed
   on every exit path the command can observe, including `SIGINT`, `SIGTERM`, and `SIGHUP`
   — the last matters
   because the consuming loop is scheduled and detached. The two suite runs are awaited
   rather than blocked on, which is what lets a signal listener run at all while a suite
   is in flight; the listener forwards the signal to that suite and ends the run as an
   exit-1 `{"error"}` naming the signal, and the removal happens on the way out. A
   `git worktree prune` runs only when the removal itself failed, since prune is
   repository-wide and would otherwise drop another tool's registration whose directory
   is merely unreachable.

## Fixtures

Fixtures live in [`../fixtures/`](../fixtures/), one directory each, and declare this stack
in their own `fixture.json`. Run them from the repository root:

```sh
bash scripts/check-tidy-checks.sh
```
