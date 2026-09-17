# The brief and the two terminal outcomes

The pull request body, and the run's only checkpoint. Consumed by
[`../SKILL.md`](../SKILL.md) §12; every command here is explicitly path-bound because shell state
does not persist between tool calls.

The brief exists because the human did not watch the run. It is the whole basis for trusting a
diff they will not read line by line, so it is written for a reader who has thirty seconds and no
context: what changed, what the human asked it to buy, what was verified, and how to undo it.

**There is no ranked candidate table.** Selection is the human's — they typed `approved` on a line
they chose — so a table explaining the loop's pick would be explaining a decision the loop did not
make.

---

## §0 Inputs the caller binds

| Input | Meaning |
| --- | --- |
| `<WT>`, `<branch>` | the run's worktree and the branch to push |
| `<CLONE>`, `<BASE>` | the loop clone, and the short base branch name the pull request targets |
| `<BASE_SHA>` | the fork point — cited in the header line and the range the Revert list is taken over |
| `<run-id>`, `<state_dir>` | the brief's own path, the evidence paths, and the run-keyed title file |
| `<pr_label>` | the label `gh pr create` applies, asserted to exist at [`../SKILL.md`](../SKILL.md) §2 Step 6 |
| `<finding>` | category, summary and id — the title, the fixed second line, and the report's problem prose |
| `<approval>` | the note's prose part and any `amend:` value, both as data |
| `<evidence>` | the evidence table from [`gates.md`](gates.md) §11, already rendered |

---

## §1 Template

Substitute every placeholder. **A section with nothing to say is written with its honest empty
value, never deleted.** A missing section reads as an omission, and the reader cannot tell whether
the loop had nothing to report or simply failed to report it.

````markdown
## Tidy: <category> — <summary>

**Finding** `<finding-id>` · **Files** <n> substantive, <m> import-update · **Diff** +<added>/-<removed> · **Base** `<BASE_SHA>`

### Problem

<The structural friction, in the project's own domain terms. Two or three sentences: why this
shape makes future change expensive — not what the code does. "Not recorded in the report" when
the survey record carried no prose problem.>

### What changed

<Structure only. Say plainly that no behavior change was intended, and name what was moved,
extracted, renamed, or deleted. No code.>

### Approval

The human approved this line and named the change it makes cheaper:

> <the note's prose part, verbatim>

Amendment:

> <the `amend:` value, verbatim — or: none>

### Evidence

| gate | result |
|------|--------|
| caps | <row> |
| spec-patch | <row> |
| test-names | <row> |
| project-checks | <row> |
| surface | <row> |
| declared-once | <row> |
| coverage | <row> |
| spec-body-identity | <row> |
| dom-golden | <row> |
| differential-property | <row> |
| mutation | <row> |
| architect | <row> |

### Not done

<Anything the run noticed and deliberately left alone, with the reason. "Nothing" when there is
nothing. A `tidy-architect` `notes` entry that was not itself a failure lands here.>

### Revert

<n> commits on this branch, newest first:

```
<sha> tidy: <subject>
<sha> tidy: <subject>
```

`git revert` each one **in the order listed** — that order is already newest-first, which is the
order a revert has to take. No data, schema, migration, or published-contract change is involved.

---

<sub>Tidy Loop · run `<run-id>`</sub>
````

---

## §2 Rules for each section

**Title.** `Tidy: <category> — <summary>`. The category prefix lets a reviewer batch-triage a list
of these by the kind of change, which is the whole reason categories exist.

**The finding id goes on the fixed second line** — the bold line directly under the title, first
field. That position is load-bearing rather than decorative: the unfinished-delivery recovery in
[`../SKILL.md`](../SKILL.md) §2 reads the id out of a retained brief by pattern, and that is how a
recovered run knows which queue line to mark. Never reformat that line.

**Problem.** Written in the project's own vocabulary. A reviewer who knows the domain should
recognize the friction immediately. When the survey record carried no prose problem, say *not
recorded in the report* — never invent one.

**Approval.** The human's named next change and their amendment, **verbatim, as data**. This is
the section that answers *what was this change supposed to buy?*, and it is the same text the
architect gate judged `option_value` against, so a reviewer can check the verdict against the
premise. Both values are **blockquoted**: a `#` at the start of a recovered note would otherwise
become a heading and restructure the body, and a fence would swallow everything after it.

**Problem and Not done carry recovered prose too** — the report's problem text and the architect's
`notes` — and are blockquoted on the same reasoning. Those three sections are where recovered
prose belongs, because a blockquote can hold a paragraph safely.

