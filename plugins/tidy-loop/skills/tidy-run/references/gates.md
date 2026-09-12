# The gate suite

The pass/fail checks a tidy branch must survive before a pull request is opened. Consumed by
[`../SKILL.md`](../SKILL.md) §10; every command here is explicitly path-bound because shell
state does not persist between tool calls.

**The suite's whole purpose** is to convert *"this diff looks like a refactor"* into *"this
diff is verified to preserve behavior, and a reviewer judged the structure genuinely better."*
Gates G1–G7 answer the first half. G8 alone answers the second.

---

## §0 Inputs the caller binds

| Input | Meaning |
| --- | --- |
| `<WT>` | absolute path to the run's worktree |
| `<CLONE>` | absolute path to the loop clone (the worktree's owner, checked out on base) |
| `<BASE>` | the short base branch name; the fork point is `origin/<BASE>` |
| `<BASE_SHA>` | the resolved commit the worktree forked from — recorded once, cited in the brief |
| `<profile>` | the loaded `.tidyloop.yaml` |
| `<finding>` | the selected finding, including `behavior_risk` and the target files |
| `<covered>` | whether any test file references the finding's target files — decided in §G2 |

Every command below is prefixed with the profile's `commands.prelude` when that key is set, so
a scheduled run gets the same toolchain an interactive shell would. A null prelude means the
command runs as written.

---

## §1 Standing rules for the whole suite

**A red gate aborts the run.** The loop does not negotiate with a gate. It does not weaken a
test, add a skip, relax a lint rule, widen a cap, or adjust an assertion. There is exactly one
exception, stated in §3 below, and it is narrow on purpose.

**Retry doctrine — the distinction that matters.**

- **G3 red from the run's own sloppiness** (a lint violation, a type error, a test broken by an
  incomplete edit) → at most **two** fix attempts. After any fix, the suite restarts **from
  G5**, because a new edit invalidates every earlier result.
- **G1, G2, G4, G6, G7, G8 red** → **no retry, abort immediately.** These are not sloppiness.
  G1 red means observable behavior changed; retrying is the loop trying to get away with it.
  G4 red means the published surface moved. G8 red means the change was not worth making. A
  second attempt at any of them is the loop optimizing against its own oracle, which is the
  one behavior that would make the whole system untrustworthy.

**Running order is by cost, cheapest first:** G5, G1, G2, G3, G4, G6, G7, G8. An expensive gate
never runs after a cheap one has already decided the outcome.

**Every abort records evidence.** Before teardown, write the branch diff to
`<CLONE>/.tidy-loop/blocked/<run-id>.patch` and the deciding output to
`<CLONE>/.tidy-loop/blocked/<run-id>.md`. The worktree is then removed — a failed structural
change has no value to keep, but the reason it failed does.

---

## §2 G5 — Diff caps

First because it is free and decisive. Three caps over three different populations, because
they bound three different risks.

### Step 1 — Partition the changed files

```bash
git -C "<WT>" diff --name-only "<BASE_SHA>...HEAD"
git -C "<WT>" status --porcelain       # must be empty; everything committed
```

Sort every changed path into one of three buckets:

- **Test** — matches `commands.test_globs`. Excluded from every cap. Tests are evidence, not
  churn, and charging them would make skipping the characterization tests the cheapest route
  under a cap.
- **Import-update-only** — the file's entire diff is import and re-export statements, per step 2.
- **Substantive** — everything else. The files whose logic actually changed.

### Step 2 — Classify import-update-only files, fail-closed

A file moved out from under its importers forces a one-line edit in each of them. Those edits
carry no behavioral risk and the typechecker is very nearly a total oracle for them, so they get
their own far looser allowance. Misclassifying a substantive file as import-only would let real
changes past the cap, so the test is two-stage and the second stage is exact.

**Stage 1 — screen.** Take the file's zero-context diff and keep only changed lines:

```bash
git -C "<WT>" diff -U0 "<BASE_SHA>...HEAD" -- "<file>" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)'
```

A candidate is one where every such line belongs to an `import` or `export … from` statement —
including the specifier-member and brace-only lines of a multi-line form, and the `from '…'`
clause. This screen is cheap and approximate; it only nominates.

