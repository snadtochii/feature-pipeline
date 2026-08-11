# Commit Mechanics

The shared stage + commit procedure for every build surface that creates a commit: the verdict gate's commit path (SKILL.md 4d — a confirmed prompt or `git.commit: always`) and the `--pr` sequence ([`pr-creation.md`](pr-creation.md) §3). Branch selection is the caller's concern — the verdict gate commits onto the current branch; `--pr` runs its own branch-decision matrix first (pr-creation.md §1). Nothing here pushes: pushing is `--pr`-only (pr-creation.md §4).

Build has no `Skill` tool, so these conventions are inlined here rather than borrowed from a separate skill. All git work runs inline via `Bash`.

**Working tree**: when the caller has a worktree bound, every `git` command below runs as `git -C "<wt-path>" …` per [`worktree.md`](worktree.md) §3, which explains why `-C` is load-bearing here rather than cosmetic. §1 additionally excludes any path `worktree.md` §2 step 4 flagged as **not ignored in the worktree** — `git reset -q -- "<rel-path>"` alongside the `claudedocs` and session-state exclusions. The message file passed to `git commit -F` is a `/tmp` or scratchpad path and is unaffected.

## §1 Stage (gitignore-aware — honors the consumer's repo)

```bash
if git check-ignore -q claudedocs; then
  git add -A                                   # claudedocs/ is ignored → safe to sweep
else
  git add -A && git reset -q -- claudedocs/     # claudedocs/ is tracked → exclude ticket bookkeeping
  echo "claudedocs/ is tracked in this repo — ticket artifacts excluded from the commit."
fi
```

Never assume `claudedocs/` is gitignored in the consumer repo — gate on the actual `.gitignore` so a project that tracks it doesn't sweep internal pipeline bookkeeping into the user's feature commit.

**Session-state backstop.** `git add -A` honors `.gitignore` but sweeps every other untracked file — including a secrets file whose gitignore entry was forgotten. When the project's `config.yaml` `test:` block declares `test.auth.storage_state`, check it before committing: if `git check-ignore -q <that path>` fails (the file is NOT ignored), exclude it (`git reset -q -- <path>`) and print one line naming it — live session cookies never enter a commit. This is the staging-side backstop to the `ui-tester`'s write-time guard, which is unenforced agent prose; on unattended paths (`git.commit: always`, `--pr`) nothing else stands between that file and the commit.

## §2 Commit message

- **Subject format**: `<TICKET-ID>: <imperative subject>`. When no ticket ID is resolvable, omit the prefix entirely and start the subject with the imperative verb.
- **Imperative mood**: the subject is an imperative-mood change description — it reads as a command completing "This commit will …" (Add / Fix / Extract / Update / Remove). Never past tense ("Added"), never third person ("Adds"), never a noun phrase — and **never the raw ticket title**. Reusing the ticket title as the subject is a forbidden anti-pattern: the title names the *feature*, the subject describes the *change*.
- **Length & case**: sentence case after the colon; no trailing period; aim ≤50 characters after the prefix, hard limit ~72 for the whole subject line.
- **Body**: one blank line after the subject, then what changed and why (distilled from `06-summary.md`) — not a line-by-line restatement of the diff. Wrap at ~72 columns; bullets allowed. Omit the body only for trivial commits.
- **Mechanics**: write the message to a file with the `Write` tool and commit with `git commit -F <message-file>` — literal content, no shell parsing. On a Bash-only surface, create the file via a nonce-delimited single-quoted heredoc (per [`../../review/references/pr-comments.md`](../../review/references/pr-comments.md) §4) — never an unquoted heredoc (the body is repo-derived text full of backticks and `$()`). Never `eval` and never inline arbitrary ticket text into the command string.
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
