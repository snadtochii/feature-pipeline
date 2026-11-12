---
name: address-review
description: "Validate a PR's review feedback — automated findings and human comments — fix the accepted ones, and post signed replies; interactive by default, --auto for the unattended path, --hold-decisions to leave real decisions to the owner."
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - TodoWrite
argument-hint: "[pr-number-or-url] [--auto] [--hold-decisions]"
---

# Address-Review — validate and address PR feedback

Fetch the **inline + summary** review comments on a pull request — both the findings a `feature:review` pass posted **and human comments** (the author or a teammate commenting on the PR directly) — validate each against the real code (**ACCEPT** if it holds, **DISMISS** if it does not, **ANSWER** for a human question that needs a response but no code change — each with a one-line reason), apply code fixes for the accepted ones, and post one **signed reply** per thread. The reply for an accepted finding notes the fix; the reply for a dismissed finding explains why it does not apply; the reply for an answered question responds to it. Every reply carries the visible role footer and the §9 hidden marker, so the loop is self-identifying and each thread is answered once.

**This skill runs in the main conversation, standalone** — **not a pipeline stage**. It spawns **no subagents** (no `Task`) and uses **no MCP**, so it behaves identically on Claude Code and Codex, including headless/scheduled `--auto` runs. It is **PR-coupled**: it operates on one PR in the repo it is invoked in and never resolves a ticket.

