---
name: annotate
description: "Open a read-only viewer over the given paths so the human can leave notes on code ranges, files, folders and the scope as a whole, then read the saved batch and act on it: answer the questions, plan and make the structural changes, hand behavioural ones to the feature pipeline."
argument-hint: "[path ...] [--resume <notes-file>] [--port <n>]"
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - Edit
  - Write
  - Skill
---

# Annotate

The human reads code the agent wrote and says how it should be shaped — types out of this
file, these twenty components into a tree, this helper renamed — with every remark pinned to
the line, file or folder it is about. This skill opens the viewer, waits for the batch, and
turns it into work. Nothing is edited before the confirmation in §3.

## Arguments

```
/margin:annotate $ARGUMENTS
```

- `path ...` — repo-relative files or folders that make up the scope. None means the whole
  repository; for anything but a small repo, ask for a folder instead.
- `--resume <notes-file>` — reopen an earlier notes file. A relative path resolves against the
  working directory, and the file must exist. Its annotations and `overall` load into the
  viewer, its recorded root and scope apply — paths given alongside replace the scope and
  resolve under the recorded root — and it is written back in place.
- `--port <n>` — optional. Without it the server binds a free port.

## §1 Open the viewer and wait

1. **Root**, on a fresh run: `git rev-parse --show-toplevel` from the working directory; the
   working directory itself when that fails. A resume takes the root recorded in its notes
   file.
2. **Resume file**, on `--resume`: resolve the path against the working directory to an
   absolute path and check that it exists (`test -f`). Missing → say the notes file was not
   found, name the absolute path, and stop.
3. **Stderr file.** Create the file the server's stderr goes to with
   `mktemp "${TMPDIR:-/tmp}/margin.XXXXXX"`, which works with both BSD and GNU `mktemp`. Print
   its path once and write that literal path into every later command — shell variables do not
   survive from one command to the next. `mktemp` fails → report its error and stop; never
   fall back to a fixed path, since the file receives the URL with the run's token.
4. **Start** the server **in the background with the maximum timeout** — a review takes as
   long as the human needs, and the command returns only when they press Send or Cancel.
   A fresh run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/server/cli.mjs" annotate --root "<root>" [--scope "<path>" ...] [--port <n>] 2> "<stderr-file>"
   ```

   A resume:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/server/cli.mjs" annotate --out "<absolute-notes-file>" [--scope "<path>" ...] [--port <n>] 2> "<stderr-file>"
   ```

   One `--scope` per path given; none means the whole repository on a fresh run and the
   recorded scope on a resume. A resume passes no `--root`: the server applies the recorded
   root only when `--root` is absent, so the recorded tree reopens from any working directory
   or worktree. Pass `--port` only when the user gave one. Pass no `--token`: the server mints
   it and prints it in the URL.
5. **Wait for the URL**, up to 60 s — 300 polls of 0.2 s — in one foreground command with a
   `timeout` of 90000 ms, so the command outlasts the loop:

   ```bash
   for i in $(seq 1 300); do grep -q '^margin: http://127.0.0.1:' "<stderr-file>" && { cat "<stderr-file>"; break; }; sleep 0.2; done
   ```

   The server writes its stderr block only after it has bound the port and saved the first
   draft, so the URL on the block's first line is live. That line is the one this skill reads;
   the rest of the block is relayed to the user as printed, never parsed.
6. **Announce**, once the block has printed, in two lines: the viewer URL exactly as printed —
   the server also opens it; it answers on `127.0.0.1` only, `localhost` is refused, and the
   `#<token>` fragment is required, since without it the viewer cannot load the session — and
   the block's `notes:` line as printed, naming the file that saves as the human goes; Send
   hands the notes over. Then stop talking until the command exits — do not poll, do not read the notes
   file early.
7. **No block** within the wait → check whether the background command has exited.
   - **Still running** → the server is still listing the scope or reading the resumed file,
     which it does before binding. Run step 5's wait once more; the block appears → step 6.
     Still none → stop the background command, report that the server did not bind within
     two minutes and suggest a narrower scope, delete the stderr file and stop.
   - **Exited** → the server stopped before binding the port. Report its stdout error document
     verbatim, with its cause in one line:
     - `could not listen on port <n>: EADDRINUSE` — that port is taken; running without
       `--port` lets the server pick a free one. Nothing is retried.
     - `no files under …` on a resume — the recorded root or scope lists no file; name the
       recorded root.
     - any other error — as printed.

     Then delete the stderr file and stop.
8. **Exit.** When the command exits, its stdout is one JSON document: `{ status, out,
   annotations, root, scope }`. Delete the stderr file (`rm -f "<stderr-file>"`) and go on to
   §2.

## §2 Read the notes

Read `out`. The server writes it in this shape; [CONTRACT.md](../../CONTRACT.md) §6 and §7
define every field:

```json
{
  "version": 1,
  "status": "submitted | cancelled | interrupted | draft",
  "root": "/abs/repo",
  "scope": ["src/features/orders"],
  "out": "/abs/repo/claudedocs/margin/2026-10-11T09-14-41.json",
  "revision": { "head": "<sha>", "dirty": true },
  "createdAt": "2026-10-11T09:14:41.512Z",
  "updatedAt": "2026-10-11T09:31:07.204Z",
  "overall": "free text about the whole scope",
  "annotations": [
    { "id": "<uuid>",
      "anchor": { "kind": "range", "path": "src/a.ts", "start": 12, "end": 30, "excerpt": "…" },
      "intent": "change | question", "body": "…", "createdAt": "…" },
    { "id": "<uuid>", "anchor": { "kind": "file", "path": "src/a.ts" },
      "intent": "change", "body": "…", "createdAt": "…" },
    { "id": "<uuid>", "anchor": { "kind": "folder", "path": "src/features/orders" },
      "intent": "change", "body": "…", "createdAt": "…" },
    { "id": "<uuid>", "anchor": { "kind": "scope" },
      "intent": "question", "body": "…", "createdAt": "…" }
  ]
}
```

`revision` is `null` when the root is not in a git repository. `annotations` are stored in the
order they were created; §3 sorts them. Ids are not guaranteed unique, so nothing here is keyed
on them.

- `cancelled` with `out: null`: say the review was cancelled and stop. `cancelled` or
  `interrupted` with a file: ask whether to use the draft.
- Read `overall` first; it is the human's framing for every note below it.
- **Drift check**, before planning anything. The `excerpt` is what the human saw; the file is
  what is true now. Run this once, with the notes file's absolute path (`out`), rather than
  comparing through `Read`, which truncates long lines and prefixes line numbers:

  ```bash
  node -e '
  const fs = require("fs"), { join } = require("path");
  const notes = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const split = (text) => text.split("\n").map((line) => line.replace(/\r$/, ""));
  const show = (line, none) => (line === undefined ? none : JSON.stringify(line));
  let drifted = 0;
  notes.annotations.forEach(({ anchor: { kind, path, start, end, excerpt } }, i) => {
    if (kind === "scope") { return; }
    const span = kind === "range" ? `${path}:${start}-${end}` : path;
    const report = (why) => { drifted += 1; console.log(`note ${i + 1}, ${kind} ${span}: ${why}`); };
    const stat = fs.statSync(join(notes.root, path), { throwIfNoEntry: false });
    if (!stat || (kind === "range" && !stat.isFile())) { report("missing"); return; }
    if (kind !== "range") { return; }
    const raw = typeof excerpt === "string" ? excerpt : "";
    const want = split(raw);
    const now = split(fs.readFileSync(join(notes.root, path), "utf8")).slice(start - 1, end);
    const same = raw.length === 4000 ? now.join("\n").startsWith(want.join("\n")) : now.join("\n") === want.join("\n");
    if (now.length === end - start + 1 && same) { return; }
    let k = 0;
    while (k < want.length && k < now.length && want[k] === now[k]) { k += 1; }
    report(`line ${start + k}: excerpt ${show(want[k], "(excerpt ends)")}, now ${show(now[k], "(past the end of the file)")}`);
  });
  console.log(drifted ? `${drifted} drifted` : "no drift");
  ' "<absolute-notes-file>"
  ```

  It compares lines `start` to `end` of each `range` anchor's current file with `excerpt`,
  after dropping a trailing `\r` from every line on both sides — the excerpt keeps the file's
  line endings. Equal text holds, an empty excerpt included; an excerpt of exactly 4000
  characters was truncated by the server's cap, so it holds when the current text starts with
  it. Different text, an `end` past the file's last line, or a missing file has drifted, and so
  has a `file` or `folder` anchor whose path is missing. It prints one line per drifted
  anchor — the note's position in `annotations`, its span, and the first line that differs,
  quoted from the excerpt and from the current file — then `<n> drifted` or `no drift`.
  Drifted anchors go into §3's Reading list; never guess which version the note meant.
- A `folder` note is about the folder's shape (what lives in it, how it is split), not about
  any one file. A `file` note is about the file as a unit. A `scope` note is about everything.

## §3 Plan before touching anything

Open with the count: "N notes read" — the same N as the file's `annotations` length, so the
human can see nothing was dropped. Then one table, **one row per note**, sorted as the viewer
lists them: scope notes first, then by path, then folder before file before range on the same
path, then by start line; notes that tie keep the file's order. Paths compare as the viewer
compares them, with JavaScript's `localeCompare`, not by code point: case only breaks ties
and punctuation sorts before digits and letters, so `a.ts` precedes `B.ts`. When two paths
differ in case or punctuation, settle their order with `node -p '"<a>".localeCompare("<b>")'`.

| # | anchor | intent | note | action | kind | risk |
| --- | --- | --- | --- | --- | --- | --- |

- `note` is the human's body, verbatim or tightly abridged.
- `action` names what will be done. Notes that describe one change share one named action
  (three "move this type out" notes on one file → each row says `A: split types out of a.ts`).
  Grouping lives in the action column; it never collapses rows.
