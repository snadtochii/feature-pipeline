# PR Creation

Build invokes this at the verdict gate (SKILL.md sub-step 4d) on verdict `pass` when `--pr` is present, after the implement → review → test checkpoints pass. It runs the branch → commit → push → open-PR sequence non-interactively (the `--pr` flag is the user's authorization for the outward-facing push), finalizes the ticket into `review/` via Transition 5 on success, and degrades to a local commit + `done/` (Transition 2) when GitHub tooling is unavailable — never crashing the verdict gate.

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

**Fetch first** so the base and the "commits ahead" check reflect the real remote, not a stale local ref — a dependency ticket may already be merged into the base while local `main` lags, which would otherwise make the matrix stack onto an already-merged branch instead of forking from the updated base:
```bash
git fetch origin --quiet
```

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

## §2 Branch + commit-message conventions (inlined)

Branch:

- **type**: infer from the work — new capability `feature`, bug `fix`, deps/chore `chore`, refactor `refactor`, docs `docs`, test `test`. Default `feature`.
- **TICKET-ID**: the ticket's frontmatter `id` (uppercase prefix + number, no leading zeros).
- **slug**: 2–5 words distilled from the ticket title, lowercased, **sanitized to `[a-z0-9-]`** (strip everything else, collapse consecutive dashes, trim to ≤40 chars). Sanitizing is mandatory — the slug is interpolated into a shell command.

Commit message — the complete spec for the commit this path creates (the PR title/body are §4's concern):

- **Subject format**: `<TICKET-ID>: <imperative subject>`. When no ticket ID is resolvable, omit the prefix entirely and start the subject with the imperative verb.
- **Imperative mood**: the subject is an imperative-mood change description — it reads as a command completing "This commit will …" (Add / Fix / Extract / Update / Remove). Never past tense ("Added"), never third person ("Adds"), never a noun phrase — and **never the raw ticket title**. Reusing the ticket title as the subject is a forbidden anti-pattern: the title names the *feature*, the subject describes the *change*.
- **Length & case**: sentence case after the colon; no trailing period; aim ≤50 characters after the prefix, hard limit ~72 for the whole subject line.
- **Body**: one blank line after the subject, then what changed and why (distilled from `06-summary.md`) — not a line-by-line restatement of the diff. Wrap at ~72 columns; bullets allowed. Omit the body only for trivial commits.
- **Mechanics**: build the message via a heredoc or a message file (`git commit -F`); never `eval` and never inline arbitrary ticket text into the command string.
- **Hygiene**: no marketing language; one concern per commit.
- **Attribution trailers** (`Co-Authored-By:`, `Claude-Session:`) — one explicit rule, three parts:
  1. **Canonical**: commits carry no attribution trailers.
  2. **Mechanism**: the consumer project disables harness attribution in `.claude/settings.json`:
     ```json
     { "attribution": { "commit": "", "pr": "", "sessionUrl": false } }
     ```
     (`includeCoAuthoredBy` is deprecated; `attribution` takes precedence over it.)
  3. **Fallback**: when that setting is absent and the harness's built-in git instructions mandate attribution trailers, do not suppress or strip them — the mandated trailer block stands at the end of the message, verbatim as mandated. Currently-known forms, illustrative rather than exhaustive (exact names and values drift across harness versions and sessions): `Co-Authored-By: <model> <noreply@anthropic.com>`, `Claude-Session: <session-id>`.

  Why three parts: an unspecified trailer outcome is itself a defect — trailer presence must be an explicit, reasoned decision, never a silent divergence from either the project convention or the harness mandate.

Example — the bad subject pastes the ticket title verbatim (noun phrase, the forbidden anti-pattern); the good version describes the change imperatively:

```
# Bad — ticket title reused as the subject
PS-38: Deep FakeInboxClient adapter at the InboxApi seam

# Good — imperative change description
PS-38: Add deep FakeInboxClient adapter at the InboxApi seam

Route InboxApi reads through a FakeInboxClient so tests exercise the
real adapter seam instead of stubbing the API layer.

# Trailer block: fallback only — present ONLY when the harness mandates
# trailers and the attribution setting is absent (trailer rule above)
Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: <session-id>
```

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
# Load the ID and title from the spec via command substitution — never paste raw text into a "..." literal.
# A double-quoted assignment does NOT neutralize backticks / $() / quotes; a command-substitution result is not re-evaluated.
TICKET_ID=$(sed -n 's/^id: *//p' "<01-spec.md path>" | head -1)
SPEC_TITLE=$(sed -n 's/^title: *//p' "<01-spec.md path>" | head -1)
# Prefix with the ticket ID (matches the commit + repo convention and the §Merge predicate's
# ID-keyed lookup); skip the prefix if the spec title already carries it, to avoid doubling.
case "$SPEC_TITLE" in
  "$TICKET_ID:"*) PR_TITLE="$SPEC_TITLE" ;;
  *) PR_TITLE="$TICKET_ID: $SPEC_TITLE" ;;
