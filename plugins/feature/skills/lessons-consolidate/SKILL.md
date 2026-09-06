---
name: lessons-consolidate
description: "Consolidate a project's claudedocs/tickets/_lessons.md to the atomic one-subject-per-line format via a human-approved diff."
disable-model-invocation: true
allowed-tools:
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Bash
  - TodoWrite
argument-hint: "[path-to-_lessons.md]"
---

# Lessons-consolidate — sweep a bloated `_lessons.md` back to the atomic format

Cluster the same-subject entries in `claudedocs/tickets/_lessons.md`, propose **conservative merges** and **stale-entry retirements** as a **human-approved unified diff** (exact before/after), and rewrite the file **only after approval**. **Git is the ground-truth anchor** — it holds the prior version, so an over-eager merge is always recoverable. The same sweep **doubles as the one-time migration** for an existing bloated log: it reshapes dense multi-topic paragraph entries into atomic, subject-keyed lines.

**This skill runs in the main conversation, standalone** — **not a pipeline stage**. It spawns **no subagents** (no `Task`) and does **no** folder/status transitions and no flow wiring. It only reshapes one file, and only after you approve the diff.

The output target is the **atomic entry format** defined in the shared contract at [`../flow/references/lessons-log-fs.md`](../flow/references/lessons-log-fs.md) — what build and debug write and plan/ship grep. This skill normalizes an existing file to that contract; it does not invent a new one.

## Arguments

```
/feature:lessons-consolidate $ARGUMENTS
```

`$1` (optional) = a path to the lessons file to sweep. Omit it to use the default `claudedocs/tickets/_lessons.md` (relative to the repo root). Accepting a path keeps the skill project-agnostic — it operates on **any** consumer's lessons log, wherever it lives.

## When to run

- **On demand** — whenever you want to tidy the log.
- **At the size cap** — the log is append-with-supersession, so it grows slowly, but on a mature project it drifts. A sweep is **recommended** once the file crosses a soft threshold: **more than ~40 `^## ` entries, or more than ~500 lines (~8k tokens)**. This is a *recommendation surfaced at the top of the run*, not an automatic trigger — nothing sweeps the file without you invoking this skill and approving its diff.

## When NOT to run

- To capture a new lesson → that is build's verdict-gate capture or `/feature:debug`, not this skill.
- To read lessons for a ticket → consumers (plan, ship) grep the log on demand; they never call this skill.
- Against a file you have uncommitted, unsaved edits to that you are **not** ready to have restructured — commit or stash first, so git's anchor reflects the state you want to fall back to.

## Preconditions (git as anchor)

The safety model is "git holds the prior version." Before proposing any rewrite, establish that anchor — the file must be recoverable if you dislike the result:

1. `git rev-parse --is-inside-work-tree` — inside a git repo? If not, there is no git anchor; **write a sibling backup** (`<file>.bak`) before the rewrite and say so in the report.
2. `git check-ignore -q <file>` (exit 0 = ignored) and `git ls-files --error-unmatch <file>` (nonzero = untracked). If the file is **git-ignored or untracked**, git will **not** hold the prior version (this is common — a consumer may gitignore `claudedocs/`, and this repo does). In that case, **write a sibling backup** (`<file>.bak`) before the rewrite and note it in the report; do not assume the file is recoverable from git.
3. If the file **is** tracked but has **uncommitted changes** (`git status --porcelain <file>` nonzero), warn that the anchor is the last commit, not the working copy — offer to proceed (git still holds the committed version) or to stop so you can commit first.

If `<file>` does not exist, report "No `_lessons.md` to consolidate at `<path>`." and exit cleanly — there is nothing to sweep.

## Process

### 1. Load and measure

- Read the file. Count entries (`grep -c '^## '`) and size (`wc -l`, `wc -c`). Print the measurement and whether it is over the recommended size cap (see "When to run").
- Preserve everything **outside** a parsed entry byte-for-byte: the leading header line (`# Lessons learned across tickets`), blank separator lines, and any malformed block the parser can't classify as an entry (see Error Handling). An entry's **own** lines — its `^## ` header plus any continuation/paragraph lines that run under it up to the next `^## ` or EOF — are the sweep's working set and **may** be reshaped in the approved rewrite. This is deliberately narrower than the contract's append-time preserve rule ([`lessons-log-fs.md`](../flow/references/lessons-log-fs.md) §4): an appender never disturbs a neighbor line, whereas this sweep restructures whole entries, so a multi-line legacy entry's continuation lines are in scope — reshaping them is exactly the migration path.

### 2. Parse into entries, then cluster by subject

