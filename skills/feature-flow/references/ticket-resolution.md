# Ticket Resolution — Shared Logic

Canonical logic for resolving a ticket argument to a ticket file and setting up the artifacts directory. Referenced by every stage skill (`analyze`, `plan`, `implement`, `review`, `test`) and by the `feature-flow` orchestrator itself.

`discovery` does **not** use this reference — it handles the intake/creation variant with prefix logic inline.

---

## Step 1 — Resolve the ticket argument

Given the ticket argument (typically `$1`):

1. **If the argument contains `/` or `.md`**, treat it as a path and read that file directly
2. **Otherwise treat it as a ticket ID** and search in this order:
   - `claudedocs/tickets/backlog/<id>.md`
   - `claudedocs/tickets/in-progress/<id>.md`
   - `claudedocs/tickets/review/<id>.md`
   - Case-insensitive glob: `claudedocs/tickets/**/*<id>*.md`
3. **If not found**, ask the user for the ticket path — do not guess
4. **Read the ticket content** and extract frontmatter fields: `id`, `title`, `project`, `tags`, `status`
5. **Determine `<ticket-id>`** = the frontmatter `id` field, or the slugified filename if no `id`

## Step 2 — Set up the artifacts directory

The artifacts directory is: `claudedocs/pipeline/<ticket-id>/`

The discovery skill may create this folder pre-emptively (to save `00-exploration.md`), so "directory exists" no longer guarantees "`01-spec.md` exists". Handle the two concerns independently:

1. **Ensure the directory exists** — create it if missing.
2. **Ensure `01-spec.md` exists** — if missing (fresh ticket, or discovery created the folder but didn't write the spec), write the full ticket content to `claudedocs/pipeline/<ticket-id>/01-spec.md`. If it already exists, read it for the spec (it may have been enriched beyond the original ticket).
3. **Read other existing artifacts** relevant to the current stage — `02-analysis.md`, `03-plan.md`, etc., and `00-exploration.md` if the stage uses it. Ignore anything under `.stale/`.

## Step 3 — Determine project root

Needed for codebase operations during the stage.

1. Read the `project` field from the ticket frontmatter
2. Locate the project directory:
   - If the current working directory matches the project, use it
   - Otherwise check common paths — ask the user if ambiguous
3. If the project root can't be determined, ask the user before proceeding

---

## Error handling

- Ticket file not found → ask the user for the path
- Frontmatter missing or malformed → warn and ask
- Project root can't be determined → ask the user
- Artifacts directory creation fails → report the error, don't silently proceed
