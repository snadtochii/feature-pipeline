# PR Comments — shared agent-comment contract

The single source of truth for how this plugin's automation posts to and reads from GitHub pull requests: the visible role footer, the hidden machine marker, the empty-review convention, and the `gh` post/fetch command patterns. The `review` skill (this folder's `SKILL.md`) is the first consumer; `feature:address-review` consumes the same contract via `../review/references/pr-comments.md` so review comments and replies share one format.

Born here because `review` is the first surface that posts *signed* comments. Modeled on `../build/references/pr-creation.md`'s born-in-build / reused-by-sync precedent — the producing skill owns the rules, the consumer links them.

## §1 Visible role footer

Every comment an agent posts carries a one-line footer naming its **role**, on its own line at the end of the comment body:

- **Review** (the `review` skill): `_— 🔎 review (automated)_`
- **Addressed reply** (the `address-review` skill): `_— 🛠️ addressed (automated)_`

**Role, not model.** The footer names what the comment *is* (a review, or a reply addressing one), never which model wrote it — the same skill runs on Claude Code and Codex, so a `Claude:`/`Codex:` label would go wrong the moment the other platform executes it. The role answers the reader's real question ("is this a review or a reply?"); footer **presence** answers the other ("is this an agent's comment or my own manual note?"). Model identity, when it matters for debugging, rides only in the hidden marker (§2).

**The author's own manual comments carry no footer** — that absence is the tell that distinguishes a human note from an automated one. Never add a footer to anything but an automated post.

**No automation mechanics in visible text.** The label, the idempotency rule, the head SHA, and any scheduling/cadence detail never appear in a visible comment. The only machine metadata that ships with a comment is the hidden marker (§2), which renders invisibly on GitHub.

## §2 Hidden marker (machine idempotency key)

Every automated review embeds one HTML comment, invisible in GitHub's rendered view, as the machine-readable idempotency key:

```
<!-- fp-review agent=<codex|claude> head=<SHA> -->
```

- `head=<SHA>` is **load-bearing** — it is the full current head SHA of the PR at review time (`gh pr view <N> --json headRefOid --jq '.headRefOid'`). Idempotency is keyed on it: a PR is "already reviewed" only when a marker for its **current** head SHA exists. When new commits land (head moves), the old marker no longer matches and the PR is reviewed again.
- `agent=<codex|claude>` is **informational** (which runtime posted). Detect it from the runtime that already discriminates the two harnesses: `agent=codex` when `$PLUGIN_ROOT` is set and `$CLAUDE_PLUGIN_ROOT` is not; otherwise `agent=claude`. This mirrors `../build/references/validation-hook.md`'s `PLUGIN_ROOT` (Codex) vs `CLAUDE_PLUGIN_ROOT` (Claude Code) resolution. It never gates idempotency — only `head` does.

The marker goes in the **review body** on the Reviews-API path (§4), or in the **single issue comment** on the fallback path (§5). Either way it must be findable by the idempotency scan (§3), which reads both surfaces.

### Legacy marker + label recognition (first-switchover)

The external loop this contract supersedes used a model-specific marker and label. Recognize both as "already reviewed" so a PR reviewed under the old automation is not re-reviewed on the first run of the new skill:

- Legacy marker: `<!-- codex-auto-review head=<SHA> -->` — treated identically to the `fp-review` marker (same head-SHA keying).
- Legacy label: `codex-reviewed` — treated like the `auto-reviewed` label (§6): a coarse "this PR was auto-reviewed at some head" signal, never the authoritative idempotency key.

New posts always use the `fp-review` marker and the `auto-reviewed` label; the legacy forms are read-only recognition, never written.

## §3 Idempotency scan (fetch existing markers)

Before reviewing a PR, resolve its current head SHA and scan its existing comment surfaces for a marker matching that SHA. A match → already reviewed at this head → skip. Read **both** surfaces (a prior run may have used either the Reviews-API or the fallback path):

```bash
HEAD_SHA=$(gh pr view "<N>" --json headRefOid --jq '.headRefOid')
# Issue-level comments + review bodies in one read:
gh pr view "<N>" --json comments,reviews \
  --jq '[.comments[].body, .reviews[].body] | .[]'
```