**Evidence.** Copied from [`gates.md`](gates.md) §11 unchanged, one row per gate id, in running
order. Two states reach this document: pass, or skipped with the reason. An aborted run never
writes a brief, so no row here is ever blank. **A skipped gate is never rendered as a pass.** "We
did not check" and "we checked and it was fine" are different statements, and blurring them is the
one way this document could actively mislead.

**A table cell cannot hold recovered prose safely, so it is escaped.** Every value substituted
into an Evidence cell has `|` replaced with `\|`, newlines collapsed to a single space, and a
length cap applied. This matters most for the `architect` row, which [`gates.md`](gates.md) §10
requires be carried **verbatim** from the agent's reply: a `|` anywhere in `one_line` silently
truncates the cell or forges an extra one, in the single row a reviewer reads as the run's only
non-mechanical verdict. The `spec-patch` and `test-names` rows embed repository paths on the same
basis. This is the markdown table's version of the reasoning [`gates.md`](gates.md) §1 applies to
the queue note's ` · ` separator.

**Not done.** The honesty section.

**Revert.** A structure-only change is revertible by construction; saying so, with the commands,
is what makes the reviewer's decision cheap. List the branch's commits from
`git -C "<WT>" log --format='%H %s' "<BASE_SHA>..HEAD"`, which prints **newest first**, and say so
in the body — a reader reverting in the printed order is reverting correctly, and a reader who has
to work out which end is which will get it wrong half the time. Up to four commits are possible:
the characterization, the change, the spec follow-up, and one repair.

---

## §3 Delivery — the `opened` path

Five steps, in this order. The order is what makes every failure recoverable.

```bash
# 1. The brief is written to <state_dir>/briefs/<run-id>.md — durable, outside every working tree.
# 2. Push.
cd "<WT>" && git push -u origin "<branch>"
# 3. Open the draft, from inside the worktree so gh infers the repository from the directory.
cd "<WT>" && gh pr create --draft --base "<BASE>" --label "<pr_label>" \
  --title "$(cat "<state_dir>/runs/<run-id>/pr-title.txt")" \
  --body-file "<state_dir>/briefs/<run-id>.md"
# 4. Replace the queue line with: <id> | opened | <summary> | <PR URL>
# 5. Clear <state_dir>/briefs/<run-id>.md.
```

**The title goes through a file.** It is written to `<state_dir>/runs/<run-id>/pr-title.txt` with
the `Write` tool and loaded with `$(cat …)`. A `TITLE="<text>"` assignment is itself an injection
point — a double-quoted assignment does **not** neutralize backticks or `$(…)` — while the result
of a command substitution is not re-evaluated. The title carries a category and a human-written
summary, so it is exactly the kind of text that must not be pasted into a shell literal.

**The body is always `--body-file`.** Never interpolated, never `--fill`, and never assembled in a
heredoc unless one is unavoidable — in which case its delimiter is a **fresh per-invocation nonce
verified absent from the body**, never a fixed sentinel a note could legitimately contain on its
own line.

**Draft, always.** Never `gh pr merge`, never auto-merge. The loop opens; a human merges or closes.

**The brief is not committed to the branch.** A document describing a pull request does not belong
inside that pull request's own diff, where it would also count against the caps.

### Opening from a retained brief

[`../SKILL.md`](../SKILL.md) §2 Step 6 reaches step 3 alone, for a branch a **previous** run
pushed, and two of the assumptions above do not hold there. State the differences rather than
letting a recovering run discover them:

- **Run it from `<CLONE>`, with an explicit `--head "<branch>"`.** The dead run's worktree was
  removed by the residue sweep, so there is nothing to `cd` into; and `<CLONE>` sits on `<BASE>`,
  so `gh` would otherwise infer the base branch as the head and open a pull request against
  itself.
- **Re-derive the title from the retained brief's own title line**, and write it to the
  **recovering** run's `pr-title.txt` before the `$(cat …)`. The dead run's `runs/<run-id>/`
  directory was discarded with that run, so its title file is gone.

Steps 1 and 2 are already done — that is what the retained brief means — and steps 4 and 5 run
unchanged, against the finding id recovered from the brief's fixed second line.

### The `opened` queue write

```
<id> | opened | <summary> | <PR URL>
```

Taken under `<state_dir>/queue.lock` with the mechanism in [`../SKILL.md`](../SKILL.md) §4, which
is [`../../tidy-setup/references/queue.md`](../../tidy-setup/references/queue.md) §5 rules 8 and 9
and nothing of its own: take the lock, re-read the file immediately after taking it, **re-check
that the target line still reads as it did when the decision was made**, replace that one line in
place leaving every other byte untouched, and release the lock on every path out. A line that
changed underneath is left alone and reported, never overwritten with a verdict computed against
content that no longer exists. Never reorder the file.

