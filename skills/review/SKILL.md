---
name: review
description: "Review every unreviewed open PR in the current repo to the embedded maintainability rubric and post signed, idempotent findings. Repo-scoped and PR-coupled (no ticket needed): enumerate open PRs, skip any whose current head SHA was already reviewed, post inline plus summary findings (or a signed no-blocking-issues comment when clean), and manage the auto-reviewed label. Runs inline, no subagents, headless-safe. Use when 'review', 'review PRs', 'review open pull requests', 'review the PRs', 'run review', 'code review the open PRs', 'feature:review'. Optionally pass one PR number or URL to review just that PR. NOT for building a ticket (use feature:build), NOT for opening a PR (that is build's --pr flag), NOT for addressing or replying to review feedback (that is feature:address-review), and it never approves or merges."
disable-model-invocation: true
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - TodoWrite
argument-hint: "[pr-number-or-url]"
---

# Review — repo-scoped PR reviewer with an embedded maintainability rubric

Enumerate the current repo's open pull requests, skip any whose **current head SHA** was already reviewed, apply the embedded maintainability rubric ([`references/review-rubric.md`](references/review-rubric.md)) to each remaining PR, and post findings — inline where line-anchored, plus one summary comment, or a single signed "no blocking issues" comment when clean. Manage the model-neutral `auto-reviewed` label, then print a per-run summary.

**This skill runs in the main conversation, standalone** — a peer of `/feature:sync`, `/feature:ship`, and `/feature:debug`, **not a pipeline stage**. It spawns **no subagents** (no `Task`) and uses **no MCP**, so it behaves identically on Claude Code and Codex, including headless/scheduled runs. It is **repo-scoped and PR-coupled**: it operates on the repo it is invoked in and never resolves a ticket.

It **never approves a PR and never mutates repository code** — it only posts comments and adjusts its own label. The comment/marker/label rules are the shared contract in [`references/pr-comments.md`](references/pr-comments.md); this skill references that file rather than restating it, so `feature:address-review` posts replies in the same format.

## Arguments

```
/feature:review $ARGUMENTS
```

`$1` (optional) = a single PR number (e.g. `42`) or PR URL to review just that one PR. Omit it to scan **all** open PRs in the current repo.

The external scheduler (the automation that lists repos and sets the cadence) is **out of scope** — it stays external and simply runs `/feature:review` inside each repo. This skill is **stateless per invocation**: each run is a fresh scan, with all persisted state living on GitHub (the `auto-reviewed` label + the hidden head-SHA markers).

## When NOT to run
- To build/implement a ticket → `/feature:build`.
- To open a PR for a ticket → that's build's `--pr` flag, not review.
- To fetch, validate, and address posted review feedback (and edit code to fix it) → `/feature:address-review`.
- You want a PR approved or merged → review never does either; merge it yourself or via `/feature:sync`.

## Preconditions (fail-closed)

Review reads and posts PR state via `gh`. Before any work, check — in order; on the first failure, print one line ("couldn't review (gh unavailable: `<reason>`)"), change nothing, and exit cleanly (this is graceful degradation, not an error):

1. `command -v gh` — gh installed?
2. `gh auth status` exits 0 — authenticated?
3. `git remote get-url origin` matches `github.com` (both `git@github.com:` and `https://github.com/` forms) — GitHub origin?

## Process

### 1. Enumerate the PRs to review

- **All (no arg)**: list open PRs and their current head SHAs:
  ```bash
  gh pr list --state open --json number,headRefOid,title,isDraft
  ```
  Review every open PR (drafts included — the external loop reviews everything unreviewed). An empty list → "No open PRs." and exit cleanly.
- **Single (`$1` given)**: accept a PR number or URL. `gh pr view "$1" --json number,headRefOid,title` resolves either form. If it doesn't resolve to an open PR, report "`$1` is not an open PR" and exit.

Build a TodoWrite item per PR so the per-run summary (Step 5) is recoverable.

### 2. Per PR — idempotency check (skip already-reviewed head SHAs)

For each PR, resolve its current head SHA and scan its existing comment surfaces for a marker matching that SHA, per [`references/pr-comments.md`](references/pr-comments.md) §3:

