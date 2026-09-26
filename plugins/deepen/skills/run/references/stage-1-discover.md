# Stage 1 — discover

Authoritative text for the stage that turns a repository into one picked deepening candidate:
the pin, the memory reconciliation, the hotspot table, the design vocabulary, the explorer, the
ids, the memory filter, the report and the pick. The stage writes no source and spawns no fenced
role; it either completes with a pick, completes with no candidate, stops for a human decision,
or aborts.

It composes four references and restates none of them: [hotspots.md](hotspots.md) owns the
hotspot measure and its script, [candidates.md](candidates.md) the candidate record, the id and
the report rows, [memory.md](memory.md) the memory file's reads, reconciliation and filtering,
and the run skill ([../SKILL.md](../SKILL.md)) the report grammar, the question and the abort.

---

## Inputs and output

Bound by the run skill before this stage starts:

| Input | Source |
| --- | --- |
| `<CLONE>`, `<BASE_SHA>`, `<state_dir>`, the profile as re-read | [preflight.md](preflight.md) §1–§4 |
| `<run-id>`, `<plugin-root>`, the pin, the takeover and tier lines | the run state, `<state_dir>/runs/<run-id>/run-state` |
| `<state_dir>/memory.md` | [memory.md](memory.md) |
| `CONTEXT.md`, `docs/adr/` at `<CLONE>` | read by the explorer |

Output: the report `<state_dir>/reports/<run-id>/1-discover.md` (§9); `candidate_id` and `slug`
in the run state once a candidate is picked; `memory.md` lines rewritten by §2 alone.

Scratch files are `<state_dir>/tmp/<run-id>-*`; the run skill removes them.

---

## §0 Re-entry

Read the report, when it exists, before anything else:

- **No report** → a fresh stage: §1.
- **Status `complete`, `complete — no candidate` or `aborted`** → the stage already ended; return
  without touching anything. The run skill reads the status line.
- **Status `needs-decision`** → take the last `decision:` line under `## Decisions`:
  - an answer that starts with a candidate id from the report's `## Candidates` table — the pick
    options' labels do → §8 with that candidate as the pick;
  - `none of these` → §8's no-candidate ending;
  - `run it` (the open-pull-request question of §7) → §8 with the candidate the report's pin line
    names;
  - any other text → a free-text answer at the pick, read as a hint. The first time, set the run
    state's `pin:` to that text with `Edit` and run the stage again from §1, skipping §2 — memory
    was reconciled on the first pass. The rewritten report keeps the earlier `## Decisions` lines.
    A second free-text answer is not re-run: write the pick question again with the same options.

No second explorer spawn happens for an answer that names a listed candidate.

---

## §1 Pin

Read `pin:` from the run state.

- `none` → no pin.
- **An id** (`^[0-9a-f]{6}$`) → one `Grep` for
  `^\| *[0-9]+ *\| *(strong|worth-exploring|speculative) *\| *<id> *\|` — a `## Candidates` row,
  whose first three columns are rank, tier and id, never a `## Filtered` line or another table that
  carries the id — over `<state_dir>/reports/`, glob `*/1-discover.md`, with line numbers. The
  match in the lexically greatest `<run-id>` directory
  is the record: its `files`, `structural_key` and the other columns of
  [candidates.md](candidates.md) §5. That is the newest date, not the newest run: two runs of
  one day order by their random suffix. Rows for one id share the hashed `category`, `files` and
  `structural_key`, so the choice only decides the unhashed columns — `name`, `tier`,
  `next_change`, `est_diff_lines`, `adr_conflict`. No match →
  `discover: aborted — pin: <id> not found in any stage 1 report — pin by hint`.
- **Anything else** → a hint, carried to the explorer as quoted data.

---

## §2 Memory reconciliation

Perform [memory.md](memory.md) §4. Its report lines and rewrites go in `## Memory`.

---

## §3 Hotspots

1. `Write` the exclude file `<state_dir>/tmp/<run-id>-exclude`, one glob per line: every
   `paths.specs` glob, every `paths.forbidden` glob, and `<inventory>**` for `paths.inventory`
   ([hotspots.md](hotspots.md) §3).
2. One `Bash` call:

   ```bash
   bash "<plugin-root>/skills/run/scripts/hotspots.sh" --repo "<CLONE>" \
     --exclude-file "<state_dir>/tmp/<run-id>-exclude" \
     --out "<state_dir>/tmp/<run-id>-hotspots.tsv"
   ```

