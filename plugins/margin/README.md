# margin

Notes in the margin of code the agent wrote. A read-only viewer in the browser — file tree,
line numbers, light syntax colouring from a vendored highlight.js, nothing else — where you pin remarks to a line range, a file, a folder or the
whole scope, then press Send. The batch lands in a JSON file in the repository and the
`annotate` skill reads it, plans, and does the structural work or hands the rest to the
feature pipeline.

It is for the kind of feedback that is awkward to type into a chat: *these twenty components
belong in a tree, not one folder* · *types and helpers out of this file* · *why is this here?*
— said while looking at the code, with the reference attached.

Claude Code only (the skill runs the server as a background Bash command). The server uses
Node 22+ built-ins only; the viewer ships one vendored library, highlight.js (see
[Vendored highlight.js](#vendored-highlightjs)) — no install, no network, no build step.

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

## Vendored highlight.js

The viewer's syntax colouring is highlight.js **11.12.0** (BSD-3-Clause, licence text in
`ui/vendor/LICENSE`), committed under `ui/vendor/` and imported only by `ui/syntax.js`, which
splits its output into lines for the viewer. The files come unmodified, below a header comment,
from the `@highlightjs/cdn-assets` 11.12.0 npm package:

| File | Upstream path | Upstream SHA-256 |
|---|---|---|
| `ui/vendor/highlight.min.js` | `es/highlight.min.js` — the library with its common language set | `1ed8fc5256b738b8875b74e4d3f0754f60d6411fb034d618dfbc4e6e6c9999d7` |
| `ui/vendor/dockerfile.min.js` | `es/languages/dockerfile.min.js` — the Dockerfile grammar, registered by `ui/syntax.js` | `5a83ccd455a2910e9018f591fc1d2856ff5151ffa9889fc000542e16b329b039` |
| `ui/vendor/LICENSE` | `LICENSE` | `6c081431591d9df696c82dc598fe1423765b8a299b200ed00b281afd0f64c490` |

The package tarball's `dist.integrity` is
`sha512-KvOKXODaiFmId9xaq3xc5xCL66wVLUuOngDbO9B/kewbFTqdGbn2nJxNhN3H5R1cgDTVj6R8vH0zgiNDEGjpDw==`.

Languages: bash, c, cpp, csharp, css, diff, go, graphql, ini, java, javascript, json, kotlin,
less, lua, makefile, markdown, objectivec, perl, php, php-template, plaintext, python,
python-repl, r, ruby, rust, scss, shell, sql, swift, typescript, vbnet, wasm, xml, yaml, and
dockerfile. A file is coloured by its extension (or its whole name when it has none) through
these languages' own names and aliases; anything else renders plain.

To update:

1. Read the new release's `dist.tarball` and `dist.integrity` from
   `https://registry.npmjs.org/@highlightjs/cdn-assets/<version>`, download the tarball and
   check its SHA-512 against `dist.integrity`.
2. Extract it into a new, empty scratch directory outside the repository and run nothing from
   it.
3. Copy `package/es/highlight.min.js` and `package/es/languages/dockerfile.min.js` (keeping the
   same language list) and `package/LICENSE` over the three files above.
4. Put back the header comment at the top of each `.js` file, with the new version and
   language list.
5. Update the version, the language list, the hashes and `dist.integrity` in this section.
6. Run `node plugins/margin/server/cli.mjs --self-test`.

## Not yet

- Diff view against a base revision.
- A generated overview (module diagram, file roles) as a second surface to annotate.
- Codex support.