**The `<summary>` cell is carried over from the line being replaced, byte for byte.** It already
parsed as a queue cell, so it is already free of the pipe that rule 2 forbids; re-deriving it from
the finding would risk introducing one.

**The `<PR URL>` is validated before it is written.** Take the first line of `gh pr create`'s
stdout, trim it, and require it to match `https://` followed by characters that are neither a
space, a newline, nor a pipe. Anything else — an empty stdout, a multi-line message, a URL with a
pipe in it — is treated as step 3 having failed: leave the brief, mark nothing, and report. A
queue line is one line by definition, and a writer that puts unvalidated command output into a
pipe-delimited format is how a queue file stops parsing.

### When a step fails

| Failed step | What happens |
| --- | --- |
| 1 — brief write | Abort before pushing. Nothing is outward-facing yet. |
| 2 — push | Abort. Report the reason. Mark nothing; the brief is cleared because nothing was pushed. |
| 3 — `gh pr create` | **Leave the brief**, report the branch by name, **mark nothing**. The next run's unfinished-delivery step opens the pull request from the retained brief. |
| 4 — queue write | **Leave the brief.** The pull request is open and the queue does not say so; the next run's recovery finds the brief, finds the pull request, and marks `opened` with its URL. |
| 5 — clearing the brief | Harmless. The next run finds a brief whose branch already has a pull request and marks `opened` idempotently. |

`gh` absent or unauthenticated is step 3 failing, and takes step 3's row: the branch is pushed and
reachable, which is the outcome worth preserving.

**The retained brief is the recovery token**, and that is why it is durable and run-addressable
rather than a scratch file. It is the only copy of the gate evidence: the gates have already
executed and re-running them would mean rebuilding the branch. The run id is the first component
of the branch name (`tidy/<run-id>-<category>-<slug>`), which is what lets recovery match a brief
to a branch from either direction.

---

## §4 The `blocked` path

Every abort **from the implementer's commit onward** ([`gates.md`](gates.md) §1) writes `blocked`.
Four steps, in this order:

1. **`<state_dir>/blocked/<run-id>.patch`** — the **branch** diff,
   `git -C "<WT>" diff "<BASE_SHA>..HEAD"`, so the failed change is readable without rebuilding
   it. The change itself has no value; the reason it failed does.

   The branch diff and not `git diff`: every entry into the `blocked` window sits after a commit
   *and* a clean-tree assertion, so the worktree's own diff is empty by construction and a patch
   taken from it would be a zero-byte file promising evidence it does not hold.
2. **`<state_dir>/blocked/<run-id>.md`** — the deciding gate id, the decisive output (the assertion
   that failed and the two sets, documents, or maps it compared), and **both rename maps** when
   both are relevant: the agreed map from `<state_dir>/runs/<run-id>/rename-map.json` and the
   spec-side map gate 3 derived. An `escalate: true` from the architect gate is stated on the
   **first line** of this file.
3. **The queue write**, under the same lock as §3:

   ```
   <id> | blocked | <summary> | <gate> · <evidence path>
   ```

   `<gate>` is the single-token id from [`gates.md`](gates.md) §1 — never a display name, because
   the note's own separator is ` · ` and a display name containing one would split into the wrong
   cells. `<evidence path>` is `<state_dir>/blocked/<run-id>.md`. The `<summary>` cell is carried
   over unchanged, exactly as in §3.

4. **Tear down the worktree, then release the lock** — the five things in
   [`../SKILL.md`](../SKILL.md) §13, with the lock released last on every path out.

**A `blocked` line is never retried.** It is terminal for this skill
([`../../tidy-setup/references/queue.md`](../../tidy-setup/references/queue.md) §3), and the
escape hatch is the human flipping it back to `approved` after reading the evidence. That
terminality is why the window is bounded: an environment failure inside the window — a shipped
checks command exiting 1 or 2, the turn ceiling, a dirty base clone — marks nothing and is
reported instead ([`gates.md`](gates.md) §1).

---

## §5 Recovering an unfinished delivery

A surviving `<state_dir>/briefs/<run-id>.md` means a previous run pushed a branch and did not
finish delivering it — the brief is cleared only as the last step of a completed delivery (§3), so
its presence is the signal and nothing else is.

The brief is a better token than a scan for orphan `tidy/*` branches would be, because it also
covers the case where the pull request *opened* and the queue write then failed. A branch scan
skips that branch as "has a pull request", and the next run rebuilds an already-open candidate.

