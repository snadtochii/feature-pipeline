---
name: address-review
description: "Close the loop on a reviewed PR — fetch the inline plus summary review comments posted by feature:review, validate each finding against the real code (ACCEPT if it holds, DISMISS if it does not, each with a one-line reason), fix the accepted ones, and post signed replies. PR-coupled (no ticket needed): defaults to the current branch's PR, or pass a PR number or URL. Interactive by default — present the triage, fix on an explicit go, reply on approval; pass --auto to validate, fix, and reply autonomously for the unattended/loop path. Runs inline, no subagents, headless-safe. Use when 'address review', 'address the comments', 'address review comments', 'address PR feedback', 'reply to review comments', 'fix the review comments', 'feature:address-review'. NOT for producing a review (use feature:review), NOT for opening a PR (that is build's --pr flag), NOT for building a ticket (use feature:build); it edits code to apply fixes and posts replies, but never approves, merges, or closes the PR."
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - TodoWrite
argument-hint: "[pr-number-or-url] [--auto]"
---

# Address-Review — validate and address PR feedback

Fetch the **inline + summary** review comments a `feature:review` pass posted to a pull request, validate each finding against the real code (**ACCEPT** if it holds, **DISMISS** if it does not — each with a one-line reason), apply code fixes for the accepted ones, and post one **signed reply** per finding. The reply for an accepted finding notes the fix; the reply for a dismissed finding explains why it does not apply. Every reply carries the visible role footer and a hidden head-SHA marker so the loop is self-identifying and idempotent.

**This skill runs in the main conversation, standalone** — a peer of `/feature:review`, `/feature:sync`, `/feature:ship`, and `/feature:debug`, **not a pipeline stage**. It spawns **no subagents** (no `Task`) and uses **no MCP**, so it behaves identically on Claude Code and Codex, including headless/scheduled `--auto` runs. It is **PR-coupled**: it operates on one PR in the repo it is invoked in and never resolves a ticket.

It is the **mutating** sibling of `feature:review`: it edits repository code to apply accepted fixes (those edits trigger the PostToolUse validation hook, with a body-level lint/typecheck fallback like build), but it **never approves, merges, or closes** the PR. The comment/footer/marker/reply rules are the shared contract in [`../review/references/pr-comments.md`](../review/references/pr-comments.md) — this skill **consumes** that file (the §1 footer, §2/§9 markers, §9 reply patterns) rather than restating it, so review comments and address replies share one format.

## Arguments

```
/feature:address-review $ARGUMENTS
```

- `$1` (optional) = a single PR **number** (e.g. `42`) or PR **URL** to address. Omit it to auto-detect the PR for the **current branch**.
- `--auto` (optional flag) = run the unattended/loop path: validate, fix the accepted findings, and post replies **autonomously** — no per-finding gate, no interactive-only assumption. Without it, the skill is **interactive by default** (present the triage, fix on an explicit go-signal, post replies only on approval).

The flag may appear in any position; `$1` is the first non-flag argument.

## When NOT to run
- To **produce** a review (scan PRs, post findings) → `/feature:review`.
- To open a PR for a ticket → that's build's `--pr` flag, not address-review.
- To build/implement a ticket from a spec → `/feature:build`.
- You want a PR approved or merged → address-review never does either; merge it yourself or via `/feature:sync`.

## Preconditions (fail-closed)

Address-review reads and posts PR state via `gh`, and reads the diff context via `git`. Before any work, check — in order; on the first failure, print one line ("couldn't address review (gh unavailable: `<reason>`)"), change nothing, and exit cleanly (this is graceful degradation, not an error):

1. `command -v gh` — gh installed?
2. `gh auth status` exits 0 — authenticated?
3. `git remote get-url origin` matches `github.com` (both `git@github.com:` and `https://github.com/` forms) — GitHub origin?

## Process

### 1. Resolve the target PR

Resolve the PR, its current head SHA, and `OWNER`/`REPO` once up front (all loaded via command substitution — never free-text interpolation, per [`../review/references/pr-comments.md`](../review/references/pr-comments.md) §7):

```bash
read -r OWNER REPO < <(gh repo view --json owner,name --jq '"\(.owner.login) \(.name)"')
```

- **No `$1`** → auto-detect the current branch's PR: `gh pr view --json number,headRefOid,title,url,state`. `gh pr view` with no argument resolves the PR whose head is the current branch. If it doesn't resolve to an open PR, report "no open PR for the current branch — pass a PR number or URL" and exit.
- **`$1` given (number or URL)** → resolve it together with its repository: `gh pr view "$1" --json number,headRefOid,title,url,state`, then parse the owner/repo from the resolved `.url` and **require it to equal the current origin `$OWNER/$REPO`**. A PR **URL can name a different repository**, but every later lookup uses `$OWNER/$REPO` + the bare number — so a cross-repo `…/other/repo/pull/2` would silently validate/edit/reply against `$OWNER/$REPO` PR #2 (a different PR with the same number). If the repos differ, **STOP and report** ("PR `$1` is in `<owner/repo>`, not the current repo `$OWNER/$REPO` — run address-review from that repo's checkout"); never reduce the target to an unqualified number against the wrong repo. If it doesn't resolve to an open PR, report "`$1` is not an open PR" and exit.

