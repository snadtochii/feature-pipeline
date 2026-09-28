# The decision record

Authoritative contract for `decision-record.md`, the approved shape of one run's change: where it
lives, its sections in their fixed order, the line each section holds, the value classes checked
before it is written, the one measure of a change's size, and which stage reads which section.

- **Written by** the decide stage alone ([stage-3-decide.md](stage-3-decide.md) §6), and only
  once every section validates (§3).
- **Read by** the architect, verbatim, in both of its briefs
  ([agents/architect.md](../../../agents/architect.md)); by the implement stage
  ([stage-4-implement.md](stage-4-implement.md)) — verbatim in the implementer's brief, section
  by section in its pre-spawn target check, its spec-mover brief and its spec-author brief; by
  the verify stage ([stage-5-verify.md](stage-5-verify.md)), which matches the inventory's `changed` statements against the
  predictions and judges the diff against the named next change; and by the deliver stage
  ([stage-6-deliver.md](stage-6-deliver.md) §4), which lists the record in the evidence pack.

The record is written with `Write` and read with `Read`. Its paths — the spec paths, the spec
moves' destinations, the new-spec paths, section 3's absorbed-site paths, section 11's site paths
and the `targets:` paths — do reach a command line, as values in the decide stage's absent-at-base
probe of each new-spec path and its present-at-base probe of each site and absorbed-site path
([stage-3-decide.md](stage-3-decide.md) §6), in
the implement stage's pre-spawn fence probe
([stage-4-implement.md](stage-4-implement.md) §2), in its absent-at-base check of each new-spec
path after the spec-author returns ([stage-4-implement.md](stage-4-implement.md) §4), and in the
spec-mover's moves and deletions; §3's closed path classes are what keep them data. Nothing else
in it — the answers, the prose, the diffs — reaches a command line.

---

## §1 Location and writes

`<state_dir>/reports/<run-id>/decision-record.md` — the run's report directory
([profile.md](../../setup/references/profile.md) §5), which lies outside every fenced role's reach
([fence.md](fence.md) §1), so no role can alter the record it implements.

The decide stage writes the whole file once every section validates, and rewrites it whole when a
revision or a confirmed split changes an answer. It is never appended to or edited in place, and
no other stage writes it.

---

## §2 Sections

One `## <name>` heading per section, in exactly this order, each present and non-empty. A list
section with no entries holds the literal line `none`.

| # | Section | Holds |
| --- | --- | --- |
| 1 | `## Candidate` | the discover report's `## Pick` lines ([candidates.md](candidates.md) §5), verbatim; plus `- slice: <k> of <N> — <title>` when a confirmed split narrowed the run |
| 2 | `## Interface shape` | prose: the new interface — what callers call, with what, and what they get back; optionally one fenced block of signatures |
| 3 | `## Behind the seam` | prose: what the interface hides — the modules, state and dependencies that move behind it; then one `absorbs: <path>:<line> — <what moves behind the interface there>` line per site the seam takes in, at least one |
| 4 | `## Surviving tests` | one line per existing spec that imports the candidate's files and survives: `<spec path> \| unchanged`, or `<spec path> \| repointed — <old> -> <new>` naming the rename-map entry that repoints it; or `none` |
| 5 | `## Spec delete list` | one line per spec the change deletes: `<spec path> \| delete \| <reason>`, or `<spec path> \| rewrite \| <reason>` for a spec whose assertions a human rewrites on the pull request; or `none` |
| 6 | `## Rename map` | a `rename_map:` block, below |
| 7 | `## Terms` | one `**<Term>**: <definition>` line per glossary term the change adds or changes, each optionally followed by an `_Avoid_: <alias>, <alias>` line; or `none` |
| 8 | `## Proposed CONTEXT.md and ADR diffs` | a `targets: <path>, <path>` line, then one fenced `diff` block per target; or `targets: none` and no block |
| 9 | `## Predicted changed statements` | one line per inventory statement the change is expected to alter, below; or `none` |
| 10 | `## Estimated diff lines` | one integer, in §4's measure |
| 11 | `## Named next change` | the change line — one line: the change this deepening makes cheaper, the architect's premise; then one `sites: <path>:<line> — <what the change edits there today>` line per site the seam absorbs, at least two; then one `excluded: <path>:<line> — <reason>` line per site the seam leaves outside it, or none — the lines obey the site rule below |
| 12 | `## New specs` | one repo-relative path per line — the unit spec the change adds for a module it introduces, below; or `none` |

