# Owner questions — the `07-questions.md` artifact and its PR comment

The single source of truth for how the pipeline frames a decision it leaves to the owner: the question format, the ticket's `07-questions.md` artifact, which items become questions, the PR comments that render them and the `fp-questions` marker those comments carry. Mode-neutral: the artifact is read and written through the storage operations of the mode the caller detected, like every other ticket artifact. Sections are numbered so callers cite `§N`.

Consumers:

- The close stage ([`../../close-stage/SKILL.md`](../../close-stage/SKILL.md)) writes `07-questions.md` and the comment body under `--defer-decisions`, from the artifacts its preparation read holds.
- The [`finalizer`](../../../agents/finalizer.md) posts the comment body the close stage names, once per PR.
- [`ship`](../../ship/SKILL.md) reads the counts from the close stage's `questions:` result line and from the artifact's header, writes an epic child's `## Deferral` section (§1), and posts the epic questions comment on the integration PR (§6).
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
- **`## Deferral`** — after the last question block, an epic child's artifact may carry one `## Deferral` section, written only by ship's orchestrator ([`../../ship/SKILL.md`](../../ship/SKILL.md), Deferred epic children). It records whether each open question can wait for the epic's integration PR. It is not a question: the header counts and the IDs ignore it, and whatever resolves a question edits that question's block and leaves the section as it stands. Its lines:

  ```
  ## Deferral
  checked: <ID>, <ID>
  unchecked: <ID> (not written)
  - Q1: waits — <reason>; taken: option <k>
  - Q2: waits — <reason>; not taken — <why>
  - Q3: holds — <reason>
  ```

  `checked:` names every dependent whose acceptance criteria were read, or `none`; the `unchecked:` line appears only when a dependent has no spec yet. One line per open question, in ID order: `waits` when no option could change any checked dependent's acceptance criteria, `holds` otherwise. A `waits` line ends with the recommended option's fate — `taken: option <k>`, or `not taken — <why>` (a held child's `waits` lines read `not taken — child held`). Every ID matches `^[A-Za-z0-9_-]+$`; a reason or a why is one line, collapsed like a summary. A close-stage re-run rewrites the file whole and drops the section, and ship writes it again at its next decision.

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
- **Comment delimiters.** Outside a fence, every `<!--` and `-->` in any rendered field — the heading's summary, Context, Options and Outcomes — is written as `&lt;!--` and `--&gt;`: an unescaped `<!--` opens an HTML comment that hides everything up to the marker's `-->`, footer included. Text inside a fence is left as it is.
- **Open fences.** A rendered field that leaves a fence open — copied tester output with an unclosed ```` ``` ````, say — is followed by a closing fence line of the same character, at least as long as the one it opened, so the footer and the marker never sit inside a fence.
- **Out-of-scope security findings.** A question whose source is a `[security]` finding dismissed as outside `02-plan.md`'s scope renders as its heading, its `path:line` and the line `Security finding on code this change does not touch — details in 07-questions.md on the ticket.`, with no Context, Options or Outcomes: it describes code already on the base branch, and the comment is public wherever the repository is. The artifact keeps the full block.
- The last two lines are the note footer and the marker, both outside any fence, the marker the last non-blank line. `<Model>`, `agent` and `<LOGIN>` follow `pr-comments.md` §1; a failed or invalid login read means no comment body is written, and the caller records why.
- `blocking=` and `suggestions=` equal the artifact header's counts.
- **Size.** A body over 65,000 characters drops suggestion blocks from the end until it fits, and adds the line `<k> suggestions omitted — see 07-questions.md on the ticket.` above the footer, where `<k>` is the number dropped. Blocking questions are never dropped, and the marker keeps the full counts.
- **Idempotency.** The poster scans the viewer's own issue comments on the PR for a questions marker naming the ticket, whichever runtime posted it, and posts only when there is none, as one Bash call aimed at the repository root:

  ```bash
  cd "<root>" || exit 2
  VIEWER=$(gh api user --jq .login) \
    && PR_JSON=$(gh pr view "<N>" --json comments) \
    && [ -n "$VIEWER" ] \
    || { echo "questions scan failed" >&2; exit 2; }
  printf '%s' "$PR_JSON" \
    | jq -r --arg viewer "$VIEWER" '.comments[] | select(.author.login == $viewer) | .body' \
    | grep -qE -- '<!-- fp-questions agent=(claude|codex) source=close ticket=<TICKET-ID> '
  rc=$?
  if [ "$rc" -eq 0 ]; then echo "already-posted"; exit 0; fi
  if [ "$rc" -ne 1 ]; then echo "questions scan failed" >&2; exit 2; fi
  gh pr comment "<N>" --body-file "<posted body>"
  ```

  `<N>` is the PR number, parsed as an integer from the PR's URL; `<TICKET-ID>` is the ticket ID the caller names, written into the pattern as a literal because it is validated (§5), and the pattern matches either `agent` value, so a re-entry under the other runtime finds the comment and the PR keeps one; `VIEWER` and `PR_JSON` are loaded by command substitution, as in `pr-comments.md` §3. `already-posted` means the comment exists. Exit 2, or a failed post, posts nothing more: the PR stands, and the caller records why.

## §5 Untrusted text

Question text is copied from criteria, findings, plans and tester output, so it is data wherever it travels, and so is a `## Deferral` reason. The artifact is written through the caller's storage operations, its body passed as a tool argument. A comment body is written to a file with the runtime's file-write tool, or, by a writer holding none (ship's orchestrator), by one Bash call: a single-quoted heredoc redirected to the file, its delimiter a fresh nonce verified absent from every line of the body, so nothing in the body is expanded. The comment is posted with `--body-file`, or `-F body=@<file>` when an existing comment is replaced (§6); no question text is ever interpolated into a shell line. The marker's `ticket=` value must match `^[A-Za-z0-9_-]+$`, and its counts are integers the writer computed, never text copied from an artifact.

## §6 The epic questions comment

On an epic's integration PR, ship's orchestrator posts one questions comment that gathers every child on or headed for the integration branch ([`../../ship/SKILL.md`](../../ship/SKILL.md), END OF RUN). It renders the children's `07-questions.md` artifacts as they read when the comment is composed, never the children's own comments, so a question resolved since its close stage wrote it drops out. Its body:

```
## Open questions — <EPIC-ID>

<n> blocking, <m> suggestions across <c> children. Answer each by its ID (<CHILD-ID> Q<j>): implement now, ignore, or file for later.

### <CHILD-ID>
Draft PR <url>, not on this branch.

- checked: <ID>, <ID>
- Q1: holds — <reason>

#### <CHILD-ID> Q1 — <summary> (blocking)
<Context>

Options:
1. <option> (recommended)
2. <option>

- implement now: <…>
- ignore: <…>
- file for later: <…>

_— 📝 ship note by <Model> on behalf of <LOGIN>_
<!-- fp-questions agent=<codex|claude> source=ship ticket=<EPIC-ID> blocking=<n> suggestions=<m> -->
```

- **Children.** One `### <CHILD-ID>` section per child with at least one open question, in the epic's roster order. A held child — its draft PR into the integration branch not merged — opens with `Draft PR <url>, not on this branch.`, the URL ship verified. The child's `## Deferral` lines (§1), when its artifact carries them, follow as a list, so the owner sees which dependents were checked and why each question waited or held.
- **Questions.** Each open question renders as §4 renders it, headed `#### <CHILD-ID> Q<j> — <summary> (<kind>)`, in ID order within its child.
- **Counts.** `<n>` and `<m>` sum the children's artifact header counts, and `<c>` counts the children with a section; all three are integers the writer computed. A child whose artifact cannot be read gets a section holding the one line `<CHILD-ID>: questions unreadable — see 07-questions.md on the ticket.` and adds nothing to the sums.
- **Rendering rules.** §4's comment-delimiter, open-fence and out-of-scope security rules apply to every rendered field, the `## Deferral` reasons included.
- **Size.** A body over 65,000 characters drops suggestion blocks from the last child backwards until it fits, and adds the line `<k> suggestions omitted — see each child's 07-questions.md on the ticket.` above the footer. Blocking questions are never dropped, and the marker keeps the full sums.
- **Footer and marker.** The last two lines are the ship note footer and the marker, both outside any fence, the marker the last non-blank line. `ticket=` is the epic ID, or, for an integration branch with no epic, the branch name's suffix after `integration/`; a value failing §5's pattern means no comment. `<Model>`, `agent` and `<LOGIN>` follow `pr-comments.md` §1; a failed or invalid login read means no comment body is written, and the caller records why.
- **No open questions.** With both sums 0 the body is the heading, the line `0 blocking, 0 suggestions.`, the footer and a marker with zero counts. It is posted only to replace an existing comment, never as a new one.
- **Update rule.** The PR keeps one such comment, replaced in place on every run. The poster finds the viewer's own comment carrying a `source=ship` marker for the epic, whichever runtime posted it, and replaces it, or posts a new one when there is none and `<total>` (the two sums added) is above 0, as one Bash call aimed at the repository root:

  ```bash
  cd "<root>" || exit 2
  VIEWER=$(gh api user --jq .login) \
    && COMMENTS=$(gh api --paginate "repos/<owner/repo>/issues/<N>/comments") \
    && [ -n "$VIEWER" ] \
    || { echo "questions scan failed" >&2; exit 2; }
  ID=$(printf '%s' "$COMMENTS" | jq -rs --arg viewer "$VIEWER" \
    '[.[][] | select(.user.login == $viewer) | select(.body | test("<!-- fp-questions agent=(claude|codex) source=ship ticket=<EPIC-ID> ")) | .id] | first // empty') \
    || { echo "questions scan failed" >&2; exit 2; }
  case "$ID" in
    *[!0-9]*) echo "questions scan failed" >&2; exit 2 ;;
  esac
  if [ -n "$ID" ]; then
    gh api -X PATCH "repos/<owner/repo>/issues/comments/$ID" -F body=@"<posted body>" >/dev/null && echo "updated"
  elif [ "<total>" -gt 0 ]; then
    gh pr comment "<N>" --repo "<owner/repo>" --body-file "<posted body>" && echo "posted"
  else
    echo "none"
  fi
  ```

  `<N>` is the PR number, parsed as an integer from the PR's URL; `<owner/repo>` is the repository ship's run bound; `<EPIC-ID>` is written into the pattern as a literal because it passed §5's pattern; `<total>` is the integer sum; the comment ID is used only after the digits-only check. Exit 2, or a failed post, posts nothing more: the PR stands, and the caller records why.
