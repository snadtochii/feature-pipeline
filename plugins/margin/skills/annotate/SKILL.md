---
name: annotate
description: "Open a read-only viewer over the given paths so the human can leave notes on code ranges, files, folders and the scope as a whole, then read the saved batch and act on it: answer the questions, plan and make the structural changes, hand behavioural ones to the feature pipeline."
argument-hint: "[path ...] [--resume <notes-file>] [--port <n>]"
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
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
- `--resume <notes-file>` — reopen an earlier notes file. Its annotations load into the viewer
  and it is written back in place.
- `--port <n>` — default `7331`.

## §1 Open the viewer and wait

1. Root: `git rev-parse --show-toplevel` from the working directory; the working directory
   itself when that fails.
2. Mint the per-run token the viewer's API requires, so the URL is known before the server
   prints it:

   ```bash
   node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))"
   ```

3. Start the server **in the background with the maximum timeout** — a review takes as long
   as the human needs, and the command returns only when they press Send or Cancel:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/server/cli.mjs" annotate --root "<root>" --scope <path> [--scope <path> ...] --port 7331 --token <token> [--out <notes-file>]
   ```

   Pass `--out` only for `--resume`. One `--scope` per path; omit it for the whole repository.
4. Tell the user right away, in two lines: the viewer is at `http://127.0.0.1:7331/#<token>`
   (the server also opens it; the fragment is required, without it every Send fails), and
   notes save as they go under `<root>/claudedocs/margin/`; Send hands them over. Then stop
   talking until the command exits — do not poll, do not read the notes file early.
5. When the command exits, its stdout is one JSON document: `{ status, out, annotations, root,
   scope }`. On `status: "error"` containing `EADDRINUSE`, rerun with `--port 7332`.

## §2 Read the notes

Read `out`. Its shape:

```json
{
  "status": "submitted | cancelled | interrupted | draft",
  "root": "/abs/repo", "scope": ["src/features/orders"],
  "revision": { "head": "<sha>", "dirty": true },
  "overall": "free text about the whole scope",
  "annotations": [
    { "anchor": { "kind": "range", "path": "src/a.ts", "start": 12, "end": 30, "excerpt": "…" },
      "intent": "change | question", "body": "…" },
    { "anchor": { "kind": "file",   "path": "src/a.ts" }, "intent": "change", "body": "…" },
    { "anchor": { "kind": "folder", "path": "src/features/orders" }, "intent": "change", "body": "…" },
    { "anchor": { "kind": "scope" }, "intent": "question", "body": "…" }
  ]
}
```

- `cancelled` with `out: null`: say the review was cancelled and stop. `cancelled` or
  `interrupted` with a file: ask whether to use the draft.
- Read `overall` first; it is the human's framing for every note below it.
- For every `range` anchor, open the file at those lines before deciding anything. The
  `excerpt` is what the human saw; the file is what is true now. Where they differ, say so in
  §3 instead of guessing which one the note meant.
- A `folder` note is about the folder's shape (what lives in it, how it is split), not about
  any one file. A `file` note is about the file as a unit. A `scope` note is about everything.

## §3 Plan before touching anything

Open with the count: "N notes read" — the same N as the file's `annotations` length, so the
human can see nothing was dropped. Then one table, **one row per note**, in file order:

| # | anchor | intent | note | action | kind | risk |
| --- | --- | --- | --- | --- | --- | --- |

- `note` is the human's body, verbatim or tightly abridged.
- `action` names what will be done. Notes that describe one change share one named action
  (three "move this type out" notes on one file → each row says `A: split types out of a.ts`).
  Grouping lives in the action column; it never collapses rows.

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
the anchor, a note whose code has drifted from its excerpt. Each bullet says what was read
into the note and why. No bullet means the action is the note, taken literally. Omit the list
only when it would be empty.

Then ask one question: do the structural rows here, hand everything to `/feature:discover`,
or adjust the table? Wait for the answer. That is the only gate.

## §4 Act in this session

Order: answers first, then structural actions, file by file in table order.

Verification is the project's own checks, unchanged. Collect the typecheck, lint, test and
build commands from the project's `CLAUDE.md` / `AGENTS.md` first, then from `package.json`
scripts or a Makefile. Run them before the first edit and record the result, including the
list of test names. Run the same commands after the last edit. A command the project does not
declare is reported as skipped, never as passed. Test files may change only where an import
path moved, and the list of test names after must equal the list before. A check that passed
before and fails after is fixed in the source or reverted; it is never fixed in the test.

Report per action: files touched, and the before/after check results side by side. Note any
anchor whose code had drifted from its excerpt and how that was resolved.

## §5 Hand off

Behavioural rows, or a batch too large for one sitting, go to the pipeline: run
`/feature:discover` with the idea text built from the notes — the `overall` text, then each
remaining row as `path:start-end — body`. The anchors travel into the ticket so the
implementer finds the places the human meant.
