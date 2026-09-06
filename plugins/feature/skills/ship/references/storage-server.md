# Ship — server-native Storage Mechanics

Canonical logic for ship's storage-touching steps in server-native storage mode. Read when the storage mode detected at ship's SETUP per [`../../flow/references/storage.md`](../../flow/references/storage.md) is server-native — an fs-native run never needs this file. Referenced by `ship`, and by [`parallel-walk.md`](parallel-walk.md) / [`reviewer-prompt.md`](reviewer-prompt.md) / [`ui-verification.md`](ui-verification.md) on ship's behalf. Operations named below are defined in [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md); sections are numbered so the skill body and its references cite `§N`. Subagent briefs inline the text §3 resolves — a subagent never reads this file.

## §1 Ticket metadata and roster

Read ticket metadata reads the ticket row: `kind`, `parent_id`, `blocked_by`. The row has no `repos` field, so every run is one lane — there is nothing to partition on. An **epic run's roster** is derived: `pipeline_list_tickets` filtered client-side to rows whose `parent_id` is the epic's ID; every listed row is materialized (a child exists only once created), so nothing is skipped.

## §2 Lessons store

The store is the lesson rows. Consume it per [`../../flow/references/lessons-log-server.md`](../../flow/references/lessons-log-server.md) §8 — `pipeline_list_lessons` plus the same subject-keyword match in memory, pulling only the matched entries. A `--parallel` run's end-of-run lessons write applies that contract's §4–§5 (supersession scan, merge-in-place, prefer-newest) with `pipeline_list_lessons` for the scan and `pipeline_add_lesson` / `pipeline_update_lesson` for the writes, one candidate at a time.

## §3 Ground truth in subagent briefs

Four placeholders in the brief templates resolve here; the orchestrator fills them before spawning.

- **`<TICKET_ARG_BLOCK>`** — the ticket's identity is its **bare ticket ID**; the orchestrator pulls the frontmatter-free `01-spec.md` body via `pipeline_get_artifact` and inlines it into the brief (there is no spec file to point at). Under `--parallel` the bare ID is also flow's ticket argument: resolution is a server round-trip independent of the worker's cwd, and the worker's stage skills read and write artifacts through the pipeline tools (per-ticket rows, so concurrent workers never collide and nothing is written into the checkout's tree).
- **`<GROUND_TRUTH_BLOCK>`** — the orchestrator pulls the frontmatter-free `01-spec.md` body via `pipeline_get_artifact` and the matching lesson rows via `pipeline_list_lessons` (subject-keyword match in memory, per the lessons contract §8 — only the matched entries, never the full store), then fills the reviewer template's placeholder with:
  ```
  GROUND TRUTH is the ticket spec, inlined below — judge the diff against it.
  --- SPEC (01-spec.md) ---
  <spec body>
  --- END SPEC ---
  Carry-forward gotchas from prior tickets (pre-matched to this ticket's areas; may be empty):
  <matched lesson entries, one per line>
  ```
  These are neutral ticket inputs (spec + lessons), not the implementer's narrative — inlining them preserves bias isolation.
- **`<AC_SOURCE_BLOCK>`** — the `ui-tester` brief carries the acceptance-criteria section of the spec body the orchestrator already pulled, inlined.
- **`<STATE_CLAUSE_BLOCK>`** (`--parallel` worker briefs) — "Do not perform ticket state transitions: never call `pipeline_transition_ticket`. Do not write to the lessons store: never call the lesson tools."

## §4 PR linkage

The post-PR linkage step: after each implementer returns, confirm the ticket row's `pr_url` is set — build records it at PR creation (`pr-creation.md` §5); if it is missing (a degraded or interrupted build), backfill it via `pipeline_update_ticket` with the verified PR's URL. An epic run's integration-PR title is read from the epic row (`pipeline_get_ticket`), and the integration PR's URL is recorded on the **epic row** via `pipeline_update_ticket` `pr_url` — ship owns this PR, so ship owns its linkage (per-ticket `pr_url`s were already set by each build).

## §5 In-review evidence and recovery

A ticket `flow --pr` built sits at row status `in-review` (Transition 5). On recovery the ticket **row** is authoritative: `pipeline_get_ticket` (or `pipeline_list_tickets` for the roster) gives `status` and `pr_url`, `pipeline_list_artifacts` shows how far the build's artifact trail got, and `pr_url` locates the existing PR directly (fall back to the `<ID>:` title search only when it is null). A `--parallel` recovery reconciles ticket state against that evidence as row statuses — the orchestrator owns status, so a crash can leave a merged PR with a stale `in-review`; `/feature:sync` fixes those.

## §6 Parallel-walk state forms

Every shared mutation in a `--parallel` run is orchestrator-only, in the forms [`../../flow/references/state-transitions-server.md`](../../flow/references/state-transitions-server.md) prescribes — `pipeline_transition_ticket` under the CAS conflict doctrine in [`../../flow/references/storage-server.md`](../../flow/references/storage-server.md) (re-read, re-evaluate, proceed-or-stop, never widen `from[]`); being the sole transition caller changes none of those rules:

- **Worker brief, state clause** — the `<STATE_CLAUSE_BLOCK>` (§3).
- **Transition 1, epic run** — the epic row's CAS flip before any dispatch; each child row set to `in-progress` at its dispatch.
- **Transition 5** — multi-solo ticket: CAS the row to `in-review`. Epic child: CAS the child row to `in-review`; the epic row's own `in-review` flip per T5's epic variant is the whole move.
- **Transition 4** (a failed worker's ticket) — the `partial-completion` CAS write.

## §7 UI evidence home and hosting

Screenshots go to a run-local directory **outside the ticket store** (e.g. `/tmp/fp-ui-test-<id>/<AC>.png`; never under `claudedocs/tickets/` — creating a tree there would violate the storage doctrine). They are binary run evidence, not a whitelisted artifact row, and are not pushed to the server. Nothing is hostable, so the evidence post always takes the path-manifest outcome in `ui-verification.md` step 3 — the per-AC verdict plus the manifest, with no `git check-ignore` probe.
