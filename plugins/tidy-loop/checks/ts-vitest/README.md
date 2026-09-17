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

## Fixtures

Fixtures live in [`../fixtures/`](../fixtures/), one directory each, and declare this stack
in their own `fixture.json`. Run them from the repository root:

```sh
bash scripts/check-tidy-checks.sh
```
