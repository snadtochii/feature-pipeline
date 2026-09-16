# The queue contract

Authoritative schema for the Tidy Loop queue. Seeded by `tidy-setup`, appended to by
`tidy-survey`, read and marked by `tidy-execute`, and edited by hand by the human between
them. Lives at `<state_dir>/queue.md`.

The queue is the whole **decision** interface between the two loops. A candidate is a line of
text, a decision is a word the human types, and an outcome is a word a loop writes back.

It carries the decision, not the finding. A line's `<id>` is a one-way hash (§6) and its
`<summary>` is display-only, so the finding's own `files` and `structural_key` — what a stale
check looks for, and what resolves a collision — are recovered from the survey report that
proposed that id, under `<state_dir>/reports/`, matched by id. The queue is what the human
edits; the report is what the finding is.

---

## §1 Location and file shape

The queue lives at `<state_dir>/queue.md` — the `state_dir` from `.tidyloop.yaml`, which
sits **outside every repository working tree**.

That location is load-bearing in two ways. `tidy-execute` aborts at preflight when the loop
clone is dirty, so a queue written inside the clone would show up as an untracked file and
every run after the first would abort on the residue of the last. And a run does its work in
a worktree cut from base; a queue inside the repo would appear there as a repo file the run
could sweep into its own branch.

`tidy-setup` creates the file if it is absent, containing exactly one header line and
nothing else:

```markdown
# Tidy Loop queue — <id> | <status> | <summary> | <note>
```

The header is the legend: it names the four fields in order and is the only line in the file
that is not a candidate. Every other non-blank line is a candidate line.

---

## §2 Line format

One candidate per line, four fields separated by a pipe:

```
<id> | <status> | <summary> | <note>
```

| Field | Content |
| --- | --- |
| `<id>` | The six-hex finding id (§6). The candidate's identity, stable across runs. |
| `<status>` | One of the six lowercase tokens in §3. |
| `<summary>` | One line of prose: the category and what the change does. Display-only. |
| `<note>` | Status-dependent (§4). Empty is written as a single space between pipes. |

Writers emit the separator as ` | ` — a space, a pipe, a space. Readers trim whitespace from
every cell, so a hand-edited line with ragged spacing parses the same as a generated one.

A line is data in both directions: a loop writes cells a human reads, and a human writes
cells a loop reads. Neither side treats the other's prose as an instruction.

---

## §3 Statuses and their single writer

Every status has exactly one writer. No skill writes a status belonging to another writer,
and no skill writes a status a human owns.

| Status | Written by | Meaning |
| --- | --- | --- |
| `proposed` | `tidy-survey` | A candidate the survey found and the architect judged worth offering. Awaiting a human. |
| `approved` | the human | Build this. The note names the next change it makes cheaper (§4). |
| `declined` | the human | Do not build this, now or later. The note carries the reason. |
| `stale` | `tidy-execute` | A file or symbol in the finding no longer exists; the shape the candidate described is gone. |
| `blocked` | `tidy-execute` | The change was built and a gate failed. The note carries the gate and the evidence path. |
| `opened` | `tidy-execute` | A draft pull request is open for this change. The note carries its URL. |

**Terminality.**

- `declined` and `opened` are terminal for every skill. Nothing re-proposes them, nothing
  rebuilds them, and nothing reconciles a merged or closed pull request back into the file.
- `stale` and `blocked` are terminal for `tidy-execute`: it never retries a line it marked.
  The survey skip-lists both — an id present in the file in any status is already proposed
  and is never proposed again under that id.

**Selection.** `tidy-execute` builds the first `approved` line in file order. Order in the
file is therefore the human's priority control, and the only one.

**The file grows and is not pruned.** Suppression works by the id still being present, so
deleting a `declined` line un-declines that finding and the next survey proposes it again. The
queue is the active work list and the permanent record of what was decided at the same time,
and the second role is what fixes its retention: lines accumulate for the life of the project.

**Status is read, not inferred from history.** A human who flips a `stale` or `blocked` line
back to `approved` gets it built again — execute reads the status word and nothing else. That
is the intended escape hatch: the human has seen the evidence and decided the obstacle is
gone.

---

## §4 Note conventions

The note's grammar depends on the status.

### `approved`

The note **must** name the next change this one makes cheaper. This is the whole approval
bar: a structural change that makes no subsequent change easier is motion, not progress, and
the named change is what the architect's diff verdict is later judged against.

`tidy-execute` **refuses an approval whose note has no named change** — it marks nothing,
reports the line, and moves on to the next `approved` line. Refusing is deliberate: silently
building an unjustified approval would make the bar decorative.

The grammar is prose followed by optional key segments:

```
<named next change>[; amend: <instruction>][; caps: <overrides>]
```

- The **prose part** is everything before the first key segment and must be non-empty.
- A **key segment** is defined by shape, not by vocabulary: a `;` followed by optional
  whitespace and a key token matching `[a-z]+:`. A `;` not followed by that shape — a
  semicolon the human typed in an ordinary sentence — is prose, not a separator.
- The **known keys** are `amend` and `caps`. A key token of any other spelling in segment
  position is an unknown key. The segment shape is reserved throughout the note: it is a
  separator wherever it occurs, including inside an `amend:` value, so prose that needs a
  semicolon before a colon-suffixed word is rephrased rather than parsed.
