# margin

Notes in the margin of code the agent wrote. A read-only viewer in the browser — file tree,
line numbers, light syntax colouring from an owned tokenizer, nothing else — where you pin remarks to a line range, a file, a folder or the
whole scope, then press Send. The batch lands in a JSON file in the repository and the
`annotate` skill reads it, plans, and does the structural work or hands the rest to the
feature pipeline.

It is for the kind of feedback that is awkward to type into a chat: *these twenty components
belong in a tree, not one folder* · *types and helpers out of this file* · *why is this here?*
— said while looking at the code, with the reference attached.

Claude Code only (the skill runs the server as a background Bash command). Zero dependencies:
Node 22+ built-ins.

## Install

```bash
/plugin install margin@<github-user>-feature
/reload-plugins
```

## Use

```
/margin:annotate src/features/orders            # one folder
/margin:annotate src/a.ts src/b.ts              # named files
/margin:annotate                                # whole repository (small repos)
/margin:annotate --resume claudedocs/margin/2026-10-11T14-05-33.json   # same root and scope as before
```

The viewer opens at `http://127.0.0.1:7331/#<token>`. Click a line number to annotate it, shift-click
to extend the range; the `+` on a tree row annotates that file or folder; *+ general note* is
for the scope as a whole; *Overall direction* is the framing the agent reads first. Each note
is a `change` or a `question`. Notes save as you go to `claudedocs/margin/<timestamp>.json`;
Send marks the file `submitted` and returns control to the session.

The skill then presents one table — note, action, kind (`answer` / `structural` /
`behavioural`), risk — and asks once. Structural actions run in the session behind the
project's own checks, run before and after, with test edits limited to moved imports and
the test list unchanged.
Behavioural ones go to `/feature:discover` with the anchors attached.

## Standalone

```bash
node plugins/margin/server/cli.mjs annotate --root /path/to/repo --scope src/features/orders --port 7331
```

Prints the viewer URL on stderr — open that exact URL: its `#fragment` is the per-run token
every API call must carry, so a page on another origin cannot plant notes or read source
(`--token` fixes it in advance). Exits when Send or Cancel is pressed, printing one JSON
document with the notes file path. [CONTRACT.md](CONTRACT.md) specifies the flags, the output
document and the exit codes.

## Notes file

[CONTRACT.md](CONTRACT.md) specifies the notes-file schema and the anchor rule. Anchors are
`range` (path, start, end, excerpt of the lines as seen), `file`, `folder`, or `scope`. The excerpt lets the reader
detect drift when the code has changed since the note was written.

## Not yet

- Diff view against a base revision.
- A generated overview (module diagram, file roles) as a second surface to annotate.
- Codex support.