**Site rule.** Sections 1, 3 and 11 name sites as `<path>:<line>` strings, and those strings are
compared exactly — never by file path alone. Across the three sections:

- every `sites:` line's `<path>:<line>` equals an `absorbs:` line's in section 3;
- every `excluded:` line's `<path>:<line>` has no `absorbs:` line in section 3;
- every distinct site on section 1's `- next_sites:` line — its entries split on ` | ` — appears in
  section 11 exactly once, as a `sites:` line or an `excluded:` line.

The rule runs from section 11 toward section 3 only: an `absorbs:` line whose site the named next
change does not edit is allowed, since a seam may take in more than one change touches.

**Rename map.** The block is the implementer's reply format
([agents/implementer.md](../../../agents/implementer.md), Outputs), byte for byte, so the declared
map and the implementer's reply compare line by line:

```
rename_map:
  modules:
    src/old/path.ts -> src/new/path.ts
  symbols:
    oldName -> newName
```

Either subsection may be empty — its heading written with nothing under it; the block itself is
always present. A symbol that moves to another file without a rename carries an identity entry
(`clamp -> clamp`). A `modules:` entry whose old path matches a `paths.specs` glob is a **spec
move**: its new path must match a `paths.specs` glob too, and it is applied by the spec-mover, not
the implementer.

**Proposed diffs.** Each block is a unified diff against `<BASE_SHA>`, headed `--- a/<path>` and
`+++ b/<path>`, or `--- /dev/null` and `+++ b/<path>` for a file the change creates. Every path on
the `targets:` line has exactly one block and every block's path is on the `targets:` line. The
implementer applies them in the implement stage; the decide stage writes to no tree.

**Predicted changed statements.** One line per statement:

```
<statement-id> | before: <then> | after: <expected then>
```

`<statement-id>` is a statement in the characterize stage's inventory summary; `before` is that
statement's `<then>` ([inventory.md](inventory.md) §1), verbatim; `after` is what the statement
will observe once the change lands. A statement on the summary's unverifiable list may be
predicted, with ` (unverifiable)` appended to its line. The verify stage treats a `changed`
statement that is listed here as intended, and one that is not as a regression.

**New specs.** One path per line, each the unit spec for one module the record introduces. A
module is introduced when it is a source file absent at `<BASE_SHA>` that section 2 or 3 names or
implies; a `modules:` destination in the rename map is a move, not an introduction. A module with
runtime behavior gets one spec; a module that only declares types or interfaces needs none. With
an empty `paths.specs` the section is `none`: the project has no spec globs, so no module needs a
declared spec. The section is a heading section of its own, never a line inside the
`rename_map:` block, which stays the implementer's reply format byte for byte. Across sections,
each path:

- matches no `paths.forbidden` glob;
- is not on the spec delete list (section 5);
- is not a spec move's new path in section 6;
- appears once in the section.

The implement stage's `deepen:spec-author` role writes the declared files.

---

## §3 Value classes

Checked by the decide stage on every section before the file is written. A value outside its
class is not written: the section's question is asked again with the reason.

| Value | Class |
| --- | --- |
| a spec path (sections 4, 5, 12) | `^[A-Za-z0-9._@+()\[\]/-]+$`; repo-relative; matches a `paths.specs` glob; no leading `/`, no `..` segment, no segment starting with `-` |
| a new-spec path (section 12) | a spec path; outside `paths.inventory` — it does not start with the inventory directory; absent at `<BASE_SHA>` — `git -C "<CLONE>" cat-file -e "<BASE_SHA>:<path>"` exits non-zero, run only on a path that has passed the spec-path class and lies outside `paths.inventory`; once in the section |
| a rename line | `^\S+ -> \S+$`, four-space indented under its subsection; a `modules:` path in the spec-path character class, repo-relative, with no leading `/`, no `..` segment and no segment starting with `-` |
| a `targets:` path | `^([a-z0-9_][a-z0-9._-]*/)*CONTEXT\.md$` or `^([a-z0-9_][a-z0-9._-]*/)*docs/adr/[0-9]{4}-[a-z0-9-]+\.md$` — no segment starts with `.` or `-`, so no `..` and no option-shaped path |
| `<statement-id>` | `^S[0-9]{2,3}$`, present in the inventory summary |
| `before` | equal to that statement's `<then>`, character for character |
| the estimate | `^[0-9]+$` |
| a reason, `after`, a term's definition, section 11's change line | one line, non-empty, `\|` written `/` |
| an `absorbs:` line (section 3) | `^absorbs: \S+:[0-9]+ — .+$`; its path in the spec-path character class, repo-relative, no leading `/`, no `..` segment, no segment starting with `-`; present at `<BASE_SHA>` — `git -C "<CLONE>" cat-file -e "<BASE_SHA>:<path>"` exits zero, run only on a path that has passed the class; its line a single number; its description one line, non-empty, `\|` written `/`; each `<path>:<line>` once in the section; at least one in the section |
| a `sites:` line (section 11) | `^sites: \S+:[0-9]+ — .+$`; its path in the spec-path character class, repo-relative, no leading `/`, no `..` segment, no segment starting with `-`; present at `<BASE_SHA>` — `git -C "<CLONE>" cat-file -e "<BASE_SHA>:<path>"` exits zero, run only on a path that has passed the class; its line a single number; its description one line, non-empty, `\|` written `/`; each `<path>:<line>` once in the section; at least two in the section — one when section 1 carries a `- slice:` line |
| an `excluded:` line (section 11) | `^excluded: \S+:[0-9]+ — .+$`; its path in the spec-path character class, repo-relative, no leading `/`, no `..` segment, no segment starting with `-`; its line a single number; its `<path>:<line>` once in section 11 across its `sites:` and `excluded:` lines; its reason one line, non-empty, `\|` written `/` |
| a `- slice:` line | `<k>` and `<N>` integers with `1 ≤ k ≤ N`, `N ≥ 2`; title one line |

