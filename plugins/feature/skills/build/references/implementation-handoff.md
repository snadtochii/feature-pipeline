# Build — `03-implementation.md` handoff format

`03-implementation.md` is the implementer's handoff. It is the implement phase's progress log. It also carries the implementer's knowledge to readers that never saw its conversation. This reference owns the whole contract for the file: its layout, what each entry holds, when entries are written, and which part each reader gets. `build/SKILL.md` cites it at every site that writes or reads the file, and so does [`stuck-detection.md`](stuck-detection.md). The append mechanism itself is §5 here. Where the file lives, and when an append reaches the ticket store in the detected storage mode, stay in [`storage-fs.md`](storage-fs.md) / [`storage-server.md`](storage-server.md) §4.

## 1. Layout

The file opens with a `# Implementation — <TICKET-ID>` title, written together with its first section. It has five level-2 sections. Each one appears only once it has content, always in this order within a pass (see Later passes below):

```
# Implementation — <TICKET-ID>

## Worktree
- wt-path: <absolute path>
- branch: <branch>
- repo-root: <absolute path>
- excluded: [<path>, ...]

## Steps

### Step 1.1 — <goal from the plan's Build Sequence>
- changed: <paths>
- constraints: <constraints discovered>
- rough edges: <what was left on purpose, or none>
- validation: <command> — green | none documented

## Rationale

### Step 1.1 — <goal>
- why this shape: <reason>
- rejected: <alternative and why, or none considered>

## Post-review
- <finding addressed>: <what changed, where, why>

## Post-test
- <failed criterion addressed>: <what changed, where, why>
```

- **`## Worktree`** is present only when a worktree is bound. It holds the record State setup writes: `<wt-path>`, `<branch>`, `<repo-root>` and `excluded:`, with the same field names and content the re-bind reads. It is written before any step entry.
- **`## Steps`** holds one entry per step of the plan's Build Sequence (§2).
- **`## Rationale`** holds one entry per step, written once at the end of the implement phase (§3).
- **`## Post-review`** and **`## Post-test`** hold the changes made after the implement phase (§4).

**Later passes.** A `continue-with-hint` re-entry, or a resumed run that re-enters the review checkpoint, runs the loop again over an existing file. One rule decides where its writes go:

- **The current pass has its `## Rationale` section** → the re-entry opens a new pass. It appends its own sections in the same order, with every heading suffixed ` (pass K)`, K counting from 2: `## Steps (pass 2)`, `## Rationale (pass 2)`, `## Post-review (pass 2)`, `## Post-test (pass 2)`.
- **The current pass has no `## Rationale` section** (the loop exited before the implement phase ended, as a `stuck` exit mid-implement does) → the re-entry continues the current pass. Its step entries go under that pass's `## Steps` section, and its phase-end write adds that pass's `## Rationale`, with an entry for every step of the pass.

`## Worktree` is never repeated. In this reference, "a `## Steps` section" (and likewise for the other three) means the unsuffixed section and every suffixed one; the current pass is the one with the highest K.

**Keys in a later pass.** An entry that redoes a Build Sequence step keeps that step's `N.M` key, headed as a revisit (§5). Work driven by the hint that maps to no Build Sequence step is keyed `P<K>.<n>`, numbered in order within pass K: `### Step P2.1 — <goal>`. A `P` key stays visible to every view but never counts toward the done signal (§8), which reads Build Sequence keys only.

## 2. `## Steps` entries

Each entry is headed `### Step N.M — <goal>`. `N.M` is copied from the `02-plan.md` Build Sequence line. It is never derived from the plan's unnumbered Implementation Steps bullets, because the Build Sequence number is the only stable identifier. Hint-driven work in a later pass that maps to no Build Sequence step takes a `P<K>.<n>` key instead (§1). Each entry has four fields, and each field is one to three bullet lines:

- **changed** — the files created or modified, as paths. Do not restate the diff. A step that changes no code still gets an entry: `changed: none — covered by Step X.Y`, or `changed: none — verification only`.
- **constraints** — constraints discovered while doing the step that the plan did not state: an invariant, an ordering requirement, or a check that failed and why.
- **rough edges** — anything left imperfect on purpose, with the reason, or `none`.
- **validation** — the validation command run and its result, or `none documented` when the project declares no validation commands.

A deviation from the plan belongs under `constraints` when a discovered fact forced it, or under `rough edges` when it was a deliberate shortcut. The reason for it belongs in the step's `## Rationale` entry.

## 3. `## Rationale` entries

Each entry is headed `### Step N.M — <goal>`, using the same key as the step's `## Steps` entry, and has two fields:

- **why this shape** — why the change took the form it did.
- **rejected** — the alternatives considered and why each lost, or `none considered`.