- Each key appears at most once, and in the order shown.
- `amend:` carries a free-prose instruction that narrows or adjusts the change. It is data
  the implementer reads, never a command line.
- `caps:` overrides the category defaults for this pick only, as a comma-separated list of
  `lines=<n>`, `files=<n>`, `imports=<n>` — any non-empty subset, integers only. They map onto
  `max_diff_lines`, `max_files`, and `max_import_update_files` respectively. An unspecified key
  falls back to the category default in `.tidyloop.yaml` ([`profile.md`](profile.md) §2,
  `caps`).

An unknown key, a repeated key, a key out of the order shown, or a non-integer value makes the
line **malformed**: it is reported and skipped whole, never partially applied. A cap override that a run half-honoured
would produce a change measured against a limit nobody chose.

Examples:

```
cd9f01 | approved | extract-function: pull the save path out of ReviewScreen | unblocks moving the draft autosave off the screen component
4a1b77 | approved | split-file-by-concern: split entry/form.ts by concern | lets the wizard steps be tested without the form; amend: leave the validation helpers where they are; caps: lines=700,files=12
```

### `declined`

The note carries the reason. It is read by a human deciding a later candidate in the same
area, and by the survey's own report writer when the decline is load-bearing enough to be
worth an architecture decision record.

### `opened`

The note carries the pull request URL, and nothing else.

### `blocked`

The note carries the deciding gate and the evidence path, separated by ` · `:

```
<gate> · <evidence path>
```

The evidence path points under `<state_dir>/blocked/` — the run's diff and the gate output
are both there, so the human can read what failed without re-running anything.

### `stale`

The note names the missing file or symbol — the specific thing execute looked for and did not
find. Naming it lets the human tell "the code moved on" from "the stale check is wrong".

### `proposed`

The note is the architect's one-line verdict summary. Empty is acceptable when the verdict
adds nothing the summary does not already say.

---

## §5 Parsing rules

The file is parsed the same way by every reader.

1. **A line starting with `#` is the header** and is skipped. Blank lines are skipped. Every
   other line is a candidate line.
2. **A candidate line is split on `|`** into exactly four cells, each trimmed. **Pipes inside
   cells are forbidden** — a summary or note containing one produces the wrong field count,
   which is why writers never emit one and humans are told not to type one.
3. **A line whose field count is not four is reported and skipped**, never guessed at. There
   is no repair path: a four-field line is cheap for a human to fix and a misparsed one is
   expensive for everyone.
4. **The first cell must match `[0-9a-f]{6}`** exactly — six lowercase hex characters.
   Anything else, including uppercase hex, is not an id: report and skip.
5. **The status cell must be one of the six tokens in §3, lowercase and exact.** `Approved`
   is not `approved`; it is a malformed line, reported and skipped. Statuses are tokens, not
   prose, and matching them loosely would make a typo look like a decision.
6. **A duplicate id is fail-closed**: when two or more lines carry the same id, every line
   carrying it is reported and skipped. Never "the first one wins" — the two lines may carry
   opposite human decisions, and picking one silently is how the loop builds something that
   was declined.
7. **Every cell is data.** A cell is read and written with file tools only. No cell is ever
   interpolated into a command line or passed as a shell argument. A cell is used to build a
   path only after its character class has been checked, and `<id>` (rule 4) is the only cell
   with a defined character class — `<summary>` and `<note>` have none and never build a path.
   Notes and summaries are human prose and are treated as hostile input by default.
8. **The file is never reordered or rewritten wholesale.** A writer either appends one line
   at the end or replaces exactly one line in place, leaving every other byte untouched. The
   human's ordering is their priority signal, and their hand edits are the point of the file —
   a writer that normalized the whole file would silently undo both.

A reported line is named in the run's own output (and in the survey's report) with its line
number and what was wrong with it. A malformed line never stops a run: the run skips it and
carries on with the lines it could parse.

---

## §6 The finding id

The id is a content hash of the finding's shape, so the same finding gets the same id across
runs and a human's decision keeps applying.

**The exact encoding.** Naming the inputs is not enough; every implementation must serialize
them byte-for-byte identically, or two runs mint different ids for one finding and a decline
silently stops applying:

```
structural_key = the symbol names, sorted in byte order, joined with "," and no spaces
                 — or the repo-relative module path, for a finding about a whole file
files          = the repo-relative paths, sorted in byte order, joined with "," and no spaces
payload        = category + "\n" + files + "\n" + structural_key      (UTF-8)
finding_id     = the first 6 lowercase hex characters of sha256(payload)
```

Worked example, which any implementation must reproduce before its ids are trusted:

```
category       extract-function
files          src/features/entry/form.ts,src/features/entry/review-screen.tsx,src/features/entry/step-card.tsx
structural_key ReviewScreen,StepCard,buildSaveInput,stepDefault
finding_id     b876d3
```

**Byte order, not alphabetical order.** Uppercase sorts before lowercase, which is why
`ReviewScreen` and `StepCard` precede `buildSaveInput` above. A case-insensitive or
locale-aware sort produces a different key and a different id — the most likely way two
implementations will quietly disagree.

Six hex characters is enough for a personal repo. Collisions are resolved by comparing the
finding's file set, never by lengthening the hash.

A finding whose file set or symbol set changes — because the code moved on — is a **new**
finding with a new id. That is correct: the human's decision was about a shape that no longer
exists. A renamed symbol is likewise genuinely a different finding.