3. Exit `1` or `2` → `discover: aborted — hotspots: <the script's error line>`.
4. `Read` the table. Its summary line goes in `## Hotspots` verbatim. An `empty:` line is also a
   degradation line — the explorer then starts from its walk alone, and a pin still applies.

---

## §4 Vocabulary and project records

1. Invoke the `Skill` tool with `mattpocock-skills:codebase-design`. The text it returns is the
   vocabulary the brief inlines. The call failing, or the skill not installed → the degradation
   line `codebase-design unavailable — explorer used its inline vocabulary summary`, and the brief
   says so.
2. `Glob` `<CLONE>/CONTEXT.md` and `<CLONE>/docs/adr/*`. Each one absent → its effect line from
   [profile.md](../../setup/references/profile.md) §6, verbatim, as a degradation line — row 11
   for the glossary, row 12 for the decision records.

---

## §5 Explorer

Spawn one `deepen:explorer`, a fresh instance, in the foreground. Its brief inlines, as data,
never as a link:

1. `<CLONE>` as the repository root, absolute, and that the walk is read-only.
2. The hotspot table as rows — path, churn, lines, indentation, both scores — or its `empty:` line.
3. The vocabulary §4 loaded, or the line `design vocabulary unavailable — use your inline
   vocabulary`.
4. The category table of [candidates.md](candidates.md) §2, and the return shape of §1 with the
   value classes of §7: field names, order, enums, at most ten blocks, ranked, no `id`.
5. The absolute path of `CONTEXT.md` and of every file under `docs/adr/`, or that each is absent.
6. The exclude file's globs, as paths never to propose changes to.
7. The pin: a hint as a quoted block marked as data, or the recovered record's `name`, `files`
   and `structural_key` — with the instruction to explore it even where the table does not list
   it, and to answer on the `pin:` line of the return shape.

The spawn failing, or returning nothing parseable →
`discover: aborted — explorer failed — <reason>`.

---

## §6 Ids

1. **Validate** every returned block against [candidates.md](candidates.md) §1, §2 and §7. A
   block that fails is dropped, with the line `candidate dropped: <name> — <field> <what is
   wrong>` under `## Degradations`.
2. **Write** one record per surviving block, `category<TAB>files<TAB>structural_key`, to
   `<state_dir>/tmp/<run-id>-records` with `Write`.
3. **Mint**, in one `Bash` call:

   ```bash
   bash "<plugin-root>/skills/run/scripts/candidate-id.sh" "<state_dir>/tmp/<run-id>-records"
   ```

   Output lines come in record order. Exit `1` or `2` →
   `discover: aborted — candidate-id: <the script's error line>`. An `invalid` line drops its
   candidate with a `candidate dropped` line.
4. **Attach** each id and the script's byte-sorted `files` and `structural_key` to its block —
   the report carries exactly what was hashed. Collisions follow
   [candidates.md](candidates.md) §4.

Zero valid blocks is zero candidates.

---

## §7 Filter and mark

1. **Locate the pin**, when there is one:
   - an id pin whose id was minted this run → that candidate;
   - otherwise the candidate the explorer's `pin:` line names, when it survived §6 → that
     candidate, with the line
     `pin: <value> not in the ranked list — explored as pinned, picked <id> <name>`;
   - a `pin:` line naming a block §6 dropped — it failed validation, minted `invalid`, or lost a
     collision — is read as `pin: none`, with the line `pin: <value> named <name>, which §6
     dropped`, and the two bullets below apply;
   - an id pin the explorer answered `pin: none` → the recovered record itself, with its earlier
     id and columns, added to the ranked list, and the line `pin: <id> not in the ranked list —
     explored as pinned, picked from its earlier record`;
   - a hint the explorer answered `pin: none` → the line `pin: <hint> held no candidate — <the
     explorer's reason>`, and the stage continues as unpinned.

   The located candidate is recorded on the report's pin line (§9) as `→ <id> <name>`.
2. **Read memory** per [memory.md](memory.md) §3 — one `Grep` for every id in the ranked list.
   Each id's status goes in the table's `memory` column.
3. **Filter** per [memory.md](memory.md) §5: a filtered candidate leaves the ranked list for
   `## Filtered`, with its status and note.
4. **The pinned candidate is never filtered**:
   - `declined` → kept, with the line `pin: <id> is declined in memory — run anyway, as pinned`.
   - `opened` → the stage stops: `discover: needs-decision — <id> already has an open pull
     request <url> — run it again?`, with the one option `run it — open a second pull request for
     this candidate`. The run skill adds `abort`.