- A marker `head=<current-SHA>` (the `fp-review` form **or** the legacy `codex-auto-review` form) already exists → **skip**: record it as *already reviewed*, leave its label untouched, move to the next PR.
- No current-SHA marker exists → this head is **unreviewed**; continue to Step 3. (A PR that carries the `auto-reviewed`/legacy `codex-reviewed` label but no current-SHA marker means the head moved — it is unreviewed; Step 4's label step removes-then-re-adds the label after posting.)

### 3. Per unreviewed PR — review against the embedded rubric

- Fetch the change: `gh pr diff "<N>"` and `gh pr view "<N>" --json title,body,headRefName,baseRefName,files`. Read surrounding source/tests as the rubric demands.
- Apply [`references/review-rubric.md`](references/review-rubric.md) to the diff. Produce a **small number of high-conviction findings**, prioritized structural-regression → missed-simplification → spaghetti → boundary → file-size → modularity → legibility. Do not flood with low-value nits; prefer fewer, sharper findings. Do **not** narrate whether to comment — just review.
- Classify each finding: **line-anchored** (maps to a `path:line` in the diff) → an inline comment; **not cleanly line-anchored** → folded into the summary body.

### 4. Per unreviewed PR — post one logical review + manage the label

Post per [`references/pr-comments.md`](references/pr-comments.md):

- **Has findings** → post the summary + inline comments as **one logical review** via the Reviews API (§4): one review object, `event=COMMENT`, the summary `body` carrying the §1 role footer (`_— 🔎 review (automated)_`) and the §2 hidden marker (`<!-- fp-review agent=<codex|claude> head=<SHA> -->`), and a `comments[]` array for the line-anchored findings. On a Reviews-API error or a self-review block, fall back (§5) to a single `gh pr comment <N> --body-file <file>` carrying the same summary (inline findings folded in as `path:line` references), footer, and marker.
- **No blocking findings** → post the single signed empty-review comment (§6) — never an approval.
- **Label** (§8): ensure `auto-reviewed` exists (`gh label create … || true`); if the PR already carried it (head moved), remove-then-re-add it so it tracks the latest reviewed head; otherwise add it.

Build the review body / payload / comment in a **file** and post via `--input` / `--body-file` — never interpolate model-generated finding text into a command literal, never `eval` (§7).

### 5. Per-run summary

After the scan, print a grouped summary with counts (omit empty groups):

```
## Review — <N> open PR(s) checked

✓ Reviewed (<n>):
  - #<num> <title> — <k> finding(s) [or "no blocking issues"] — PR <url>
↺ Skipped, already reviewed at current head (<n>):
  - #<num> <title> — PR <url>
🏷  Labels updated (<n>):
  - #<num> — auto-reviewed (added | refreshed)
⚠ Failures (<n>):
  - #<num> — <reason>
```

The `⚠ Failures` group carries any per-PR `gh` error (one bad PR never aborts the scan). If `gh`/auth/origin was unavailable, the preconditions already printed the one-line skip and exited before this summary.

## Boundaries

**Will:**
- Enumerate open PRs (all, or one when `$1` is given), skip already-reviewed head SHAs, and review the rest against the embedded rubric.
- Post inline + summary findings as one logical review (or one signed empty-review comment when clean), each carrying the visible role footer and hidden head-SHA marker.
- Maintain the model-neutral `auto-reviewed` label (create if missing; remove-then-re-add when the head SHA moved), recognizing the legacy `codex-reviewed` label / `codex-auto-review` marker on first switchover.
- Degrade fail-closed when `gh`/auth/origin is unavailable — change nothing, print one skip line, exit cleanly.
- Print a per-run summary (PRs reviewed, PRs skipped as already-reviewed, labels updated, failures).

**Will Not:**
- Approve a PR (`gh pr review --approve`), request changes, merge (`gh pr merge`), or close (`gh pr close`) — it only comments and labels.
- Edit, push, or delete any repository file — review never mutates repo code.
- Put automation mechanics (label, idempotency, head-SHA, scheduling) into visible comment text — the only machine metadata is the hidden marker.
- Spawn subagents (no `Task`) or use MCP — inline-only for cross-platform/headless parity.
- Add repo-list or scheduling config — the scheduler is external; each run is a stateless single-repo scan.

## Error Handling

- `gh` missing / unauthenticated / non-GitHub origin → "couldn't review (gh unavailable)", no changes, clean exit.
- `gh pr diff`/`gh api`/post errors for one PR → record `⚠ <reason>` for that PR in the summary and continue with the rest (one bad PR never aborts the scan).
- **Self-review blocked** (PR author == the posting `gh` identity) → fall back from the Reviews API to a single `gh pr comment` ([`references/pr-comments.md`](references/pr-comments.md) §5); the marker still lands so the run stays idempotent.
- **Security-heuristic flag** on posting under the user's own identity → expected when the user authorized the review hop; not an error (§5).
- No open PRs / single arg not an open PR → report and exit cleanly.
