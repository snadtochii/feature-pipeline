# The hotspot measure

Authoritative definition of the hotspot table a `deepen:run` hands its explorer: the churn
window, the measured set, the three quantities, the ranking, the two score columns, and the
script that computes all of it in one call. Read by the discover stage
([stage-1-discover.md](stage-1-discover.md) §3), which runs the script and inlines its rows into
the explorer's brief.

The table is a **cross-run number**. Two runs a week apart rank the same repository with it, and
a candidate's place in one run is compared against its place in the next. An unpinned measure
drifts between implementations without any error — the tables just disagree — so the measure is
shipped as a script, [`../scripts/hotspots.sh`](../scripts/hotspots.sh), whose `--self-test`
reproduces §8 and runs in CI through `scripts/check-deepen-contract.sh`. Prose here and the
script say the same thing; where they differ, the script is wrong and the self-test should
have caught it.

Everything below is deterministic: `git`, `bash` and `awk`, no model, reproducible from the same
repository state. The script targets bash 3.2 and both BSD `awk` and `mawk`, so nothing here uses
a GNU extension.

---

## §1 Window

Churn is counted over a fixed window: `--since="6 months ago"`.

The window is a constant of the measure, not a profile field. A per-project window changes what
"hot" means between two repositories and between two edits of one profile, and the loop has no
decision that needs that dial yet. When one does, it becomes a profile rule appended after the
existing ones, and this section names it.

The value is already a date spec `git log` parses. A shorthand such as `6m` is never passed to
`git log`: git fails to parse it, finds no date, and silently returns zero commits — a failure
that looks exactly like a quiet repository.

---

## §2 Churn

```bash
git -C "<CLONE>" log --since="6 months ago" --no-renames -z --name-only --format=
```

Churn is the number of commits in the window that touch a path. `--format=` suppresses every
commit header, `--name-only` lists each commit's paths, and `-z` separates them with NUL, so the
output is a flat NUL-delimited path list with one entry per commit touching a path. It is read
one path at a time with `read -r -d ''`.

- **`-z`** — without it git C-quotes a path holding a non-ASCII or control byte, and the quoted
  spelling names no file. A path that still holds a newline or a tab after NUL parsing cannot be a
  row of the tab-separated table (§7); it is skipped and counted.
- **`--no-renames`** — a rename is counted as a change to both its source and its destination,
  never collapsed into one path the history cannot attribute.

Paths are counted, then ordered by churn descending, ties in byte order (`LC_ALL=C`). The walk in
§3 takes survivors from the top of that order until **40** are measured; ranking below the top 40
churn files spends measurement on files nothing changes.

---

## §3 The measured set

A churned path is measured when, in this order:

1. **It matches no exclusion glob.** The exclusion globs are the profile's `paths.specs` and
   `paths.forbidden` globs and `<inventory>**` for `paths.inventory`, which the discover stage
   writes to the exclude file one per line, plus this fixed generic list:

   ```
   *.lock
   *-lock.json
   *-lock.yaml
   **/go.sum
   *.min.*
   *.map
   ```

   Globs follow the fence's grammar ([fence.md](fence.md) §2): brace alternation expanded first,
   bash extglob forms, a leading `./` stripped, each pattern tried as written, with every `/**/`
   collapsed to `/`, and with a leading `**/` stripped; `*` spans `/`; matching is
   case-insensitive. Over-exclusion is the harmless direction here — a file dropped from the table
   is still reachable by the explorer's walk, while a lockfile or a minified bundle left in would
   dominate every ranking with an enormous indentation sum. An empty or missing exclude file means
   the generic list alone.
2. **It exists at `HEAD` as a regular file** — its `git ls-tree HEAD` entry has mode `100644` or
   `100755`, decided from the tree and never from the disk, so an untracked or ignored file left
   in the clone, a symlink, and a path under a symlinked directory are not measured. A path
   deleted during the window still appears in §2's output; it is skipped and counted, never an
   error.
3. **It is text** — `grep -Iq . "<path>"` succeeds. A binary file, an empty file and a file of
   blank lines all fail it; each is skipped and counted.

A path matched by step 1 is **excluded**; a path dropped by step 2 or 3, or by §2's newline and
tab rule, is **skipped**. Both counts cover the paths the walk considered before it reached 40
measured files, except §2's newline and tab paths: they leave the list before the walk, so every
distinct one in the window is counted. Either way the counts say what the table left out, so an
empty or thin table can never masquerade as a quiet repository.

---

## §4 Lines

`wc -l` over the file as it stands at `HEAD`, blank lines included. Reported, never ranked on
(§6).

---

## §5 Indentation complexity

The sum, over a file's non-blank lines, of each line's indentation **level**. A tab is one level;
a run of leading spaces is `int(spaces / width)` levels.

**The width is detected once, over the whole measured set** — never per file. A per-file unit
means two files of one repository are measured with different rulers, and the score's only job is
to order files within one repository. A fixed width would rank a 2-space project at double the
levels of an identically structured 4-space one; one width detected over the set cancels the
house style out of every comparison the table is used for.