**Stage 2 — verify exactly.** Strip every import and export-binding statement from the base and
branch versions of the file, then compare what is left:

```bash
git -C "<WT>" show "<BASE_SHA>:<file>" | <strip> > <scratch>/base
cat "<WT>/<file>"                      | <strip> > <scratch>/head
diff -q <scratch>/base <scratch>/head
```

Identical remainder → **import-update-only**. Any difference → **substantive**.

The stripper is not a parser, and it does not need to be — but it does need three rules, and
two of them exist because their absence is exploitable. This was tested against real files
before it was written down.

1. **A statement starts** on a line matching `import` or `export` at the start, *unless* it is an
   exported declaration — `export const`, `export function`, `export class`, `export type`,
   `export interface`, `export enum`, `export default`, `export async`, `export abstract`,
   `export let`, `export var`. Those are code and must survive the strip.
2. **A statement ends** at the first line that terminates it: a `from '…'` clause, the
   side-effect `import '…';` form, **or a line ending in a semicolon**. The semicolon
   terminator is load-bearing. Without it, a local re-export with no from-clause —
   `export { helper };` — never terminates, so the strip runs to end of file and swallows every
   line of real code after it. Both versions then reduce to the same empty remainder and the
   file is reported import-only while its logic changed underneath. That is not a theoretical
   hole: it reproduces on a four-line file.
3. **Two fail-closed backstops.** If a statement does not terminate within 10 lines, or if the
   strip consumed everything and the remainder is empty while the original clearly held code,
   the strip has **failed** — emit no remainder and classify the file **substantive**.

With those rules the classifier can only be wrong in the safe direction: a misparse makes the
remainders differ or trips a backstop, and either way the file is charged against the tight
substantive cap rather than the loose one. That asymmetry is what makes a heuristic acceptable
inside a gate at all.

The same classifier handles barrel files with no special rule, since a barrel edit is an
export-binding line.

### Step 3 — Resolve the caps for this category

Read `caps.per_category[<finding.category>]`, falling back to the top-level `caps` for any key
it does not override.

### Step 4 — Measure

```bash
git -C "<WT>" diff --shortstat "<BASE_SHA>...HEAD" -- <substantive and import-update paths>
```

Lines are insertions plus deletions, over non-test files only. Note the doubling this implies: a
relocated function body is added in its new home and deleted from its old, so a 90-line
extraction costs about 180. The per-category numbers already account for it.

**Pass:** substantive files within the resolved `max_files`, import-update-only files within
`max_import_update_files`, non-test changed lines within the resolved `max_diff_lines`, and the
tree fully committed.

**Fail:** over any cap → abort, ledger status `escalated`. The model found more to do than it was
authorized to do; a human decides whether that larger change is wanted. Never trim the diff to
fit.

### Step 5 — Scope, as a hard stop

Fail outright if any changed path matches `forbidden_paths`, or falls outside `scan.include`
without being a test file or an import-update-only file. An import update in a file outside the
scan set is expected and fine — the loop does not control who imports what. A *substantive*
change out there means the implementation wandered, and the run is not trustworthy.

Report every bucket's count in the brief. A run that repointed twenty importers and changed two
files is a very different object from one that changed twenty files, and a reviewer deciding in
thirty seconds needs to see which one they have.

---

## §3 G1 — Base-test gate

**The behavior oracle.** The branch must pass the test files exactly as they exist at the base
commit.

```bash
git -C "<WT>" checkout "<BASE_SHA>" -- <commands.test_globs>
cd "<WT>" && <commands.test>
git -C "<WT>" checkout HEAD -- <commands.test_globs>
git -C "<WT>" status --porcelain     # must be empty again
```

**Why this single command carries the weight.** It closes both failure modes of an unattended
refactor at once. Behavior under the existing suite is preserved, *and* no test was adjusted to
accommodate the change. A diff-pattern check on assertion lines would be a weaker, fuzzier
version of the same idea, and would be defeated by a rewritten assertion that happens to look
like a move.

**Two mechanical details that are easy to get wrong.**

