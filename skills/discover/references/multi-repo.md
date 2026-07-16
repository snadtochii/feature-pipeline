# Multi-Repo Workspaces — the `repos` Frontmatter Convention

Canonical logic for discover's multi-repo handling. Read when Phase 1's workspace-shape detection lands on multi-repo — a single-repo workspace never needs this file. Referenced by `discover` only.

- **Record the child-repo directory names verbatim** — exact on-disk names (e.g. `big-leaves-api`, never shortened). They are the vocabulary for the `repos` frontmatter field.
- **The repos-append convention** (every `repos` mention in discover defers here): each artifact discovery writes (solo spec, epic PRD, child spec) gets `repos: [<exact-dir-names>]` **appended** as real frontmatter — never a commented placeholder; the templates carry only the fields every ticket has. Write the field even when the ticket touches just one repo (explicitness beats omission once the workspace is multi-repo).
- **Which repos go in each list**, decided per artifact at its write step:
  - Solo spec — from Phase 2 exploration reconciled with the Phase 3 confirmation below
  - Epic PRD — the union of the children's repos
  - Child spec — from the Phase 3.5 decomposition table
- **Phase 3 confirmation** (one line of the Technical Considerations theme): "This looks like it touches `<repo-a>` + `<repo-b>` — correct?" — inferred by matching the explorer output's file paths against the detected child-repo directory names. The user's answer wins over the inference.
