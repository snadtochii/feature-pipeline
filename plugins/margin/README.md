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

The viewer opens at the URL the server prints, `http://127.0.0.1:<port>/#<token>` — a free
port unless `--port` is given. The server answers on `127.0.0.1` only: open the URL as
printed, since `localhost:<port>` is refused with 421, and keep its `#fragment`, the per-run
token. Click a line number to annotate it, shift-click
to extend the range; the `+` on a tree row annotates that file or folder; *+ general note* is
for the scope as a whole; *Overall direction* is the framing the agent reads first. Each note
is a `change` or a `question`. Notes save as you go to `claudedocs/margin/<timestamp>.json`,
or back into the file a `--resume` names; Send marks the file `submitted` and returns control
to the session.

The skill ([skills/annotate/SKILL.md](skills/annotate/SKILL.md)) then presents one table —
note, action, kind (`answer` / `structural` / `behavioural`), risk — and asks once. A note
whose code differs from the excerpt you saw is quoted both ways and held until you name it. Structural actions run in the session behind the
project's own checks, run before and after, with test edits limited to moved imports and
the test list unchanged.
Behavioural ones go to `/feature:discover` with the anchors attached.

## Standalone

```bash
node plugins/margin/server/cli.mjs annotate --root /path/to/repo --scope src/features/orders
```

Prints the viewer URL on stderr once the port is bound — a free port unless `--port` is
given. Open that exact URL: its `#fragment` is the per-run token
every API call must carry, so a page on another origin cannot plant notes or read source
(`--token` fixes it in advance). Exits when Send or Cancel is pressed, printing one JSON
document with the notes file path. [CONTRACT.md](CONTRACT.md) specifies the flags, the output
document and the exit codes.

## Notes file

[CONTRACT.md](CONTRACT.md) specifies the notes-file schema and the anchor rule. Anchors are
`range` (path, start, end, excerpt of the lines as seen), `file`, `folder`, or `scope`. The excerpt lets the reader
detect drift when the code has changed since the note was written.

## Runtime dependencies

None of these is checked at install. The skill looks for each one when it needs it; each
bullet says what happens when it is missing.

- **`feature`** — the skill hands behavioural notes to `/feature:discover` (its §5). Not
  installed → the skill prints the `/feature:discover …` command it built, for you to run once
  the plugin is installed.
- **`git`** — optional. It resolves the root, makes the listing git-aware and fills
  `revision`. Missing → the root is the working directory, the listing walks the scope paths,
  and `revision` is `null`.

## Not yet

- Diff view against a base revision.
- A generated overview (module diagram, file roles) as a second surface to annotate.
- Codex support.
