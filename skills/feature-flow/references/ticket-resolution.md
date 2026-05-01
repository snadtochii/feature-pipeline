# Ticket Resolution — Shared Logic

Canonical logic for resolving a ticket argument to a **ticket folder** and ensuring the spec is in place. Referenced by every stage skill (`analyze`, `plan`, `implement`, `review`, `test`) and by the `feature-flow` orchestrator itself.

`discovery` does **not** use this reference — it handles the intake/creation variant with prefix logic inline.

---

## Layout context

Every ticket has a single folder:

```
claudedocs/tickets/<state>/<id>/
├── 01-spec.md            ← THE spec (frontmatter + body — this IS the ticket)
├── 00-exploration.md     ← discovery output, optional
├── 02-analysis.md        ← analyze stage
├── 02b-decomposition.md  ← decompose, optional
├── 03-plan.md            ← plan stage
├── 04-implementation.md  ← implement stage (live, updated incrementally)
├── 05-review.md          ← review stage
├── 06-tests.md           ← test stage
├── 07-summary.md         ← completion
├── bugs/                 ← test-stage bug reports
├── .iterations.json      ← loop-back counter state (feature-flow)
└── .stale/               ← superseded artifacts after deliberate re-runs
```

`<state>` is one of `backlog`, `in-progress`, `done`. The ticket folder moves between state folders as the pipeline advances; everything inside (artifacts, bugs/, state files) moves with it.

The variable `<ticket-folder>` used throughout stage skills resolves to `claudedocs/tickets/<state>/<id>/` for whichever state the ticket is currently in.

---

## Step 1 — Resolve the ticket argument

Given the ticket argument (typically `$1`):

1. **If the argument contains `/` or `.md`**, treat it as a path:
   - If it ends in `01-spec.md`, the ticket folder is its parent directory.
   - If it's a directory under `claudedocs/tickets/<state>/`, that's the ticket folder.
   - Otherwise, parse out the ID and fall through to ID-based search.
2. **Otherwise treat it as a ticket ID** and search in this order:
   - `claudedocs/tickets/backlog/<id>/`
   - `claudedocs/tickets/in-progress/<id>/`
   - `claudedocs/tickets/done/<id>/`
   - Case-insensitive glob: `claudedocs/tickets/**/<id>/`
3. **If not found**, ask the user for the ticket path — do not guess.
4. **Read `01-spec.md`** from the resolved ticket folder and extract frontmatter fields: `id`, `title`, `project`, `tags`, `status`.
5. **Determine `<ticket-id>`** = the frontmatter `id` field, or the folder name if no `id` is set.

The resolved path `claudedocs/tickets/<state>/<id>/` is the `<ticket-folder>` referenced by every downstream stage.

## Step 2 — Ensure the spec exists

The ticket folder should always contain `01-spec.md` — that file is the ticket. Edge cases:

1. **Folder exists with `01-spec.md`** — read it. Done.
2. **Folder exists, `01-spec.md` missing** — corrupted state. Ask the user before proceeding.
3. **Read other existing artifacts** relevant to the current stage — `02-analysis.md`, `03-plan.md`, etc., and `00-exploration.md` if the stage uses it. Ignore anything under `.stale/`.

## Step 3 — Determine project root

Needed for codebase operations during the stage.

1. Read the `project` field from `01-spec.md`'s frontmatter
2. Locate the project directory:
   - If the current working directory matches the project, use it
   - Otherwise check common paths — ask the user if ambiguous
3. If the project root can't be determined, ask the user before proceeding.

---

## Error handling

- Ticket folder not found → ask the user for the path
- `01-spec.md` missing inside the ticket folder → corrupted state; ask the user
- Frontmatter missing or malformed → warn and ask
- Project root can't be determined → ask the user