Prose sections (2, 3) are non-empty and are not `none` — section 3's prose part before its
`absorbs:` lines included; the `absorbs:` lines are checked by their own class. A carriage return in any answer is
stripped before the value is checked. How a `sites:` or `excluded:` line stands against section
3's `absorbs:` lines and section 1's sites is the site rule (§2), checked by the decide stage's
site check, never by these classes. A real file whose path falls outside the path class cannot
be declared: the question that needs it names it, and the human narrows the candidate or renames
the file outside the run.

---

## §4 Estimated diff lines — the measure

The one unit every size in a run is stated in. The estimate in section 10, the explorer's
`est_diff_lines` ([candidates.md](candidates.md) §1), a split slice's `est`, and the comparison
against `run.split_above` ([profile.md](../../setup/references/profile.md) §2) all mean this:

> the lines added plus the lines removed, as `git diff --numstat` counts them, on the run branch
> from the inventory commit `<INV_SHA>` to the branch head, over every path except those under
> `paths.inventory` — source changes, spec moves and deletions, new specs, and `CONTEXT.md` and
> ADR edits all count; a binary file counts zero.

The inventory is excluded because it is the oracle, committed before the change and not part of
it. A split is proposed when the estimate is strictly greater than `run.split_above`.

---

## §5 Readers

| Reader | Reads | For |
| --- | --- | --- |
| the architect, on a proposal and on a diff | the whole record, verbatim | its verdict; section 11 alone — the change line with its `sites:` and `excluded:` lines — is the premise of its first question on both triggers, and section 3's `absorbs:` lines are the seam's own claim it checks in the code |
| decide — the site check ([stage-3-decide.md](stage-3-decide.md) §6) | section 1's `- next_sites:` line, section 3's `absorbs:` lines and section 11 | every site and absorbed site present at `<BASE_SHA>`; the site rule (§2) — every `sites:` line on an `absorbs:` line, no `excluded:` line on one, every Candidate site once in section 11 |
| implement — the implementer's brief | the whole record, verbatim | the change to make |
| implement — the pre-spawn target check ([stage-4-implement.md](stage-4-implement.md) §2) | the `targets:` line; the spec moves in section 6; section 5; section 12 | probing every planned write against the fence |
| implement — the rename-map check and the spec-mover | sections 5 and 6 | the declared entries; the paths the spec-mover may delete |
| implement — the spec-author brief ([stage-4-implement.md](stage-4-implement.md) §4, step 4a) | sections 2, 3 and 12 | the interface its specs assert; the modules they test; the paths it writes |
| decide, the architect and implement | section 12 | the decide stage's class and cross-section checks; the architect's completeness question; the paths the implement stage's `deepen:spec-author` writes, and its fence set |
| verify | sections 2, 3, 6, 9 and 11 | the declared rename map, passed to the mutation runner; intended `changed` statements; the architect's diff premise; sections 2, 3, 9 and 11 as the reviewers' declared scope |
| deliver | the whole record | the evidence pack; section 5's `rewrite` lines listed as deleted for a human to rewrite on the pull request |
