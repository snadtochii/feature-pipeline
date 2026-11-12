# Sync — fs-native Storage Mechanics

Canonical logic for sync's storage-touching steps in fs-native storage mode. Read when the storage mode detected at sync's start per [`../../flow/references/storage.md`](../../flow/references/storage.md) is fs-native — a run in the other storage mode never needs this file. Referenced by `sync`, and at §6 by [`pr-creation.md`](../../build/references/pr-creation.md), [`gh-preconditions.md`](../../review/references/gh-preconditions.md) and [`multi-repo.md`](../../discover/references/multi-repo.md). Operations named below are defined in [`../../flow/references/storage-fs.md`](../../flow/references/storage-fs.md); sections are numbered so the skill body cites `§N`.

## §1 Scan set

The scan set is every ticket sitting in `backlog/`, `in-progress/`, or `review/` — the **folder** is the authoritative scan dimension; frontmatter `status` is a consistency signal, not a filter. `done/` is terminal and never scanned. Folder-keying reaches every ticket that could carry a merged PR, including a solo ticket parked in `backlog/`/`in-progress/` after a crash or re-plan, and an epic child that is `in-review` in place while its subtree still sits in `in-progress/<EPIC>/` (a sibling is mid-build, so the precedence rule `in-progress` ⊐ `review` ⊐ `done` keeps the epic out of `review/` — the `in-progress/` folder scan still reaches the child via the `*/tasks/*` glob).

- **All (no arg)**: glob `claudedocs/tickets/*/*/01-spec.md` (solo tickets) and `claudedocs/tickets/*/*/tasks/*/01-spec.md` (epic children). Use the `Glob` tool — a no-match pattern returns nothing, not an error; don't rely on raw shell globbing, which can abort on no-match. The `*/tasks/*` depth is fixed at one level (epics nest exactly one level: parent → `tasks/<child>/`); do not use `**`. **Keep by folder**: from each matched path, read the state-folder segment (the directory right under `claudedocs/tickets/`) and keep the ticket iff that segment is `backlog`, `in-progress`, or `review`; drop anything under `done/`.
- **Single (`$1` given)**: resolve the ID per [`../../flow/references/ticket-resolution-fs.md`](../../flow/references/ticket-resolution-fs.md) Step 1. Accept it if its resolved folder is under `backlog/`, `in-progress/`, or `review/`, regardless of frontmatter `status`; if it resolves under `done/`, report "`<id>` is already in done/ — nothing to sync" and exit.
- **Scanned location**: the ticket's current state folder, carried alongside it for Step 3 (the solo `mv` source) and the Step 3/4 report shaping.
- **Terminal short-circuit, applied here**: read each kept ticket's frontmatter `status`; `done` or `cancelled` inside an active folder is a stale terminal status and a no-op for sync — such a ticket is dropped from the PR-checked set.
- **Malformed/unparseable frontmatter**: the ticket is still PR-checked (folder membership, not status, put it in the scan set) — its status simply can't be compared for the mismatch note in Step 3. Skip any status edit that can't be parsed safely.
- **Empty set**: no ticket in any of the three folders → report "Nothing to sync — no tickets in `backlog/`, `in-progress/`, or `review/`." and exit cleanly.

## §2 PR lookup key

The ID-keyed lookup in the skill body is the only key: nothing precedes it and nothing is recorded on the ticket after it. No survivor → `no-PR-found`; shaping per §4.

## §3 Transition 6 mechanics

Transition 6 is invoked per [`../../flow/references/state-transitions-fs.md`](../../flow/references/state-transitions-fs.md); the `mv`/`Edit` mechanics below are its form for sync's two ticket shapes.

