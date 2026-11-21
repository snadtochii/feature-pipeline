# Owner questions — the `07-questions.md` artifact and its PR comment

The single source of truth for how the pipeline frames a decision it leaves to the owner: the question format, the ticket's `07-questions.md` artifact, which items become questions, the PR comment that renders them and the `fp-questions` marker that comment carries. Mode-neutral: the artifact is read and written through the storage operations of the mode the caller detected, like every other ticket artifact. Sections are numbered so callers cite `§N`.

Consumers:

- The close stage ([`../../close-stage/SKILL.md`](../../close-stage/SKILL.md)) writes `07-questions.md` and the comment body under `--defer-decisions`, from the artifacts its preparation read holds.
- The [`finalizer`](../../../agents/finalizer.md) posts the comment body the close stage names, once per PR.
- [`ship`](../../ship/SKILL.md) reads the counts from the close stage's `questions:` result line and from the artifact's header.
- Whatever reads a run's drafts, or resolves their questions, reads the artifact and the marker in this grammar.

The comment's signature is the note signature of [`../../review/references/pr-comments.md`](../../review/references/pr-comments.md) §1, *Signing a note*; this file adds only the marker kind that follows it.

## §1 Artifact grammar

`07-questions.md` is a numbered ticket artifact, after the close stage's `06-summary.md`. It opens with three column-0 header lines, then one block per question, in ID order:

```
ticket: <TICKET-ID>
blocking: <n>
suggestions: <m>

## Q1 — <one-line summary>
kind: blocking
status: open
origin: failed-criterion

### Context
<evidence>

### Options
1. <option> (recommended)
2. <option>

### Outcomes
implement now: <what would change, and where>
ignore: <what is accepted as it stands>
file for later: <proposed inbox title>
```

- **Header.** `ticket:` is the ticket ID. `blocking:` and `suggestions:` count the questions whose `status:` is `open`, by `kind:`; the writer computes both as integers from the blocks it writes.
- **Summary.** One line, with no `|` and no newline: a `|` is replaced by `/`, and a newline collapses to one space.
- **`kind:`** — `blocking` (the PR is not ready until it is answered) or `suggestion` (the PR can be reviewed and merged as it stands).
- **`status:`** — `open`, `ignored`, `implemented` or `filed`. The close stage writes `open` only; the other values are set by whatever resolves the question.
- **`origin:`** — the §3 source: `failed-criterion`, `tester-crash`, `review-finding`, `validation`, `stuck`, `deferred-finding`, `out-of-scope-finding` or `rough-edge`.
- **`### Context`** — the evidence a reader needs to decide without opening other files: the criterion's text and its failed entry from `05-tests.md`, screenshot paths, a finding's `path:line` and its reviewer's text, the stuck pattern and the last actions. A plan default that bears on the question is quoted here (§3). A finding about a credential or secret is named by its `path:line`, never quoted. Fenced code is allowed.
- **`### Options`** — two or three numbered options, each a real course of action, exactly one marked `(recommended)`. "Accept as it stands" is a valid option; a padding option is not.
- **`### Outcomes`** — exactly three lines, in this order. `implement now:` names the change and the files it would touch. `ignore:` names what stays as it is and what the owner accepts by leaving it. `file for later:` is the proposed title of the inbox item, one line.

## §2 IDs

IDs are `Q1`, `Q2`, … in §3 source order, assigned when the artifact is first written. They are never renumbered: a later edit changes a block's `status:` and leaves its ID. A re-run of the close stage on the same pass rewrites the file whole from the same sources, so it reproduces the same IDs. Outside the artifact a question is addressed as `<TICKET-ID> Q<n>`, which is how the comment, a report and a resolving reply name it.

## §3 Sources and classification

Every source is an artifact the close stage already holds. In source order:

