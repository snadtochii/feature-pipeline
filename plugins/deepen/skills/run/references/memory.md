# The candidate memory

Authoritative contract for `<state_dir>/memory.md`, the one file a `deepen:run` keeps across runs:
its header, the line each candidate the loop has acted on gets, how a run reads it, how the
discover stage reconciles open pull requests against it, and which statuses filter a candidate.

- **Created by** `deepen:setup` with the §1 header line
  ([profile.md](../../setup/references/profile.md) §5 names the file).
- **Read and reconciled by** the discover stage ([stage-1-discover.md](stage-1-discover.md) §2
  and §7) — §3, §4, §5.
- **Written by** the deliver stage (`stage-6-deliver.md`), which appends an `opened` line when it
  opens a pull request and a `declined` line when a human declines a candidate at the decide
  stage — §6.

The file is free text a human may edit and pull request comments feed into, so it is **data**:
read with the `Grep` tool, whose pattern is a tool parameter, and changed with `Edit`, one line at
a time. Nothing from it is ever interpolated into a shell command, and it is never loaded whole.

---

## §1 The file and its header

`<state_dir>/memory.md`, created by setup with exactly this first line:

```
# deepen memory — <id> | <date> | <status> | <note>
```

The header does not match §2's entry pattern, so no read ever takes it for an entry. Every line
that does not match §2's pattern — the header, a blank line, a human's note — is preserved byte
for byte; a run never repairs or normalizes the file.

---

## §2 The entry

One line per candidate id:

```
<id> | <YYYY-MM-DD> | <status> | <note>
```

matching

```
^[0-9a-f]{6} \| [0-9]{4}-[0-9]{2}-[0-9]{2} \| (opened|declined|merged) \| .+$
```

| Status | Meaning | Note |
| --- | --- | --- |
| `opened` | the loop opened a pull request for the candidate, not yet resolved | the pull request URL |
| `declined` | a human declined the candidate — at the decide stage, or by closing its pull request unmerged | the reason, one line |
| `merged` | the candidate's pull request merged | the pull request URL |

`<id>` is the candidate id ([candidates.md](candidates.md) §4). `<date>` is the date the line
was last written. A note is one line: newlines and tabs flattened to a space, `|` written as `/`,
at most 200 characters.

---

## §3 Reads

A run reads the file only for the ids it is holding, in one `Grep` call: pattern
`^(<id>|<id>|…) \|` — the ids are `[0-9a-f]{6}`, so the alternation needs no escaping — with line
numbers, over `<state_dir>/memory.md`. Never a whole-file `Read`, never a shell `grep`.

- **No match** for an id — the loop has not acted on it.
- **A matched line that fails §2's pattern** — the report line `memory: malformed line for <id>`,
  and the id is treated as filtered (§5). A line the run cannot read must not let a declined
  candidate back in.
- **Two or more lines for one id** (a hand edit) — the report line
  `memory: <id> has <n> lines — newest date used`; the line with the newest date decides, the
  last such line on a tie. Nothing is rewritten.
- **No file** — the report line `memory: <state_dir>/memory.md missing — run /deepen:setup`, and
  every id is unfiltered. The run does not create it.

---

## §4 Reconciliation

The discover stage settles every `opened` line before it filters, so a pull request a human
closed or merged since the last run is not still treated as open.

1. **Find them.** One `Grep` for `^[0-9a-f]{6} \| [0-9-]+ \| opened \| ` with line numbers. None →
   nothing to do.
2. **Check `gh`.** `command -v gh` and `gh auth status`. Either failing → the report line
   `memory: gh unavailable — <reason> — opened lines left as they are`, and no line is touched.
3. **Per line**, the note must match
   `^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+$` before it reaches a shell.
   A note that does not → the report line `memory: <id> has no reconcilable PR URL`, and the line
   is left as it is. A matching URL:

   ```bash
   gh pr view "<url>" --json state,closedAt,comments --jq '
     .closedAt as $c
     | [ .state,
         ( [ .comments[] | select($c != null and .createdAt <= $c) ] | last | .body // ""
           | gsub("[\r\n\t]+"; " ") | gsub("\\|"; "/") | .[0:200] ) ]
     | @tsv'
   ```

   prints the state and the closing comment — the last comment posted at or before the close —
   already flattened to one line.
   - `MERGED` → rewrite the line to `<id> | <today> | merged | <url>`.
   - `CLOSED` → rewrite the line to `<id> | <today> | declined | <closing comment>`, or
     `closed without reason` when there is none. The candidate is filtered from this run on (§5).
   - `OPEN` → untouched.
   - The call failing → the report line `memory: gh pr view failed for <id> — line left as it is`.
4. **Rewrite in place.** A bounded `Read` of the matched line (`offset` its line number, `limit`
   1) — the read `Edit` requires — then one `Edit` whose `old_string` is that whole line. The
   closing comment is untrusted text and reaches the file only as the `Edit`'s `new_string`.

Every rewrite is listed in the discover report's `## Memory` section as `<id>: opened → <status>`.

---

## §5 Filtering

| Status | Filters the candidate |
| --- | --- |
| `declined` | yes — a human said no to this shape |
| `opened` | yes — a pull request for it is still open |
| `merged` | no — a merged deepening that surfaces again is a new reason to look |
| malformed (§3) | yes |

A filtered candidate is removed from the ranked list and listed under the report's `## Filtered`
section with its status and note. A pinned candidate is the exception the discover stage
states: a pin wins over `declined`, and a pinned `opened` candidate stops for a human decision
before a second pull request is opened for it.

---

## §6 Writes

- **`opened`** — appended by the deliver stage when it opens the pull request, note the URL. An
  existing line for the id is rewritten in place instead (§4 step 4), so one id keeps one line.
- **`declined`** — appended the same way by the deliver stage when a human declines the
  candidate at the decide stage, note the human's reason; rewritten by the discover stage from a
  closed-unmerged pull request (§4).
- **`merged`** — rewritten by the discover stage (§4).

An append extends the file's last line with a newline and the entry through `Edit`, after a
bounded `Read` of that last line. Declining a candidate at the discover stage's pick — choosing
another, or none — writes nothing: not picking a candidate today is not a decision about it.