A PR is **already reviewed** iff that text contains `head=<HEAD_SHA>` inside an `fp-review` **or** legacy `codex-auto-review` marker. The `auto-reviewed`/`codex-reviewed` label alone does **not** prove the current head was reviewed — a label present without a current-SHA marker means the head moved since the last review, so re-review (§6 then removes-and-re-adds the label).

`<N>` is a controlled integer PR number (from `gh pr list`), quoted; `HEAD_SHA` is loaded via command substitution — never interpolate free-text into the command (see §7).

## §4 Post a review — Reviews API (inline + summary as one review)

The summary comment and all line-anchored inline comments must be **one logical review** carrying **one** head-SHA marker. The GitHub Reviews API posts them atomically as a single review object. Build the payload as a JSON file (never a shell-interpolated string) and pass it with `--input`:

```bash
# OWNER/REPO from the repo, not interpolated free-text:
read -r OWNER REPO < <(gh repo view --json owner,name --jq '"\(.owner.login) \(.name)"')
# Write every generated artifact to a PRIVATE temp dir, never the repo worktree — review is read-only
# on repo code, and a fixed name in the cwd can clobber a user file and litter the tree. Auto-clean:
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
# review runs with Bash only (no Write tool), so materialize the model-generated text injection-safely.
#  1. Write the summary body (findings + footer + marker) via a QUOTED heredoc — the quoted delimiter
#     disables ALL shell expansion, so backticks / $() / quotes are written literally. The delimiter MUST
#     be a fresh per-invocation token you VERIFY is absent from the body before composing the heredoc
#     (you author both lines and body — guarantee it; regenerate on the rare collision). NEVER a fixed
#     sentinel a finding could legitimately contain on its own line — that would close the heredoc early
#     and feed the remainder to the shell. Use a long random nonce (shown illustratively as
#     __FP_BODY_<nonce>__ — pick and verify a new one each run, do not reuse this literal):
cat > "$WORK/review-body.md" <<'__FP_BODY_3f9c1ad7e2__'
<summary findings>

_— 🔎 review (automated)_
<!-- fp-review agent=<codex|claude> head=<SHA> -->
__FP_BODY_3f9c1ad7e2__
#  2. Build each line-anchored finding as JSON with jq (finding text rides as a --arg value,
#     never shell-parsed), collect them into a JSON array $COMMENTS_JSON (default '[]'), e.g.:
#       entry=$(jq -n --arg path "$p" --argjson line "$ln" --arg side RIGHT --arg body "$txt" \
#                 '{path:$path, line:$line, side:$side, body:$body}')
#  3. Assemble the payload with jq, passing body + comments as DATA (--rawfile / --argjson),
#     so nothing model-generated is ever parsed by the shell:
jq -n --rawfile body "$WORK/review-body.md" --argjson comments "${COMMENTS_JSON:-[]}" \
  '{event:"COMMENT", body:$body, comments:$comments}' > "$WORK/payload.json"
gh api --method POST "repos/$OWNER/$REPO/pulls/<N>/reviews" --input "$WORK/payload.json"
```

- `event` is **`COMMENT`** — never `APPROVE` or `REQUEST_CHANGES`. The skill comments; it never approves or requests changes.
- The top-level `body` carries the summary findings, the §1 role footer, and the §2 hidden marker.
- Each `comments[]` entry anchors a finding to `{path, line, side}` (`side: "RIGHT"` for the new version). Findings that aren't cleanly line-anchored go in the summary `body`, not the array.
- **Every finding in a summary gets a stable ordinal** so `address-review` can triage and reply to them individually (a consumer that treats a whole multi-finding summary as one item can only assign one verdict to several independent findings). Tag **each** finding `**[F<k>]**` (k = 1, 2, …) on its own line — on the Reviews-API path that is each unanchored finding; on the §5 fallback path it is **every** finding including the folded-in former-inline ones (`[F<k>] path:line — finding`), so a consumer that splits on `[F<k>]` drops none. The ordinal is unique only **within one summary**, so the consumer keys each finding by the **source review/comment id plus its ordinal** — `[F1]` in two different summaries are distinct. A single-finding summary is just `[F1]`.
- Capture failure: if the Reviews-API call errors (including the self-review restriction below), fall back to §5.

## §5 Fallback — single issue comment (`gh pr comment`)

When the Reviews API is unavailable or **GitHub blocks self-review** (the PR author and the posting `gh` identity are the same user — `event: COMMENT` reviews on your own PR can be rejected depending on repo/account settings), post the findings as one plain issue comment instead. Inline anchoring is lost; fold the line references into the body text, **each tagged with its ordinal** (`[F<k>] path:line — finding`) so the consumer drops none.

