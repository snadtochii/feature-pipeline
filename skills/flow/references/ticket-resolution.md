# Ticket Resolution — Shared Logic

Canonical logic for resolving a ticket argument to a **ticket folder**, ensuring the spec is in place, locating the shared exploration, and validating that the ticket is actually pipelineable. Referenced by every stage skill (`analyze`, `plan`, `implement`, `review`, `test`) and by the `flow` orchestrator itself.

`discover` does **not** use this reference — it handles the intake/creation variant with prefix logic inline.

---

## Layout context

A ticket folder has one of two shapes depending on whether it came from a single-ticket discovery or from a multi-sibling discovery (an epic with children).

### Solo ticket (single-mode discover)

```
claudedocs/tickets/<state>/<id>/
├── 01-spec.md            ← THE spec (frontmatter + body — this IS the ticket)
├── exploration.md        ← discover output, optional
├── 02-analysis.md        ← analyze stage
├── 03-plan.md            ← plan stage
├── 04-implementation.md  ← implement stage (live, updated incrementally)
├── 05-review.md          ← review stage
├── 06-tests.md           ← test stage
├── 07-summary.md         ← completion
├── bugs/                 ← test-stage bug reports
├── .iterations.json      ← loop-back counter state (flow)
└── .stale/               ← superseded artifacts after deliberate re-runs
```

### Epic with children (multi-mode discover)

```
claudedocs/tickets/<state>/<EPIC-ID>/
├── prd.md                ← parent epic — frontmatter (kind: epic, children: [...]) + PRD body
├── exploration.md        ← shared exploration, lives once for all siblings
└── tasks/
    ├── <CHILD-1-ID>/
    │   ├── 01-spec.md    ← child ticket — frontmatter (parent, epic, siblings, blocked_by) + body
    │   ├── 02-analysis.md
    │   ├── 03-plan.md
    │   ├── 04-implementation.md
    │   ├── 05-review.md
    │   ├── 06-tests.md
    │   ├── 07-summary.md
    │   ├── bugs/
    │   ├── .iterations.json
    │   └── .stale/
    ├── <CHILD-2-ID>/
    └── <CHILD-3-ID>/
```

`<state>` is one of `backlog`, `in-progress`, `done`. The whole epic subtree moves between state folders together; per-child progress is tracked in each child's frontmatter `status` field.

The variable `<ticket-folder>` used throughout stage skills resolves to:
- `claudedocs/tickets/<state>/<id>/` for solo tickets
- `claudedocs/tickets/<state>/<EPIC-ID>/tasks/<CHILD-ID>/` for child tickets

The variable `<epic-folder>` (used only when `<ticket-folder>` is a child) resolves to `claudedocs/tickets/<state>/<EPIC-ID>/` — the deepest ancestor containing `prd.md`.

---

## Step 1 — Resolve the ticket argument

Given the ticket argument (typically `$1`):

1. **If the argument contains `/` or `.md`**, treat it as a path:
   - If it ends in `01-spec.md`, the ticket folder is its parent directory.
   - If it ends in `prd.md`, the argument refers to an epic — see Step 4 (Validate kind) for handling.
   - If it's a directory under `claudedocs/tickets/<state>/`, that's the ticket folder.
   - Otherwise, parse out the ID and fall through to ID-based search.
2. **Otherwise treat it as a ticket ID** and search in this order:
   - `claudedocs/tickets/backlog/<id>/`
   - `claudedocs/tickets/in-progress/<id>/`
   - `claudedocs/tickets/done/<id>/`
   - **Nested children**: glob `claudedocs/tickets/**/tasks/<id>/` to catch children of an epic
   - Case-insensitive glob: `claudedocs/tickets/**/<id>/`
3. **If not found**, ask the user for the ticket path — do not guess.
4. **Read the spec/PRD** from the resolved folder:
   - If the folder contains `01-spec.md`, this is a solo or child ticket — read it.
   - If the folder contains `prd.md` (and no `01-spec.md`), this is an epic — see Step 4 (Validate kind) below.
5. **Determine `<ticket-id>`** = the frontmatter `id` field, or the folder name if no `id` is set.

The resolved path becomes `<ticket-folder>` for downstream stages.

## Step 2 — Ensure the spec exists

The ticket folder should always contain `01-spec.md` — that file is the ticket. Edge cases:

1. **Folder exists with `01-spec.md`** — read it. Done.
2. **Folder exists with `prd.md` but no `01-spec.md`** — this is an epic folder, not a child ticket. See Step 4.
3. **Folder exists, neither `01-spec.md` nor `prd.md`** — corrupted state. Ask the user before proceeding.
4. **Read other existing artifacts** relevant to the current stage — `02-analysis.md`, `03-plan.md`, etc., and `exploration.md` if the stage uses it (see Step 5). Ignore anything under `.stale/`.

## Step 3 — Determine project root

Needed for codebase operations during the stage.

