# Candidates

Authoritative contract for a deepening candidate: the record the explorer returns, the category
vocabulary, the structural key, the id and how it is minted, the rows the discover report keeps,
the slug a picked candidate names its branch with, and the value classes checked before any
value reaches a shell. Read by the discover stage ([stage-1-discover.md](stage-1-discover.md)
§5–§8), which spawns the explorer, mints the ids and writes the report; restated as the return
shape in [agents/explorer.md](../../../agents/explorer.md), which must match §1 field for field.

The id is a **cross-run identity**. `<state_dir>/memory.md` ([memory.md](memory.md)) records what
the loop did with a candidate by id, `--pin` names a candidate by id, and a later run must mint the
same id for the same candidate or a decline silently stops applying. The encoding is therefore
shipped as a script, [`../scripts/candidate-id.sh`](../scripts/candidate-id.sh), whose
`--self-test` reproduces §4's worked example and runs in CI through
`scripts/check-deepen-contract.sh`.

---

## §1 The explorer's return shape

Each candidate is a block of `<field>: <value>` lines, one field per line, in this order, blocks
separated by one blank line. `name:` opens a block. After the last block, when the brief carried
a pin, one `pin:` line — the `name` of the block that answers it, or `none — <why>` — and then
one `notes:` line.

| Field | Value |
| --- | --- |
| `name` | kebab case, a few words naming the deepening — `order-pricing-module` |
| `tier` | `strong`, `worth-exploring` or `speculative` |
| `category` | one of §2's four values — the dominant dependency category across the cluster |
| `files` | the repo-relative paths of the cluster, comma-separated, no spaces |
| `structural_key` | §3 |
| `next_change` | one line: the named next change this deepening makes cheaper |
| `est_diff_lines` | an integer: the estimated diff lines the deepening itself takes, in the measure [decision-record.md](decision-record.md) §4 defines |
| `deletion_test` | one line: what deleting the shallow module would do — complexity vanishes, or reappears across N callers |
| `friction` | one line: the friction met while walking the code that marks this cluster |
| `adr_conflict` | `<adr path> — <one line on why the friction may warrant reopening it>`, or `none` |

- Blocks come **ranked**: every `strong` block before every `worth-exploring` block, every
  `worth-exploring` before every `speculative`, best first within a tier. At most ten blocks.
- The explorer returns **no `id`**. Ids are minted by the discover stage (§4), never by a model.
- A block missing a field, with a field out of its class (§7), or with a `category` outside §2 is
  dropped by the discover stage with a report line naming the block's `name` and the field — never
  repaired, never guessed.

---

## §2 Category

The dependency category that decides how a deepened module is tested across its seam. Exactly
one of:

| Value | The cluster's dependencies are |
| --- | --- |
| `in-process` | pure computation and in-memory state, no I/O — deepenable by merging and testing through the new interface |
| `local-substitutable` | I/O with a local stand-in the suite can run (an in-memory database, an in-memory filesystem) |
| `remote-owned` | the project's own services across a network boundary — a port at the seam, an in-memory adapter in tests |
| `true-external` | a third-party service the project does not control — an injected port, a mock adapter in tests |

A cluster that mixes categories takes the one that dominates its seam. Any other value drops the
candidate (§1).

---

## §3 Structural key

The symbol names the deepening is about, sorted in byte order and joined with `,` and no spaces —
or, for a candidate about a whole file, that file's repo-relative path. It is what makes two
candidates over the same files distinct, and what keeps one candidate's id stable while the
code around its symbols moves.

---

## §4 The id

**The exact encoding.** Every implementation serializes the inputs byte for byte identically, or
two runs mint different ids for one candidate:

```
structural_key = the §3 elements, sorted in byte order, joined with "," and no spaces
files          = the repo-relative paths, sorted in byte order, joined with "," and no spaces
payload        = category + "\n" + files + "\n" + structural_key      (UTF-8, no trailing newline)
id             = the first 6 lowercase hex characters of sha256(payload)
```

**Byte order, not alphabetical order** — `LC_ALL=C sort`. Uppercase sorts before lowercase, so
`ReviewScreen` and `StepCard` precede `buildSaveInput`. A case-insensitive or locale-aware sort
produces a different key and a different id.

