# Discover — fs-native Storage Mechanics

Canonical logic for discover's ticket-store steps in fs-native storage mode. Read when the storage mode detected at Phase 0 per [`../../flow/references/storage.md`](../../flow/references/storage.md) is fs-native — a run in the other storage mode never needs this file. Referenced by `discover`, and by [`multi-sibling.md`](multi-sibling.md) on its behalf. Operations named below are defined in [`../../flow/references/storage-fs.md`](../../flow/references/storage-fs.md); sections are numbered so the skill body cites `§N`.

## §1 Ground rules

- **The folder tree is the ticket store.** A ticket is a folder under `claudedocs/tickets/<state>/` (a child: `<state>/<EPIC>/tasks/<CHILD>/`); the folder name is the ID, no slug. `01-spec.md` IS the ticket — YAML frontmatter carries the metadata (`id`, `title`, `status`, `priority`, `complexity`, `tags`, `created`, `project`; for children also `parent`, `epic`, `siblings`, `blocked_by`), the body carries the content. Templates from `templates/` are filled frontmatter included.
- **`status` is written as `backlog`** by the template fill; discover performs no transitions.
- **Prefix** comes from `claudedocs/tickets/config.yaml` (§2); IDs are allocated locally by scanning the tree (§3).
- **The exploration-mode gate is unchanged.** An exploration session that ends without a ticket leaves the project tree untouched — no folder is created before the developer commits.

## §2 Phase 0 infrastructure

1. **Check if `claudedocs/tickets/` directory exists** in the project root
2. If not:
   - Ask the user for a **ticket prefix** for this project (e.g., `BL` for big-leaves, `SY` for symphony)
   - Create the full structure:
     ```
     claudedocs/tickets/
     ├── backlog/
     ├── in-progress/
     └── done/
     ```
   - Write the config to `claudedocs/tickets/config.yaml` so future runs don't need to ask again. Initial content:
     ```yaml
     prefix: <PREFIX>
     ```
     This file is the source of truth for tickets-system configuration. Future fields go here too — do not introduce new dotfiles for additional config.
3. If `claudedocs/tickets/` already exists, read the prefix from `claudedocs/tickets/config.yaml` (parse the YAML and extract the `prefix` field)
   - If `config.yaml` is missing, scan existing ticket filenames to infer the prefix, or ask the user. Once known, write `config.yaml` so the next run doesn't repeat the inference.