It is the **mutating** sibling of `feature:review`: it edits repository code to apply accepted fixes (each validated with the project's documented lint/typecheck commands), but it **never approves, merges, or closes** the PR. The comment/footer/marker/reply rules are the shared contract in [`../review/references/pr-comments.md`](../review/references/pr-comments.md) — this skill **consumes** that file (the §1 footer, §2/§9 markers, §9 reply patterns) rather than restating it, so review comments and address replies share one format.

## Arguments

```
/feature:address-review $ARGUMENTS
```

- `$1` (optional) = a single PR **number** (e.g. `42`) or PR **URL** to address. Omit it to auto-detect the PR for the **current branch**.
- `--auto` (optional flag) = run the unattended/loop path: validate, fix the accepted findings, and post replies **autonomously** — no per-finding gate, no interactive-only assumption. Without it, the skill is **interactive by default** (present the triage, fix on an explicit go-signal, post replies only on approval).
- `--hold-decisions` (optional flag, used with `--auto`) = everything `--auto` does, except that a finding needing the owner's decision is held instead of fixed or dismissed (Step 3). Use it when someone will read the result. Without `--auto` it has no effect, because every finding already waits for the go-signal.

Flags may appear in any position; `$1` is the first non-flag argument.

## When NOT to run
- To **produce** a review (review a PR, post findings) → `/feature:review`.
- To open a PR for a ticket → that's build's `--pr` flag, not address-review.
- To build/implement a ticket from a spec → `/feature:build`.
- You want a PR approved or merged → address-review never does either; merge it yourself or via `/feature:sync`.

## Preconditions (fail-closed)

Address-review reads and posts PR state via `gh`, and reads the diff context via `git`. Before any work, run the shared fail-closed check sequence in [`../review/references/gh-preconditions.md`](../review/references/gh-preconditions.md); this skill's skip message is "couldn't address review (gh unavailable: `<reason>`)".

## Process

### 1. Resolve the target PR

Resolve the PR, its current head SHA, and `OWNER`/`REPO` once up front (all loaded via command substitution — never free-text interpolation, per [`../review/references/pr-comments.md`](../review/references/pr-comments.md) §7):

```bash
read -r OWNER REPO < <(gh repo view --json owner,name --jq '"\(.owner.login) \(.name)"')
```

- **No `$1`** → auto-detect the current branch's PR: `gh pr view --json number,headRefOid,title,url,state`. `gh pr view` with no argument resolves the PR whose head is the current branch. If it doesn't resolve to an open PR, report "no open PR for the current branch — pass a PR number or URL" and exit.
- **`$1` given (number or URL)** → resolve it together with its repository: `gh pr view "$1" --json number,headRefOid,title,url,state`, then parse the owner/repo from the resolved `.url` and **require it to equal the current origin `$OWNER/$REPO`**. A PR **URL can name a different repository**, but every later lookup uses `$OWNER/$REPO` + the bare number — so a cross-repo `…/other/repo/pull/2` would silently validate/edit/reply against `$OWNER/$REPO` PR #2 (a different PR with the same number). If the repos differ, **STOP and report** ("PR `$1` is in `<owner/repo>`, not the current repo `$OWNER/$REPO` — run address-review from that repo's checkout"); never reduce the target to an unqualified number against the wrong repo. If it doesn't resolve to an open PR, report "`$1` is not an open PR" and exit.

Capture `N` (the PR number, a controlled integer) and `HEAD_SHA` (`headRefOid`), which the checkout binding below checks against. A `CLOSED`/`MERGED` PR → report "PR `#<N>` is `<state>` — nothing to address" and exit (don't post to a closed thread).

**Bind the working tree to the PR's exact commit before editing.** A branch *name* alone identifies neither the code nor the push destination — a same-named local branch can be stale or diverged, and a fork PR can check out cleanly while a plain `git push` targets `origin` (the wrong repo). Capture the PR's head **commit, ref, and repository**: `gh pr view "$N" --json headRefName,headRefOid,headRepositoryOwner,headRepository`. Then, before Step 5 edits anything: check out the PR head (`gh pr checkout "$N"`) and require the tree to be **clean** with `git rev-parse HEAD` equal to the captured `headRefOid` **exactly** — not merely a same-named branch. If it doesn't match, the tree is dirty, or the head repo is a fork you cannot push to, **STOP and report** rather than editing whatever is checked out — otherwise `address-review 123` edits unrelated/stale code and reports it against PR #123. Record the writable head remote + ref for Step 5's push. (Auto-detect mode is already on the PR's exact head, so this is a no-op there.)

### 2. Read the thread states

One command reads the PR's comment surfaces and computes every thread's state per [`../review/references/pr-comments.md`](../review/references/pr-comments.md) §9: which comments are threads, which replies pair with them, and whether each thread is open, settled, held or fix-failed. This skill acts on those states and never pairs replies itself.

- `<plugin-root>` — the parent of the `skills/` directory that holds this skill, the plugin's root; on Claude Code, the path `${CLAUDE_PLUGIN_ROOT}` resolves to.
- **The command** — `node '<plugin-root>/skills/address-review/scripts/threads.mjs' --repo "$OWNER/$REPO" --pr "$N"`, with `<plugin-root>` written out as the literal absolute path inside single quotes, exactly in that form every time: an unattended run's permission allowlist matches the command text. `OWNER`, `REPO` and `N` are the values Step 1 loaded (§7). Its JSON is model-read.
- **Exit codes** — 0 answered; 1 a read failed, `gh` is missing or it printed something unexpected; 2 a bad invocation. A non-zero exit, or a document carrying `error`, prints `couldn't address review (thread-state read failed: <error>)` and stops: nothing is edited, pushed or posted.
- **A result that does not arrive whole.** The document stays within 16 KiB so that it arrives whole. If the session still stores it in a file and shows only a preview, run the command once more; a second preview is a failed read.

The document:

| Field | Meaning |
|---|---|
| `viewer` | the `gh` login this run posts as — Step 6's `<LOGIN>` |
| `counts` | every thread on the PR by state — `open`, `settled`, `held`, `fix_failed` — plus `unlisted`, the threads the size bound left out of `threads` |
| `complete` | `false` when the size bound left threads out. The listing keeps the oldest threads, so an unlisted thread is reached only as listed threads settle; a listed thread that gets no reply (not actionable, held under `--auto --hold-decisions`, a fix still failing) keeps its place on the next pass |
| `threads` | every thread that is not settled, oldest first; settled threads appear only in `counts` |

Each `threads` entry:

- `key` — the thread key in the §9 `re=` grammar (`inline:<id>`, `review:<id>[#F<k>]`, `comment:<id>[#F<k>]`); a top-level reply's `re=` is this value.
- `shape` — `inline`, `review-summary`, `issue-summary`, `human-review` or `human-issue`; `source` — `review` or `human`; `state` — `open`, `held` or `fix-failed`.
- `id` — the source's REST id: the inline comment a threaded reply anchors to, or the review or issue comment; `k` — a summary finding's `[F<k>]` ordinal.
- `at`, `url` — when the source was posted, and its link; `path`, `line` — an inline thread's anchor.
- `author`, `author_association` — the source's login and its GitHub association with the repository (`OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE`, …).
- `text` — the comment or finding text: `cut: true` when it was capped at 1500 characters, `text_omitted: true` in its place when the size bound dropped it.
- `reply_at`, `reply_url` — the newest paired reply, when the thread has one.
- `followups` — an inline thread's human replies that no paired reply answers, oldest first: every human reply when the thread has no paired reply, else those newer than it, which re-opened the thread. Each carries `id`, `at`, `author`, `author_association` and `text` (`cut: true` when capped at 1500 characters); when the thread's text is omitted, its followups list no `text` either. Read them with the thread: a human reply can narrow or withdraw what the root asks. An inline thread a bot started is listed only once a person replied in it, with `source` `human`, the bot's comment as `text` and the replies in `followups`.

For a thread whose text is cut or omitted, read the full body by its id with one `gh api` call — `repos/$OWNER/$REPO/pulls/comments/<id>` for an inline thread, `repos/$OWNER/$REPO/pulls/$N/reviews/<id>` for a review, `repos/$OWNER/$REPO/issues/comments/<id>` for an issue comment — and a cut or omitted followup the same way by its `id`, as an inline comment. Each id is a controlled integer from the document (§7).

**The work set** is every `open` and `fix-failed` thread, and every `held` one except under `--auto --hold-decisions`, where a held thread waits per §9 and Step 7 lists it again. A `fix-failed` thread is retried (Step 3). What stays this skill's own call:

- whether a human thread is actionable (Step 3);
- whether a listed `human-issue` comment newer than a held top-level thread's `reply_at` plainly answers it. Only a comment whose `author` is the `viewer`, or whose `author_association` is `OWNER`, `MEMBER` or `COLLABORATOR`, can answer a hold; any other account's comment is its own thread. An answer that qualifies is the owner's answer, folded into that held thread, which is triaged with it and replied to with `answers=comment:<id>` (§9), and it is not a thread of its own;
- one combined reply to a human review summary that plainly bundles several independent asks, each triaged.

Each thread gets its own verdict in Step 3 and its own reply in Step 6 — two `[F<k>]` findings of one summary are two threads.

Build a TodoWrite item per work-set thread so the Step 7 summary is recoverable. If the work set is empty and nothing is held, report "No outstanding review comments to address on PR `#<N>` (<settled> settled)." and exit cleanly. With an empty work set and at least one held thread, go straight to Step 7 and list them.

### 3. Validate each thread (ACCEPT / DISMISS / ANSWER + one-line reason)

For each thread, read the finding against the **real current code** (use `Read`/`Grep`/`Glob` on the referenced `path:line`, and `git diff "$base"...HEAD` for the change under review where useful — resolve `$base` non-interactively: `base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || echo main)`). A `fix-failed` thread is judged again like any other, and ACCEPT retries its fix. Judge it:

- **ACCEPT** — the finding is real and applies to the current code (a human ask for a change counts the same as an automated finding). Record a one-line reason and the intended fix.
- **DISMISS** — the finding is wrong, stale (already fixed / no longer applies), out of scope, or a false positive. Record a one-line reason.
- **ANSWER** *(human threads)* — the comment asks a question or raises a discussion point rather than requesting a change. No code edit; the Step 6 reply answers it. Record the one-line answer.
- **HOLD** *(`--hold-decisions` only)* — the finding is real, but acting on it is the owner's call. Hold only when one of these is true:
  - **It changes the intention.** The fix would contradict or change what this PR set out to do: its title and body, plus the ticket, PRD and decisions from this conversation when you have them. For example, the fix adds logic where the PRD says none, or removes something the PR body lists as deliberate.
  - **It cannot be resolved.** The options lead to materially different outcomes for users or the project, and nothing in the code, the PR, the project docs or this conversation settles which one is wanted.

  Everything else is decided, not held: how to structure a fix, naming, which of several workable fixes to use, and how far a refactor goes. Take the simplest option that satisfies the finding and say what you chose in the reply. If you hesitate between holding and deciding, decide. A wrong finding is a DISMISS whatever it proposes. Record why it is held, the options and your recommendation.
- **Not actionable** *(human issue comments and review summaries)* — plainly not review feedback ("LGTM", "thanks", an approval body, off-topic chatter). Skip: no fix, no reply; listed in the Step 7 report so nothing disappears silently.

This mirrors `ship`'s self-validation hop (ACCEPT/DISMISS with a one-line reason, fix only the accepted) — here the verdicts drive **posted, signed** replies rather than drafts. Do not fix DISMISSed or ANSWERed threads; they still get a reply (Step 6). A HELD thread gets no edit and a hold reply (Step 6).

### 4. Gate on mode

- **Interactive (default).** Present the triage as a numbered list — one line per thread: `path:line` (or `summary`), the source (`review` or `human`), the finding, the ACCEPT/DISMISS/ANSWER verdict, and the one-line reason. Then ask for an explicit **go-signal** before editing any code. The user may flip a verdict, edit a reason, or drop a thread before you proceed. The go-signal authorizes **applying the fixes only** — posting the replies is a separate approval gate in Step 6; do not edit any code until the user says go.
- **`--auto`.** Skip the per-finding gate entirely — proceed straight to Step 5 with the Step 3 verdicts. No interactive prompt, no approval pause. This is the unattended/loop path and must make no interactive-only assumption.
- **`--auto --hold-decisions`.** The same, with HELD threads set aside: the rest go straight to Step 5 with no prompt, and the held ones wait in Step 7's report.

### 5. Apply fixes for ACCEPTed findings

Step 5 runs only when Step 3 produced at least one ACCEPT. With zero ACCEPTs, skip it entirely — no edit, no validation, no commit, no push — and go to Step 6, whose replies are then all DISMISS, ANSWER or HOLD. Validation runs only after an edit this skill made; a pass with no accepted fix runs none.

Edit the repository code to apply each accepted fix, smallest change first, validating as you go:

- **Validation after each edit** runs the project's **lint/typecheck commands**, resolved as build's implement checkpoint resolves them: read the project instruction files for **both** runtimes — `CLAUDE.md` (Claude Code) **and** `AGENTS.md` (Codex) — for lint/typecheck commands (a `## Commands` / `## Validation` / `## Testing` section, or inline `npm run lint` / `pnpm test` / `cargo check` / `pytest` references), with a deterministic precedence (the current runtime's primary file first — `AGENTS.md` when `$PLUGIN_ROOT` is set and `$CLAUDE_PLUGIN_ROOT` is not, else `CLAUDE.md` — then the other), and run them via `Bash` after each meaningful change. A Codex repo that documents its checks only in `AGENTS.md` must NOT be mistaken for "no commands". If neither file documents any, log one line ("No validation commands found in project CLAUDE.md/AGENTS.md — proceeding without skill-body validation") and continue.
- **On a failing fix** (lint/typecheck won't pass, or the change can't be made cleanly): **report rather than silently proceed.** Mark that finding `fix-failed` with the error, leave its code reverted/untouched so the tree stays green, and give it the fix-failed reply (Step 6). Do not post a "fixed" reply for a fix that didn't land.

DISMISSed and ANSWERed threads make no code change, so they run no validation. When every accepted fix ends `fix-failed`, the code is reverted and the tree is the PR head: no commit, no push, and no validation run to confirm the revert.

**Publish the fixes to the PR before replying.** Step 6 must never claim a fix the PR doesn't contain. The per-edit result stands — there is no separate pre-commit run: once the last edit's validation is green, commit the fixes (subject `address-review: <pr-or-ticket-id>` — no `Co-Authored-By`, one concern) and push **explicitly to the writable head repository + ref captured in Step 1** (`git push <head-remote> HEAD:<head-ref>` — never assume `origin`, since a fork PR's head lives on another remote). Then confirm the push landed: the PR's `headRefOid` now points at your commit. Only a finding whose fix is **pushed to the PR head** earns a `Fixed` reply; a fix validated locally but not pushed (or fix-failed) gets the fix-failed reply (Step 6), never `Fixed`. In `--auto` this commit + push + confirmation is mandatory before any `Fixed` reply.

### 6. Post signed replies

Post one reply per thread, per [`../review/references/pr-comments.md`](../review/references/pr-comments.md) §9. In interactive mode this is a **second, separate gate**: the Step 4 go-signal authorized *applying the fixes* only — after fixing, present the drafted replies (one per thread, with its verdict and text) and post **only after** the user approves them. The user may edit a reply or hold one back before posting. In `--auto`, post autonomously with no gate.

**Bind the reply head once.** Before the first reply, read the PR head with `gh pr view "$N" --json headRefOid --jq .headRefOid`, print it, and carry the printed SHA as the literal `REPLY_HEAD`. It is the post-push head when Step 5 pushed and the Step 1 head otherwise, and every marker this pass posts names it — this is the one place `head=` is bound. A failed read puts every reply under `? Couldn't post`, with none posted.

Each reply carries the §1 footer `_— 🛠️ addressed by <Model> on behalf of <LOGIN>_` and the §9 `fp-address` marker with `head=<REPLY_HEAD>` and the §9 keys the reply needs: `re=` (the thread's `key`) on every top-level reply, `answers=` on a reply to a top-level answer, `hold=1` on a hold reply, `failed=1` on a fix-failed reply. `agent`, and `<Model>` to match it, follow §9. `<LOGIN>` is the Step 2 document's `viewer`, written as a literal with no `@`. Reply content by verdict:

- **ACCEPTed + fixed** → a one-line note of what changed (e.g. "Fixed — extracted the duplicated guard into `validateInput`."). On a `fix-failed` thread this is the reply that settles it.
- **ACCEPTed + fix-failed** → a one-line note that the finding is valid but the fix couldn't land this pass, with the blocker, and `failed=1` in the marker — posted only when the thread's state was not already `fix-failed`. A retry that fails again posts nothing; Step 7 lists it.
- **DISMISSed** → a one-line note explaining why it doesn't apply (stale / out of scope / false positive).
- **ANSWERed** → the answer to the question/discussion point, no fix claim.
- **HELD** → why it is the owner's call, the options with your recommendation, how to answer, and `hold=1` in the marker (§9). No fix claim.

Anchor by thread shape per §9's "Posting the reply": an `inline` thread → a threaded reply to its `id`; a summary finding → one top-level `gh pr comment "$N" --body-file <file>` per finding, its visible text naming the same source; a human review summary or issue comment → one top-level comment opening with a short quote or paraphrase of the comment it answers, so the pairing stays readable for humans. Build every reply body with the **Write tool** to a temp path a prior Bash call printed (§9) and post via `--input`/`--body-file` — never a `--body "…"` literal, never `eval` (§7).

**Remove the `auto-reviewed` label after the replies land**, per §8, when this pass pushed a commit and no thread is held — neither held this pass nor, under `--hold-decisions`, still held from an earlier one (`counts.held`): `gh pr edit "$N" --remove-label auto-reviewed 2>/dev/null || true` (best-effort — an absent label is fine). This is the only label action this skill takes — it never adds the label.

### 7. Report

Print a grouped summary with counts (omit empty groups):

```
## Address-review — PR #<N> (<k> thread(s))

✓ Accepted & fixed (<n>):
  - <path:line | summary> [review|human] — <finding> → <fix> — replied
✗ Dismissed (<n>):
  - <path:line | summary> [review|human] — <finding> — <reason> — replied
💬 Answered (<n>):
  - <path:line | summary> [human] — <question> — <answer> — replied
⚠ Accepted, fix failed (<n>):
  - <path:line | summary> [review|human] — <finding> — <blocker> — replied (fix deferred)
⚠ Fix still failing, no reply (<n>):
  - <path:line | summary> [review|human] — <finding> — <blocker>
– Not actionable, skipped (<n>):
  - <comment> — <reason>
↺ Settled, skipped: <n>
… Not listed this pass: <unlisted>
? Couldn't post (<n>):
  - <path:line | summary> — <reason>
⏸ Needs your decision (<n>):
  - <path:line | summary> [review|human] — <finding> — <why it is held> — options: <recommended> (recommended) | <other> — hold reply posted | held earlier
🏷 Label: auto-reviewed removed | not present | left (nothing pushed) | left (threads held)
```

A line says `replied` only for a thread that got a reply this pass. `↺ Settled, skipped` is `counts.settled` from Step 2, and `… Not listed this pass` appears only when the document's `complete` is false. A `⏸` line says `hold reply posted` for a hold this pass and `held earlier` for a thread that was already held.

When a thread is held, the run ends here with the fixes already pushed and asks nothing further. If the owner answers in this conversation, that answer authorizes both the fix and the reply: re-run Step 1's resolve and bind first and stop if it fails, then apply it per Step 5 and reply per Step 6 with no further gate.

If `gh`/auth/origin was unavailable, the preconditions already printed the one-line skip and exited before this summary. One reply that fails to post never aborts the rest — record it under `? Couldn't post` and continue.

## Boundaries

**Will Not:**
- Approve (`gh pr review --approve`), request changes, merge (`gh pr merge`), or close (`gh pr close`) the PR — it only edits code and posts replies.

## Error Handling

- **Security-heuristic flag** on posting under the user's own `gh` identity → expected when the user authorized the address hop (running `/feature:address-review` is that authorization); not an error (mirrors [`../review/references/pr-comments.md`](../review/references/pr-comments.md) §5).