esac
gh pr create --base "<base>" --title "$PR_TITLE" --body-file "<06-summary.md path>"
```
- Ready PR (no `--draft`).
- **Title** = `<TICKET-ID>: <01-spec.md title>` — the `<TICKET-ID>:` prefix mirrors the commit-message convention (§2) and is **required** by the §Merge predicate's ID-keyed lookup, which filters on `title startswith "<TICKET-ID>:"`; a prefix-less title makes `sync` miss the PR. **Body** = `06-summary.md` passed via `--body-file` (no shell interpolation of arbitrary text).
- **Epic child**: title = `<CHILD-ID>: <child title>` (same ID-prefix rule, using the child's own ID); prepend a one-line lead `Part of epic <EPIC-ID> (<epic-slug>).` to the body file; the commit references the child ID.
- Capture the PR URL from `gh pr create` stdout.
- **Push rejected**, or **`gh pr create` fails after a successful push** → degrade: report (branch is pushed; PR not opened, with the reason), finalize `done/`, record in `06-summary.md`.

**Injection discipline**: branch slug sanitized to `[a-z0-9-]`; PR title and ticket ID loaded into variables via command substitution from `01-spec.md` (NOT pasted into `"..."` literals — a double-quoted assignment doesn't neutralize backticks / `$()` / quotes) and concatenated into `$PR_TITLE`; PR body via `--body-file`; no `eval`. The push is outward-facing and is authorized only by `--pr`.

## §5 Finalize

- **Success** (PR opened, URL captured) → Transition 5 (`in-progress → review`, status `in-review`). Record the PR URL + branch in `06-summary.md`. Print:
  `✅ PR opened: <url>  (branch <branch> → <base>). Ticket → review/. Merge the PR, then re-run to finalize to done/.`
- **Degradation** (any precondition/push/PR failure) → Transition 2 (`done/`). Record the reason + branch in `06-summary.md`. Print the specific degradation line.
- The verdict stays `pass` in both cases — degradation is not a build failure.

## Merge predicate (single definition — referenced by build's `review/` resumption row and the `sync` skill)

For an `in-review` ticket (a solo ticket or an at-review epic in `review/`, or — for the `sync` caller — an epic child whose subtree is still in `in-progress/`), determine whether its PR has merged. **The rule is shared; the lookup key depends on the caller:**

- **Branch-keyed** — build's per-ticket `review/` resumption, which has the current checkout:
  ```bash
  gh pr view "<branch>" --json state,mergeCommit,baseRefName --jq '.state + " " + (.mergeCommit.oid // "") + " " + .baseRefName'
  ```
  `<branch>` is the ticket's pushed branch (recorded in `06-summary.md`) or the current checkout. The output is `state`, the merge-commit SHA (`MERGE_SHA`) when merged, and the PR's own base branch (`PR_BASE`), all fed into the reachability gate below.
- **ID-keyed** — the `sync` skill's batch scan, which has no reliable branch (the slug is judgment-distilled and the branch matrix may reuse a non-convention branch). GitHub's title search is tokenized, so anchor on the `<TICKET-ID>:` title convention:
  ```bash
  gh pr list --search "<TICKET-ID> in:title" --state all --json number,state,url,createdAt,title,mergeCommit,baseRefName --jq '[.[] | select(.title | startswith("<TICKET-ID>:"))] | sort_by(.createdAt) | last | .state + " " + (.mergeCommit.oid // "") + " " + .baseRefName'
  ```
  Every PR/commit title leads with `<TICKET-ID>:`, so the `startswith` post-filter pins the ticket's own PR; `last` picks the newest. More robust than the branch when the branch isn't recoverable. As with the branch-keyed lookup, this yields `state`, the merge-commit SHA (`MERGE_SHA`), and the PR's own base branch (`PR_BASE`) for the reachability gate below.

**Shared rule** (both lookups): a PR promotes to `done/` only when it is `MERGED` **and** its merge commit is **reachable from the base branch** — checking *that* a PR merged is not enough, because an epic child squash-merged only into `integration/<epic-id>` reports `MERGED` identically to a solo PR merged into the base. Gating on reachability keeps `sync` safe to run mid-epic-run: a child stays `in-review` until its code actually lands on `<base>`.

Resolve the ticket's **true trunk from the PR itself** — the branch its code must reach to be "done" — not from the repository default, which would ignore a non-default `ship --base <branch>` (a run targeting a non-default base would merge and then stay `in-review` forever, its merge SHA checked against the wrong branch). This section is referenced **standalone** (build's `review/` resumption and `sync`), so it fetches and resolves the base itself:
```bash
git fetch origin --quiet
# A direct-to-trunk PR's own base IS the trunk (this respects `--base <branch>`).
# An epic child's PR base is its `integration/<epic-id>` branch — its true trunk is that
# integration branch's OWN PR base (the epic's `--base`), so the child promotes only once the
# integration PR lands on the real trunk (preserving the shared rule's mid-epic-run safety).
if [ -n "$PR_BASE" ] && [ "${PR_BASE#integration/}" = "$PR_BASE" ]; then
  base="$PR_BASE"                                                    # solo / direct-to-trunk PR