```bash
# Same private workdir + verified-unique quoted delimiter as §4 (a fresh nonce, verified absent from the
# body — never a fixed sentinel); never write to the repo worktree:
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/comment.md" <<'__FP_BODY_3f9c1ad7e2__'
<summary findings — every finding tagged [F<k>], folded inline findings as [F<k>] path:line — finding>

_— 🔎 review (automated)_
<!-- fp-review agent=<codex|claude> head=<SHA> -->
__FP_BODY_3f9c1ad7e2__
gh pr comment "<N>" --body-file "$WORK/comment.md"
```

- `comment.md` carries the same content the Reviews-API `body` would: summary findings (with inline findings inlined as `path:line` references), the §1 footer, and the §2 hidden marker.
- Use `--body-file`, never `--body "<interpolated text>"` — review text is model-generated and must not be pasted into a command literal (§7).

This is the same fallback `../ship/SKILL.md`'s reviewer hop uses (`gh pr review … --comment` → `gh pr comment`); here the summary content and marker are identical across both paths so the §3 scan finds the marker regardless of which path posted it.

### Security-heuristic flag note

Posting to GitHub under the user's own `gh` identity can trip a security heuristic — this is **expected** when the user has authorized the automated-review hop (running `/feature:review` is that authorization). It is not an error. A single-identity setup also means findings are *comments*, not a formal approve/request-changes review — which is correct here, since the skill must never approve.

## §6 Empty review (no blocking findings)

When the rubric (`review-rubric.md`) surfaces no high-conviction blocking findings, do **not** approve (the skill never approves; self-approval is blocked anyway). Post **one** signed, professional summary comment:

```
I reviewed this change and do not see blocking issues.

_— 🔎 review (automated)_
<!-- fp-review agent=<codex|claude> head=<SHA> -->
```

Posted via `gh pr comment <N> --body-file <file>` (no inline anchors needed). It still carries the footer + marker, so the §3 scan counts the head SHA as reviewed and a re-run is idempotent.

## §7 Injection discipline

Mirror `../build/references/pr-creation.md`'s discipline for every `gh`/`git` call here:

- PR numbers are controlled integers from `gh pr list`; SHAs and `OWNER`/`REPO` are loaded via command substitution from `gh` — never pasted free-text.
- Comment/review **bodies and payloads** ride in files (`--body-file`, `--input`), never in a `--body "…"` literal — a double-quoted assignment does **not** neutralize backticks / `$()` / quotes, and review text is model-generated.
- Never `eval`. Never interpolate a diff snippet, finding text, or PR title into a command string.

## §8 The `auto-reviewed` label

A coarse, model-neutral signal that a PR has been auto-reviewed at *some* head; the §2 marker is the precise per-head key.

```bash
# Ensure it exists (idempotent — ignore "already exists"):
gh label create auto-reviewed --description "Auto-reviewed by feature:review" --color BFD4F2 2>/dev/null || true
# First review at a head: add it (idempotent — a no-op if already present).
gh pr edit "<N>" --add-label auto-reviewed
# Head moved since the last review (label present, no current-SHA marker): refresh the label.
# Run the remove best-effort and the add as a SEPARATE, ALWAYS-run statement, so a failed add after a
# successful remove can never leave the PR label-less. The hidden marker (§2) — not the label — is the
# authoritative per-head idempotency key; the label is only a coarse "auto-reviewed at some head" signal.
gh pr edit "<N>" --remove-label auto-reviewed 2>/dev/null || true
gh pr edit "<N>" --add-label auto-reviewed
```

Recognize the legacy `codex-reviewed` label as equivalent on first switchover (§2); new runs write only `auto-reviewed`.

## §9 Reply to a review finding (the `address-review` side)

`feature:address-review` consumes everything above to *read* a review, then posts one signed **reply** per finding it triaged. Replies reuse the §1 role footer for the address role and carry their own hidden marker so a re-run can tell which findings it already answered.

