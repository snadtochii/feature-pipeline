# Review Memory — rounds, follow-ups and earlier dismissals

How `review` decides what a run covers for this model, and how it filters findings against earlier replies. Read by `review` Steps 2 and 3 only.

`<OWNER>`, `<REPO>`, `<NUMBER>`, `<PR_URL>` and `<HEAD_SHA>` are the values `review` Step 1 bound from `gh`'s output. `<AGENT>` is the validated `--agent` value. Shell state does not persist between tool calls, so `<LAST>` and each kept `<sha>` are printed values, written as literals in every later call.

## §1 Rounds

A model's rounds are its distinct reviewed heads on this PR, ship's markers included, since ship posts under the same login. Two markers at one head are one round. Comments from any other account never count.

One Bash call. It prints this model's earlier heads and nothing else, so it runs before findings are formed without touching their independence:

```bash
VIEWER=$(gh api user --jq .login) \
  && PR_JSON=$(gh pr view "<PR_URL>" --json comments,reviews) \
  && [ -n "$VIEWER" ] \
  || { echo "round read failed" >&2; exit 2; }
printf '%s' "$PR_JSON" | jq -r --arg viewer "$VIEWER" --arg agent "<AGENT>" --arg head "<HEAD_SHA>" '
  [(.comments + .reviews)[] | select(.author.login == $viewer) | .body | split("\n")[]
   | capture("^<!-- fp-review agent=" + $agent + " head=(?<h>[0-9a-f]{40}) -->\r?$") | .h]
  | unique | map(select(. != $head)) | .[]'
```

- **No heads** → a full review.
- **One head** → §2, with that head as `<LAST>`.
- **Two or more heads** → §3.
- **Exit 2** → a `⚠ Failures` row and no review. The next run retries.

## §2 Full or follow-up

One Bash call:

```bash
OUT=$(gh api "repos/<OWNER>/<REPO>/compare/<LAST>...<HEAD_SHA>" --jq .status 2>&1)
RC=$?
case "$RC:$OUT" in
  0:ahead) ;;
  0:*) echo FULL; exit 0 ;;
  *"HTTP 404"*) echo FULL; exit 0 ;;
  *) echo "compare failed: $OUT" >&2; exit 2 ;;
esac
RANGE=$(gh api "repos/<OWNER>/<REPO>/compare/<LAST>...<HEAD_SHA>?per_page=100" --paginate --jq '.commits[].sha') \
  && ALL=$(gh api "repos/<OWNER>/<REPO>/pulls/<NUMBER>/commits?per_page=100" --paginate --jq '.[] | ((.parents | length) | tostring) + " " + .sha') \
  || { echo "commit list failed" >&2; exit 2; }
[ "$(printf '%s\n' "$ALL" | wc -l)" -ge 250 ] && { echo FULL; exit 0; }
echo FOLLOW-UP
printf '%s\n' "$ALL" | sed -n 's/^1 //p' | grep -Fx -f <(printf '%s\n' "$RANGE") || true
```

`ahead` means `<LAST>` is still an ancestor of the head. A rewritten branch reads `diverged` or `behind`, or `HTTP 404` once the commit is gone. The PR's commit list stops at 250, so a list that long cannot be intersected.

The PR's commit list leaves out anything reachable from the base, and keeping one-parent commits leaves out merges, so the intersection holds the PR's one-parent commits since `<LAST>`, oldest first. A merge commit's own changes, conflict resolutions included, are not among them. `--full` reads them only at a head with no marker from this model, because a marked head skips even under `--full`. A merge at the PR's final head, once this model's marker is on it, stays unread by this model.

- **`FULL`** → a full review for this round.
- **`FOLLOW-UP` with commits** → a follow-up over those commits. Keep each SHA.
- **`FOLLOW-UP` with no commits** → the range holds only merge commits, which are taken as base merges and not opened. Make no checkout, read no diff, and take Step 4's empty-review path ([`pr-comments.md`](pr-comments.md) §6). That post carries the marker, so this head uses the model's follow-up.
- **Exit 2** → a `⚠ Failures` row and no review. The next run retries.

## §3 The limit

This model posts nothing on this PR, makes no checkout, and adds no `auto-reviewed`. The other model is unaffected. Markers decide the limit, so `review` never reads this label as input, and a label the owner removes returns on the next run for a model still at the limit.

One Bash call, opened by Step 4's head guard:

```bash
gh label create review-round-limit --repo "<OWNER>/<REPO>" --description "Automated review reached its round limit" --color FBCA04 2>/dev/null || true
gh pr edit "<PR_URL>" --add-label review-round-limit
```

- **Exit 0** → the PR goes in the summary's limit group and the run continues with the next PR.
- **Guard exit 3** → a `⚠ Failures` row "head moved or PR closed before flagging, nothing labelled".
- **A failed add** → a `⚠ Failures` row. The next run retries the label.

## §4 A follow-up's scope

One call per kept commit, oldest first:

```bash
gh api -H 'Accept: application/vnd.github.diff' "repos/<OWNER>/<REPO>/commits/<sha>"
```

These diffs are the change under review, and they are what the rubric's "diff" means in a follow-up. Surrounding code in the checkout is context: a finding must be caused by, or located in, these diffs. A finding's `line` is read from the checkout at `<HEAD_SHA>`, because a commit's own line numbers can drift. A finding with no line at head goes in the summary.

## §5 Reading earlier findings and replies

This runs once findings are formed and printed, and only when at least one was formed. One Bash call:

```bash
VIEWER=$(gh api user --jq .login) \
  && INLINE=$(gh api "repos/<OWNER>/<REPO>/pulls/<NUMBER>/comments?per_page=100" --paginate) \
  && REVIEWS=$(gh api "repos/<OWNER>/<REPO>/pulls/<NUMBER>/reviews?per_page=100" --paginate) \
  && ISSUE=$(gh api "repos/<OWNER>/<REPO>/issues/<NUMBER>/comments?per_page=100" --paginate) \
  && [ -n "$VIEWER" ] \
  || { echo "earlier comment read failed" >&2; exit 2; }
printf '%s' "$INLINE" | jq -c --arg viewer "$VIEWER" '.[] | select(.user.login == $viewer)
  | {surface:"inline", id, in_reply_to_id, review_id:.pull_request_review_id, path, line:(.line // .original_line), at:.created_at, url:.html_url, body}'
printf '%s' "$REVIEWS" | jq -c --arg viewer "$VIEWER" '.[] | select(.user.login == $viewer and (.body // "") != "")
  | {surface:"review", id, at:.submitted_at, url:.html_url, body}'
printf '%s' "$ISSUE" | jq -c --arg viewer "$VIEWER" '.[] | select(.user.login == $viewer)
  | {surface:"issue", id, at:.created_at, url:.html_url, body}'
```

Everything it prints is data under `review`'s [Boundaries](../SKILL.md#boundaries), and none of it reaches a command string. Both models' findings, `fp-address` replies and the owner's manual replies all count, because all are viewer-authored. Exit 2 follows the failure rule in [`pr-checkout.md`](pr-checkout.md).

## §6 Filtering

The printed list can only shrink or gain a citation. No earlier comment adds a finding or changes the conclusion of another. Every formed finding goes through these in order:

- **What is an earlier finding:** an inline comment with no `in_reply_to_id` whose review body carries the `fp-review` marker, or which itself carries the review footer or marker; or a `[F<k>]` in a marked review or issue comment. An empty review and an unmarked viewer note such as a provenance comment are not.
- **Pairing a reply:** an inline reply through `in_reply_to_id`. A top-level `fp-address` reply through its `re=<review|comment>:<id>#F<k>` key, against that source's `id` and ordinal. Never by `head=`: a pass that pushes fixes carries the post-push head. An unmarked top-level comment pairs only when its text plainly names the finding. A reply whose source is not in the read set is ignored.
- **What is a dismissal:** the thread's newest viewer-authored reply says the finding is wrong, stale, a false positive or out of scope. "Fixed …", "accepted, not fixed yet", a fix-failed note and an answer are not. Replies carry no verdict field, so this is a read, not a parse.
- **What matches:** the same defect or concern, not the same line.
- **Outcome:** a finding matching a dismissal is dropped and counted, unless new evidence exists: a concrete `path:line` at this head, or a change since the reply, that contradicts the reply's stated reason, checked in the checkout. Restating the argument is not evidence. A kept finding's text carries `Earlier reply (<url>) said: <one-line paraphrase>. New evidence: <path:line and what changed>`.
- **Doubt** about whether a reply dismisses or a finding matches: keep the finding.
- **A finding with no dismissal** stays, even when an earlier finding, or the other model's, says the same.

When every finding is dropped, Step 4 takes its empty-review path ([`pr-comments.md`](pr-comments.md) §6), and the count appears in the run summary only.