5. **Decision-record conflicts are kept.** A block's `adr_conflict` stays in the table's column
   and in the `## Pick` block. At a human pick it is also in the pick question's description, so
   the human decides there; an unattended pick (§8) carries it to the decide stage, which names it
   ([stage-3-decide.md](stage-3-decide.md) §5, `diffs`). It is never a reason to drop.

---

## §8 Pick

An unpinned pick depends on `attendance`, read from the profile as re-read
([profile.md](../../setup/references/profile.md) §2). A hint pin that §7 step 1 turned unpinned
reaches the unpinned cases below.

- **Pinned** → the located candidate is the pick.
- **Unpinned, `attendance: semi`, zero ranked candidates** → `discover: complete — no candidate`.
  The run ends clean.
- **Unpinned, `attendance: semi`, otherwise** → `discover: needs-decision — pick a candidate`,
  with one option per ranked candidate from the top, at most three —
  `- <id> <name> — <tier>, <category>, ~<est_diff_lines> lines; next: <next_change>` with
  `; conflicts with <adr path>` appended when `adr_conflict` is not `none` — and last
  `- none of these — end the run; nothing is recorded`, the option that ends the run.
- **Unpinned, `attendance: unattended`** → the rank rule — this stage's default for an
  unattended run ([profile.md](../../setup/references/profile.md) §2). The first case that holds
  decides:
  1. zero ranked candidates and §7 step 3 filtered none → `discover: complete — no candidate`.
     The run ends clean.
  2. zero ranked candidates and §7 step 3 filtered at least one →
     `discover: aborted — no candidate left after memory exclusion — pin a declined id to run it
     anyway; an opened id can be pinned once its pull request merges or closes`. A pinned
     `opened` id stops at §7 step 4, so the remedy never offers pinning one.
  3. §7 step 2 met [memory.md](memory.md) §3's no-file case →
     `discover: aborted — memory: <state_dir>/memory.md missing — run /deepen:setup`. Without the
     file nothing excludes an opened or declined candidate, so a scheduled run would pick the same
     one every time.
  4. otherwise → the pick is the first row of the ranked list as §7 step 3 left it; `<n>` is that
     row's `rank`. No `## Options` and no question are written, and nothing is written to memory
     ([memory.md](memory.md) §6).
- **An answer** (§0) naming a candidate → the pick; `none of these` →
  `discover: complete — no candidate`. Declining at the pick writes nothing to memory
  ([memory.md](memory.md) §6).

With a pick: write the `## Pick` block ([candidates.md](candidates.md) §5), then set the run
state's `candidate_id` and `slug` ([candidates.md](candidates.md) §6) with `Edit`, and the status
line becomes `discover: complete`. A pick by the rank rule also writes
`pick: rank <n> (unattended)` to the report (§9 item 4).

---

## §9 Report

`<state_dir>/reports/<run-id>/1-discover.md`, standing alone for a reader who did not watch.
Written with `Write` when the stage first reaches a status; a re-entry rewrites the status line
with `Edit` and appends what it adds.

1. The status line ([../SKILL.md](../SKILL.md) §3's grammar).
2. The takeover line from the run state, when it is not `none` — directly under the status line
   ([preflight.md](preflight.md) §2).
3. The tier line from the run state, verbatim ([preflight.md](preflight.md) §5).
4. `pin: <value>`, with `→ <id> <name>` once §7 located it, or `pin: none`; directly under it,
   on a pick by §8's rank rule, `pick: rank <n> (unattended)`.
5. `## Degradations` — every degradation line of §3–§7, or `none`.
6. `## Memory` — [memory.md](memory.md)'s report lines and rewrites, or `none`.
7. `## Hotspots` — the table with every column of [hotspots.md](hotspots.md) §6, and its summary
   line.
8. `## Candidates` — the ranked table, columns per [candidates.md](candidates.md) §5.
9. `## Filtered` — each filtered candidate's id, name, status and note, or `none`.
10. `## Explorer notes` — the explorer's `notes:` line and, with a pin, its `pin:` line.
11. `## Pick` — when a candidate is picked.
12. `## Options` — when the status is `needs-decision`.
13. `## Decisions` — appended by the run skill.

Every stop in this stage comes before any worktree exists, so the run skill's abort takes its
short path.
