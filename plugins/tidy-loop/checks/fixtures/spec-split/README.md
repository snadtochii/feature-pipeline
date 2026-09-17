# Fixture: spec split

Four trees of the same tiny TypeScript project, pinning the one question
`verify-spec-patch` exists to answer: did the tests **move**, or were they
rewritten to suit the new code?

`base/` declares `Range`, `clamp`, and `add` in `src/math.ts` and `pad` in
`src/format.ts`. `src/math.spec.ts` holds `describe('clamp')` — three cases, two
of them deliberately sharing a name — and `describe('add')`; `src/format.spec.ts`
holds `describe('pad')`.

Each candidate is the same split done differently:

- **`candidate/`** — the honest one. `src/range.ts` now declares `Range` and
  `clamp`, `src/math.ts` keeps only `add`, and the `clamp` cases move verbatim
  into a new `src/range.spec.ts` that imports `./range`. `src/format.*` is
  untouched.
- **`candidate-cheating/`** — the honest split, plus `add` returning `a + b + 1`
  with its expectation edited to match. The spec patch carries that edited
  expectation, so it fails against the *old* `add`.
- **`candidate-regression/`** — the honest split, plus two unannounced
  regressions: `add` returns `a - b` with its spec unchanged, and `src/format.ts`
  is renamed to `src/text.ts` while `src/format.spec.ts` still imports
  `./format`.

Each expected document says something specific about that shape:

- **`candidate/verify-spec-patch`** — `verdict: true`. `src/range.spec.ts` is an
  **addition**: it imports `./range`, which does not exist at the base revision,
  so it cannot run there and is excluded from the base-plus-patch run. Everything
  else runs on both trees and agrees. This is what a refactor-neutral spec change
  looks like.
- **`candidate-cheating/verify-spec-patch`** — `basePlusPatch.green: false`, with
  `src/math.spec.ts > add > sums two numbers` in `failed`. The weakened
  expectation only holds on the candidate, which is exactly the answer the base
  run is there to produce. Both `candidate` arrays stay empty: the cheat is
  visible on the base side, not the candidate side.
- **`candidate-regression/verify-spec-patch`** — `basePlusPatch.green: true`, so
  the spec change itself is honest, and both `candidate` branches fire. The
  behaviour regression shows up as `passToFail`; the module rename makes
  `src/format.spec.ts` fail to load on the candidate, so its two tests vanish
  from that report and show up as `missingToFail`.
- **`base/test-names`, `candidate/test-names`, and the multiset assertion** —
  the honest candidate's moved spec file is an addition, so the pair command
  never cross-checks the cases it carries. The `sameTestNames` comparison is what
  carries that half of the evidence: the two trees hold the **same** test names,
  files disregarded, duplicates included. Together the two documents say "nothing
  was lost, and nothing that stayed was weakened". Names, not bodies: a moved case
  whose assertion was weakened in the new file is an addition to the pair command
  and an unchanged name to the multiset, so neither document changes. That is the
  blind spot of this split shape — a test moved into a new module is guarded by
  its name alone — and closing it takes a per-test body identity, which belongs
  to a separate gate at the consumer's layer rather than to this command.

The duplicate-named pair is among the moved cases on purpose: it exercises both
the multiset's duplicate preservation and the pair command's rule that two tests
sharing an identity collapse to failed if either failed.

## Layout

The toolchain is pinned once at this directory (`package.json` +
`package-lock.json`, installed with `npm ci`); each tree carries only its own
`tsconfig.json` and sources, and resolves the toolchain by Node's walk-up.

`verify-spec-patch` needs git, and the trees here are tracked files of this
repository. The runner therefore builds a **throwaway** repository per candidate
under its own temporary directory: the base tree copied in and committed, then
replaced by the candidate tree and committed again, with a `node_modules`
symlink back to this directory that `.git/info/exclude` keeps out of both
commits. `fixture.json` declares which trees pair with which (`specPatch`), which
single-tree commands apply per tree (`trees`), and which trees must share a name
multiset (`sameTestNames`).

No tree carries an ignore file of its own: the runner stages them with
`git add -A`, and a `.gitignore` inside a tree would silently withhold files from
the base commit.

`node_modules/` is gitignored. Run the whole thing with
`bash scripts/check-tidy-checks.sh` from the repository root.
