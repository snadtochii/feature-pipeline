# The survey report's per-finding record

Authoritative shape for the machine-readable part of a survey report. Written by `tidy-survey`
into `<state_dir>/reports/<ISO-date>.md`, read by `tidy-execute` at selection.

The rest of a report is prose for a human. This record is the part another skill parses, and it
exists because **the queue carries a decision, not a finding**: a queue line's id is a one-way
hash and its summary is display-only, so the finding's `files` and `structural_key` — what a
stale check looks for, and what resolves a collision — have to be recoverable from somewhere.
That somewhere is the report that proposed the id.

---

## §1 The record

One fenced block per proposed finding, anywhere in the report, tagged `tidy-finding`:

````markdown
```tidy-finding
id: b876d3
category: extract-function
files: src/features/entry/form.ts,src/features/entry/review-screen.tsx
structural_key: ReviewScreen,buildSaveInput
```
````

Four keys, all required, one per line, in this order, each `<key>: <value>` with a single space
after the colon.

| Key | Content |
| --- | --- |
| `id` | The six-lowercase-hex finding id, exactly as it appears on the queue line. |
| `category` | The finding's category, from the profile's allowlist. |
| `files` | Repo-relative paths, **sorted in byte order, joined with `,` and no spaces**. |
| `structural_key` | The finding's canonical non-prose identity: symbol names sorted in byte order and joined with `,`, or the repo-relative module path for a finding about a whole file. |

`files` and `structural_key` are serialized **exactly as the id's hash payload serializes them**
([`../../tidy-setup/references/queue.md`](../../tidy-setup/references/queue.md) §6). Byte order,
not alphabetical order: uppercase sorts before lowercase. Writing them any other way means the
record cannot be checked against the id it claims to describe, and the two implementations
disagree silently.

No path in either field ever contains a comma. A comma is the separator, and there is no
escaping rule — a repository with a comma in a source path is out of scope for the loop rather
than a reason to invent one.

**`structural_key`'s two forms are told apart mechanically, never by inspection.** It is the
module-path form when the whole value, uncommaed, equals one of the entries in `files`; it is the
symbol-name list otherwise. A writer therefore emits a whole-file finding's key as the *exact*
same string it put in `files`, byte for byte — a differently-spelled path is neither form, and a
reader that cannot tell the two apart would probe the exported surface for a symbol named after a
file, get back "absent", and conclude the finding is gone.

---

## §2 How a reader finds the record

1. Search `<state_dir>/reports/` for blocks whose `id` matches the wanted id.
2. **The most recent report by ISO date wins** when several carry it. The later proposal
   describes the tree as it more recently was.
3. **An id in no report is reported and skipped — never marked `stale`.** `stale` asserts that
   the shape the candidate described is *gone*; a missing report means its shape is *unknown*.
   Telling a human the code moved on when a report was simply pruned is a wrong answer, not a
   conservative one.
4. A block missing a key, or carrying an `id` that is not six lowercase hex characters, is
   reported with its report path and skipped. There is no repair path and no guessing.

---

## §3 Why this is a contract and not a convention

Both sides are unattended. The writer proposes findings on one schedule and the reader builds
them on another, with a human's decision in between and possibly days between the two. A shape
that lived only in whichever skill happened to write it first would drift the moment either side
was edited, and the failure would be silent: a reader that cannot parse a record reports the line
and moves on, so the loop would quietly stop building anything while every individual run looked
healthy.

The same reasoning is why the record is a fenced block rather than a table or a prose sentence.
It survives a human editing the prose around it, it is greppable by id, and it has exactly one
spelling.
