# The hotspot score

Authoritative definition of the Tidy Loop hotspot measure: the churn window, the three
quantities, the ranking, and the two columns a report shows. Read by `tidy-setup` (§3, the
preview it shows the user) and by `tidy-survey` (the ranking it proposes from).

The score exists once here because it is a **cross-skill number**. A preview that ranks files
one way and a survey that ranks them another calibrates a decision the loop never makes, and
the two implementations diverge silently — nothing errors, the tables just disagree.

Everything below is deterministic: shell and `awk`, no model, reproducible from the same
repository state. Stock BSD `awk` is the target, so nothing here uses a GNU extension.

---

## §1 Window normalization

`scan.window` in the profile is the shorthand `[0-9]+[dwmy]` — `120d`, `26w`, `6m`, `1y`.

**It is not a git-parsable date spec and must never be interpolated into `git log` as written.**
`git log --since="120d"` returns *zero commits*: git parses the string, fails to find a date,
and silently yields nothing. Every hotspot ranking built on it comes back empty forever, and
the failure looks exactly like a quiet repository.

Normalize first, then interpolate the normalized value:

| Suffix | Normalized `--since` value |
| --- | --- |
| `d` | `<N> days ago` |
| `w` | `<N> weeks ago` |
| `m` | `<N> months ago` |
| `y` | `<N> years ago` |

A `scan.window` that does not match `[0-9]+[dwmy]` is a validation failure
([`profile.md`](profile.md) §3), not a value to guess at.

---

## §2 Churn

```bash
git -C "<repo>" log --since="<normalized window>" --name-only --pretty=format: -- <pathspecs> \
  | grep -v '^$' \
  | sort | uniq -c | sort -rn | head -40
```

Churn is the commit count touching each file in the window. `--pretty=format:` with an empty
format plus `--name-only` emits one path per line with a blank line between commits, so the
blank lines are stripped before counting.

**`scan.include` globs are not git pathspecs.** A gitignore-style pattern such as
`plugins/tidy-loop/**` matches nothing when handed to `git log`. Pass a plain directory path,
or the explicit `:(glob)` magic form, and never expand the globs in the shell first — an
unquoted glob is expanded against the *current* working directory, not the repository.

`head -40` bounds the measured set. Ranking below the top 40 churn files is spending
measurement on files nothing changes.

**A file deleted during the window still appears in this output.** Skip it when measuring
rather than failing the run.

---

## §3 Lines

Non-blank and blank alike — `wc -l` over the file as it stands on the current tree. Reported,
never ranked on (§5).

---

## §4 Indentation complexity

The sum, over a file's non-blank lines, of each line's indentation **level**. One nesting level
is one level, whatever character produced it: a tab is one level, and a run of leading spaces
is `int(spaces / width)` levels.

### The width is detected once per run, over the whole measured set

Not per file. Per-file detection gives two files in one repository different units and destroys
the within-repo comparability the score depends on; a single detected width preserves it — a
project's constant indent width cancels out of a comparison between its own files — while still
scoring a 2-space project the same way a 4-space one is scored.

Two other units are the intuitive readings, and this contract takes neither on purpose. **A
fixed width** — four leading spaces is one level everywhere — scores a 2-space project at double
the levels of an identically-structured 4-space one, so the measure would rank by house style
rather than by nesting. **The file's own modal indent** fixes that but reintroduces the worse
problem: the score's only job is to order files *within one repository*, and a per-file unit
means the two numbers being compared were produced by different rulers. Detecting once, over the
whole measured set, is the unit that makes the comparison the score is actually used for a valid
one.

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

Read it as: take the **most frequent positive leading-space count** across the set — ties go to
the smaller count, so the result does not depend on `awk`'s hash order — then **halve it while
half of it also occurs**. The halving is what stops a deeply nested 4-space project from
detecting a width of 8: in such a project an 8-space indent is common and so is a 4-space one,
so the mode reduces to 4 and stops there, because 2-space indents do not occur.

A file set with no space-indented lines at all — a tabs-only project — detects width `1` and
scores tabs alone, which is correct: with no spaces to divide, there is nothing for the width
to mean.

### The per-file sum

```bash
awk -v w="<detected width>" '/[^[:space:]]/ {
       match($0, /^[ \t]*/); ind = substr($0, 1, RLENGTH)
       tabs = gsub(/\t/, "", ind)
       lvl += tabs + int(length(ind) / w)
     } END { print lvl + 0 }' "<file>"
```

`gsub` returns the number of tabs it removed and leaves `ind` holding only the leading spaces,
so `length(ind)` after it is the space count.

**The measured set belongs to the consuming skill**, which names it, and the width is detected
once over whatever that skill measured. The two consumers legitimately measure different sets —
at preview time `forbidden_paths` has not been confirmed yet, so the preview cannot filter on a
list the user has not agreed to. What this contract fixes is the *algorithm*, and that the width
is detected once per run: comparability holds within a run, which is the only place the score is
ever compared.

At minimum, every consumer's set keeps only what `scan.include` bounds and drops what
`scan.exclude` catches. A minified bundle or a generated file yields an enormous indentation sum
and would dominate every ranking, which is one of the reasons `exclude` must cover build output
and generated sources ([`profile.md`](profile.md) §2).

---

## §5 The ranking and the two reported columns

```
score = churn × indentation
```

**`churn × indentation` is the ranking.** It is the CodeScene hotspot proxy for where
refactoring pays off: the overlap of how often a file changes with how tangled it is.

**`churn × lines` is reported alongside, and ranks nothing.** It is the intuitive reading of
"big file", and seeing where the two columns disagree is what tells a reader whether the loop
is aimed at size or at tangle.

Both columns appear in every table built from this measure — `tidy-setup`'s preview and
`tidy-survey`'s report — together with the raw `churn`, `lines`, and `indentation` values, so
the scores can be recomputed by hand from the same row.

A high score is not a defect. It says a file is where change and structure overlap; it does not
say the file is badly written.

---

## §6 Worked example

Any implementation must reproduce this before its numbers are trusted, for the same reason
[`queue.md`](queue.md) §6 pins the finding id: two implementations of an unpinned measure
disagree quietly.

The measured set is one file, `example.ts`:

```
function f() {
    if (a) {
        return 1
    }
}
```

**Width detection.** The positive leading-space counts are `4`, `8`, `4`. The mode is `4`
(twice). `4` is even and `2` does not occur in the set, so the halving stops immediately.
**Detected width: `4`.**

**Indentation.** Levels per line: `0`, `1`, `2`, `1`, `0`. **Indentation: `4`.**

**Lines: `5`.** With a churn of `7` commits in the window, the row reads:

| File | Churn | Lines | `churn × lines` | `churn × indentation` |
| --- | --- | --- | --- | --- |
| `example.ts` | 7 | 5 | 35 | 28 |

A second pinned case, for the mixed-character rule: a two-line file whose first line is
indented by one tab and whose second is indented by four spaces. The space count `4` is the
only positive one, so the detected width is `4`, and the levels are `1` and `1` — an
indentation of `2`.
