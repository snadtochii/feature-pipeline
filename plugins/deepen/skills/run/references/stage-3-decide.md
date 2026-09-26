# Stage 3 — decide

Authoritative text for the stage that turns the picked candidate and the inventory summary into an
approved decision record: it asks the human one question at a time about the change, drafts the
glossary and ADR edits as proposed diffs, writes the record, and has the read-only
architect judge it — proposing a sequence of pull requests when the change is large. The stage
writes to no working tree and never reads the checks; it either completes, completes declined,
stops for a human decision, or aborts.

It composes these references and restates none of them:
[decision-record.md](decision-record.md) owns the record's sections, line formats, value classes
and size measure; [candidates.md](candidates.md) the `## Pick` block; [inventory.md](inventory.md)
the statement line; [worktree.md](worktree.md) the run worktree's names; and the run skill
([../SKILL.md](../SKILL.md)) the report grammar, the question, the pause and the common abort.

---

## Inputs and output

Bound by the run skill before this stage starts:

| Input | Source |
| --- | --- |
| `<CLONE>`, `<BASE_SHA>`, `<state_dir>`, the profile as re-read | [preflight.md](preflight.md) §1–§4 |
| `<run-id>`, `<slug>`, `<plugin-root>`, `candidate_id` | the run state, `<state_dir>/runs/<run-id>/run-state` |
| the `## Pick` block | `<state_dir>/reports/<run-id>/1-discover.md` ([candidates.md](candidates.md) §5) |
| the `## Inventory summary` section, and only it | `<state_dir>/reports/<run-id>/2-characterize.md` |
| the source, `CONTEXT.md`, `docs/adr/` | `<CLONE>`, on `base` at `<BASE_SHA>` |

`<inventory>` is `paths.inventory`; `<runs>` is `<state_dir>/runs/<run-id>`; `<report>` is
`<state_dir>/reports/<run-id>/3-decide.md`.

**Nothing else is read.** Not the checks, not the inventory file, not the rest of
`2-characterize.md`, not `<state_dir>/inventory-drafts/`, not anything under `<inventory>` at
`<CLONE>` — earlier runs' merged inventories included — and no file under `<WT>`: the stage runs
two `git` reads against the worktree (§1, §11) and opens nothing in it. `<CLONE>` does not hold
this run's inventory commit, which lives only on the run branch.

Earlier runs' inventories are committed on `base`, so a source lookup at `<CLONE>` can reach them.
Every `Grep` at `<CLONE>` — §1's checks, §5's default lookups, the `surviving` search — carries
the exclusion glob `!<inventory>**`, and a path under `<inventory>` that a `Glob` returns is
dropped, never opened.

Output: the report `<report>` (§12); the record `<state_dir>/reports/<run-id>/decision-record.md`
([decision-record.md](decision-record.md) §1); `<runs>/inventory-summary.md`,
`<runs>/architect-brief.md` and `<runs>/decide-wt-snapshot`. The stage writes nothing else — no
source, no spec, no `CONTEXT.md`, no ADR in the repository. §11 asserts it.

Every stop in this stage is one line: an abort (`decide: aborted — <the line>`) goes through the run
skill's common abort, which removes the worktree stage 2 created; a question
(`decide: needs-decision — Q<n> <field>: <question>`) goes through the run skill's §5.

---

## §0 Re-entry