- Split the file into entries at each `^## ` line (an entry runs until the next `^## ` or EOF, so a multi-line/paragraph entry stays whole).
- For each entry, identify its **subject** — the single concrete path, tool, command, setting, or area the lesson is about (the same subject notion the contract's supersession check keys on — [`lessons-log-fs.md`](../flow/references/lessons-log-fs.md) §4). A well-formed atomic entry already names one; a dense legacy entry may name several.
- **Migration reshape (bloated-file path):** an entry that carries **multiple distinct subjects** in one dense paragraph is split into **one atomic line per subject**, each re-keyed to the shared subject and carrying the entry's ticket ID(s) and verdict. Splitting is conservative — it re-slices existing text, it does not re-summarize or invent; keep the sharpest existing phrasing for each subject verbatim.
- **Legacy date policy:** entries written before the dated format carry **no date** — never invent one. Resolve a date deterministically: if the file is **git-tracked**, recover the date of the commit that introduced the entry (`git log --diff-filter=A -1 --format=%ad --date=short -S'<entry ID>' -- <file>`) and stamp it; if that yields nothing, or the file is **untracked/ignored**, write the split lines in an explicit **undated** form (`## <id> (<verdict>): …` — verdict but no date field) rather than a fabricated date. A newly recovered or already-present date always uses the dated form (`## <id> (<verdict>, <YYYY-MM-DD>): …`); the undated form is a legacy-only fallback that the next dated capture on that subject supersedes.
- Cluster all resulting atomic lines by subject so same-subject lines sit together.

### 3. Decide merges and retirements (conservative)

For each subject cluster:

- **Merge** same-subject lines into one, in the contract's merged-entry form with **prefer-newest** on a genuine same-subject conflict ([`lessons-log-fs.md`](../flow/references/lessons-log-fs.md) §2, §4–§5), stamping the **newest** contributing date. Keep the single **sharpest existing phrasing** — never a lossy re-summary, never a hallucinated rewrite. If two lines under one subject carry **distinct, still-true facts**, keep both as separate atomic lines rather than fusing them into a vaguer one.
- **Ordering undated legacy lines (prefer-newest tie-break):** treat an undated line (a legacy entry whose date could not be recovered per the Legacy date policy) as **older** than any dated line under the same subject, so a dated line always wins prefer-newest against it. If every contributing line under a subject is undated, keep the undated form and use **file order** as the deterministic tie-break — the earliest line is the merge base and later lines fold in — never fabricate a date to force an ordering.
- **Retire** a line only when it is **clearly stale or fully superseded** — its subject no longer exists, or a newer same-subject line completely covers it. Retirement is a proposal shown in the diff with a one-line reason, never silent.
- **Leave untouched** any entry that is already atomic, single-subject, and not duplicated — a no-op line stays byte-for-byte.

The guard against an over-eager merge/retirement is the **human-approved diff** in Step 4, backed by git — not the model's confidence. Bias toward keeping a distinct fact; when unsure whether two lines share a subject, leave them separate.

### 4. Present the diff and gate on approval

- Compose the proposed rewritten file in a scratch buffer. Show a **unified diff** (proposed vs current) so every merge, split, retirement, and re-key is visible as exact before/after. Group the diff by subject cluster and annotate each retirement with its one-line reason.
- Summarize the deltas: `<n>` entries → `<m>` entries; `<k>` merges, `<r>` retirements, `<s>` legacy entries reshaped into atomic lines.
- **Wait for explicit approval.** Never rewrite unattended. If no user is present to approve (a headless/non-interactive run), print the proposed diff and **stop without writing** — the sweep is advisory-only until a human approves. On rejection, change nothing and exit.

### 5. Rewrite (only after approval)

- If Step 3 of the preconditions flagged no git anchor, write the `<file>.bak` sibling **now, before** touching the original.
- Write the approved content to the file with `Write` (full-file rewrite — the whole `^## ` set is restructured at once), preserving the header and any non-entry lines exactly.
- Do **not** commit — leaving the change unstaged keeps git's prior version as the live anchor and lets you review, amend, or `git checkout -- <file>` to revert. Committing is your call.

### 6. Report

Print a short summary:

```
## Lessons-consolidate — <path>
Before: <n> entries, <lines> lines (<over|under> the ~40-entry / ~500-line cap)
After:  <m> entries
  merges:     <k>
  retirements:<r>  (stale/superseded — see diff)
  reshaped:   <s>  (dense legacy entries split into atomic lines)
Anchor: git (tracked) | backup written to <file>.bak (untracked/ignored)
Rewrite applied — review `git diff <file>` (or the .bak) before committing.
```

On rejection or a headless run, report that nothing was written and the diff was advisory only.

## Boundaries

**Will Not:**
- Capture new lessons, promote to `CLAUDE.md`, move ticket folders, flip `status`, or touch flow state — it only reshapes one file.
- Spawn subagents (no `Task`) or use MCP.

## Error Handling

- Malformed / unparseable entry → leave it byte-for-byte and surface it in the report; never drop or "repair" a line the parser can't classify.