Capture `N` (the PR number, a controlled integer) and `HEAD_SHA` (`headRefOid`). A `CLOSED`/`MERGED` PR → report "PR `#<N>` is `<state>` — nothing to address" and exit (don't post to a closed thread).

**Bind the working tree to the PR's exact commit before editing.** A branch *name* alone identifies neither the code nor the push destination — a same-named local branch can be stale or diverged, and a fork PR can check out cleanly while a plain `git push` targets `origin` (the wrong repo). Capture the PR's head **commit, ref, and repository**: `gh pr view "$N" --json headRefName,headRefOid,headRepositoryOwner,headRepository`. Then, before Step 5 edits anything: check out the PR head (`gh pr checkout "$N"`) and require the tree to be **clean** with `git rev-parse HEAD` equal to the captured `headRefOid` **exactly** — not merely a same-named branch. If it doesn't match, the tree is dirty, or the head repo is a fork you cannot push to, **STOP and report** rather than editing whatever is checked out — otherwise `address-review 123` edits unrelated/stale code and reports it against PR #123. Record the writable head remote + ref for Step 5's push. (Auto-detect mode is already on the PR's exact head, so this is a no-op there.)

### 2. Fetch and group the review findings (idempotency-aware)

Read **both** comment surfaces the review skill may have used (Reviews-API path vs. issue-comment fallback), per [`../review/references/pr-comments.md`](../review/references/pr-comments.md) §3–§6 and §9:

```bash
# Inline review comments + their replies (each carries id, path, line, body, in_reply_to_id,
# and pull_request_review_id — the REST numeric id of the review the comment belongs to):
gh api "repos/$OWNER/$REPO/pulls/$N/comments" --paginate
# Review summaries via REST, so the review `id` is the NUMERIC id the inline comments'
# pull_request_review_id joins on (`gh pr view --json reviews` returns a GraphQL node id like
# `PRR_…`, which does NOT match pull_request_review_id):
gh api "repos/$OWNER/$REPO/pulls/$N/reviews" --paginate
# Issue-level comments (fallback / empty-review / summary replies):
gh pr view "$N" --json comments
```

Then:

- **Identify automated review findings.** A finding is review-produced when its source carries the §1 review footer (`🔎 review`) or the §2 marker (`fp-review`, or the legacy `codex-auto-review`). Three finding shapes exist, mirroring how review posts:
  - **Inline review comment** — a line-anchored entry from `.../pulls/$N/comments` belonging to a review whose body carries the review marker (join the inline comment's `pull_request_review_id` to the matching review `id` from `.../pulls/$N/reviews` — both REST numeric ids), OR any inline comment that itself carries the footer/marker. It has a numeric `id`, `path`, and `line` — repliable inline.
  - **Summary (Reviews-API)** — a review entry (from `.../pulls/$N/reviews`) whose `body` carries the footer/marker. Not line-anchored; its findings live in the body text, and a summary may carry **several**, each tagged `[F<k>]` per [`../review/references/pr-comments.md`](../review/references/pr-comments.md) §4 — treat **each `[F<k>]` as its own finding**.
  - **Summary (fallback)** — a `comments[]` issue comment whose `body` carries the footer/marker. Per pr-comments.md §5 **every** finding is tagged `[F<k>]` — both the folded-in former-inline ones (`[F<k>] path:line — finding`) and the unanchored ones — so split on `[F<k>]` and you drop none.
  - **Not a finding — skip it:** a §6 *empty-review* comment ("no blocking issues" — footer/marker but no findings) is the review reporting the PR is clean. It is **not** a triable thread — exclude it from the work set. If the only automated surface on the PR is an empty-review comment, there is nothing to address (the Step 2 "no un-addressed automated findings" exit applies).
- **Group into threads.** Each inline comment is its own thread (anchored to its `id` + `path:line`). Each **`[F<k>]` finding within a summary is its own thread**, keyed by the **source review/comment id plus its ordinal** `k` (the `[F<k>]` ordinal is unique only within one summary, so `[F1]` from two summaries are distinct threads; a single-finding summary is just `[F1]`). Step 3 gives each its own ACCEPT/DISMISS verdict and Step 6 its own reply — never collapse a multi-finding summary into one verdict. Skip a comment that is itself an `fp-address` reply (its body carries the §9 reply marker) — never triage your own prior replies.
- **Skip already-addressed threads (reply idempotency).** Per §9: a thread is already addressed at the current head iff its replies contain `fp-address … head=$HEAD_SHA`. Drop those from the work set so a re-run doesn't double-reply. (When the head moved since a prior address pass, the old `fp-address` marker no longer matches `$HEAD_SHA`, so the finding is re-addressed — correct, the code changed.)

Build a TodoWrite item per surviving thread so the Step 7 summary is recoverable. If there are **no** un-addressed automated findings, report "No outstanding review comments to address on PR `#<N>` (current head)." and exit cleanly.

### 3. Validate each finding (ACCEPT / DISMISS + one-line reason)

For each thread, read the finding against the **real current code** (use `Read`/`Grep`/`Glob` on the referenced `path:line`, and `git diff "$base"...HEAD` for the change under review where useful — resolve `$base` as the review checkpoint does: `base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || echo main)`). Judge it:

- **ACCEPT** — the finding is real and applies to the current code. Record a one-line reason and the intended fix.
- **DISMISS** — the finding is wrong, stale (already fixed / no longer applies), out of scope, or a false positive. Record a one-line reason.

This mirrors `ship`'s self-validation hop (ACCEPT/DISMISS with a one-line reason, fix only the accepted) — here the verdicts drive **posted, signed** replies rather than drafts. Do not fix DISMISSed findings; they still get a reply (Step 6) explaining the dismissal.

### 4. Gate on mode

- **Interactive (default).** Present the triage as a numbered list — one line per thread: `path:line` (or `summary`), the finding, the ACCEPT/DISMISS verdict, and the one-line reason. Then ask for an explicit **go-signal** before editing any code. The user may flip a verdict, edit a reason, or drop a thread before you proceed. The go-signal authorizes **applying the fixes only** — posting the replies is a separate approval gate in Step 6; do not edit any code until the user says go.
- **`--auto`.** Skip the per-finding gate entirely — proceed straight to Step 5 with the Step 3 verdicts. No interactive prompt, no approval pause. This is the unattended/loop path and must make no interactive-only assumption.

### 5. Apply fixes for ACCEPTed findings

Edit the repository code to apply each accepted fix, smallest change first, validating as you go:

- **Validation after each edit** relies on the PostToolUse validation hook (`Write|Edit|MultiEdit|apply_patch`), with a **body-level lint/typecheck fallback** mirroring build's implement checkpoint: read the project instruction files for **both** runtimes — `CLAUDE.md` (Claude Code) **and** `AGENTS.md` (Codex) — for lint/typecheck commands (a `## Commands` / `## Validation` / `## Testing` section, or inline `npm run lint` / `pnpm test` / `cargo check` / `pytest` references), with a deterministic precedence (the current runtime's primary file first — `AGENTS.md` when `$PLUGIN_ROOT` is set and `$CLAUDE_PLUGIN_ROOT` is not, else `CLAUDE.md` — then the other), and run them via `Bash` after each meaningful change. A Codex repo that documents its checks only in `AGENTS.md` must NOT be mistaken for "no commands". If neither file documents any, log one line ("No validation commands found in project CLAUDE.md/AGENTS.md — proceeding without skill-body validation") and continue.
- **On a failing fix** (lint/typecheck won't pass, or the change can't be made cleanly): **report rather than silently proceed.** Mark that finding `fix-failed` with the error, leave its code reverted/untouched so the tree stays green, and downgrade its reply (Step 6) to a note that the finding was accepted but the fix could not be completed this pass. Do not post a "fixed" reply for a fix that didn't land.

DISMISSed findings make no code change.

**Publish the fixes to the PR before replying.** Step 6 must never claim a fix the PR doesn't contain. After the accepted fixes pass validation, commit them (subject `address-review: <pr-or-ticket-id>` — no `Co-Authored-By`, one concern) and push **explicitly to the writable head repository + ref captured in Step 1** (`git push <head-remote> HEAD:<head-ref>` — never assume `origin`, since a fork PR's head lives on another remote). Then confirm the push landed: the PR's `headRefOid` now points at your commit. Only a finding whose fix is **pushed to the PR head** earns a `Fixed` reply; a fix validated locally but not pushed (or fix-failed) gets the pending/failed reply (Step 6), never `Fixed`. In `--auto` this commit + push + confirmation is mandatory before any `Fixed` reply.

### 6. Post signed replies

Post one reply per thread, per [`../review/references/pr-comments.md`](../review/references/pr-comments.md) §9. In interactive mode this is a **second, separate gate** (AC8): the Step 4 go-signal authorized *applying the fixes* only — after fixing, present the drafted replies (one per thread, with its verdict and text) and post **only after** the user approves them. The user may edit a reply or hold one back before posting. In `--auto`, post autonomously with no gate.

Each reply carries the §1 footer `_— 🛠️ addressed (automated)_` and the §9 hidden marker `<!-- fp-address agent=<codex|claude> head=$HEAD_SHA -->` (detect `agent` per §2: `agent=codex` when `$PLUGIN_ROOT` is set and `$CLAUDE_PLUGIN_ROOT` is not; otherwise `agent=claude`). Reply content by verdict:

- **ACCEPTed + fixed** → a one-line note of what changed (e.g. "Fixed — extracted the duplicated guard into `validateInput`.").
- **ACCEPTed + fix-failed** → a one-line note that the finding is valid but the fix couldn't land this pass, with the blocker.
- **DISMISSed** → a one-line note explaining why it doesn't apply (stale / out of scope / false positive).

Anchor by finding shape (§9): an **inline** review comment → a threaded reply to its review-comment `id` via `gh api … /pulls/$N/comments/<COMMENT_ID>/replies --input <payload>` (or the `in_reply_to` equivalent); a **summary `[F<k>]` finding** → one top-level `gh pr comment "$N" --body-file <file>` per finding, naming the **source review/comment id + `[F<k>]`** it answers. Build every reply body with the **Write tool** to a temp path whose absolute location a prior Bash call printed (§9 — shell `$WORK` does not survive across tool calls; thread the literal path, never the repo worktree) and post via `--input`/`--body-file` — never a `--body "…"` literal, never `eval` (§7).

### 7. Report

Print a grouped summary with counts (omit empty groups):

```
## Address-review — PR #<N> (<k> finding(s))

✓ Accepted & fixed (<n>):
  - <path:line | summary> — <finding> → <fix> — replied
✗ Dismissed (<n>):
  - <path:line | summary> — <finding> — <reason> — replied
⚠ Accepted, fix failed (<n>):
  - <path:line | summary> — <finding> — <blocker> — replied (fix deferred)
↺ Skipped, already addressed at current head (<n>):
  - <path:line | summary>
? Couldn't post (<n>):
  - <path:line | summary> — <reason>
```

If `gh`/auth/origin was unavailable, the preconditions already printed the one-line skip and exited before this summary. One reply that fails to post never aborts the rest — record it under `? Couldn't post` and continue.

## Boundaries

**Will:**
- Resolve one PR (current branch by default, or `$1` as a number/URL), fetch its inline + summary review comments, and skip threads already addressed at the current head SHA.
- Validate each finding ACCEPT/DISMISS with a one-line reason against the real code.
- Edit repository code to apply accepted fixes (triggering the PostToolUse validation hook + a body-level lint/typecheck fallback), reporting rather than proceeding when a fix can't land cleanly.
- Post one signed reply per finding (accepted-fixed, accepted-fix-failed, or dismissed), each carrying the visible role footer and hidden `fp-address` head-SHA marker, anchored to the original comment.
- Run interactively by default (triage → go-signal → fix → reply on approval) or autonomously under `--auto`.
- Degrade fail-closed when `gh`/auth/origin is unavailable — change nothing, print one skip line, exit cleanly.

**Will Not:**
- Approve (`gh pr review --approve`), request changes, merge (`gh pr merge`), or close (`gh pr close`) the PR — it only edits code and posts replies.
- Produce a review or manage the `auto-reviewed` label — that's `/feature:review`.
- Re-triage or reply to its own prior `fp-address` replies, or double-reply to a thread already addressed at the current head.
- Spawn subagents (no `Task`) or use MCP — inline-only for cross-platform/headless parity.
- Restate the comment/footer/marker/reply contract — it consumes [`../review/references/pr-comments.md`](../review/references/pr-comments.md).

## Error Handling

- `gh` missing / unauthenticated / non-GitHub origin → "couldn't address review (gh unavailable)", no changes, clean exit.
- No `$1` and no PR for the current branch, or `$1` not an open PR, or the PR is closed/merged → report and exit cleanly (nothing to address).
- No un-addressed automated findings at the current head → report "No outstanding review comments to address" and exit cleanly.
- `gh api`/`gh pr comment` errors posting one reply → record `? Couldn't post (<reason>)` for that thread and continue with the rest (one failed reply never aborts the pass).
- A fix that won't pass validation → mark the finding `fix-failed`, keep the tree green, post the accepted-fix-failed reply, and surface it under `⚠ Accepted, fix failed` — never post a "fixed" reply for a fix that didn't land.
- **Security-heuristic flag** on posting under the user's own `gh` identity → expected when the user authorized the address hop (running `/feature:address-review` is that authorization); not an error (mirrors [`../review/references/pr-comments.md`](../review/references/pr-comments.md) §5).
