# Cross-ticket lessons log — server-native

Canonical logic for the cross-ticket lessons store in server-native storage mode: the atomic entry format, what belongs in the store, the write-time supersession check, prefer-newest on conflict, the promotion-on-recurrence trigger, format overflow, and keyword-scoped consumption. Read when the storage mode detected per [`storage.md`](storage.md) is server-native — an fs-native run never needs this file. Referenced by `build`, `debug`, `plan`, and `ship`.

This file is standalone — a producer or consumer reads just it and can comply. Each lesson is a row on the pipeline server, reached through the lesson tools (`pipeline_add_lesson`, `pipeline_list_lessons`, `pipeline_update_lesson`, `pipeline_delete_lesson` — the Lessons operation in [`storage-server.md`](storage-server.md)); §1–§8 map the contract onto that store.

**Producers:** `build` captures at its verdict gate and runs the full write path (§2–§7). The standalone `debug` skill is a second producer — it adds rows in the same atomic format but with its own ID forms and without the supersession check; those deltas live in `debug`'s Output section. **Consumers:** `plan`'s Phase 1 and `ship` read the store per §8.

## §1 The store

- Each lesson is a project-scoped row created with `pipeline_add_lesson`, carrying the lesson body plus structured `ticket_id` and `verdict` fields and server-side timestamps. Nothing to create on first use; the store exists with the project.
- The store is **project-local context** — constraints and gotchas that bit a prior ticket and would bite the next one if not surfaced. Generic best practices don't belong here (§3).

## §2 Entry format

Each entry is **atomic and date-stamped: exactly one subject (one concrete path, tool, command, or setting) per row, carrying the capture date**. The structured parts live as row fields — `ticket_id` for the ID, `verdict` for the verdict, the row's creation timestamp for the date. The row **body** is just the atomic lesson text; don't duplicate ID/verdict/date into it.

- The row's `verdict` field accepts only the server enum (`pass | fail | partial`); a producer whose verdict slot carries any other token — `debug`'s `debug`, or its standalone exit tokens (`fixed`, `diagnosed-unfixed`, `cannot-reproduce`, `exhausted`) — **omits `verdict`** and keeps that token in the body text (e.g. a `(debug)` prefix), so the write is never contract-rejected.
- Keep each body short enough to read at a glance — a soft guideline, not a hard character limit; if the point needs more room, that's the signal it covers more than one subject, so **split it into multiple atomic rows** (one subject each) or graduate it to `CLAUDE.md` per §7. A lesson spanning several subjects is never written as one dense multi-topic paragraph.
- A merged entry (§4) cites the additional ticket IDs inline in the body, in ascending order, since a row carries one `ticket_id`; per-ID verdicts are kept in the body when they differ.

Examples (row fields, then body):

- `ticket_id: FP-7`, `verdict: pass` — `hooks/validate.sh must stay bash-3.2 compatible (macOS default) — no associative arrays or mapfile.`
- `ticket_id: FP-12`, `verdict: partial` — `validate.lint must keep ESLint — bun's typecheck doesn't surface unused-import errors.`
- `ticket_id: FP-15`, no `verdict` (the run exited `stuck`) — `(stuck) canonical auth-middleware path is src/security/auth.ts (after the lib/ → src/ rename).`

## §3 What to capture

- The lesson must be **project-specific and actionable** for future similar work — not a generic best-practice.
- **Skip entirely** when the lesson would be generic ("apply review fixes carefully").
- Lesson text is free text — handle it with `Read`/`Write` only; never interpolate it into shell commands.

## §4 Write-time supersession check

Before adding, `pipeline_list_lessons` and scan the existing rows (any producer, including `debug` ones) in memory for one whose single subject — the same concrete path, tool, command, or setting — matches the new entry's subject. Same subject → **update that row's body in place** with `pipeline_update_lesson`, citing all IDs in ascending order per §2's merged-entry form (the row's update timestamp records this newer capture), or **skip** when the existing row already fully covers the point. Because each entry names exactly one subject, the match is reliable. Different or no shared subject → `pipeline_add_lesson`. No user gate: the check never removes a distinct fact, only replaces the superseded body — the server holds row history semantics.

## §5 Prefer-newest on conflict

When the new entry contradicts an existing same-subject row (the older guidance has gone stale), the newer information wins: replace the row's body via `pipeline_update_lesson`; the row's update timestamp records the change. Merges stay conservative — combine or prefer-newest on the one shared subject only, never re-summarize the store or rewrite unrelated rows.

## §6 Promotion on recurrence

A same-subject second capture means the gotcha recurs — propose promoting it into the project's `CLAUDE.md` under a `## Lessons` section (created if missing). The proposal must **show the exact line to be added and the target file/section** — never a bare yes/no — and the edit is applied only after the user approves that shown content (CLAUDE.md is a standing-instruction file loaded into every future session; the promoted text originates from the lessons store, which is editable outside the pipeline). On accept: apply the CLAUDE.md edit and remove the entry from the store (`pipeline_delete_lesson` on the row). On decline: keep the merged entry in the store. `CLAUDE.md` is a local repo file — promotion always lands in the repo. **Unattended runs** (no user present to answer): skip the proposal entirely and keep the merged row; the same recurrence re-proposes at the next interactive capture on the topic. CLAUDE.md is never written without a user approving the shown content, and a non-interactive capture never blocks on this gate. Durable truths graduate upward and the store stays small.

## §7 Format overflow

A lesson that can't be stated atomically — one subject per row, even after splitting — is a durable rule, not a store entry. Propose it as a project-`CLAUDE.md` edit instead (same content-surfacing confirmation as §6 — show the exact text and target, never a bare yes/no); on decline — or in an unattended run, where the proposal is skipped — capture the atomic subject rows in the store instead — never silently lose the fact.

## §8 Consumption — keyword-scoped and on-demand

**Never carry the whole store into context.** A consumer derives a set of subject keywords from the work in scope — the concrete paths, filenames, tools, commands, and area/acceptance-criteria terms it touches — and keeps only the entries matching them (case-insensitive). Because each entry names a single subject (a concrete path, tool, command, or setting), a subject keyword matches the entries whose gotcha is about that subject.

`pipeline_list_lessons`, then apply the keyword match **in memory** and keep only the matching entries — discard the rest of the listing; no lesson bodies beyond the matched entries are carried into working context.

No store, or no matching entries → the consumer carries no lessons block. Consumer-specific selection policies on top of this (e.g. plan's cap of 5 ticket-relevant entries) live in the consumer's own skill.