**Worked example**, which any implementation reproduces before its ids are trusted. The encoding
is category-agnostic, so the example pins it with a category string outside §2 — it exercises the
serialization and the hash, not the vocabulary:

```
category       extract-function
files          src/features/entry/form.ts,src/features/entry/review-screen.tsx,src/features/entry/step-card.tsx
structural_key ReviewScreen,StepCard,buildSaveInput,stepDefault
id             b876d3
```

**The script.** `bash "<plugin-root>/skills/run/scripts/candidate-id.sh" <records-file>` reads one
record per line, `category<TAB>files<TAB>structural_key`, re-sorts `files` and `structural_key`
itself after splitting on `,`, and prints `<id><TAB>category<TAB>files<TAB>structural_key` for
each, with `files` and `structural_key` in their sorted, hashed form — so the report carries
exactly what was hashed. A line without exactly three non-empty tab-separated fields, or with an
empty element between commas, prints `invalid<TAB><the line as read>` — the caller drops that
candidate with a report line. Output lines come in input order. Exit `0`
when every line was answered (`invalid` lines included), `1` when no sha256 tool is available or
the hash fails, `2` on a wrong invocation (no argument, an unreadable file). `--self-test` asserts
`b876d3` from deliberately unsorted input.

Duplicate paths inside one `files` value are kept as the explorer sent them, so they change the
hash; the explorer lists each path once.

**Collisions.** Six hex characters is enough for one repository. Two candidates in one run with
the same id and the same file set are one candidate returned twice — the lower-ranked copy is
dropped silently. The same id over different file sets is a true collision: the lower-ranked
candidate is dropped with the report line `id collision: <id> — <kept name> / <dropped name>`.
The hash is never lengthened.

A candidate whose file set or symbol set changes because the code moved on is a **new**
candidate with a new id — a decline was about a shape that no longer exists.

---

## §5 What the discover report keeps

`1-discover.md` keeps every ranked candidate as one row of its `## Candidates` table, so a later
run's `--pin <id>` finds the record with one `Grep` anchored on the row's first three columns —
rank, tier, id, in this order ([stage-1-discover.md](stage-1-discover.md) §1) — across past reports:

| Column | From |
| --- | --- |
| `rank` | position in the ranked list, from 1 |
| `tier` | §1 |
| `id` | §4 |
| `name` | §1 |
| `category` | §1 |
| `files` | §1, byte-sorted, comma-joined |
| `structural_key` | §3, byte-sorted, comma-joined |
| `next_change` | §1 |
| `est_diff_lines` | §1 |
| `adr_conflict` | §1 — kept, never a reason to drop |
| `memory` | the candidate's [memory.md](memory.md) status, or `—` |

A `|` in a free-text cell (`name`, `next_change`, `adr_conflict`) is written as `/`, so every row
has exactly the table's columns.

The picked candidate is written again as the report's `## Pick` block, one `- <field>: <value>`
line per field, in this order — the block the later stages read:

```
## Pick
- id: <id>
- name: <name>
- tier: <tier>
- category: <category>
- files: <files>
- structural_key: <structural_key>
- next_change: <next_change>
- est_diff_lines: <est_diff_lines>
- adr_conflict: <adr_conflict>
```

---

## §6 Slug

The picked candidate's `<slug>` — the run branch and worktree name
([worktree.md](worktree.md) §1) — is its `name` when the name matches `^[a-z0-9-]{1,40}$`, and
its id otherwise. It is recorded in the run state beside the candidate id.

---

## §7 Value classes

Checked by the discover stage on every returned block before the record reaches the records file
or the report. A value outside its class drops the candidate (§1).

| Field | Class |
| --- | --- |
| `name` | `^[a-z0-9][a-z0-9-]*$` |
| `tier` | one of the three §1 values |
| `category` | one of the four §2 values |
| `files` | comma-separated repo-relative paths; no element empty, starting with `/`, holding a `..` segment, or containing a tab, a newline, a `,` inside a path, or a `\|` |
| `structural_key` | comma-separated elements; none empty or containing a tab, a newline or a `\|` |
| `est_diff_lines` | `^[0-9]+$` |
| `next_change`, `deletion_test`, `friction`, `adr_conflict` | one line, non-empty |

The records file is written with `Write`, never assembled on a command line, and the script
reads it as data.
