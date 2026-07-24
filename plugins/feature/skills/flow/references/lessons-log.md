# Cross-ticket lessons log — shared contract

The single source of truth for the cross-ticket lessons store: the atomic entry format, what belongs in the log, the write-time supersession check, prefer-newest on conflict, the promotion-on-recurrence trigger, format overflow, and grep-scoped consumption. This file is standalone — a producer or consumer reads just it and can comply.

Lessons follow the project's **storage mode** (detected per [`storage.md`](storage.md) §Mode detection): **fs-native** stores them as lines in `claudedocs/tickets/_lessons.md` exactly as §1–§8 describe; **server-native** stores each lesson as a row on the pipeline server, reached through the lesson tools — the per-section **Server-native** notes below map the same rules onto that store. The semantics (atomicity, supersession, prefer-newest, promotion, grep-scoped consumption) are identical in both modes.

**Producers:** `build` captures at its verdict gate and runs the full write path (§2–§7). The standalone `debug` skill is a second producer — it appends entries in the same `^## `-matching format but with its own ID forms and without the supersession check; those deltas live in `debug`'s Output section. **Consumers:** `plan`'s Phase 1 and `ship` read the log per §8. The standalone `lessons-consolidate` skill normalizes an existing **fs** file back to this contract via a human-approved diff (it operates on `_lessons.md` only).

## §1 The file

- Path: `claudedocs/tickets/_lessons.md`, relative to the repo root. The leading underscore keeps it sorted above the ticket-state folders (`backlog/`, `in-progress/`, `review/`, `done/`) when listing `claudedocs/tickets/`.
- If the file doesn't exist at capture time, create it with a one-line header (`# Lessons learned across tickets`) and append.
- The log is **project-local context** — constraints and gotchas that bit a prior ticket and would bite the next one if not surfaced. Generic best practices don't belong here (§3).
- **Server-native**: there is no `_lessons.md` — each lesson is a project-scoped row created with `pipeline_add_lesson`, carrying the lesson body plus structured `ticket_id` and `verdict` fields and server-side timestamps. Nothing to create on first use; the store exists with the project.

## §2 Entry format

Each entry is a `^## ` header line that is **atomic and date-stamped: exactly one subject (one concrete path, tool, command, or setting) per line, carrying the capture date**:

```
## <ticket-id> (<verdict>, <YYYY-MM-DD>): <one atomic lesson about a single subject>
```

- Use the environment's current date at capture time for `<YYYY-MM-DD>`.
- Keep each line short enough to read at a glance — a soft guideline, not a hard character limit; if the point needs more room, that's the signal it covers more than one subject, so **split it into multiple atomic lines** (one subject each) or graduate it to `CLAUDE.md` per §7. A lesson spanning several subjects is never written as one dense multi-topic paragraph.
- A merged entry (§4) cites multiple IDs in ascending order — `## FP-9, FP-28 (pass, <YYYY-MM-DD>): <lesson>` — keeping per-ID verdicts when they differ.

Examples:

- `## FP-7 (pass, 2026-07-06): hooks/validate.sh must stay bash-3.2 compatible (macOS default) — no associative arrays or mapfile.`
- `## FP-12 (partial, 2026-07-06): validate.lint must keep ESLint — bun's typecheck doesn't surface unused-import errors.`
- `## FP-15 (stuck, 2026-07-06): canonical auth-middleware path is src/security/auth.ts (after the lib/ → src/ rename).`

**Server-native**: the header's structured parts live as row fields — `ticket_id` for the ID, `verdict` for the verdict, the row's creation timestamp for the date. The row **body** is just the atomic lesson text (one subject, same atomicity and splitting rules as above); don't duplicate ID/verdict/date into it. A merged entry (§4) cites the additional ticket IDs inline in the body, since a row carries one `ticket_id`.

## §3 What to capture

