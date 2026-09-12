# The brief

The pull request body, and the run's only checkpoint. Consumed by
[`../SKILL.md`](../SKILL.md) §11.

The brief exists because the human did not watch the run. It is the whole basis for trusting a
diff they will not read line by line, so it is written for a reader who has thirty seconds and
no context. Decision-ready, never raw output: what changed, why this finding and not the
others, what was verified, and how to undo it.

---

## §1 Template

Substitute every placeholder. A section with nothing to say is written with its honest empty
value, never deleted — a missing section reads as an omission, and the reader cannot tell
whether the loop had nothing to report or simply failed to report it.

```markdown
## Tidy: <category> — <one-line summary>

**Finding** `<finding-id>` · **Files** <n> substantive, <m> import-only · **Diff** +<added>/-<removed> · **Base** `<BASE_SHA>`

### Problem

<The structural friction, in the shared design vocabulary and the project's own domain terms.
Two or three sentences. Why this shape makes future change expensive — not what the code does.>

### What changed

<Structure only. Say plainly that no behavior change was intended, and name what was moved,
extracted, named, or deleted. No code.>

### Why this one

| # | finding | category | score | outcome |
|---|---------|----------|-------|---------|
| 1 | <summary> | <category> | <score> | **selected** |
| 2 | <summary> | <category> | <score> | behavior risk: real → escalated |
| 3 | <summary> | <category> | <score> | over diff cap (est. <n> lines) |
| 4 | <summary> | <category> | <score> | category not in allowlist |
| 5 | <summary> | <category> | <score> | previously rejected (`<finding-id>`) |

### Evidence

| gate | result |
|------|--------|
| diff caps | <lines> lines / <n> substantive files / <m> import-only files |
| base-test (tests from `<BASE_SHA>`) | pass |
| characterization | <n> added, passing on base · or: not required (target covered) |
| lint · typecheck · test · build | pass · pass · pass · pass |
| public surface | identical · or: skipped (no surface oracle declared) |
| mutation | skipped (tier 1) |
| smoke | skipped (none declared) |
| architecture | <tidy-architect's one_line> |

### Not done

<Anything noticed and deliberately left alone, with the reason. "Nothing" when there is
nothing.>

### Revert

Single commit. `git revert <sha>` restores the previous structure. No data, schema, migration,
or published-contract change is involved.

---

<sub>Tidy Loop · tier <n> · run `<run-id>` · merge rate <x>% (<category>) · <m> reverts all
time · [ledger](<ledger path>)</sub>
```

---

## §2 Rules for each section

**Title.** `Tidy: <category> — <summary>`. The category prefix lets a reviewer batch-triage a
list of these by the kind of change, which is the whole reason categories exist.

**The finding id goes in a fixed position** — the bold line directly under the title. Ledger
reconciliation recovers it from there by pattern, so moving it breaks the loop's memory. Never
reformat that line.

**Problem.** Written in the project's own vocabulary. A reviewer who knows the domain should
recognize the friction immediately; one who has to translate the description back into their own
terms will skip it.

**Why this one** is the section that answers the reader's real question: *what did this thing
decide on my behalf that I did not see?* Every candidate the scanner produced gets a row,
including the dropped ones, each with the actual reason it was dropped. This is the direct
mitigation for the loop's central risk — that the selection is unattended. Unattended is
acceptable; invisible is not.

Never trim the table to the flattering rows. A run that dropped four findings for good reasons
demonstrates working judgement; a run that shows only its selection demonstrates nothing.

The `score` column is the finding's aggregated hotspot score: the **maximum** `churn × lines`
over its files, not the sum. Name that rule under the table. The ordering itself is the fixed
lexicographic key in [`../SKILL.md`](../SKILL.md) §6 — risk, then category precedence from the
allowlist, then this score, then estimated lines, then the finding id — so a reader given the
same findings can reproduce the selection exactly. Row order follows that key, which is why a
lower-scoring row can outrank a higher one, and the table should not be re-sorted by score to
look tidier.

**Evidence.** Copied from the gate suite's own table
([`gates.md`](gates.md) §10). Three states only: pass, skipped with the reason, or the run never
got here. **A skipped gate is never rendered as a pass.** "We did not check" and "we checked and
it was fine" are different statements, and blurring them is the one way this document could
actively mislead.

**Not done.** The honesty section. Anything the run noticed and left alone, and why. It is also
where a `tidy-architect` `notes` entry lands when it was not itself a failure.

**Revert.** A structure-only change is revertible by construction; saying so, with the command,
is what makes the reviewer's decision cheap. If the change is somehow *not* a single commit,
that is a defect in the run, not a line to soften here.

**Footer.** The metrics from [`ledger.md`](ledger.md) §6, so trend is visible at the point of
decision rather than in a report nobody opens.

---

## §3 Delivery

```bash
cd "<WT>" && git push -u origin "<branch>"
cd "<WT>" && gh pr create --draft --base "<BASE>" --label "<pr_label>" \
  --title "<title>" --body-file "<brief path>"
```

Run from inside the worktree so `gh` infers the repository from the working directory. Write the
body to a file and pass `--body-file`; never interpolate the brief into a shell argument, since
it carries model-written prose, file paths, and a reviewer's recovered rejection notes.

**Draft, always.** Never `--fill`, never `gh pr merge`, never auto-merge, at any tier. The loop
opens; a human merges or closes.

---

## §4 The reject path

Closing the pull request with a one-line reason is the entire rejection interface. No form, no
label, no ceremony.

The next run's reconciliation reads that comment, records the finding as `rejected` with the
reason as its note, and never proposes it again. Worth stating in the brief's own footer link:
the reason is not bureaucracy, it is the only channel by which a rejection's *why* reaches
future runs. A pull request closed silently still suppresses the finding, but the loop learns
nothing about why.

---

## §5 The tier-0 report

At tier 0 there is no pull request. The same content, minus the gate evidence and the revert
section, is written to `<state_dir>/reports/<ISO-date>.md` and its path printed.

Keep **Why this one** in full — at tier 0 that table *is* the product. The whole purpose of the
observe tier is calibrating the selection step against the user's own judgement, and the ranked
list with reasons is the only thing that makes that comparison possible.

Include the architecture gate's verdict on the proposal. It gates nothing at tier 0, but a
verdict on the idea is exactly what a human comparing their judgement to the loop's wants to
see.