- A pathspec checkout resolves the globs against the **base commit's tree**, so a
  characterization test this run added (absent on base) is *not* removed by the restore. G1
  therefore runs base tests plus this run's new tests together, which is strictly stronger than
  base tests alone. That is intended.
- The restore on the third line is not optional and not best-effort. Verify `status --porcelain`
  is empty afterwards. A run that proceeds with base test files still in the tree would commit
  them, silently reverting test changes that were never part of the finding.

**Pass:** the suite is green and the restore left the tree clean.

**Fail:** abort, ledger `blocked`, note naming the first failing test. No retry, ever.

**Tier rule.** At tier 1 a finding may not move or rename a test file, because base tests
restored over a moved source tree cannot resolve their imports. At tier 2 a finding may declare
a rename map, and the restore step rewrites **import paths only** — nothing else — in the
restored base tests. Any other edit to a restored file voids the gate.

---

## §4 G2 — Characterization gate

**Conditional, and mandatory exactly when G1 is weakest.**

Decide `<covered>` first, mechanically: does any file matching `commands.test_globs` reference
the finding's target files — by import path, by module specifier, or by the symbols they export?

```bash
git -C "<WT>" grep -l -E "<target module basenames|exported symbols>" -- <commands.test_globs>
```

**The coupling rule, and the sharpest point in the whole suite:** G1 is only meaningful if the
target code is actually exercised. On uncovered code the existing suite passes whatever the
refactor did, so G1 returns a green that means nothing. Therefore:

- `<covered>` **true** → G2 is optional. Run it when the finding's `behavior_risk` is `low`.
- `<covered>` **false** → G2 is **required**. A run that cannot produce passing characterization
  tests for uncovered target code **aborts before implementing**. Uncovered code is not tidied
  blind.

**Procedure.** The run's *first* commit adds characterization tests and nothing else. They
record what the code does **today** — including boundaries: zero, negative, empty, absent,
maximum. They are not aspirational and they do not assert what the code should do.

Verify them against the untouched original, before any source edit:

```bash
# on a tree whose source is still at <BASE_SHA>, with only the new test files added
cd "<WT>" && <commands.test>
```

**Pass:** every new characterization test passes on base, unmodified.

**Fail:** abort before implementing. A characterization test that fails on base is simply
wrong — it describes behavior the code does not have — and nothing built on it can be trusted.

**Why this makes agent-written tests usable here.** The agent is not judging what the code
*should* do; it transcribes what the code *does*, and the transcription is checked against the
original. Transcription is a far narrower task than specification, and it has a mechanical
verifier. That is the entire trust argument.

**The limit, stated rather than hidden.** Characterization tests cover only the inputs someone
thought of. They are not a proof, and behavior can still differ on untested inputs. They convert
*"the diff looks safe"* into *"the diff is safe for the inputs we know"* — the increment this
loop needs, and no more. Gate G6 is what later measures whether those tests would actually
notice a fault.

**In the suite**, G2 re-confirms: the characterization tests still pass after implementation.
They already ran inside G1; this step exists to report them separately in the brief, because a
reviewer wants to see the count.

---

## §5 G3 — Project checks

```bash
cd "<WT>" && <commands.lint>
cd "<WT>" && <commands.typecheck>
cd "<WT>" && <commands.test>
cd "<WT>" && <commands.build>
```

Each null command is skipped and reported as skipped, never as passed. The brief's evidence
table distinguishes the two, because "we did not check" and "we checked and it was fine" are
different statements to a reviewer.

**Pass:** every non-null command green.

**Fail:** the one place the retry doctrine in §1 applies. Two fix attempts, then abort; after
any fix the suite restarts from G5.

---

## §6 G4 — Public surface gate

Skipped when `surface_oracle` is empty, and reported as skipped.

The comparison needs base artifacts. Build them in the **loop clone**, which is already on base
and already installed — no second install, no second worktree:

```bash
cd "<CLONE>" && <commands.build>
# hash every surface_oracle match in <CLONE>, then every match in <WT>
find "<CLONE>" -path "<each surface_oracle glob>" | sort | xargs shasum -a 256
find "<WT>"    -path "<each surface_oracle glob>" | sort | xargs shasum -a 256
```