```bash
awk '/^ +[^ ]/ { match($0, /^ +/); c[RLENGTH]++ }
     END {
       best = 0; bestn = 0
       for (w in c) {
         if (c[w] > bestn || (c[w] == bestn && w + 0 < best)) { best = w + 0; bestn = c[w] }
       }
       if (best == 0) { print 1; exit }
       while (best % 2 == 0 && ((best / 2) in c)) { best = best / 2 }
       print best
     }' <every file in the measured set>
```

The most frequent positive leading-space count across the set, ties to the smaller count so the
result does not depend on `awk`'s hash order, then halved while half of it also occurs. The
halving stops a deeply nested 4-space project from detecting 8. A set with no space-indented line
detects width `1` and scores its tabs alone.

The per-file sum:

```bash
awk -v w="<detected width>" '/[^[:space:]]/ {
       match($0, /^[ \t]*/); ind = substr($0, 1, RLENGTH)
       tabs = gsub(/\t/, "", ind)
       lvl += tabs + int(length(ind) / w)
     } END { print lvl + 0 }' "<file>"
```

`gsub` returns the number of tabs it removed and leaves `ind` holding only the leading spaces, so
`length(ind)` after it is the space count.

Every file operand is passed as `./<path>`, so no path is read as an `awk` option or as a
`name=value` assignment.

---

## §6 Ranking and the two score columns

```
score = churn × indentation
```

**`churn × indentation` is the ranking** — the overlap of how often a file changes with how
tangled it is, which is where a deepening pays off. **`churn × lines` is reported beside it and
ranks nothing**: it is the "big file" reading, and where the two columns disagree tells the reader
whether a candidate is aimed at size or at tangle.

Rows are ordered by `churn × indentation` descending, ties by path in byte order. Every table
built from this measure — the explorer's brief and the discover report — shows the raw `churn`,
`lines` and `indentation` beside both scores, so either score can be recomputed by hand from its
row.

A high score is not a defect. It says a file is where change and structure overlap — the
explorer's starting pull, never its verdict.

---

## §7 The script

```bash
bash "<plugin-root>/skills/run/scripts/hotspots.sh" \
  --repo "<CLONE>" --exclude-file "<exclude file>" --out "<table file>"
bash "<plugin-root>/skills/run/scripts/hotspots.sh" --self-test
```

- **Arguments.** All three paths absolute; a relative one, an unknown flag or a missing flag is a
  wrong invocation. `--repo` may name any directory inside the repository; the script measures
  from its top level.
- **Output file.** A tab-separated table with a header row —
  `path  churn  lines  indentation  churn_x_lines  churn_x_indentation` — and one row per
  measured file in §6's order. An empty table is the header alone.
- **Standard output.** One summary line,
  `measured: <n>, excluded: <n>, skipped: <n>, width: <w>`, and, when nothing was measured, a
  second line naming why:

  | Line | Cause |
  | --- | --- |
  | `empty: no commits in window` | §2 listed no path at all. |
  | `empty: no churned file survives the measured-set filter` | Every churned path was excluded, deleted, or unrepresentable (§3 steps 1–2). |
  | `empty: no text in the measured set` | Paths survived steps 1–2, and none of them is text. |

  The three call for different responses — a quiet repository, a profile whose globs swallow the
  codebase, a repository of generated or binary artifacts — so the caller reports the line
  verbatim.
- **Exit codes.** `0` an answer was computed, an empty table included; `1` the answer could not
  be computed — not a git repository, `git log` failed, a measurement or the output write failed;
  `2` a wrong invocation. The caller treats `1` and `2` as a failed measurement and an empty table
  as an answer.
- **Scratch space.** One `mktemp -d` directory, removed on every exit path.

---

## §8 Worked example

Any implementation reproduces this before its numbers are trusted; the script's `--self-test`
builds it as a throwaway repository and asserts every row and the summary line.

The measured set holds two files. `example.ts`, committed seven times in the window and ending as:

```
function f() {
    if (a) {
        return 1
    }
}
```

and `mixed.ts`, committed once — two lines, the first indented by one tab, the second by four
spaces.

**Width detection.** The positive leading-space counts are `4`, `8`, `4` from `example.ts` and
`4` from `mixed.ts`. The mode is `4`, and `2` does not occur, so the halving stops at once.
**Detected width: `4`.**

**`example.ts`.** Levels per line `0`, `1`, `2`, `1`, `0` — indentation `4`, lines `5`, churn
`7`. **`mixed.ts`.** Levels `1` (one tab) and `1` (four spaces) — indentation `2`, lines `2`,
churn `1`.

| path | churn | lines | indentation | churn_x_lines | churn_x_indentation |
| --- | --- | --- | --- | --- | --- |
| `example.ts` | 7 | 5 | 4 | 35 | 28 |
| `mixed.ts` | 1 | 2 | 2 | 2 | 2 |

The same repository also holds a `package-lock.json` (the generic list) and a `Specs/skip.ts`
matched case-insensitively by the exclude glob `{specs,other}/**` — both excluded — and a
`gone.ts` deleted in the window and a binary `bin.dat` — both skipped. The summary line reads
`measured: 2, excluded: 2, skipped: 2, width: 4`. Re-run with the exclude glob `*`, the table is
the header alone and the second line reads
`empty: no churned file survives the measured-set filter`.