Re-bind from the run state (the run skill's §0). When the report exists, read only what routing
needs, never the whole report: its status line (`Read`, first line), and one `Grep -n` over it
for `^(Q[0-9]+ \||A[0-9]+ \||decision: |### Round )` — the ledger, the answers, the decisions and
the architect rounds. Any other section — `## Options`, `## Split`, a `### Q<n>` block under
`## Drafts` — is read bounded to itself, only by the step that needs it: a re-asked question its
own options, §5 a default drawn from a draft, §6 the drafts its assembly takes, §7 the split
check.

- **No report** → a fresh stage: §1.
- **Status `complete`, `complete — declined` or `aborted`** → the stage already ended; return
  without touching anything.
- **Status `needs-decision`** → the status line names `Q<n>` and its field. Answers pair with
  questions by count, never by position in the file: every question gets exactly one
  `decision:` line once answered, a pause writes none (the run skill's §5), and the stage asks the
  next question only after the previous one's answer — so the `k`-th `decision:` line under
  `## Decisions` answers `Q<k>`. Count them as `<d>`:
  - `<d>` is `<n> - 1` — `Q<n>` is unanswered, a pause recovered by hand → ask `Q<n>` again: the
    same status line and `## Options`, and return.
  - `<d>` is `<n>` → the last `decision:` line is `Q<n>`'s answer. Append `A<n> | <the answer>`
    under `## Answers` with `Edit`, unless an `A<n>` line is already there, and continue at the
    section that owns the field (§4's field table) — §1's re-entry reads run first; §2 and §3 do
    not.
  - any other count → `decide: aborted — <d> decisions recorded for Q<n>; answers and questions
    are out of step`.

A re-entry never re-invokes the skills of §3, never re-asserts §2 over a summary already on disk,
and never re-takes a snapshot that exists. The
report keeps every earlier `## Questions`, `## Answers` and `## Decisions` line.

---

## §1 Bind and read

1. **Name `<WT>` and `<branch>`** per [worktree.md](worktree.md) §1, and check the worktree
   read-only: `git -C "<CLONE>" worktree list --porcelain` lists `<WT>` on `refs/heads/<branch>`.
   The stage never creates or re-attaches it — that is the implement stage's
   ([worktree.md](worktree.md) §3). Absent → the `## Degradations` line
   `worktree absent — the implement stage re-attaches it; worktree comparison skipped`, once, and
   §11 compares only `<CLONE>` on that entry.
2. **Snapshot**, when the worktree is present and `<runs>/decide-wt-snapshot` is absent:

   ```bash
   { git -C "<WT>" rev-parse HEAD; git --no-optional-locks -C "<WT>" status --porcelain -z --no-renames --untracked-files=all; } \
     > "<runs>/decide-wt-snapshot"
   ```

   It is what §11 compares the worktree against at every exit.
3. **The pick.** `Grep` `^## Pick$` with line numbers over `1-discover.md`, then a bounded `Read`
   of the nine lines after it. A field missing or out of its [candidates.md](candidates.md) §7
   class → `decide: aborted — 1-discover.md carries no valid pick`. On the fresh pass only, `Glob`
   each of its `files` at `<CLONE>`; any absent →
   `decide: aborted — picked files missing at <BASE_SHA>: <paths>`. §11 keeps `<CLONE>` unchanged
   after that, so a re-entry does not repeat the check.
4. **The inventory summary.** On the fresh pass: `Grep` `^## ` with line numbers over
   `2-characterize.md`, then one bounded `Read` from the `## Inventory summary` line to the line
   before the next heading — never the whole report. No such heading →
   `decide: aborted — 2-characterize.md has no inventory summary`. Write the section's text
   verbatim to `<runs>/inventory-summary.md` with `Write`, then §2. On a re-entry the summary is
   that file, already asserted: `Read` it when a step needs it — §5's `predicted` default, §6's
   `before` check, §7's brief — and never `2-characterize.md` again.

---

## §2 Isolation

The checks are the run's oracle; the stage that shapes the change must not see them. On the
fresh pass, right after §1 writes it, three assertions over `<runs>/inventory-summary.md`, in one
`Bash` call:

```bash
grep -nE 'T[12]-[0-9]{2,3}' "<runs>/inventory-summary.md"
grep -nF "<inventory><slug>/" "<runs>/inventory-summary.md"
grep -nE '^[[:space:]]*(```|~~~)' "<runs>/inventory-summary.md"
```

Any output is a hit → `decide: aborted — inventory summary carries <the first matching line>`.
The summary is plain lines by its producer's contract
([stage-2-characterize.md](stage-2-characterize.md) §9 item 4), so a fenced block in it is check
material, never formatting. `<inventory>` and `<slug>` have passed their profile and [worktree.md](worktree.md) §1 classes.

`## Isolation` in the report records each assertion and its result, and this line, verbatim:
`limit: the characterize stage ran earlier in this conversation — these assertions cover what the
decide stage loads and what it hands the architect, not earlier turns`. §7 asserts the
architect's brief the same way.

---

## §3 Skills and project records

On the fresh pass only:

1. **`grilling`.** Invoke the `Skill` tool with `mattpocock-skills:grilling`. The stage keeps its
   discipline — walk the decision tree branch by branch, give a recommended answer with every
   question, look facts up rather than ask them — and overrides two things: the cadence is one
   question per stop, depth-first on coupled fields (§4, §5), never a round of several; and facts
   are looked up by the stage itself with `Read`, `Grep` and `Glob` at `<CLONE>`, never by a
   spawned helper. The question tree is §5's in either case. The call failing, or the skill not
   installed → `grilling unavailable — inline dialogue used the stage's own question list`.
2. **Project records.** `Glob` `<CLONE>/CONTEXT.md` and `<CLONE>/docs/adr/*`. Each one absent →
   the line naming what it does to this stage — [profile.md](../../setup/references/profile.md)
   §6 rows 11 and 12 are the earlier stages' effects, not this one's:
   - `CONTEXT.md absent — terms are proposed for a new file; the human decides whether to create
     it` (§5, field `create-context`);
   - `docs/adr/ absent — no recorded decision to supersede; a proposed ADR is numbered 0001` (§5,
     field `diffs`).

`domain-modeling` is invoked later, at the terms question (§5, field `terms`).

Every line this section produces goes under `## Degradations`.

---

## §4 The question ledger

Every question the stage asks is a ledger entry on disk before the stop, and every answer is on
disk before the next question — so a pause, a resumed conversation or an abort loses nothing.

**Entry.** Before each stop, append under `## Questions` with `Edit`:

```
Q<n> | <field> | <question> | default: <answer> — <rationale>
```

`<n>` counts from 1 across the whole stage — grilling questions, the rewrite, create, architect,
split and decline questions alike — so numbering never drifts. `<question>` is one line; a `|` in
any part is written `/`. Material too long for one line — a spec classification, a drafted diff —
goes under `## Drafts` as `### Q<n>`, is printed to the conversation just before the stop, and the
question names it (`see Drafts Q<n>`).

**Stop.** The status line becomes `decide: needs-decision — Q<n> <field>: <question>`, and
`## Options` is rewritten:

- `- accept — <the default>` first;
- up to two alternatives the stage derived from the code, each `- <label> — <what it does>`;
- nothing else: the run skill adds `abort`, and a free-text answer is always possible.

§11 runs before the stop is returned to the run skill.

**Answer.** On re-entry (§0), the answer is `A<n>`: `accept` means the default, another label its
alternative, anything else the human's own text. Newlines in a `decision:` line are already
flattened to ` / ` by the run skill. An answer that fails its field's class
([decision-record.md](decision-record.md) §3) is asked again as a new question on the same field,
the default unchanged and the reason appended to the question. The field's current value is its
latest valid answer — unless a `revise` (§8) or `confirm` (§9) answer newer than it reopened the
field, which then has no current value until it is answered again.

**No defaults are applied silently.** Every field is asked; a profile or an earlier run never
answers for the human.

| Field | Owner | Record section ([decision-record.md](decision-record.md) §2) |
| --- | --- | --- |
| `interface` | §5 | Interface shape |
| `seam` | §5 | Behind the seam |
| `surviving` | §5 | Surviving tests |
| `rewrite` | §5 | Spec delete list |
| `delete` | §5 | Spec delete list |
| `rename` | §5 | Rename map |
| `new-specs` | §5 | New specs |
| `terms` | §5 | Terms |
| `create-context` | §5 | Proposed CONTEXT.md and ADR diffs |
| `diffs` | §5 | Proposed CONTEXT.md and ADR diffs |
| `predicted` | §5 | Predicted changed statements |
| `estimate` | §5 | Estimated diff lines |
| `next` | §5 | Named next change |
| `architect` | §8 | — |
| `split` | §9 | — |
| `decline` | §10 | — |

---

## §5 The question tree

Asked in this order, one per stop. Before each question, read what its default needs from
`<CLONE>` and the summary; every default carries a one-line rationale. The fields are coupled: a
later default derives from earlier answers, and an answer that invalidates a field already
answered — a rename that moves a spec the surviving-tests answer called unchanged, an interface
that no longer hides what the seam answer says, an interface that introduces a module the
new-specs answer has no path for — asks that field again, depth-first, before the tree moves on.
Two questions are conditional: `rewrite` is raised by a `surviving` answer and
`create-context` by a `terms` answer, and each is pending while the answer that raised it is newer
than its own latest answer. On re-entry, a pending conditional question is asked first; otherwise
the next question is the first of the eleven fields below with no current value.

1. **`interface`** — the new interface: what callers call, with what, and what they get back.
   Default: the shape the pick's `files`, `structural_key` and `category` suggest at the seam their
   callers already cross. Alternatives: a narrower or a wider interface when the callers split.
2. **`seam`** — what sits behind the interface: the modules, state and dependencies it hides, and
   for a `remote-owned` or `true-external` category the port and its test adapter
   ([candidates.md](candidates.md) §2). Default: the modules, state and dependencies the pick's
   `files` hold behind the `interface` answer, with the port and test adapter the category calls
   for.
3. **`surviving`** — when `paths.specs` is empty, record `none` for this field, `delete` and
   `new-specs` without asking, with the line `spec questions skipped — paths.specs is empty`.
   Otherwise `Grep` the `paths.specs` globs at `<CLONE>` for specs that import or mock any of the
   pick's `files`, and classify each: `unchanged`, `repointed` (by a rename entry), `delete` (it
   tests a module the change removes and the inventory covers its behavior), or `rewrite` (its
   assertions need rewriting — neither a rename nor a deletion). The classification is the
   default, under `## Drafts`. An answer with any `rewrite` asks **`rewrite`** next:
   `Q<n> rewrite: <k> specs need rewritten assertions — delete them for a human rewrite on the pull
   request, or narrow the candidate?`, options
   `- accept — delete those specs now; the human rewrites them on the pull request` and
   `- narrow — re-open the interface shape to avoid the rewrite`. `accept` puts each on the delete
   list as `<path> | rewrite | <reason>`; `narrow` asks `interface` again with the rewrite as the
   reason, and the tree continues from there.
4. **`delete`** — the spec delete list: every `delete` spec from the classification, each with its
   reason, plus the accepted `rewrite` lines. Default: exactly those.
5. **`rename`** — the `rename_map:` block: `modules:` for every file that moves, `symbols:` for
   every exported name that changes, identity entries for symbols that move unrenamed, and each
   `repointed` spec's entry. Spec moves — a `modules:` entry whose old path matches a
   `paths.specs` glob — are named in the question. Default: the moves and renames the `interface`
   and `seam` answers imply, with identity entries for symbols that move unrenamed — an empty
   `rename_map:` when nothing moves.
6. **`new-specs`** — the declared spec paths, one per module the change introduces
   ([decision-record.md](decision-record.md) §2, `New specs`). When `paths.specs` is empty,
   record `none` without asking — on a re-ask too, whichever answer reopened the field. Default:
   one spec beside each new module the `interface` and `seam` answers name or imply, placed and
   suffixed like the existing specs that match `paths.specs` for the pick's files — or, when none
   of those files has a spec, like the spec matching `paths.specs` nearest to them in the tree
   (one exists: [profile.md](../../setup/references/profile.md) §4 rule 12) — a sibling
   `x.test.ts`, or a mirrored `tests/…/x.spec.ts` — and matching a `paths.specs` glob; `none`
   when the record adds no module. The inferred modules and their paths are drafted under
   `## Drafts`.
7. **`terms`** — invoke the `Skill` tool with `mattpocock-skills:domain-modeling` once per run, for
   its glossary rules and formats; the stage overrides its inline updates — `CONTEXT.md` is never
   edited here, every edit becomes a proposed diff (field `diffs`). The call failing, or the skill
   not installed → `domain-modeling unavailable — CONTEXT.md and ADR diffs drafted from the stage's
   own format notes`: a glossary entry is `**<Term>**: <definition>`, optionally followed by
   `_Avoid_: <aliases>`; an ADR is `docs/adr/<NNNN>-<slug>.md` with a title, the
   context, the decision and its consequences. Default: the terms the interface and seam answers
   introduce or change, against `<CLONE>/CONTEXT.md`. When `CONTEXT.md` is absent and the answer
   has terms, ask **`create-context`**: `Q<n> create-context: CONTEXT.md is absent — propose
   creating it with these terms?`, `accept` → the diffs field drafts it as a new file,
   `- no — record the terms without a CONTEXT.md diff` → the terms stay in the record only.
8. **`diffs`** — one unified diff per target against `<BASE_SHA>`, drafted under `## Drafts`, with
   the `targets:` line ([decision-record.md](decision-record.md) §2). `CONTEXT.md` carries the
   answered terms. An ADR is drafted only when domain-modeling's three-part test holds —
   hard to reverse, surprising without context, the result of a real trade-off — numbered one above
   the highest `<CLONE>/docs/adr/[0-9][0-9][0-9][0-9]-*.md`, or `0001` when there is none. A pick
   whose `adr_conflict` is not `none` names that decision in the question, and the default says
   whether a new ADR supersedes it. Default: the drafted diffs and their `targets:` line —
   `targets: none` when no term and no decision changes.
9. **`predicted`** — the inventory statements the change is expected to alter, each
   `<statement-id> | before: <then> | after: <expected then>`, from the summary's statement lines.
   Default: the statements whose `<then>` the interface answer changes — for a pure deepening,
   `none`. A statement on the summary's unverifiable list may be predicted with ` (unverifiable)`.
10. **`estimate`** — one integer in [decision-record.md](decision-record.md) §4's measure.
    Default: the pick's `est_diff_lines`, adjusted for the spec deletions, the new specs and the
    proposed diffs the explorer did not know about, with the adjustment in the rationale.
11. **`next`** — the named next change the deepening makes cheaper; the architect's premise.
    Default: the pick's `next_change`.

Every field answered → §6.

---

## §6 The record

Assemble `decision-record.md` from the fields' current values, in
[decision-record.md](decision-record.md) §2's order: `Candidate` from the `## Pick` lines (plus the
`- slice:` line after a confirmed split, §9), each other section from its field (§4's table).
Check every value against [decision-record.md](decision-record.md) §3, and the cross-section rules
of its §2: every spec move's new path matches a `paths.specs` glob, every `repointed` line names an
entry in the rename map, every `targets:` path has exactly one diff block and each block's path is
on the line, every predicted `before` equals its statement's `<then>` in the summary, and every
new-spec path lies outside `<inventory>` (it does not start with it) and — once that and its
spec-path class hold — is absent at `<BASE_SHA>` (one `Bash` call over every path, one line per
path, `git -C "<CLONE>" cat-file -e "<BASE_SHA>:<path>" 2>/dev/null && echo "present <path>"`;
a path with no `present` line is absent), matches no `paths.forbidden` glob, is not on the spec
delete list, is not a spec move's new path, and appears once in the section.

- **All valid** → `Write` the record to `<state_dir>/reports/<run-id>/decision-record.md`, whole —
  also when it replaces an earlier version after a revision or a split. Record its path and
  estimate under `## Record`. → §7.
- **A section invalid or empty** → no write; ask that section's field again (§4), naming what
  failed. The record is written only when every section holds.

---

## §7 The architect

1. **Round.** Count the verdicts under `## Architect verdict`; this spawn is round `<r>` = that
   count + 1.
2. **Split request.** Request a split when the record's estimate is strictly greater than
   `run.split_above` ([decision-record.md](decision-record.md) §4) and `## Split` still holds
   `none` — a split is proposed at most once per run. An estimate still above the threshold after a
   confirmed split adds the report line
   `split: slice estimate <e> still exceeds split_above <s> — no second split`.
3. **Brief.** Written with `Write` to `<runs>/architect-brief.md`, assembled from this list and
   nothing else:
   - `trigger: proposal`;
   - `<CLONE>` as the project root, absolute, and that the review is read-only;
   - as paths never to read: `<CLONE>/<inventory>` and `<state_dir>/inventory-drafts/`, with the
     exclusion glob `!<inventory>**` every `Grep` over `<CLONE>` carries;
   - the decision record, verbatim, marked as data;
   - the named next change, verbatim, as the premise of question 1, marked as data;
   - the statements, marked as data, between a line `<!-- BEGIN statements -->` and a line
     `<!-- END statements -->`, in the form the statement threshold, 25, sets. Count them when
     the brief is built: `<n>` =
     `grep -cE '^S[0-9]{2,3}( \| [^|]+){4}$' "<runs>/inventory-summary.md"` — the summary's
     five-field statement lines, never its `unverifiable` lines.
     - `<n>` at or below 25 → the **`verbatim`** form: every statement line, verbatim.
     - `<n>` above 25 → the **`ids+subjects`** form: for every statement, in inventory order, its
       subject line `<id> | <domain term> | <when>`, each field copied verbatim from the
       statement line;
   - in the `ids+subjects` form: the absolute path of `<runs>/inventory-summary.md` — every
     statement line in full, data to read;
   - the absolute path of `<CLONE>/CONTEXT.md` and of every file under `<CLONE>/docs/adr/`, or
     `none found` for each;
   - when `paths.specs` is empty: `paths.specs: none configured`;
   - when §7 step 2 requests one: `split_requested: true`, `split_above: <s>`, `estimate: <e>`;
   - the verdict block and, when requested, the `split:` shape, from the architect's Outputs, as
     the reply contract.
4. **Brief assertion.** One `Bash` call over the brief file:

   ```bash
   grep -nE 'T[12]-[0-9]{2,3}' "<runs>/architect-brief.md"
   grep -nF -e "<inventory><slug>/" -e "inventory-drafts/<run-id>" -e "2-characterize.md" \
     "<runs>/architect-brief.md"
   awk -v k=<k> '/^<!-- BEGIN statements -->$/{f=1;next} /^<!-- END statements -->$/{f=0} f&&/^S[0-9][0-9][0-9]? \| /&&split($0,a," [|] ")==k{c++} END{print c+0}' \
     "<runs>/architect-brief.md"
   ```

   `<k>` is the field count of the form step 3 took — 5 for `verbatim`, 3 for `ids+subjects` — so
   a statement line in the other form is not counted. Any output from the two `grep`s →
   `decide: aborted — the architect brief carries <the first matching line>`. A count from the
   `awk` other than `<n>` → `decide: aborted — the architect brief carries <c> of <n> statements
   in the <form> form`. The results, and the line `brief: verbatim` or
   `brief: ids+subjects, <n> statements` naming the form step 3 took, join `## Isolation`, one
   set per round.
5. **Spawn** one `deepen:architect`, a fresh instance, in the foreground, whose prompt is the
   brief file's content.
6. **Validate** the reply's verdict block, line by line: `verdict` is `pass` or `fail`; `escalate`
   is `true` or `false`; `option_value`, `completeness`, `decisions` and `intent` start with `pass`
   or `fail`; `ch9` starts with `pass`, `fail` or `n/a`; `one_line` and `notes` are present. A
   `verdict: pass` with any question starting `fail` is read as `fail` — never as a pass. Clean
   every value before it is written: strip carriage returns, line feeds and every other C0
   control character, write `|` as `/`, strip ` · `, collapse runs of whitespace to one space,
   and cut to 200 characters.
7. **No verdict.** A spawn that fails, or a reply with no valid block → one re-spawn from the same
   brief; a second failure → `decide: aborted — architect returned no verdict block`. Silence from
   the judge is never a pass.
8. **Record** the cleaned block under `## Architect verdict` as `### Round <r>`, and the `split:`
   lines, when present, beside it. → §8.

The validated verdict lives in the report, never in the record.

---

## §8 Verdict

- **`pass`** → §9.
- **`fail`** → a stop on the field `architect`:
  `Q<n> architect: the architect failed the record — <one_line>`, the failing questions and
  `escalate` under `## Drafts` as `### Q<n>`, with the options
  - `- revise — re-open the questions the failing checks map to`
  - `- proceed — override the verdict; recorded in the report`
  - `- decline — end the run and record the candidate as declined`

  When `## Architect verdict` already holds three rounds, `revise` is not offered.

On the answer:

- **`revise`** reopens the fields the failing questions map to — `option_value` → `next` and
  `interface`; `ch9` → `interface` and `seam`; `completeness` → `rename`, `surviving`, `delete`
  and `new-specs`; `decisions` and `intent` → `interface` and `seam`. A reopened field has no current
  value until an answer newer than this one, so §5 asks it again, in its order, with its previous
  answer as the default and the architect's reason in the rationale; then §6 rewrites the record
  and §7 takes the next round.
- **`proceed`** → the line `architect: fail — overridden by the human` under the round, with the
  `decisions` or `intent` reason quoted when `escalate` was `true`. → §9.
- **`decline`** → §10.
- **Free text** → read as `revise`, the text carried to the reopened questions as a hint — while
  `revise` was offered. After three rounds it was not, so free text asks the same question again
  with `proceed` and `decline` only.

---

## §9 Split

- **No split requested this round** → the stage completes: §11, then the status line
  `decide: complete`.
- **Requested**, and the reply's `split:` block is valid — two or more lines numbered from 1 in
  order, each `<n>. <title> | files: <paths> | statements: <ids or none> | est: <integer>`, every
  file among the pick's `files`, the rename map's paths, the spec lines, the new-spec paths and the
  `targets:` line,
  every statement id in the summary → write the sequence under `## Split`, replacing its `none`,
  and stop on the field
  `split`: `Q<n> split: the estimate <e> exceeds split_above <s> — build slice 1 of <N> in this
  run?`, with the options
  - `- confirm — this run builds slice 1: <title>`
  - `- override — build the whole record as one pull request`
- **Requested, and the block is absent, malformed or `split: none — <why>`** → `## Split`'s `none` is
  replaced by `split: architect proposed no valid sequence — the record stays whole`, with the architect's
  reason when it gave one, and the stage completes as above. A split never rejects a candidate.

On the answer:

- **`confirm`** narrows this run to slice 1: reopen `interface`, `seam`, `surviving`, `delete`,
  `rename`, `new-specs`, `terms`, `diffs`, `predicted` and `estimate` (§8's reopen rule), each default derived
  from slice 1's files and statements — the terms and diffs only those slice 1's code carries, so
  no glossary or ADR text lands ahead of the code it describes; §6 rewrites the record with `- slice: 1 of <N> — <title>` under
  `Candidate`; §7 takes one more round, without a split request. Later slices are pinned by hint in
  later runs; `## Split` keeps the whole sequence for them.
- **`override`** → the line `split: overridden — one pull request` under `## Split`; the stage
  completes as above.
- **Free text** → the same question again with the same options.

---

## §10 Decline

Stop on the field `decline`: `Q<n> decline: why is this candidate declined?`, with the one option
`- no reason — decline without one`. A free-text answer is the reason.

On the answer, flatten the reason to one line with `|` written `/` — `no reason` when that option
was taken — and complete declined: §11, then the status line `decide: complete — declined` with
`declined: <reason>` directly under it. The record stays as last written. The run skill routes a
declined run to the deliver stage, which records the decline in `memory.md`
([memory.md](memory.md) §6) and opens no pull request.

---

## §11 Tree assertion

Before every exit that leaves the stage for the run skill — `complete`, `complete — declined` and
every `needs-decision` stop — one `Bash` call:

```bash
git --no-optional-locks -C "<CLONE>" status --porcelain -z --no-renames | tr '\0' '\n'
git -C "<CLONE>" rev-parse HEAD
{ git -C "<WT>" rev-parse HEAD; git --no-optional-locks -C "<WT>" status --porcelain -z --no-renames --untracked-files=all; } \
  | cmp - "<runs>/decide-wt-snapshot" && echo "wt: unchanged"
```

It holds when `<CLONE>`'s status is empty, its `HEAD` is `<BASE_SHA>`, and the worktree matches
the snapshot (`wt: unchanged`). With the worktree absent on this entry, or no snapshot taken yet
(§1), the worktree half is not run. Anything else →
`decide: aborted — stage 3 wrote to <CLONE | WT>: <the paths or the HEAD that differ>`.

---

## §12 Report

`<report>`, standing alone for a reader who did not watch. Written with `Write` when the stage
first reaches a status; later a re-entry rewrites the status line and `## Options` with `Edit` and
appends to the other sections.

1. The status line ([../SKILL.md](../SKILL.md) §3's grammar).
2. `declined: <reason>` directly under it, when the status is `complete — declined`.
3. `## Degradations` — every line of §1, §3 and §5, or `none`.
4. `## Isolation` — §2's and §7's assertions and results, each round's `brief:` line, and the
   limit line.
5. `## Questions` — the ledger entries (§4).
6. `## Answers` — the `A<n>` lines (§0).
7. `## Drafts` — the `### Q<n>` material, or `none`.
8. `## Architect verdict` — every round, with its override line when one was taken, or `none`.
9. `## Split` — the sequence and its outcome, or `none` until §9 first writes it (§7 step 2 reads
   the `none` as "no split proposed yet").
10. `## Record` — the absolute path of `decision-record.md` and its estimate, once written.
11. `## Options` — when the status is `needs-decision`.
12. `## Decisions` — appended by the run skill.