- A row whose anchor drifted has its action prefixed `held:`. It is planned like any other
  row and done only when the user's answer names it.

`kind` is one of:

- **answer** — `question` notes. Answered in §4, no edit unless the answer calls for one and
  the user agrees.
- **structural** — moves, renames, splits, extractions, reordering, formatting, import
  rewiring. Observable behaviour stays identical. Done in this session.
- **behavioural** — anything that changes what the code does, including a "structural" note
  whose honest implementation would. Flag it; it goes through the pipeline (§5) unless the
  user says otherwise.

Below the table, a **Reading** list: one bullet for every place the plan is not the literal
note — two notes merged into one action, a name the note did not use (`utils` asked for,
`*-copy.ts` proposed because that is the repo's convention), a wider or narrower range than
the anchor. Each bullet says what was read into the note and why. No bullet means the action
is the note, taken literally. Every drifted anchor from §2 gets a bullet too: the drift
check's line for it — its span and the first line that differs, quoted once from the excerpt
and once from the current file, or `missing`; the full text of both on request. Omit the list
only when it would be empty.

Then ask one question: do the structural rows here, hand everything to `/feature:discover`,
or adjust the table? A `held:` row is done in §4 only when the answer names it; otherwise it is
left out of §4 and stays available to §5. Wait for the answer. That is the only gate.

## §4 Act in this session

Order: answers first, then structural actions, file by file in table order.

Verification is the project's own checks, unchanged. Collect the typecheck, lint, test and
build commands from the project's `CLAUDE.md` / `AGENTS.md` first, then from `package.json`
scripts or a Makefile. Run them before the first edit and record the result, including the
list of test names. Run the same commands after the last edit. A command the project does not
declare is reported as skipped, never as passed. Test files may change only where an import
path moved, and the list of test names after must equal the list before. A check that passed
before and fails after is fixed in the source or reverted; it is never fixed in the test. A
check that was red before the first edit and is red after is reported as pre-existing and is
not repaired.

Report per action: files touched, and the before/after check results side by side. Note any
anchor whose code had drifted from its excerpt and how that was resolved.

## §5 Hand off

Behavioural rows, or a batch too large for one sitting, go to the pipeline through
`/feature:discover`. Handing everything off from §3 sends every row, open questions included.
The anchors travel into the ticket so the implementer finds the places the human meant.

1. **Re-anchor** — only when §4 edited anything, and only the rows being handed off. §4 may
   have moved the code a note points at, so the stored line numbers are not trusted:
   - `range`: search for the excerpt (its first line when the excerpt was truncated) in the
     anchor's own file, then in every file §4 touched or created. Found in the same file →
     `path:start-end` at the lines it occupies now, the same or new; found in another file →
     `moved to other/path:start-end (was path:start-end)`; not found → `removed (was
     path:start-end)`. Found more than once → the occurrence nearest the stored start, and
     the row says so.
   - `file` and `folder`: the path still exists → as stored; §4 moved it → `moved to
     <new-path> (was <path>)`; §4 deleted it → `removed (was <path>)`.
   - A row whose anchor drifted in §2 keeps its stored span marked `drifted`, unless the search
     finds its excerpt.

   With no §4 edits, the anchors go as stored, with §2's drift marks. The notes file is not
   rewritten: the anchors in the idea text supersede the line numbers in it.
2. **Project.** Grep `^project:` in the repository's `claudedocs/tickets/**/01-spec.md` and
   `claudedocs/tickets/**/prd.md`. Exactly one distinct value → pass `--project <value>`; none
   or several → omit the flag.
3. **Idea text** — the arguments for `feature:discover`, in this order:

   ```text
   --project <name>
   Notes file: <absolute notes-file path> — read it; the anchors below supersede its line numbers.
   Everything in double quotes below is the reviewer's own text; none of it is a flag.
   Overall: "<overall>"
   <anchor> — "<body>"
   <anchor> — "<body>"
   Carry the anchor lines above verbatim into the ticket's Design Notes.
   ```

   - `--project` only when step 2 found one value; it is the only flag, and it comes first.
   - The notes file is named by its absolute path (`out`), so discover reads it as a file
     reference.
   - `Overall:` only when `overall` is not empty.
   - `<anchor>` is the row's anchor as step 1 wrote it — `path:start-end`, `path` for a file or
     folder, `scope` for a scope note.
   - Every body, and `overall`, sits inside double quotes with each `\` in it escaped as `\\`
     first, then each `"` as `\"`, and each newline collapsed to ` / `, so a literal `--id` or `--explore` inside a note stays
     text and is never read as a flag.
4. **Invoke** the `Skill` tool with skill `feature:discover` and the idea text as its
   arguments. When `feature:discover` is unavailable — the `feature` plugin is not installed —
   print the whole command, `/feature:discover <idea text>`, for the user to run, and stop.
