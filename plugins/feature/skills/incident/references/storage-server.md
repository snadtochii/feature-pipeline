# Incident — server-native Storage Mechanics

Canonical logic for the incident skill's ticket duplicate lookup in server-native storage mode. Read when the storage mode detected at incident's step 1 per [`../../flow/references/storage.md`](../../flow/references/storage.md) is server-native — an fs-native run never needs this file. Referenced by `incident`. Sections are numbered so the skill body cites `§N`. Every `pipeline_*` call passes `project_id` verbatim from the `project:` UUID read at incident's step 1 — never resolved from a name.

The lookup is advisory. It reads ticket rows through `pipeline_list_tickets` and `pipeline_get_ticket`, writes nothing, and never stops a run.

## §1 Candidates

Tickets are rows on the personal server.

- **Keywords** — from the failure's signature ([output-format.md](output-format.md) §2): the service; the rule's name, and its UID when known; and the distinctive words of the signature's message field, the message and its error text — the literal words left around its `*` placeholders, leaving out words any log line carries (`error`, `failed`, `request`).
- **Search** — call `pipeline_list_tickets` once and match each keyword, case-insensitively, against every row's `title`, in memory.
- **Rank** — a row is a candidate when its title matches the rule's name or UID, or two or more message keywords; the service's name alone is too broad. Order candidates by the number of keywords matched.
- **Open at most 5** — call `pipeline_get_ticket` for the best-ranked candidates' descriptions, 5 rows at most.

## §2 Match

A candidate is the same failure when its description names the same rule for the same service, or describes the same failing message or the same code location. A candidate that is not a match is not reported.

For each match report the ticket's ID, its `title` and its `status`, as the row holds them. Then say how it relates:

| Status | Reported as |
|---|---|
| `backlog`, `in-progress`, `in-review` | Already ticketed. The report's ticket draft names it instead of proposing a new ticket. |
| `done`, `partial-completion` | A possible regression: the failure was worked on and has occurred again. |
| `cancelled` | Named, and marked as having delivered nothing. It is no evidence the failure was handled. |

A candidate whose `pipeline_get_ticket` call fails after the list succeeded is judged on its title alone and reported with `description not read`.

## §3 When the lookup cannot run

- An empty list → recorded as `no tickets found`.
- A tool that is unavailable, or a `pipeline_list_tickets` call that fails — a connection error, a timeout, a server answer such as a missing capability → recorded as `ticket lookup not run: <tool> — <error>`, never retried. A ticket is looked up through these two tools or not at all.

Either way the run continues to its report. A failing call stops a stage run in this mode; this lookup degrades instead because it is advisory and writes nothing.
