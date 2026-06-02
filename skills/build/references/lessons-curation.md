# Lessons Curation

Build invokes this at the verdict gate (SKILL.md sub-step 4c), right after appending the new lesson and before presenting the verdict gate. The job is to keep `claudedocs/tickets/_lessons.md` high-signal: `plan`'s Phase 1 pastes the whole file verbatim into the `requirements-analyst`, so a duplicate, contradictory, or stale entry degrades the context that shapes every future plan. The scan is automatic; any rewrite is gated behind explicit user approval, so curation can never silently corrupt the log.

The step uses only build's existing tools — `Read` to parse, `Glob` for the existence check (it takes the token as a literal pattern argument, not a shell word), `Write` to re-emit on accept. No new tool, no frontmatter. If `Bash` is used for the existence check instead, the token MUST be single-quoted and never interpolated raw — lesson lines are free text and may contain shell metacharacters.

## When it runs

Runs on every verdict (`pass` / `partial` / `stuck`), since the lesson append in 4b happens on every verdict.

Silent no-op — produce no output and present no gate — when any of:
- `_lessons.md` is missing or contains only the header / whitespace.
- The scan finds nothing to act on (no duplicates, no contradictions, no stale candidates).

Only when the scan finds at least one item does the step surface the findings summary and gate.

## Parsing

Read `_lessons.md` and split into entries on lines matching `^## ` — each such line is one entry of the form `## <id> (<verdict>): <lesson>` (an entry may already carry multiple IDs and inline flags from a prior curation).

Treat every line that does NOT match `^## ` as opaque and preserve it byte-for-byte: the `# Lessons learned across tickets` header, blank lines, and any hand-edited prose. Opaque lines are excluded from dedup and contradiction analysis. A line is still eligible for the staleness existence-check if it happens to contain a path token, since that check is line-local and read-only.

If the file is malformed (missing header, stray body paragraphs, non-conforming lines), stay tolerant: never "repair" or normalize structure. The rewrite (on accept) only rewrites lines the step has an actual finding for and reproduces everything else verbatim.

## Detection

### 1. Duplicates
Two or more entries making the same prescriptive point. The just-appended entry is a common source — 4b's skip-if-already-captured is single-entry model judgment and can miss a near-duplicate. Propose merging into one line (see Rewrite rules); do not privilege the newest entry.

```
## FP-9 (pass): keep both lint and typecheck in validate — typecheck misses unused imports.
## FP-12 (pass): validate must run lint AND typecheck; typecheck alone misses unused imports.
→ merge into one line citing FP-9, FP-12
```

### 2. Contradictions
Flag only when two entries make **opposing prescriptive claims about the same named token** — a concrete path, tool, command, or setting. Same subject + opposing imperative = contradiction; same subject + compatible facts = not. When unsure, do NOT flag — under-flagging is safe (the gate is summary-only and re-surfaces next build), a false contradiction flag pollutes the very context this step protects. Flag, never resolve: no winner is picked.

```
## FP-5 (pass): drop typecheck from validate — it's redundant with lint.
## FP-11 (pass): keep both lint and typecheck — typecheck catches what lint misses.
→ flag both ⚠️ contradicts (same subject: typecheck in validate; opposing imperatives)
```

### 3. Stale entries (existence check)
For each entry, extract path tokens and check whether they still exist; flag a miss, never delete.

Extraction:
- **Primary**: any backtick-quoted span (lessons cite paths in backticks by convention).
- **Secondary**: any unquoted whitespace-delimited token containing a `/` OR matching a file-extension pattern (`\.[a-z0-9]{1,6}$`).
- Strip trailing punctuation (`.`, `,`, `)`, `:`). Skip URLs (`http`...), tokens with spaces, and bare extensions.
- Skip (do not probe) any token that is absolute (starts with `/`) or that escapes the project root after normalizing `..` segments — exclude it from the staleness check rather than probe outside the workspace.

Resolve each token relative to the project root (the directory containing `claudedocs/`). If it resolves to neither an existing file/dir nor a `Glob` match, flag the entry `⚠️ possibly stale`. An entry with no path token is simply not staleness-checked. This is path-presence only — it does NOT judge whether the lesson's advice is still semantically true (that's `plan`'s job at read time).

```
## FP-15 (stuck): canonical auth path is `src/security/auth.ts` after the lib/ → src/ rename.
→ if src/security/auth.ts no longer exists: flag ⚠️ possibly stale
```

## Findings summary and gate

Present a short block grouped by the three categories — one bullet per finding, citing the affected IDs and the proposed action — then the gate. Match the verdict-gate UX (heading → context → `Options:` list, 2-space indent, ` — ` separator):

```
## Lessons Curation — findings

Duplicates: FP-9 + FP-12 make the same point → merge into one line.
Contradictions: FP-5 ("drop typecheck") vs FP-11 ("keep both") → flag both ⚠️ contradicts.
Possibly stale: FP-15 cites `src/security/auth.ts` (not found) → flag ⚠️ possibly stale.

Options:
  - accept-and-rewrite — write the reconciled _lessons.md (merges applied, flags added)
  - skip-for-now — leave _lessons.md unchanged; findings re-surface next build
  - something-else — give a free-form instruction; it's applied and the result re-shown
```

## Rewrite rules

On `accept-and-rewrite`, re-emit the **whole file** via `Write`, reconstructed from the parsed entries:

- **Preserve format**: keep the `# Lessons learned across tickets` header as the first line and the one-H2-line-per-entry shape `## <id> (<verdict>): <lesson>` that `plan` consumes.
- **Verbatim-reproduce invariant**: every line the step had NO finding for — including opaque/hand-edited lines — is reproduced exactly (same text, same order). A full re-emit must never drop or reword an untouched line.
- **Preserve order**: no sorting, no grouping. A merged line takes the position of its earliest-ID member; the later member's line is removed. Flagged lines stay in place — flags are appended inline, not reordered.
- **Merge**: cite all source IDs in ascending order, keeping the clearer/more-specific wording regardless of which entry it came from: `## FP-9, FP-12 (pass): <lesson>`. When merged entries carry different verdicts, keep both per-ID — `## FP-9 (pass), FP-12 (partial): <lesson>` — never collapse to one verdict.
- **Flags**: append inline to the affected line — `⚠️ possibly stale`, `⚠️ contradicts <id>`. Flagging is lossless: never delete a distinct fact, never restructure entries into area-grouped prose.

## On the gate choice

- **`accept-and-rewrite`** — perform the rewrite above, then continue to the verdict gate (4d).
- **`skip-for-now`** — write nothing to disk; the findings were summary-only. Continue to the verdict gate. The same tension may re-surface next build; that's acceptable.
- **`something-else`** — take a free-form instruction (e.g. "merge the first two but leave FP-15 alone"), apply it within these same rewrite rules, re-show the resulting file, and re-present the gate. Loop until the user lands on accept or skip.
