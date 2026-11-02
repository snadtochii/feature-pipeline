# Review Memory — rounds, follow-ups and earlier dismissals

How `review` decides what a run covers for this model, and how it filters findings against earlier replies. Read by `review` Steps 2 and 3 only.

`<OWNER>`, `<REPO>`, `<NUMBER>`, `<PR_URL>` and `<HEAD_SHA>` are the values `review` Step 1 bound from `gh`'s output. `<AGENT>` is the validated `--agent` value. Shell state does not persist between tool calls, so `<LAST>` and each kept `<sha>` are printed values, written as literals in every later call.

## §1 Rounds

A model's rounds are its distinct reviewed heads on this PR, ship's markers included, since ship posts under the same login. Two markers at one head are one round. A head that added only merge commits since an earlier marked head is not a round, even when a review there has findings: it reads only what those merges changed by hand (§4), which is usually nothing. Comments from any other account never count.

One Bash call. It prints this model's earlier heads and nothing else, each followed by `merge-only` when its only marker is on §2's merge-only comment, so it runs before findings are formed without touching their independence:

```bash
VIEWER=$(gh api user --jq .login) \
  && PR_JSON=$(gh pr view "<PR_URL>" --json comments,reviews) \
  && [ -n "$VIEWER" ] \
  || { echo "round read failed" >&2; exit 2; }
printf '%s' "$PR_JSON" | jq -r --arg viewer "$VIEWER" --arg agent "<AGENT>" --arg head "<HEAD_SHA>" '
  [(.comments + .reviews)[] | select(.author.login == $viewer) | .body as $b | $b | split("\n")[]
   | capture("^<!-- fp-review agent=" + $agent + " head=(?<h>[0-9a-f]{40}) -->\r?$")
   | {h, quiet: ($b | startswith("Only base merges landed since my last review"))}]
  | group_by(.h) | map(select(.[0].h != $head)) | .[]
  | .[0].h + (if all(.quiet) then " merge-only" else "" end)'
```

- **No heads** → a full review.
- **One head** → §2, with that head as `<LAST>`.
- **Two or more heads** → the count below.
- **Exit 2** → a `⚠ Failures` row and no review. The next run retries.

The count is one Bash call, with those heads written as literals, space-separated, for `<HEADS>`, and the ones labelled `merge-only` likewise for `<QUIET>`, which may be empty. It prints the heads that are rounds, then a `nearest <sha>` line naming the marked head closest behind `<HEAD_SHA>`, when one is its ancestor:

```bash
ALL=$(gh api "repos/<OWNER>/<REPO>/pulls/<NUMBER>/commits?per_page=100" --paginate --jq '.[] | ((.parents | length) | tostring) + " " + .sha') \
  || { echo "commit list failed" >&2; exit 2; }
[ "$(printf '%s\n' "$ALL" | wc -l)" -ge 250 ] && { printf '%s\n' <HEADS>; exit 0; }
OWN=$(printf '%s\n' "$ALL" | sed -n '/^2 /!s/^[0-9]* //p')
for CUR in <HEADS>; do
  case " <QUIET> " in *" $CUR "*) continue ;; esac
  printf '%s\n' "$ALL" | grep -q " $CUR\$" || { printf '%s\n' "$CUR"; continue; }
  ROUND=1
  for PRIOR in <HEADS>; do
    [ "$PRIOR" = "$CUR" ] && continue
    OUT=$(gh api "repos/<OWNER>/<REPO>/compare/$PRIOR...$CUR?per_page=100" --paginate --jq '.status, .commits[].sha' 2>&1)
    RC=$?
    case "$RC:$OUT" in
      0:ahead*) ;;
      0:*) continue ;;
      *"HTTP 404"*) continue ;;
      *) echo "compare failed: $OUT" >&2; exit 2 ;;
    esac
    printf '%s\n' "$OUT" | grep -Fxq -f <(printf '%s\n' "$OWN") || ROUND=0
  done
  [ "$ROUND" = 0 ] || printf '%s\n' "$CUR"
done
BEST_N=
for CUR in <HEADS>; do
  OUT=$(gh api "repos/<OWNER>/<REPO>/compare/$CUR...<HEAD_SHA>" --jq '.status + " " + (.ahead_by | tostring)' 2>&1)
  RC=$?
  case "$RC:$OUT" in
    0:ahead*) N=${OUT#ahead } ;;
    0:*) continue ;;
    *"HTTP 404"*) continue ;;
    *) echo "compare failed: $OUT" >&2; exit 2 ;;
  esac
  if [ -z "$BEST_N" ] || [ "$N" -lt "$BEST_N" ]; then BEST_N=$N; BEST=$CUR; fi
done
[ -z "$BEST_N" ] || printf 'nearest %s\n' "$BEST"
```