Compare the relative-path-keyed digests, not the raw output — the absolute paths differ by
construction.

**Pass:** identical sets of relative paths, and identical digests for every one.

**Fail:** abort, ledger `blocked`, note naming each differing artifact. A changed published
surface is not a structure-only change, whatever the diff looks like.

**What this gate is worth.** On a repo whose shared boundary is an emitted artifact, an
identical surface is strong, nearly free evidence that a change is internal. It catches the
class G1 misses: a widened type, a dropped optional field, a renamed export that every existing
test happens to tolerate.

---

## §7 G6 — Mutation gate

Tier 2 and above, and only when `commands.mutation` is set. Skipped otherwise, reported as
skipped.

Run it scoped to the touched files, on base and on the branch, and compare surviving mutants.

**Pass:** the surviving-mutant count for the touched files does not increase versus base.

**Fail:** abort, ledger `blocked`.

**Why it belongs in this suite specifically.** Coverage says a line ran; mutation says a test
would notice if the line were wrong. Tests written by a model can be coverage-positive and
assertion-empty — a documented failure mode, at a material rate — and this is the only check in
the suite that detects it. It is off at tier 1 purely on runtime cost, which is why tier 2
expects it before caps are widened.

---

## §8 G7 — Smoke

Runs when `commands.smoke` is set. Skipped otherwise, reported as skipped.

```bash
cd "<WT>" && <commands.smoke>
```

**Pass:** green. **Fail:** abort, ledger `blocked`.

The command must not require a fixed-port server. A server already listening from another
checkout answers the check, nothing under test boots, and the gate reports a green it never
earned. A false green is the worst outcome available to this system, so such a command is
rejected at setup rather than tolerated here.

---

## §9 G8 — Architecture gate

**The quality oracle, and the only gate that can say the change was not worth making.** Runs
last, only once everything above is green.

Spawn the `tidy-architect` agent. Its brief carries:

1. **The finding** — what the change claimed it would improve.
2. **The diff** — `git -C "<WT>" diff "<BASE_SHA>...HEAD"`.
3. **The project root** — `<WT>`, not the clone root. An architect handed the right diff and a
   root pointing at a tree without the change reads files that contradict the hunks and returns
   confident nonsense.
4. **The glossary and the decision records** — paths, so it reads them itself.
5. **The category allowlist**, so it knows what the change was permitted to be.

It answers five questions — depth, seam reality, naming, recorded decisions, conventions — and
returns a single verdict plus a one-line summary for the brief.

**Pass:** `verdict: pass`. Carry `one_line` into the evidence table verbatim.

**Fail:** abort. Ledger `blocked` normally, `escalated` when the agent sets `escalate: true`
because a recorded decision was contradicted — reopening a decision is a human call, never an
unattended one.

**Never retry a failed G8 by re-implementing.** That is the loop rewriting its work until the
judge approves, which converts the one judgement gate into a filter the loop optimizes against.
A failed G8 ends the run, and the finding is recorded so the next run does not re-propose it
blind.

G8 runs at every tier, including tier 0, where it judges the written proposal rather than a diff
and its verdict is reported rather than gating anything.

---

## §10 The evidence table

Every gate contributes one row to the brief, with three possible states — **pass**, **skipped
(reason)**, or the run aborted here. A skipped gate is never rendered as a pass. The table is
the reviewer's whole basis for trusting a diff they did not read line by line, so its honesty
is the product.

| gate | row |
| --- | --- |
| G5 | `diff caps · <lines> lines / <n> substantive files / <m> import-only files` |
| G1 | `base-test · tests from <BASE_SHA> · pass` |
| G2 | `characterization · <n> added · passing on base` or `not required (target covered)` |
| G3 | `lint · typecheck · test · build` with per-command state |
| G4 | `public surface · identical` or `skipped (no surface oracle declared)` |
| G6 | `mutation · no new survivors` or `skipped (tier 1)` |
| G7 | `smoke · pass` or `skipped (none declared)` |
| G8 | `architecture · <one_line>` |