- The lesson must be **project-specific and actionable** for future similar work — not a generic best-practice.
- **Skip entirely** when the lesson would be generic ("apply review fixes carefully").
- Lesson text is free text — handle it with `Read`/`Write` only; never interpolate it into shell commands.

## §4 Write-time supersession check

Before appending, read `_lessons.md` and scan the existing `^## ` entries (any producer, including `debug/` ones) for one whose single subject — the same concrete path, tool, command, or setting — matches the new entry's subject. Same subject → **update/merge that one line in place**, citing all IDs in ascending order per §2's merged-entry form and stamping this newer capture's date, or **skip** when the existing entry already fully covers the point. Because each entry names exactly one subject, the match is reliable. Different or no shared subject → append. No user gate: the check never deletes a distinct fact, only replaces the superseded line — git holds the history. Lines not matching `^## ` are preserved byte-for-byte; never repair or normalize the file.

**Server-native**: the same check over rows — `pipeline_list_lessons`, match the new entry's subject against the existing bodies in memory, and on a same-subject match update that row's body with `pipeline_update_lesson` (merged form per §2's server note) instead of adding a duplicate; no match → `pipeline_add_lesson`. The server holds row history semantics; the check still never removes a distinct fact.

## §5 Prefer-newest on conflict

When the new entry contradicts an existing same-subject line (the older guidance has gone stale), the newer information wins: replace that line's lesson text with the new one and stamp this capture's date; git holds the prior version (server-native: replace the row's body via `pipeline_update_lesson`; the row's update timestamp records the change). Merges stay conservative — combine or prefer-newest on the one shared subject only, never re-summarize the file or rewrite unrelated lines.

## §6 Promotion on recurrence

A same-subject second capture means the gotcha recurs — propose promoting it into the project's `CLAUDE.md` under a `## Lessons` section (created if missing). The proposal must **show the exact line to be added and the target file/section** — never a bare yes/no — and the edit is applied only after the user approves that shown content (CLAUDE.md is a standing-instruction file loaded into every future session; the promoted text originates from the lessons store, which is editable outside the pipeline). On accept: apply the CLAUDE.md edit and remove the entry from the store (fs-native: delete the line from `_lessons.md`; server-native: `pipeline_delete_lesson` on the row). On decline: keep the merged entry in the store. `CLAUDE.md` stays a local file in both modes — promotion always lands in the repo. **Unattended runs** (no user present to answer): skip the proposal entirely and keep the merged line; the same recurrence re-proposes at the next interactive capture on the topic. CLAUDE.md is never written without a user approving the shown content, and a non-interactive capture never blocks on this gate. Durable truths graduate upward and the file stays small.

## §7 Format overflow

A lesson that can't be stated atomically — one subject on one line, even after splitting — is a durable rule, not a log entry. Propose it as a project-`CLAUDE.md` edit instead (same content-surfacing confirmation as §6 — show the exact text and target, never a bare yes/no); on decline — or in an unattended run, where the proposal is skipped — capture the atomic subject lines in `_lessons.md` instead — never silently lose the fact.

## §8 Consumption — grep-scoped and on-demand

**Never carry the whole store into context.** A consumer derives a set of subject keywords from the work in scope — the concrete paths, filenames, tools, commands, and area/acceptance-criteria terms it touches — and keeps only the entries matching them (case-insensitive). Because each entry names a single subject (a concrete path, tool, command, or setting), a subject keyword matches the entries whose gotcha is about that subject. Per mode:

- **fs-native**: `grep` the file for the matching lines (a single alternation or one pass per keyword), so only the matching atomic entries enter context.
- **server-native**: `pipeline_list_lessons`, then apply the same keyword match **in memory** and keep only the matching entries — discard the rest of the listing; no lesson bodies beyond the matched entries are carried into working context.

No store, no file, or no matching entries → the consumer carries no lessons block. Consumer-specific selection policies on top of this (e.g. plan's cap of 5 ticket-relevant entries) live in the consumer's own skill.
