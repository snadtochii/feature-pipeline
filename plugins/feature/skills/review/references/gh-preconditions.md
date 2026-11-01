# gh Preconditions — shared fail-closed check sequence

The single source of truth for the precondition checks a GitHub-coupled skill runs before any work. The `review` skill (this folder's `SKILL.md`) is the first consumer; `feature:sync` and `feature:address-review` consume the same sequence via `../review/references/gh-preconditions.md`, so all three skills gate on one contract. Modeled on `../build/references/pr-creation.md`'s born-in-build / reused-by-sync precedent — the producing skill owns the rules, the consumers link them. (`pr-creation.md` §0 itself consumes the check sequence only, keeping its own degrade-to-commit consequence inline — the fail-closed contract below binds just the three standalone skills.)

Each consuming skill supplies exactly one thing of its own: the wording of its one-line skip message. Everything else here — the checks, their order, and the fail-closed contract — is shared. `review` also states one exception, for its URL form only.

## The check sequence

Run the checks **in order**, before any other work:

1. `command -v gh` — gh installed?
2. `gh auth status` exits 0 — authenticated?
3. `git remote get-url origin` matches `github.com` (both the `git@github.com:` and `https://github.com/` origin forms) — GitHub origin?

`review` given a full PR URL runs checks 1 and 2 only, because the URL names the repo and no command depends on the current directory. A bare PR number and its no-argument scan run all three. `sync`, `address-review` and `pr-creation.md` always run all three.

## Fail-closed contract

On the **first** failing check:

- **Print one line** — the consuming skill's skip message, carrying the reason (which check failed).
- **Change nothing** — no file edits, no folder moves, no `gh` reads or posts.
- **Exit cleanly** — this is graceful degradation, not an error.

Only when every check that applies passes does the skill's own Process begin.