A head labelled `merge-only` is never a round, because that comment states nothing was read. A head gone from the PR's commit list, after a force-push or because the base advanced past it, always counts, because the commit list no longer shows what its review read. Any other head stops being a round only when an earlier marked head is its ancestor and no PR commit other than a two-parent merge lies between them. The earliest head always counts, and so does a head on a rewritten branch or one whose commit is gone, because each of those got a full review. A commit list of 250 or more cannot be intersected, so every head counts.

- **One head printed, or none** → §2, with the `nearest` head as `<LAST>`, so a merge already read is not read again, or with any head of `<HEADS>` when there is no `nearest` line.
- **Two or more printed** → §3. The `nearest` line plays no part.
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
KEPT=$(printf '%s\n' "$ALL" | grep -F -f <(printf '%s\n' "$RANGE")) || true
printf '%s\n' "$KEPT" | grep -Eq '^([3-9]|[1-9][0-9]+) ' && { echo FULL; exit 0; }
echo FOLLOW-UP
printf '%s\n' "$KEPT" | sed -n 's/^[01] /commit /p; s/^2 /merge /p'
```

`ahead` means `<LAST>` is still an ancestor of the head. A rewritten branch reads `diverged` or `behind`, or `HTTP 404` once the commit is gone. The PR's commit list stops at 250, so a list that long cannot be intersected.

The PR's commit list leaves out anything reachable from the base, so the intersection holds the PR's commits since `<LAST>`, oldest first, each as `commit <sha>` or, with two parents, `merge <sha>`. A commit with three or more parents means a full review, because git cannot redo that merge to show its hand edits.

- **`FULL`** → a full review for this round.
- **`FOLLOW-UP` with a `commit` or `merge` line** → a follow-up over those lines. Keep each line's kind and SHA.
- **`FOLLOW-UP` with no lines** → the range holds only commits already on the base. Make no checkout and read no diff. Step 4 posts the merge-only comment below.
- **Exit 2** → a `⚠ Failures` row and no review. The next run retries.

The merge-only comment goes on a head with nothing to read, here or in §4. It carries the marker, so the head is not taken up again, uses no round (§1, which keys on its opening words), and is posted the way [`pr-comments.md`](pr-comments.md) §6 posts its comment:

```
Only base merges landed since my last review, and they add no edits of their own, so I report no blocking issues on this head.

_— 🔎 review (automated)_
<!-- fp-review agent=<AGENT> head=<HEAD_SHA> -->
```

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

One call per kept `commit`, oldest first:

```bash
gh api -H 'Accept: application/vnd.github.diff' "repos/<OWNER>/<REPO>/commits/<sha>"
```

Each kept `merge` is read through [`pr-checkout.md`](pr-checkout.md) Merge commits, which prints only what that merge changed by hand. A clean merge prints nothing. When no `commit` was kept and every merge printed nothing, there is nothing to review: Step 3 removes the checkout and Step 4 posts the merge-only comment in §2.

These diffs are the change under review, and they are what the rubric's "diff" means in a follow-up. Surrounding code in the checkout is context: a finding must be caused by, or located in, these diffs. A finding's `line` is read from the checkout at `<HEAD_SHA>`, because a commit's or merge's own line numbers can drift. A finding with no line at head goes in the summary.

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