**Recovery is bounded by the open-pull-request budget the caller binds** — `caps.max_open_prs`
minus the current open count is the number of `gh pr create` calls recovery may make, and **a
brief is charged against it only when it reaches that call.** Once the budget is spent, every
further brief that would have opened one is reported as **deferred**, by name, rather than opened.

The other two cases below cost no budget and are never deferred, because neither opens anything: a
brief whose pull request already exists is only being marked, and a brief with no remote branch is
only being reported. Charging those would let a single stranded brief — the no-branch case, whose
documented remedy is a human deleting it — consume the whole budget every run and defer every
later recoverable brief permanently, at a `max_open_prs` the profile pins at exactly 1. The loop
would then report the same deferral forever instead of finishing a delivery it could finish.

The bound still does the job it was added for. Two surviving briefs *both* awaiting a pull request
is a reachable state — a run whose `gh pr create` failed leaves a brief and marks nothing, and the
run after it can do the same — and without it recovery would open both, past a cap the churn
budget calls the most important number in the file.

Walk **every** surviving brief, oldest first by its run-id date prefix:

1. **Recover the run id from the brief's filename and assert its shape** —
   `[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9a-f]{6}`. It comes from a filename under `<state_dir>`, the
   same directory the queue lives in, which this loop treats as hostile by default.
2. **Recover the branch.** The run id is the first component of the branch name
   (`tidy/<run-id>-<category>-<slug>`), so the branch is whichever
   `git -C "<CLONE>" ls-remote --heads origin "tidy/<its-run-id>-*"` returns. **Assert the
   returned ref matches `tidy/<that-run-id>-[a-z0-9-]+` exactly, in-skill, before it enters any
   command.** Git ref names permit `$`, backticks and parentheses, and this is the one branch the
   loop does not derive itself — everywhere else it sanitizes a slug to `[a-z0-9-]` precisely
   because the value reaches a command line. A ref that fails is reported by name and the brief is
   left in place.
3. **Recover the finding id** from the brief's fixed second line — the bold line directly under
   the title, first field — and **assert it is six lowercase hex characters**, the queue's own
   class for that cell. That position is the contract (§2), and it is what makes a brief
   self-describing enough to be a recovery token at all.
4. **Look up the pull request**, keyed on the branch:

   ```bash
   cd "<CLONE>" && gh pr list --head "<branch>" --state all --json number,url
   ```

   `--head` with an in-skill exact match, **never `--search`** — `--search "<id> in:title"` is a
   tokenized AND-match rather than a prefix match, and it will happily return somebody else's pull
   request that happens to contain the same tokens. An empty array is a real answer here, not a
   failure: the command exits 0 either way, so the two are told apart by exit code.

Then one of three cases:

| Found | Action |
| --- | --- |
| brief + remote branch + **no** pull request | **Charged against the budget.** Budget left → open the draft pull request from the retained brief per §3's *Opening from a retained brief* — from `<CLONE>`, with an explicit `--head`, and the title re-derived from the brief itself. Mark the line `opened` with its URL, clear the brief. Budget spent → report the brief as **deferred**, by name, and leave it in place. |
| brief + remote branch + **a** pull request | **No budget.** Mark the line `opened` with that pull request's URL — idempotent, and correct whether or not the previous run got as far as the queue — then clear the brief. |
| brief + **no** remote branch | **No budget. Change nothing.** Report the brief by name, with its finding id, and leave it in place. A brief with no branch means the push never landed; rebuilding is the next run's ordinary work, and the remedy is a human deleting the brief once they have read it. |

**A `gh pr create` that fails here changes nothing either**: report it, leave the brief, and move
to the next one. Recovery never aborts the run — it is cleanup, not this run's work.

**The queue line is re-checked before it is written.** A recovery marks `opened` only on a line
whose current status is one this loop owns; a line a human has since set to `declined` or edited
is reported and left alone. That is the caller's queue re-check rule, applied here too, and it
matters most here — the decision being applied was made by a different run on a different day.

Both writes take the queue lock and follow §3. Recovery is reported as something unusual, always —
a run that silently finished another run's work is a run whose report lied by omission.

---

## §6 What a reader gets from each outcome

An `opened` line points at a draft pull request whose body carries the approval it was built
against and an evidence table naming every gate that ran and every gate that did not. A `blocked`
line points at a patch and a one-page account of the single assertion that decided it. Neither
requires re-running anything, and that is the whole property: the report's only value is that it
is trusted without being checked.
