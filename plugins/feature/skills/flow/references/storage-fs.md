# Storage — fs-native Operations

Canonical logic for the storage operations in fs-native storage mode. Read when the storage mode detected per [`storage.md`](storage.md) is fs-native — a run in the other storage mode never needs this file. Referenced by [`ticket-resolution-fs.md`](ticket-resolution-fs.md), [`state-transitions-fs.md`](state-transitions-fs.md), [`lessons-log-fs.md`](lessons-log-fs.md), and the stage skills.

Tickets are files under `claudedocs/tickets/`, read and written entirely offline. A ticket's state is its folder — one of `backlog/`, `in-progress/`, `review/`, `done/` — plus the `status` field in its frontmatter. `config.yaml`'s `prefix` is the ID prefix used for allocation.

---

## Operation vocabulary

The per-concern references express their steps in terms of these operations rather than restating them.

### Resolve ticket (argument → handle)

Turn a ticket argument (ID or path) into a working handle: the search order and nested-child lookup in [`ticket-resolution-fs.md`](ticket-resolution-fs.md) Step 1 — the handle is the resolved `<ticket-folder>` path.

### Read ticket metadata

Read the ticket's structured fields from the YAML frontmatter of `01-spec.md` (solo/child) or `prd.md` (epic) — `status`, `kind`, `parent`, `children`, `blocked_by`, `title`, `priority`, `complexity`, `tags`.

### Read artifact

`Read` `<ticket-folder>/<name>` (e.g. `01-spec.md`, `02-plan.md`).

### Write artifact

`Write`/`Edit` `<ticket-folder>/<name>`.

### Delete artifact

The start-fresh reset. User-side for build's signal (delete `03-implementation.md` onward before re-invoking); skill-side in exactly one place — flow's SETUP downstream-artifact invalidation, which removes build artifacts when `02-plan.md` is absent. No other pipeline skill deletes artifacts.

Delete `<ticket-folder>/<name>`; git history retains the body if a backup is wanted.

### List artifacts (names + timestamps)

`Glob` the ticket folder; recency comes from file mtimes.

### Transition status

Move the ticket through the state machine. The per-transition semantics (sources, targets, epic-child variants, epic-completion predicate) live in [`state-transitions-fs.md`](state-transitions-fs.md); the mechanism each transition dispatches on is a folder `mv` between state directories + a frontmatter `status` `Edit`, exactly as each transition specifies.

### Update ticket fields

Write non-status fields — `title`, `priority`, `complexity`, `tags`, `blocked_by` — via frontmatter `Edit` on `01-spec.md` / `prd.md`. `pr_url` has no frontmatter slot — build records the PR URL in `06-summary.md`, and `sync` rediscovers PRs by title search.

### List tickets / list children

`Glob` the state folders (`claudedocs/tickets/*/*/01-spec.md`, `claudedocs/tickets/*/*/tasks/*/01-spec.md`); an epic's children live under `<epic-folder>/tasks/*/`.

### Create ticket

`discover`'s inline intake variant — prefix/ID allocation and folder creation live in the `discover` skill, not here.

### Lessons produce / consume

The contract lives in [`lessons-log-fs.md`](lessons-log-fs.md) — entries append to `claudedocs/tickets/_lessons.md`. This vocabulary entry exists so lessons are reached through the same seam; the format, supersession, and grep-scoping rules are owned there.
