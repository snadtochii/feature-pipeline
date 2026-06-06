# PR Creation

Build invokes this at the verdict gate (SKILL.md sub-step 4e) on verdict `pass` when `--pr` is present, after the implement → review → test checkpoints pass. It runs the branch → commit → push → open-PR sequence non-interactively (the `--pr` flag is the user's authorization for the outward-facing push), finalizes the ticket into `review/` via Transition 5 on success, and degrades to a local commit + `done/` (Transition 2) when GitHub tooling is unavailable — never crashing the verdict gate.

Build has no `Skill` tool, so the branch/commit conventions are inlined here rather than borrowed from a separate skill. All git/gh work runs inline via `Bash`.

## When it runs

- The full sequence (§0–§5): only on verdict `pass` with `--pr`. On `partial`/`stuck`, or without `--pr`, this reference is not used — the standard commit gate applies.
- The **Merge predicate** section only: referenced by build's `review/` resumption row, which runs on every re-invocation of a `review/` ticket regardless of whether `--pr` is on the command line.

## §0 Preconditions (short-circuit to commit-only)

Run before any branch/push work, in order; first failure → degrade (do NOT proceed to push):

1. `command -v gh` — gh installed?
2. `gh auth status` exits 0 — authenticated?
3. `git remote get-url origin` matches `github.com` (both `git@github.com:` and `https://github.com/` forms) — GitHub origin?

On any failure: still create the branch + local commit (§1–§3, skipping push/PR), print one specific line (e.g. `--pr: gh not installed — committed to <branch>, finalized to done/.`), finalize via Transition 2 (`done/`), and record the reason in `06-summary.md`. Never abort the verdict gate.

## §1 Detect base + decide the branch

Base branch — mirror the review-checkpoint helper, but resolve to the **short** branch name (the matrix below uses `<base>` as a local branch name, so `origin/main` would break `git checkout`/`gh --base`):
```bash
base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || echo main)
```
`<base>` is the short branch name (e.g. `main`); `origin/<base>` (e.g. `origin/main`) is the remote-tracking ref. Current branch: `git rev-parse --abbrev-ref HEAD`.

Branch-decision matrix:
- **On `main`/`master`** → `git checkout -b <branch>` carrying the uncommitted changes (clean fork; the trunk stays put).
- **On a feature branch, no commits ahead of base** (`git rev-list origin/<base>..HEAD` empty) → fork from base: `git stash -u` → `git checkout <base>` → `git pull --ff-only` → `git checkout -b <branch>` → `git stash pop` → commit.
- **On a feature branch WITH commits ahead of base** (`git rev-list origin/<base>..HEAD` non-empty) → do NOT silently fork; the uncommitted work may depend on those commits. Pause and ask: **reuse current branch** / **fork anyway** / **abort**.
- **Detached HEAD** → can't safely reuse; pause and ask: **fork anyway** / **abort**.
- **No local base branch** (only `origin/<base>`) → fork from `origin/<base>` directly (`git checkout -b <branch> origin/<base>`); never assume a local `<base>` exists.
- **Stash-pop conflict mid-fork** → stop; leave the stash intact; print the conflict + `resolve, then \`git stash pop\``; abort the PR step WITHOUT committing; report and exit the ship path (do not crash the gate).

`<branch>` = `<type>/<TICKET-ID>-<slug>` (see §2).

## §2 Branch + commit conventions (inlined)

- **type**: infer from the work — new capability `feature`, bug `fix`, deps/chore `chore`, refactor `refactor`, docs `docs`, test `test`. Default `feature`.
- **TICKET-ID**: the ticket's frontmatter `id` (uppercase prefix + number, no leading zeros).
- **slug**: 2–5 words distilled from the ticket title, lowercased, **sanitized to `[a-z0-9-]`** (strip everything else, collapse consecutive dashes, trim to ≤40 chars). Sanitizing is mandatory — the slug is interpolated into a shell command.
- **commit message**: `<TICKET-ID>: <Imperative subject>`, blank line, then a body (what changed and why, distilled from `06-summary.md`). Build it via a heredoc or a message file (`git commit -F`); never `eval` and never inline arbitrary ticket text into the command string.

## §3 Stage (gitignore-aware — honors the consumer's repo)

```bash
if git check-ignore -q claudedocs; then
  git add -A                                   # claudedocs/ is ignored → safe to sweep
else
  git add -A && git reset -q -- claudedocs/     # claudedocs/ is tracked → exclude ticket bookkeeping
  echo "--pr: claudedocs/ is tracked in this repo — ticket artifacts excluded from the PR commit."
fi
git commit -F <message-file>
```
Never assume `claudedocs/` is gitignored in the consumer repo — gate on the actual `.gitignore` so a project that tracks it doesn't sweep internal pipeline bookkeeping into the user's feature PR.

## §4 Push + open PR (injection-safe)

```bash
git push -u origin "<branch>"
# Load the title from the spec via command substitution — never paste raw title text into a TITLE="..." literal.
# A double-quoted assignment does NOT neutralize backticks / $() / quotes; a command-substitution result is not re-evaluated.
TITLE=$(sed -n 's/^title: *//p' "<01-spec.md path>" | head -1)
gh pr create --base "<base>" --title "$TITLE" --body-file "<06-summary.md path>"
```
- Ready PR (no `--draft`).
- **Title** = the ticket's `01-spec.md` title. **Body** = `06-summary.md` passed via `--body-file` (no shell interpolation of arbitrary text).
- **Epic child**: title = the child's title; prepend a one-line lead `Part of epic <EPIC-ID> (<epic-slug>).` to the body file; the commit references the child ID.
- Capture the PR URL from `gh pr create` stdout.
- **Push rejected**, or **`gh pr create` fails after a successful push** → degrade: report (branch is pushed; PR not opened, with the reason), finalize `done/`, record in `06-summary.md`.

**Injection discipline**: branch slug sanitized to `[a-z0-9-]`; PR title loaded into a variable via command substitution from `01-spec.md` (NOT pasted into a `TITLE="..."` literal — a double-quoted assignment doesn't neutralize backticks / `$()` / quotes); PR body via `--body-file`; no `eval`. The push is outward-facing and is authorized only by `--pr`.

## §5 Finalize

- **Success** (PR opened, URL captured) → Transition 5 (`in-progress → review`, status `in-review`). Record the PR URL + branch in `06-summary.md`. Print:
  `✅ PR opened: <url>  (branch <branch> → <base>). Ticket → review/. Merge the PR, then re-run to finalize to done/.`
- **Degradation** (any precondition/push/PR failure) → Transition 2 (`done/`). Record the reason + branch in `06-summary.md`. Print the specific degradation line.
- The verdict stays `pass` in both cases — degradation is not a build failure.

## Merge predicate (single definition — referenced by build's `review/` resumption row)

For a ticket in `review/` (status `in-review`), determine whether its PR has merged:
```bash
gh pr view "<branch>" --json state --jq '.state'
```
- `MERGED` → fire Transition 6 (`review → done`); print `PR merged; <ticket-id> finalized to done/.`
- anything else (`OPEN`, `CLOSED`, or `gh` unavailable) → treat as not merged: print `PR still open for <ticket-id>; merge it, then re-run to finalize.` and exit without changes.

`<branch>` is the ticket's pushed branch (recorded in `06-summary.md`) or the current checkout. This check runs on every re-invocation of a `review/` ticket and does NOT require `--pr` on the command line — `--pr` authorizes *opening* a PR; *checking* an already-open one is a pure resumption action.
</content>
