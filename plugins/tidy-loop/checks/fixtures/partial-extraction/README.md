# Fixture: partial extraction

Two trees of the same tiny TypeScript project. `base/` declares `Range` and
`clamp` in `src/math.ts`, which `src/stats.ts` and `src/report.ts` both import,
and holds an unrelated `src/format.ts`. `candidate/` is the refactor done
**half way**: `src/range.ts` now declares `Range` and `clamp` too, `src/stats.ts`
imports from it, `src/report.ts` still imports from `src/math.ts`, the original
declarations in `src/math.ts` were never removed, and `src/format.ts` was
renamed to `src/text.ts` with its content untouched. Both trees also carry
`src/percent.ts`, which keeps a **private** `clamp` of its own and exports
only `percent`. That is the shape a structural check has to be able to see, so
it is the shape the fixture pins.

Each command's expected document says something specific about that shape:

- **`exported-surface`** — `src/stats.ts` digests differently between the trees,
  because its emitted declarations import `Range` from a different module; that
  is the surface change the half-finished rewire causes. `src/math.ts`,
  `src/report.ts`, and the renamed module all digest identically, so a real
  difference is not lost in noise. `src/text.ts` appears in **both** documents:
  `base/`'s `src/format.ts` compares under its mapped key, which is what makes
  the two documents key-comparable at all. `src/range.ts` exists only in the
  candidate. `declaredOnce` is the copy detector — `clamp` and `Range` list one
  file in `base/` and two in `candidate/`, which is exactly how a gate tells a
  move from a copy. `src/percent.ts` appears in neither list: its `clamp` is
  not exported, and only a module's exported surface declares a tracked
  symbol, so a private helper that happens to share the name cannot block a
  legitimate move.

- **`test-names`** — `src/math.spec.ts` deliberately contains two `it` cases with
  the *same* name inside one `describe`, so both documents prove the multiset
  keeps duplicates rather than collapsing them. The candidate adds
  `src/range.spec.ts` and carries `src/format.spec.ts` over as
  `src/text.spec.ts`.

- **`coverage-hit`** — `base/` is asked about `src/math.ts` and `src/stats.ts`,
  both executed by the suite, so `covered` is true. `candidate/` is asked about
  `src/range.ts` and `src/report.ts`; `src/report.ts` has no spec at all, so it
  reports zero covered statements and `covered` is false. The expected documents
  store the **projected** shape — each target reduced to a boolean, with no raw
  statement counts — because those counts depend on the provider and the Node
  build, and the gate's question is executed-or-not.

## Layout

The toolchain is pinned once at this directory (`package.json` +
`package-lock.json`, installed with `npm ci`); `base/` and `candidate/` resolve
it by Node's walk-up and carry only their own `tsconfig.json` and sources. The
two trees deliberately do not share a `tsconfig`: an `extends` chain would
couple them, and one of the things being checked is that each tree is compiled
on its own terms. Both configs set `noEmit: true` and `declaration: false`,
which is what proves `exported-surface` overrides emit settings in memory
instead of relying on the repository's.

`node_modules/` and `coverage/` are gitignored. Run the whole thing with
`bash scripts/check-tidy-checks.sh` from the repository root.
