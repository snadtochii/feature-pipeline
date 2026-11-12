# Incident — fs-native Storage Mechanics

Canonical logic for the incident skill's ticket duplicate lookup in fs-native storage mode. Read when the storage mode detected at incident's step 1 per [`../../flow/references/storage.md`](../../flow/references/storage.md) is fs-native — a run in the other storage mode never needs this file. Referenced by `incident`. Sections are numbered so the skill body cites `§N`.

The lookup is advisory. It reads ticket specs, writes nothing, and never stops a run.

## §1 Candidates

Tickets are files under `<project-root>/claudedocs/tickets/`: a ticket's spec is its `01-spec.md`, an epic's is its `prd.md`.

- **Keywords** — from the failure's signature ([output-format.md](output-format.md) §2): the service; the rule's name, and its UID when known; and the distinctive words of the signature's message field, the message and its error text — the literal words left around its `*` placeholders, leaving out words any log line carries (`error`, `failed`, `request`).
- **Search** — `Write` the keywords to the search file, one per line, and run one `search --scope tickets --output files` (`incident/SKILL.md`, Roots and the script). A keyword shorter than 3 characters is left out, and at most 20 are kept, the service and the rule first. The scope reads only files named `01-spec.md` or `prd.md`, at any depth, so an epic's children under `tasks/` are included; each listed file's `patterns` are the keywords it matched.
- **Rank** — a file is a candidate when it matches the rule's name or UID, or two or more message keywords; the service's name alone is too broad. Order candidates by the number of keywords matched. A `files` list the size bound cut short (`truncated`) is ranked on what arrived, and the lookup is recorded as partial.
- **Open at most 5** — `Read` the best-ranked candidates' frontmatter and description, 5 files at most.

## §2 Match

A candidate is the same failure when its description names the same rule for the same service, or describes the same failing message or the same code location. A candidate that is not a match is not reported.

For each match report the ticket's ID (frontmatter `id`, else its folder's name), its `title` and its `status`. The status is read from the ticket's own frontmatter — where the ticket sits on disk says nothing. Then say how it relates:

| Status | Reported as |
|---|---|
| `backlog`, `in-progress`, `in-review` | Already ticketed. The report's ticket draft names it instead of proposing a new ticket. |
| `done`, `partial-completion` | A possible regression: the failure was worked on and has occurred again. |
| `cancelled` | Named, and marked as having delivered nothing. It is no evidence the failure was handled. |

A match whose frontmatter cannot be read is reported by path with status `unknown`.

## §3 When the lookup cannot run

- No `claudedocs/tickets/` tree, or no spec inside it → recorded as `no tickets found`.
- A `search` or `Read` that fails → recorded as `ticket lookup not run: <search | Read> — <error>`, never retried.

Either way the run continues to its report.