- *Solo ticket*: move the folder first from its **current** state folder — `mv "claudedocs/tickets/<current-state>/<id>" "claudedocs/tickets/done/<id>"`, where `<current-state>` is the `backlog`/`in-progress`/`review` folder the §1 scan matched (**not** a hardcoded `review/`) — then `Edit` its `01-spec.md` frontmatter `status` → `done`. Do not unify this solo path with the epic-child path below (a child flips in place without a folder move). **Mismatch note**: when the source folder is *not* `review/` — a merged PR reached a solo ticket that never went through the normal `review → done` path — add one `⚠` note line for it in Step 4 (e.g. `⚠ <id> promoted from <folder>/ — merged outside the review→done path`). A promotion from `review/` is the normal path and gets no note.
- *Epic child*: no child-folder move — `Edit` the child's `status` → `done`. The child's subtree may be in `review/` **or** still in `in-progress/` (a sibling is mid-build or not yet started); either way the child flips in place, and no mismatch note is emitted (an epic child's status/folder decoupling is by design, not an anomaly). **Defer** Transition 6's **Epic-completion predicate** to once per affected epic at the end of the pass: collect the epics whose children you promoted this pass; for each, re-resolve `<epic-folder>` (the deepest ancestor containing `prd.md`, at its **current** location) and apply the **Epic-completion predicate** (see [`../../flow/references/state-transitions-fs.md`](../../flow/references/state-transitions-fs.md)) *after* all in-pass child flips are written — invoke it, don't reimplement the roster/sibling scan. On `promote`, `mv` the whole epic subtree from its current folder — `<epic-folder> → done/<EPIC>` (source is wherever the epic currently sits, `in-progress/` or `review/`, **not** a hardcoded `review/<EPIC>`) — and set `prd.md` `status` → `done`. On `stay`, leave the epic where it is: the child flip stands and the epic stays put under the precedence rule. The predicate gates on the epic's **declared `children:` roster**, so a just-in-time epic whose later-phase children aren't materialized yet correctly stays put even when every authored child is terminal. Render any predicate warnings (roster-unknown when `children:` can't be read; roster-drift when a materialized child isn't in the roster) as `⚠ Needs attention` report lines (Step 4). (Deferring once per epic avoids re-applying the predicate per merged child, where only the last child's check can succeed.)
- **Atomicity** (per `state-transitions-fs.md`): always move the folder before editing frontmatter, so a move failure leaves the prior state recoverable.

## §4 Report shaping

The Step 4 template renders as written: `<folder>` is the scanned state folder carried from §1, `done/` is the promotion target, and `review/` marks the in-review location. A `no-PR-found` ticket is shaped by its scanned folder — a silent aggregate line for `backlog/` and `in-progress/` tickets (most active tickets legitimately have no PR), a loud per-ticket `? Couldn't check` line for a `review/` ticket (no PR on a `review/` ticket is an anomaly).

## §5 Error handling

- Folder-move failure mid-promotion → surface it, stop that ticket (frontmatter still reflects the prior state for recovery), continue with the rest of the pass.

## §6 Repository aiming

Where the precondition checks and each ticket's git and gh commands run depends on the workspace's shape.

- **Shape.** Decided once at sync's start, from the project root, with [`discover`](../../discover/SKILL.md)'s multi-repo test — no `.git` at the root, and an immediate child holding one:
  ```bash
  [ ! -e .git ] && [ -n "$(find . -mindepth 2 -maxdepth 2 -name .git -print -quit)" ]
  ```
  Exit 0 means multi-repo. `-e` also matches a worktree's `.git` file, and `find` avoids a `*/` glob, which can abort on no-match.
- **Any other shape.** The shared sequence in [`gh-preconditions.md`](../../review/references/gh-preconditions.md) runs as written, before any work, and every command runs from the working directory. `repos:` is not read, and nothing below applies.
- **Multi-repo, before Step 1.** Checks 1 and 2 run up front, and a failure keeps the shared contract: one skip line, change nothing, exit. Check 3 runs after binding.
- **Binding, after Step 1.** Each ticket still in the PR-checked set binds a `<repo-path>` from the `repos:` in its own `01-spec.md`, or in `prd.md` for an epic given as `$1`. A child's value is never read from its epic.
  - One entry: `<project-root>/<entry>`, passing the in-place repository check in [`ticket-resolution-fs.md`](../../flow/references/ticket-resolution-fs.md) Step 3. Failing it: `couldn't-check (repos: entry does not resolve to a git repository)`.
  - Two or more, on an `in-review` ticket: the 2+ rule in [`ship`'s `storage-fs.md`](../../ship/references/storage-fs.md) §1, **Lane binding**, which binds the entry whose `origin` names the repository of the ticket's `pr:` line. No `pr:` line, or no match: `couldn't-check (names <n> repos; none bound from its pr: line)`.
  - Two or more, on any other ticket: `couldn't-check (names <n> repos; a PR needs one)`.
  - No field, an empty list, or a value that cannot be read: `couldn't-check (no repository: its repos: field names none)`.
- **Check 3, per repository.** Runs once per distinct `<repo-path>`: `git -C "<repo-path>" remote get-url origin` matches `github.com`, in the same two origin forms as the shared check. A failure gives each of that repository's tickets `couldn't-check (repo <repo> failed pre-flight: <what failed>)`, and the other repositories continue.
- **Aiming.** Every git and gh command of Steps 2 and 3 for a bound ticket runs as `(cd "<repo-path>" && …)`, the PR lookup and each Merge predicate call included, so the working directory stays at the project root for §3's relative `mv`. Commands that share a variable stay in one subshell — for the Merge predicate, every variable its closing subshell sentence lists.
- **Report.** A `couldn't-check` from this section is a loud `? Couldn't check` line whatever the folder. The ticket counts in the header, runs no lookup, never promotes, and never joins the silent aggregate.