- **Footer (reuse §1, do not redefine):** every reply ends with `_— 🛠️ addressed (automated)_` on its own last line — the address role's §1 footer. Footer **presence** still distinguishes an agent reply from the author's own manual note.
- **Reply marker:**
  ```
  <!-- fp-address agent=<codex|claude> head=<SHA> -->
  ```
  - `head=<SHA>` is **load-bearing** — the full current head SHA of the PR at address time (`gh pr view <N> --json headRefOid --jq '.headRefOid'`). It keys reply idempotency: a finding is "already addressed" only when its thread already carries an `fp-address` reply for the **current** head SHA. When new commits land (head moves), a prior reply no longer matches and the finding is addressed again.
  - `agent=<codex|claude>` is **informational** — the runtime that posted, detected exactly as §2 (`agent=codex` when `$PLUGIN_ROOT` is set and `$CLAUDE_PLUGIN_ROOT` is not; otherwise `agent=claude`). It never gates idempotency — only `head` does.

Both ACCEPTed findings (reply notes the fix) and DISMISSed findings (reply explains why it doesn't apply) get a signed reply in this exact shape.

### Reply idempotency scan

Before replying, read the PR's existing reply surfaces and skip any finding whose thread already carries an `fp-address` marker at the current head SHA. Review comments (inline + their replies) come from the Pulls API; summary replies are issue comments:

```bash
HEAD_SHA=$(gh pr view "<N>" --json headRefOid --jq '.headRefOid')
# Inline review comments + their replies (each carries id + in_reply_to_id):
gh api "repos/$OWNER/$REPO/pulls/<N>/comments" --paginate
# Issue-level comments (summary replies land here):
gh pr view "<N>" --json comments --jq '.comments[].body'
```

A thread is **already addressed** iff its replies contain `fp-address … head=<HEAD_SHA>`. `<N>` is a controlled integer; `HEAD_SHA`/`OWNER`/`REPO` load via command substitution — never interpolate free text (§7).

### Posting the reply (anchor on the original comment id)

The reply body is written by the **Write tool** and posted by Bash — **separate tool calls** — so the temp path must survive across them. A `WORK=$(mktemp -d)` with a `trap … EXIT` does **not**: the variable never reaches the Write call, and the dir is deleted the instant that first Bash call returns (the cross-tool-call shell-state trap — shell state is per-Bash-invocation). Instead, create the dir in one Bash call and **print its absolute path**, keep that **literal** path in agent state, pass it explicitly to Write and to every later `jq`/`gh` call, and clean up explicitly at the end:

```bash
d=$(mktemp -d); echo "$d"     # capture the printed literal path (e.g. /tmp/tmp.AbC123) and reuse it verbatim below
```

`address-review` has the **Write tool**: write each reply body (the one-line note + §1 footer + `fp-address` marker) to `<d>/reply.md` with Write — literal content, so no heredoc, no delimiter, no shell parsing of the model-generated reason. Then post by **the kind of finding being answered** (substitute the literal `<d>` captured above — never a `$WORK` that won't survive the next call):

- **Inline review comment** (line-anchored — has a numeric review-comment `id`): post a threaded reply anchored to that id via the dedicated replies endpoint. Pass the body as a jq-built payload (never a `--body "…"` literal):
  ```bash
  jq -n --rawfile body "<d>/reply.md" '{body:$body}' > "<d>/reply-payload.json"
  gh api --method POST "repos/$OWNER/$REPO/pulls/<N>/comments/<COMMENT_ID>/replies" --input "<d>/reply-payload.json"
  ```
  Equivalent form (same effect): `POST repos/$OWNER/$REPO/pulls/<N>/comments` with `{body, in_reply_to:<COMMENT_ID>}` as the payload. `<COMMENT_ID>` is the review comment's `id` from the fetch (a controlled integer).
- **Summary finding** (a `[F<k>]` finding in the review body or the §5/§6 fallback issue comment — **not** line-anchored, so there is no inline thread to anchor to): post **one top-level issue comment per `[F<k>]` finding**, each carrying the same footer + marker and naming the **source review/comment id + `[F<k>]`** it answers:
  ```bash
  gh pr comment "<N>" --body-file "<d>/summary-reply.md"
  ```

After all replies are posted, remove the dir explicitly (`rm -rf "<d>"`) — there is no EXIT trap to lean on across tool calls.

**Injection discipline (mirror §7):** comment ids are controlled integers from the fetch; reply bodies ride in files (`--rawfile`/`--body-file`/`--input`), never a `--body "…"` literal — the triage reason is model-generated. Never `eval`; never interpolate finding or reason text into a command string.