The section is written once, as the last action of the implement phase, with an entry for every step. A step completed in an earlier session, whose reasoning is no longer in context, gets `not recorded (resumed session)` in both fields. Rationale is never reconstructed after the fact.

## 4. `## Post-review` and `## Post-test`

The review checkpoint writes `## Post-review` after it applies fixes. The test checkpoint writes `## Post-test` after it applies fixes. Each bullet names the finding or failed criterion it addresses, then what changed, where, and why. A checkpoint that changed no code writes no section. These headings are what let a reader tell implement-phase entries from later ones: entries under a `## Steps` or `## Rationale` section were written by an implement phase, and entries under a `## Post-review` or `## Post-test` section were written after one.

## 5. Write timing

- **Step entries ride with validation.** A step's `## Steps` entry is appended in the same Bash call as that step's final validation command, never in a turn of its own:

  ```bash
  set -o pipefail; <validate> && cat >> "<ticket-folder>/03-implementation.md" <<'HANDOFF_<N.M>_END'
  ### Step N.M — <goal>
  ...
  HANDOFF_<N.M>_END
  ```

  The heredoc delimiter is quoted, so `$`, backticks and quotes in the entry are written literally. Quoting does not stop a line that equals the delimiter from closing the heredoc early and running every line after it as a shell command, so the delimiter must appear on no line of the entry: use a per-write token such as `HANDOFF_<N.M>_END`, never a generic `EOF`, and check the entry for it before sending. Every append to this file follows this rule. The first step's call also writes the `## Steps` heading, and the title when the file does not exist yet. A red validation run writes nothing, because `&&` stops the append. That guard holds only when the exit status of `<validate>` is the validation's own, so two rules bind every chained write, the phase-end write included. Several validation commands are joined with `&&`, never `;`, because a `;` list reports only its last command's status. The call opens with `set -o pipefail`, so validation output piped through a trimming command (`npm run lint 2>&1 | tail -40`) fails when the validation fails instead of taking `tail`'s status. Fix the failure, then issue the combined call again. An entry therefore always records a green step.
- **No validation commands.** When the project declares none, the entry's append runs as a parallel call in the same turn as the next step's first tool call. The last step's entry goes with the phase-end write.
- **Phase end.** The implement phase ends with one write, its last action, chained onto the final validation command in the same call. It carries any `(revisit)` entries that the cross-cutting final validation produced, followed by the whole `## Rationale` section.
- **Append-only and chronological.** Entries are never edited in place. A redone step gets a new entry under the same key, headed `### Step N.M — <goal> (revisit)`. The last entry for a key is the current one, and the repeat stays visible to the stuck arbiter.
- **Storage.** When the append reaches the ticket store in the detected storage mode is set by [`storage-fs.md`](storage-fs.md) / [`storage-server.md`](storage-server.md) §4.

## 6. Views

Each reader gets one of four views of the file:

- **Neutral view** — the whole file with every `## Rationale` section removed, each from its heading up to the next `## ` heading or the end of the file. Before any `## Rationale` exists (mid-phase, or a resumed build), the neutral view is the whole file.
- **Worktree view** — the `## Worktree` section only.
- **Newest steps** — the last `<N>` `### Step` entries across all `## Steps` sections, in reverse order so the newest comes first. With fewer than `<N>` entries, all of them.
- **Full view** — the whole file.

A spawn prompt inlines the resolved text of its view, never a path or a link to this file.

## 7. Consumers

| Reader | View |
|---|---|
| Reviewer shared base (`build/SKILL.md` §2b) | Neutral |
| `ui-tester` prompt (`build/SKILL.md` §3b) | Neutral |
| Worktree re-bind (`build/SKILL.md` State setup) | Worktree |
| Stuck arbiter ([`stuck-detection.md`](stuck-detection.md) §6) | Newest steps, plus the current `## Post-review` / `## Post-test` bullets when it fires in that checkpoint |
| The step that applies review findings (`build/SKILL.md` §2e) | Full |
| Resumption router (`build/SKILL.md` §5) | The done signal (§8) |
| `06-summary.md` | Never `## Rationale` (`build/SKILL.md` §4b) |

The rationale is kept from reviewers, the tester and the summary so that they judge the change on its own terms. The fix step reads it so that it can accept or dismiss a finding the way the implementer would have.

## 8. Done signal

- A Build Sequence step is done when a `### Step N.M` entry for it exists under a `## Steps` section.
- The implement phase is complete when the current pass has its `## Rationale` section.
- Build never ticks `02-plan.md`'s checkboxes.

A file with no `## Steps` section still resumes. Work out the next step from the file's prose and the current diff, then continue from that step with the structure above.