elif [ -n "$PR_BASE" ]; then
  base=$(gh pr list --head "$PR_BASE" --state all --json number,baseRefName \
           --jq 'sort_by(.number) | last | .baseRefName' 2>/dev/null)   # epic child → epic's trunk
fi
# Fallback only when the PR base can't be resolved; an unresolved base is treated as NOT
# promotable below (never a pass), so this can never wrongly promote.
[ -n "$base" ] || base=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@' || echo main)
```

Then, from the lookup's `state` and `MERGE_SHA`:

- **Not `MERGED`** (`OPEN`, `CLOSED`, or `gh` unavailable) → treat as not merged: print `PR still open for <ticket-id>; merge it, then re-run to finalize.` and exit without changes.
- **`MERGED`** → gate on reachability (`MERGE_SHA` is the `mergeCommit.oid` from the lookup — a controlled command-substitution value, never free text):
  ```bash
  if [ -n "$MERGE_SHA" ] && git merge-base --is-ancestor "$MERGE_SHA" "origin/$base" 2>/dev/null; then
    : # merged AND reachable from origin/<base> → fire Transition 6
  else
    : # merged only into an integration branch, or SHA/base unresolvable → NOT promotable
  fi
  ```
  - **Reachable** → fire Transition 6 (`review → done`), print `PR merged and reachable from <base>; <ticket-id> finalized to done/.` For an epic child, the finalization also runs the **Epic-completion predicate** (`state-transitions.md`) — promoting the epic subtree only when the full declared roster is materialized-and-terminal.
  - **Not reachable, or `MERGE_SHA`/`base` unresolvable** (offline, or `gh`/`git` can't answer) → reuse the not-merged output path: print `PR still open for <ticket-id>; merge it, then re-run to finalize.` and exit without changes. **Never promote on an unverifiable merge** — an unresolved SHA or base is treated as not-yet-on-`<base>`, not as a pass.

This gate applies to **both** lookups (branch-keyed for build, ID-keyed for `sync`) — the rule lives once here; neither caller forks it.

This check runs on every re-invocation of a `review/` ticket (or every `sync` pass) and does NOT require `--pr` on the command line — `--pr` authorizes *opening* a PR; *checking* an already-open one is a pure read.