1. Read the `project` field from `01-spec.md`'s frontmatter
2. Locate the project directory:
   - If the current working directory matches the project, use it
   - Otherwise check common paths — ask the user if ambiguous
3. If the project root can't be determined, ask the user before proceeding.

## Step 4 — Validate kind (epic refusal)

After reading frontmatter, check the `kind` field:

- If `kind: epic` is present, the resolved item is a parent epic, not a pipelineable ticket. **Abort the stage** with this message:
  ```
  <ID> is an epic (kind: epic), not a pipelineable ticket. Epics group siblings — they hold the PRD, the shared exploration, and the decomposition table, but they don't go through analyze/plan/implement/review/test themselves.

  Run the pipeline against one of its children instead:
  <list the IDs from the epic's `children:` frontmatter field>
  ```
- If `kind` is absent or has any other value, the ticket is pipelineable. Proceed.

This is the centralized epic-refusal rule. Stage skills (`analyze`, `plan`, `implement`, `review`, `test`) inherit it via this reference and don't need to duplicate the check.

## Step 5 — Locate exploration (when the stage needs it)

`analyze` reads `exploration.md` as a seed for incremental codebase exploration. Other stages may also reference it. The file lives in different places depending on the ticket shape:

- **Solo ticket** (`<ticket-folder>` matches `claudedocs/tickets/<state>/<id>/`): exploration is at `<ticket-folder>/exploration.md`.
- **Child of an epic** (`<ticket-folder>` matches `claudedocs/tickets/<state>/<EPIC-ID>/tasks/<CHILD-ID>/`): exploration is at `<epic-folder>/exploration.md`, where `<epic-folder>` is `<ticket-folder>/../..` (the deepest ancestor containing `prd.md`).

If `exploration.md` is missing entirely (solo ticket created outside `discover`, or an epic that never ran exploration), proceed without a seed — `analyze` falls back to a full codebase exploration in that case.

## Step 6 — Validate blockers

After reading frontmatter, check the `blocked_by` field. If it's missing or empty, skip this step. Otherwise, for each blocker ID:

1. **Locate the blocker** using the same Step 1 logic (search `backlog/`, `in-progress/`, `done/`, including nested children under `tasks/`).
2. **Determine completion**: a blocker is "done" if its frontmatter `status` is `done` or `cancelled`, OR its folder is under `claudedocs/tickets/done/`. Frontmatter is authoritative; folder location is the fallback when frontmatter is missing.

The stage's behavior depends on which stage is running:

- **`analyze`, `plan`** — do NOT refuse on unfinished blockers. Auto-load each blocker's available artifacts (`01-spec.md`, `02-analysis.md`, `03-plan.md` — whichever exist) and pass them to the stage as **Blocker Context**, so the stage reasons against the planned dependency rather than a blind codebase. Print a one-line note per blocker:
  ```
  Loaded blocker context from <blocker-id> (status: <status>, artifacts: <comma-separated list>).
  ```
  The Blocker Context section format passed to subagents (analyze) or read inline (plan):
  ```
  ## Blocker Context
  This ticket is blocked by <blocker-id> (status: <status>).
  <blocker-id>'s spec: <full content of blocker's 01-spec.md>
  <blocker-id>'s analysis: <full content of blocker's 02-analysis.md, if present>
  <blocker-id>'s plan: <full content of blocker's 03-plan.md, if present>

  Factor this into your <analysis|plan> — assume the blocker will deliver what its plan/spec describes; do NOT flag as gaps things the blocker is already designed to provide.
  ```

- **`implement`, `review`, `test`** — REFUSE if any blocker is not done (or cancelled). Abort with this message:
  ```
  Cannot run <stage> on <ticket-id>. Blockers not yet done:
  - <blocker-id> (status: <status>, location: claudedocs/tickets/<state>/.../<blocker-id>/)
  - ...

  Either complete the blockers first, or bypass with --ignore-blockers (proceeds at your risk; you may break the build).
  ```

### Bypass: `--ignore-blockers`

When the stage is invoked with `--ignore-blockers` (either directly via the stage skill, or propagated from `flow`):

- For `implement`/`review`/`test`: skip the refusal. Print a one-line warning instead, then proceed:
  ```
  ⚠ Bypassing blocker check for <ticket-id>. Unfinished blockers: <list>. Proceeding anyway.
  ```
- For `analyze`/`plan`: the flag is a no-op (these stages don't refuse anyway), but blocker-context loading still happens.

This rule is centralized here so stage skills inherit it via reference and don't duplicate the check.

---

## Error handling

- Ticket folder not found → ask the user for the path
- Both `01-spec.md` and `prd.md` missing inside the resolved folder → corrupted state; ask the user
- Frontmatter missing or malformed → warn and ask
- Project root can't be determined → ask the user
- Resolved item is an epic (`kind: epic`) → abort with the message in Step 4; do not silently fan out to children
- Blocker can't be located → warn and treat as not-done (worst-case assumption); the user can investigate or bypass with `--ignore-blockers`