| Source | `kind` | `origin` |
|---|---|---|
| Each entry under `05-tests.md` `## Failed Criteria` | blocking | `failed-criterion` |
| A `ui-tester` crash or timeout recorded there | blocking | `tester-crash` |
| Each accepted finding in `04-review.md` whose `outcome` is not `applied` | blocking | `review-finding` |
| A red validation run (`## Post-review validation`, or the close stage's own run) | blocking | `validation` |
| The stuck pattern — the handoff's `## Stuck`, a `stuck (<pattern>)` or `failed (all reviewers)` review label, or the fix loop's | blocking | `stuck` |
| Each `deferred (conflict)` finding in `04-review.md` | suggestion | `deferred-finding` |
| Each finding dismissed as outside `02-plan.md`'s scope | suggestion | `out-of-scope-finding` |
| Each handoff `rough edges` line other than `none` | suggestion | `rough-edge` |

- A finding dismissed as wrong, stale or a false positive is never a question.
- A plan `auto-resolved` default is never its own question. When it bears on a question above, it is quoted in that question's `### Context` as the choice already made.
- Two sources describing one problem — a failed criterion and the review finding that names its cause — merge into one question under the earlier source's row; the later source's evidence joins its `### Context`.
- There is no count cap.
- A `partial` or `stuck` verdict always yields at least one blocking question, because the verdict itself rests on a blocking source. A `pass` yields suggestions only, and an artifact is written only when there is at least one.

## §4 The questions comment

The comment is a rendering of the artifact, posted once per PR as an issue comment. Its body:

```
## Open questions — <TICKET-ID>

<n> blocking, <m> suggestions. Answer each by its ID (<TICKET-ID> Q<k>): implement now, ignore, or file for later.

### Q1 — <summary> (blocking)
<Context>

Options:
1. <option> (recommended)
2. <option>

- implement now: <…>
- ignore: <…>
- file for later: <…>

_— 📝 close note by <Model> on behalf of <LOGIN>_
<!-- fp-questions agent=<codex|claude> source=close ticket=<TICKET-ID> blocking=<n> suggestions=<m> -->
```

- Questions appear in ID order, open ones only, each with its kind in the heading.
- **Comment delimiters.** Outside a fence, every `<!--` and `-->` in rendered Context and Options text is written as `&lt;!--` and `--&gt;`: an unescaped `<!--` opens an HTML comment that hides everything up to the marker's `-->`, footer included. Text inside a fence is left as it is.
- **Out-of-scope security findings.** A question whose source is a `[security]` finding dismissed as outside `02-plan.md`'s scope renders as its heading, its `path:line` and the line `Security finding on code this change does not touch — details in 07-questions.md on the ticket.`, with no Context, Options or Outcomes: it describes code already on the base branch, and the comment is public wherever the repository is. The artifact keeps the full block.
- The last two lines are the note footer and the marker, both outside any fence, the marker the last non-blank line. `<Model>`, `agent` and `<LOGIN>` follow `pr-comments.md` §1; a failed or invalid login read means no comment body is written, and the caller records why.
- `blocking=` and `suggestions=` equal the artifact header's counts.
- **Size.** A body over 65,000 characters drops suggestion blocks from the end until it fits, and adds the line `<k> suggestions omitted — see 07-questions.md on the ticket.` above the footer, where `<k>` is the number dropped. Blocking questions are never dropped, and the marker keeps the full counts.
- **Idempotency.** The poster scans the viewer's own issue comments on the PR for the marker prefix and posts only when it is absent, as one Bash call aimed at the repository root:

  ```bash
  cd "<root>" || exit 2
  VIEWER=$(gh api user --jq .login) \
    && PR_JSON=$(gh pr view "<N>" --json comments) \
    && [ -n "$VIEWER" ] \
    || { echo "questions scan failed" >&2; exit 2; }
  printf '%s' "$PR_JSON" \
    | jq -r --arg viewer "$VIEWER" '.comments[] | select(.author.login == $viewer) | .body' \
    | grep -qF -- '<!-- fp-questions agent=<a> source=close ticket=<TICKET-ID> '
  rc=$?
  if [ "$rc" -eq 0 ]; then echo "already-posted"; exit 0; fi
  if [ "$rc" -ne 1 ]; then echo "questions scan failed" >&2; exit 2; fi
  gh pr comment "<N>" --body-file "<posted body>"
  ```

  `<N>` is the PR number, parsed as an integer from the PR's URL; the marker prefix is the one the caller names, a literal because its `agent` and `ticket=` values are validated (§5); `VIEWER` and `PR_JSON` are loaded by command substitution, as in `pr-comments.md` §3. `already-posted` means the comment exists. Exit 2, or a failed post, posts nothing more: the PR stands, and the caller records why.

## §5 Untrusted text

Question text is copied from criteria, findings, plans and tester output, so it is data wherever it travels. The artifact and the comment body are written with the runtime's file-write tool, and the comment is posted with `--body-file`; no question text is ever interpolated into a shell line. The marker's `ticket=` value must match `^[A-Za-z0-9_-]+$`, and its counts are integers the writer computed, never text copied from an artifact.
