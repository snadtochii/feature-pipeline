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
# review runs with Bash only (no Write tool), so materialize the model-generated text injection-safely:
#  1. Write the summary body (findings + footer + marker) via a QUOTED heredoc — the quoted
#     'BODY_EOF' delimiter disables ALL shell expansion, so backticks / $() / quotes in the
#     model-generated body are written literally, never evaluated:
cat > review-body.md <<'BODY_EOF'
<summary findings>

_— 🔎 review (automated)_
<!-- fp-review agent=<codex|claude> head=<SHA> -->
BODY_EOF
#  2. Build each line-anchored finding as JSON with jq (finding text rides as a --arg value,
#     never shell-parsed), collect them into a JSON array $COMMENTS_JSON (default '[]'), e.g.:
#       entry=$(jq -n --arg path "$p" --argjson line "$ln" --arg side RIGHT --arg body "$txt" \
#                 '{path:$path, line:$line, side:$side, body:$body}')
#  3. Assemble payload.json with jq, passing body + comments as DATA (--rawfile / --argjson),
#     so nothing model-generated is ever parsed by the shell:
jq -n --rawfile body review-body.md --argjson comments "${COMMENTS_JSON:-[]}" \
  '{event:"COMMENT", body:$body, comments:$comments}' > payload.json
gh api --method POST "repos/$OWNER/$REPO/pulls/<N>/reviews" --input payload.json
```

- `event` is **`COMMENT`** — never `APPROVE` or `REQUEST_CHANGES`. The skill comments; it never approves or requests changes.
- The top-level `body` carries the summary findings, the §1 role footer, and the §2 hidden marker.
- Each `comments[]` entry anchors a finding to `{path, line, side}` (`side: "RIGHT"` for the new version). Findings that aren't cleanly line-anchored go in the summary `body`, not the array.
- Capture failure: if the Reviews-API call errors (including the self-review restriction below), fall back to §5.

## §5 Fallback — single issue comment (`gh pr comment`)

When the Reviews API is unavailable or **GitHub blocks self-review** (the PR author and the posting `gh` identity are the same user — `event: COMMENT` reviews on your own PR can be rejected depending on repo/account settings), post the findings as one plain issue comment instead. Inline anchoring is lost; fold the line references into the body text (`path:line — finding`).

```bash
# Create comment.md the same injection-safe way as §4 — a QUOTED heredoc (no shell expansion of the body):
cat > comment.md <<'COMMENT_EOF'
<summary findings, with inline findings folded in as path:line references>

_— 🔎 review (automated)_
<!-- fp-review agent=<codex|claude> head=<SHA> -->
COMMENT_EOF
gh pr comment "<N>" --body-file comment.md
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