The template read (Phase 0's last step) follows in the skill body. Phase 1's workspace-shape detection runs in this mode as the skill body states — `repos` is a frontmatter field here.

## §3 ID allocation

Scan the **entire** `claudedocs/tickets/` tree recursively — epic children live nested under `<state>/<EPIC>/tasks/<CHILD>/` and draw from the **same single sequential numbering space** as top-level tickets, so a top-level-only scan can hand out an ID a nested child already uses. Collect every folder anywhere under `claudedocs/tickets/**` whose name matches the configured `<PREFIX>-<N>` (the folder name IS the ID — match folder names, not frontmatter; ignore non-matching prefixes), take the maximum `<N>`, and allocate from `max + 1` (no matches → start at `<PREFIX>-1`). No leading zeros; gaps left by deleted tickets are fine — never backfill them.

- **Single-mode**: allocate one ID — `<PREFIX>-<max+1>`.
- **Multi-mode**: allocate `N + 1` IDs — the first goes to the parent epic, the next `N` to the children in checkpoint order. The Phase 3.5 checkpoint renders these tentative IDs directly.
- If `--id <XX-N>` was provided: in single-mode, that's the ticket's ID; in multi-mode, that's the parent epic's ID, and the children are allocated as the next IDs after `max(existing tree max, supplied epic N)` — not blindly `<XX-N+1>`, which can collide with a higher-numbered nested child.
- **`--id` collision check**: before using any `--id`-supplied ID, check whether a folder with that ID already exists anywhere in the tree. If it does, warn the user and pause for explicit confirmation; never silently overwrite or proceed.

## §4 Single-mode generation

1. **Create the ticket folder** at `claudedocs/tickets/backlog/<TICKET-ID>/` (folder name is just the ID — no slug).

2. **Write the spec** to `claudedocs/tickets/backlog/<TICKET-ID>/01-spec.md` using `templates/task.md`. The spec file IS the ticket — frontmatter for metadata, body for the content.

   In a multi-repo workspace, append `repos:` per [`multi-repo.md`](multi-repo.md).

3. **Write the exploration** to `claudedocs/tickets/backlog/<TICKET-ID>/exploration.md` (no `00-` prefix — numbering is reserved for stage artifacts in task folders). Include a short header at the top:
   ```
   # Exploration — <TICKET-ID>
   **Source**: discover skill, Phase 2
   **Date**: <today's date>
   **Scope**: broad exploration of areas relevant to the feature idea (not yet ticket-scoped — plan's Phase 1 synthesis will do targeted follow-up)
   ```
   Then the full Phase 2 explorer output verbatim. This artifact is read by `plan`'s Phase 1 synthesis as a seed for incremental exploration, avoiding a second full codebase sweep. If exploration was thin (e.g., small or purely-UI feature), still write the file so plan can see what discovery covered.

4. **Present the ticket**:
   ```
   ## Ticket Created

   **Folder**: claudedocs/tickets/backlog/<TICKET-ID>/
   **ID**: <TICKET-ID>
   **Title**: <title>
   **Complexity**: <S/M/L/XL>
   **Priority**: <priority>

   [Show the full ticket content]

   → Edit if you want to adjust anything
   → Run `/feature:flow <TICKET-ID>` to start the pipeline
   → Run `/feature:plan <TICKET-ID>` to just plan first (Phase 1 synthesis surfaces gaps and patterns before build)
   ```

## §5 Multi-mode generation

The Phase 3.5 checkpoint ([`multi-sibling.md`](multi-sibling.md)) applies unchanged; epic and child IDs come from §3. After approval:

1. **Create the parent epic folder** at `claudedocs/tickets/backlog/<EPIC-ID>/` and the children container at `claudedocs/tickets/backlog/<EPIC-ID>/tasks/`.

2. **Generate an `epic` slug** from the discovery topic (lowercase, hyphenated; e.g., `dark-mode-rollout`). This becomes the shared `epic:` value across the parent and all children.

3. **Write the parent PRD** to `claudedocs/tickets/backlog/<EPIC-ID>/prd.md` using `templates/prd.md`. The PRD captures feature-level content — problem, goals, end-to-end user journey, cross-cutting constraints, decomposition table, discovery rationale. **`templates/prd.md` is the canonical epic schema — fill in *every* frontmatter field it declares; do not restate or re-derive the standard field list here.** As you fill it, set the epic-specific values discover computes:
   - `id: <EPIC-ID>`
   - `title: <epic title>` — descriptive (the title shown in the Phase 3.5 checkpoint header), never the bare `<EPIC-ID>`
   - `kind: epic` — marks this non-pipelineable, so `plan`/`build` refuse to run against it
   - `epic: <epic-slug>`
   - `children: [<CHILD-1-ID>, <CHILD-2-ID>, ...]` — the declared roster
   - `repos:` — only in a multi-repo workspace, appended per [`multi-repo.md`](multi-repo.md): the union of the children's repos.

   Everything else (`status`, `created`, `project`, `priority`, `tags`, …) comes straight from the template — the template is the one place that list lives.

   The PRD is **not** a duplicate of the children's specs combined — it holds only feature-level content that applies across siblings: the original problem statement, feature-level acceptance criteria, cross-cutting constraints (a11y, perf, security applying to all children), the decomposition table, and discovery notes. Each child's spec narrows to its own slice.

4. **Write the shared exploration** to `claudedocs/tickets/backlog/<EPIC-ID>/exploration.md` (one file at the epic level — children share it via folder containment, not by per-child copies). Header:
   ```
   # Exploration — <EPIC-ID> (shared across siblings)
   **Source**: discover skill, Phase 2
   **Date**: <today's date>
   **Scope**: broad exploration of areas relevant to the feature idea, shared across all children of this epic
   ```

5. **Write each child spec** to `claudedocs/tickets/backlog/<EPIC-ID>/tasks/<CHILD-ID>/01-spec.md` using `templates/task.md`. **`templates/task.md` is the canonical task schema — fill in *every* frontmatter field it declares; do not restate or re-derive the standard field list here.** Because a child belongs to an epic, additionally **append** the multi-sibling linkage fields as real frontmatter — the template carries only the fields every ticket has, so write these explicitly for a child (never as commented placeholders):
   - `parent: <EPIC-ID>`
   - `epic: <epic-slug>` — same slug as the parent and siblings
   - `siblings: [<other-CHILD-IDs>]` — informational; the others, not self
   - `blocked_by: [<CHILD-ID>, ...]` — omit if no blockers

   In a multi-repo workspace, also append `repos:` per [`multi-repo.md`](multi-repo.md) — this child's repos, from the Phase 3.5 decomposition table.

   As you fill the standard fields the template already lists, give them child-specific values: `id` (the `<CHILD-ID>` allocated per §3), `title` (descriptive, from the Phase 3.5 decomposition table — never the bare `<CHILD-ID>`; this is what boards, flow's epic-walker progress, and PR titles render), `complexity` (assessed per child), and `priority`/`tags` (inherit from the epic, plus any child-specific tags).

   Child body follows `templates/task.md` standard sections, scoped to the child's slice. The "Description" should reference the parent (`See parent epic <EPIC-ID> for full context`) rather than restating it. "Out of Scope" should reference siblings by ID where relevant (`X is handled by <SIBLING-ID>`).

6. **Present the result**:
   ```
   ## Epic + Children Created

   **Epic folder**: claudedocs/tickets/backlog/<EPIC-ID>/
   **Epic ID**: <EPIC-ID> (kind: epic — not pipelineable directly)
   **Epic slug**: <epic-slug>
   **Children**: <N>

   | ID | Title | Complexity | Repos | blocked_by |
   |---|---|---|---|---|
   | <CHILD-1-ID> | <title> | M | <repo-a> | — |
   | <CHILD-2-ID> | <title> | M | <repo-a>, <repo-b> | <CHILD-1-ID> |
   ...

   (Omit the `Repos` column in a single-repo workspace, matching the Phase 3.5 table.)

   **PRD**: claudedocs/tickets/backlog/<EPIC-ID>/prd.md
   **Shared exploration**: claudedocs/tickets/backlog/<EPIC-ID>/exploration.md

   → Edit any spec or the PRD to adjust
   → Start the first child: /feature:flow <CHILD-1-ID>
   → Or plan first: /feature:plan <CHILD-1-ID>
   ```

## §6 Partial-failure honesty

Generation writes files in a fixed order (single-mode: folder, spec, exploration; multi-mode: epic folder, PRD, shared exploration, then each child folder and spec in checkpoint order). If a write fails midway:

1. **Report exactly what exists**: the folders and files written so far, by path.
2. **Report exactly what remains**: the files still pending, in order.
3. **Stop.** Never delete a folder that predates this run.

A re-run must not allocate past a half-written folder: either finish the remaining writes into the existing folder(s) by hand, or remove this run's partial folder(s) first so §3's scan allocates the same IDs again.
