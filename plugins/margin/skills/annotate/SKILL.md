---
name: annotate
description: "Open a read-only viewer over the given paths, optionally with an overview of the area's file measurements, roles and deepening candidates, so the human can leave notes on code ranges, files, folders, candidates and the scope as a whole, then work through each round they send: answer the questions, plan and make the structural changes, hand behavioural ones and accepted candidates off, and reply beside every note, until the human finishes."
argument-hint: "[path ...] [--overview] [--resume <notes-file>] [--port <n>]"
disable-model-invocation: true
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - Edit
  - Write
  - Skill
  - Agent
  - Task
---

# Annotate

The human reads code the agent wrote and says how it should be shaped — types out of this
file, these twenty components into a tree, this helper renamed — with every remark pinned to
the line, file or folder it is about. This skill opens the viewer and, round by round, turns
each batch the human sends into work and a reply beside every note. Nothing is edited before
the round's confirmation in §3.

## Arguments

```
/margin:annotate $ARGUMENTS
```

- `path ...` — repo-relative files or folders that make up the scope. None means the whole
  repository; for anything but a small repo, ask for a folder instead.
- `--resume <notes-file>` — reopen an earlier notes file. A relative path resolves against the
  working directory, and the file must exist. Its annotations and `overall` load into the
  viewer, its recorded root and scope apply — paths given alongside replace the scope and
  resolve under the recorded root — and it is written back in place. Its rounds and replies
  load too, and the loop continues with the next round. The overview beside it — the notes
  path with its trailing `.json` replaced by `.overview.json` — reopens with it when that file
  exists.
- `--overview` — analyze the scope before the viewer opens — file measurements, each file's
  kind and role, and deepening candidates — and open it with an Overview tab (§1a). It needs at
  least one path: with none, ask for a folder and wait. On `--resume` it is ignored with one
  line saying so: a resume reopens the overview its notes were written against.
- `--port <n>` — optional. Without it the server binds a free port.

## §1 Open the viewer and loop over rounds

1. **Root**, on a fresh run: `git rev-parse --show-toplevel` from the working directory; the
   working directory itself when that fails. A resume takes the root recorded in its notes
   file.
2. **Resume file**, on `--resume`: resolve the path against the working directory to an
   absolute path and check that it exists (`test -f`). Missing → say the notes file was not
   found, name the absolute path, and stop. Then read `<last>`, the last round handled, from
   it now, before the server starts: the viewer can send a round as soon as it opens, and a
   round sent before `<last>` is read would be skipped.

   ```bash
   node -p 'const n = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const notes = Array.isArray(n.annotations) ? n.annotations : []; `round ${Array.isArray(n.rounds) ? n.rounds.length : 0}, ${notes.filter((a) => a && a.round !== undefined && !(a.replies && a.replies.length)).length} sent without a reply`' "<absolute-notes-file>"
   ```

   `<last>` is the printed round: the number of stored `rounds`, which the server keeps as
   stored and resumes from ([CONTRACT.md](../../CONTRACT.md) §5). Keep the count of notes sent
   without a reply for step 6. A file this cannot parse prints an error → go on to step 3; the
   server refuses the file, and step 7 reports why.

   Then the notes file's overview: `<sibling>` is the absolute notes path with its trailing
   `.json` replaced by `.overview.json`; a notes path that does not end in `.json` has none.
   `test -f "<sibling>"` succeeds → step 4 passes it as `--overview`. It fails, or there is no
   sibling → the resume runs without an overview, and when `--overview` was given too, one line
   says the notes file has no overview beside it.
3. **Stderr file.** Create the file the server's stderr goes to with
   `mktemp "${TMPDIR:-/tmp}/margin.XXXXXX"`, which works with both BSD and GNU `mktemp`. Print
   its path once and write that literal path into every later command — shell variables do not
   survive from one command to the next. `mktemp` fails → report its error and stop; never
   fall back to a fixed path, since the file receives the URL with the run's token.
4. **Start** the server **in the background with the maximum timeout** — a review takes as
   long as the human needs, and the command returns only when the run ends — Finish, Cancel or
   a signal. With `--overview` on a fresh run, §1a builds the overview first; the server starts
   only once it has, so generation finishes before step 5's wait begins.
   A fresh run:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/server/cli.mjs" annotate --root "<root>" [--scope "<path>" ...] [--port <n>] 2> "<stderr-file>"
   ```

   A fresh overview run, with `<notes>` and `<overview>` the two paths §1a step 7 minted:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/server/cli.mjs" annotate --root "<root>" --scope "<path>" ... --out "<notes>" --overview "<overview>" [--port <n>] 2> "<stderr-file>"
   ```

   `<notes>` does not exist yet, so the run is fresh and its notes file is created there, beside
   the overview.

   A resume:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/server/cli.mjs" annotate --out "<absolute-notes-file>" [--scope "<path>" ...] [--overview "<sibling>"] [--port <n>] 2> "<stderr-file>"
   ```

   `--overview` only when step 2 found the sibling.

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
   the block's `notes:` line as printed, naming the file that saves as the human goes. Add
   that each Send hands a round over, and that Finish in the viewer, or saying so here, ends
   the review. When the run was given an overview, add that the viewer has an Overview tab,
   where a candidate takes a note like a file does.

   `<last>`, the last round handled, is what every wait carries: `0` on a fresh run, and on a
   resume the round step 2 read. On a resume, a count above `0` of notes sent without a reply
   (step 2) is named once: an earlier run sent them and never answered; the viewer's reply
   action on one sends a follow-up in the next round.
7. **No block** within the wait → check whether the background command has exited.
   - **Still running** → the server is still listing the scope or reading the resumed file,
     which it does before binding. Run step 5's wait once more; the block appears → step 6.
     Still none → stop the background command, report that the server did not bind within
     two minutes and suggest a narrower scope, delete the stderr file, apply the overview
     cleanup (§1a) and stop.
   - **Exited** → the server stopped before binding the port. Report its stdout error document
     verbatim, with its cause in one line:
     - `could not listen on port <n>: EADDRINUSE` — that port is taken; running without
       `--port` lets the server pick a free one. Nothing is retried.
     - `no files under …` on a resume — the recorded root or scope lists no file; name the
       recorded root.
     - `overview <file>: …` on a resume — the overview beside the notes file was refused; name
       the file, and say that moving it aside resumes the notes without an overview.
     - any other error — as printed.

     Then delete the stderr file, apply the overview cleanup (§1a) and stop.
8. **Wait for a round**, **in the background with the maximum timeout**, with `<url>` the
   viewer URL exactly as printed and `<last>` written as a number:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/server/cli.mjs" wait "<url>" --after <last>
   ```

   Then say nothing until a background command exits — do not poll, and do not read the notes
   file while a wait is outstanding. Exactly one wait runs at a time: a chat message that does
   not end the review (step 9) is answered in chat, and the outstanding wait keeps running. On
   the wait's exit, its stdout is the wait document `{ status, round, out }`:
   - exit 0 with `"status": "sent"` → `<R>` is the document's `round` and `<out>` its `out`.
     The round to handle is every note whose `round` is above `<last>` and at most `<R>` —
     more than one Send when the human sent again before the wait was answered. Run §2–§6 on
     it, set `<last>` to `<R>`, and start this step again.
   - exit 0 with any other `status` — `finished`, `cancelled` or `interrupted` → §7.
   - no wait document — exit 1, or the command was stopped: the server's background command
     has exited → §7; it is still running → start one new wait with the same `--after`. A
     second such exit in a row → report it, print the viewer URL and step 9's Finish command
     for the user to run, and stop.
9. **Ending from chat.** A message from the human that clearly means the review is over —
   "we're done", "close the viewer", "stop the server", in any phrasing — ends the run,
   whether it arrives while a wait is outstanding, as the answer at §3's gate, or mid-round,
   before the human pressed Send. Call Finish, with `<port>` and `<token>` taken from the URL
   (`http://127.0.0.1:<port>/#<token>`) and written literally:

   ```bash
   curl -s -w '\n%{http_code}' -X POST -H 'x-margin-token: <token>' http://127.0.0.1:<port>/api/finish
   ```

   The last line printed is the status code. `200` (`finished`), `409` (`the run has ended` —
   the viewer ended it first) and `000` (curl reached no server) all lead to §7. Start no
   further wait: the outstanding one exits with the end status, and that exit belongs to §7.
   No status line — `curl` is not installed → ask the human to press Finish in the viewer;
   the outstanding wait's exit then leads to §7.
   At §3's gate, an answer that only ends the review takes no action for the round and calls
   Finish now; an answer that asks for work and then to finish runs the round through §6 and
   calls Finish in place of step 8.

   A run can also end from the viewer while the skill works a round. The skill learns it when
   §6's post answers `409`: the round's actions have run with their checks, and its replies
   go to the chat.

## §1a Build the overview

Run from §1 step 4, only with `--overview` on a fresh run, before the server starts. The
overview file is written by the server's `assemble` and nothing else: the skill never writes
overview JSON itself, and never edits the file `assemble` wrote. Generation runs a deep
exploration, so it takes minutes; say so once before step 1.

1. **Temp directory.** `mktemp -d "${TMPDIR:-/tmp}/margin-overview.XXXXXX"` → `<tmp>`. Print its
   path once and write that literal path into every later command. `mktemp` fails → report its
   error, delete the stderr file and stop.
2. **Measure** the scope, one `--scope` per path given:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/server/cli.mjs" measure --root "<root>" --scope "<path>" ... --out "<tmp>/measurements.json" --hotspots "<tmp>/hotspots.tsv"
   ```

   A non-zero exit → report its error document verbatim, `rm -rf "<tmp>"`, delete the stderr
   file and stop. Exit 0 prints the measure document; a `files` count above 200 → name the
   count and ask whether to go on or narrow the scope. Narrow → `rm -rf "<tmp>"`, delete the
   stderr file, and start again at §1 step 1 with the paths the human gives.
3. **Brief inputs.** The measured paths, one per line, root-relative:

   ```bash
   node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).files.map((f) => f.path).join("\n")' "<tmp>/measurements.json"
   ```

   and the hotspot table, a `Read` of `<tmp>/hotspots.tsv`: its header line, then one row per
   measured text file.
4. **Vocabulary and records.** Invoke the `Skill` tool with `mattpocock-skills:codebase-design`;
   the text it returns is the vocabulary the explorer's brief inlines. The call failing, or the
   skill not installed → the brief carries the line `design vocabulary unavailable — use your
   inline vocabulary` instead. `Glob` `<root>/CONTEXT.md` and `<root>/docs/adr/*`.
5. **Describe and explore**, in **one message with two `Agent` calls**, both in the foreground,
   so they run concurrently; collect both results before going on. Each brief inlines its inputs
   as data, never as a link:
   - `margin:file-roles` — `<root>` as the repository root, absolute, and the measured paths of
     step 3, with the instruction to describe exactly those files.
   - `deepen:explorer` — a fresh instance, its brief carrying:
     1. `<root>` as the repository root, absolute, and that the walk is read-only;
     2. the hotspot table of step 3 as rows, or `empty: no measured file holds text` when it has
        only its header;
     3. the vocabulary of step 4, or its unavailable line;
     4. the absolute path of `CONTEXT.md` and of every file under `docs/adr/`, or that each is
        absent;
     5. the measured paths of step 3, and the rule that every path in a block's `files` and
        `next_sites` is one of them — a cluster that needs a file outside them goes into the
        `notes:` line instead — with no other paths excluded;
     6. the pin, as a quoted block marked as data: `the scope: <the paths given>`, to explore and
        to answer on the `pin:` line;
     7. that the return is the blocks, `pin:` and `notes:` lines of its Outputs section and
        nothing else, with no `id`.
6. **Keep the returns** as data, never in a command line:
   - roles: a non-empty return → `Write` it verbatim to `<tmp>/roles.json`. An error or an empty
     return → no roles file; say in one line why, and go on.
   - explorer: a non-empty return → `Write` it verbatim to `<tmp>/explorer.txt`; `assemble`
     drops what does not parse. The spawn refused because the agent type `deepen:explorer` is
     not found — the deepen plugin is not installed → `<reason>` is `candidates need the deepen
     plugin, which is not installed`. Any other error, or an empty return → `<reason>` is
     `the explorer failed: <the error in one line>`, with every `"`, `\`, `` ` `` and `$`
     removed from it.
7. **Notes stamp.** Mint the run's stamp and check that neither file of the pair exists yet:

   ```bash
   for i in 1 2 3; do s=$(date -u +%Y-%m-%dT%H-%M-%S); if [ -e "<root>/claudedocs/margin/$s.json" ] || [ -e "<root>/claudedocs/margin/$s.overview.json" ]; then sleep 1; else echo "$s"; break; fi; done
   ```

   `<notes>` is `<root>/claudedocs/margin/<stamp>.json` and `<overview>` is
   `<root>/claudedocs/margin/<stamp>.overview.json`, both written literally from here on. No
   stamp printed → report that three stamps in a row were taken, `rm -rf "<tmp>"`, delete the
   stderr file and stop.
8. **Assemble**, with `--roles` only when step 6 wrote the roles file, and `--explorer` or
   `--explorer-unavailable` by step 6's explorer outcome; the temp directory is removed in the
   same command, whatever the exit:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/server/cli.mjs" assemble --measurements "<tmp>/measurements.json" [--roles "<tmp>/roles.json"] [--explorer "<tmp>/explorer.txt" | --explorer-unavailable "<reason>"] --out "<overview>"; rc=$?; rm -rf "<tmp>"; (exit $rc)
   ```

   A non-zero exit → report its error document verbatim, delete the stderr file and stop;
   nothing was written. Exit 0 → relay the assemble document's `files`, `candidates`, `dropped`
   and `notices` counts in one line, and its stderr warning lines as printed. Back to §1 step 4.

**Overview cleanup.** An overview file belongs to the notes file beside it. Wherever a run that
used one ends — §1 step 7 and §7 — check the notes file with `test -f "<notes-file>"`, the
`<notes>` path on a fresh run and the resumed file on a resume. When it no longer exists,
`rm -f "<overview-file>"` and say the overview went with it. A notes file that still exists
keeps its overview.

## §2 Read the round

The round is read from `<out>`, the notes file the wait document names, between rounds: the
server saves every change atomically, so a read sees a whole file. It writes the file in this
shape; [CONTRACT.md](../../CONTRACT.md) §6 and §7 define every field:

```json
{
  "version": 1,
  "status": "finished | cancelled | interrupted | draft",
  "root": "/abs/repo",
  "scope": ["src/features/orders"],
  "out": "/abs/repo/claudedocs/margin/2026-10-11T09-14-41.json",
  "revision": { "head": "<sha>", "dirty": true },
  "createdAt": "2026-10-11T09:14:41.512Z",
  "updatedAt": "2026-10-11T09:31:07.204Z",
  "overall": "free text about the whole scope",
  "overallReplies": [{ "body": "…", "round": 1, "createdAt": "…" }],
  "round": 1,
  "rounds": [{ "round": 1, "sentAt": "2026-10-11T09:31:07.204Z", "overall": "…" }],
  "annotations": [
    { "id": "<uuid>",
      "anchor": { "kind": "range", "path": "src/a.ts", "start": 12, "end": 30, "excerpt": "…" },
      "intent": "change | question", "body": "…", "createdAt": "…", "round": 1,
      "replies": [{ "body": "…", "round": 1, "createdAt": "…" }] },
    { "id": "<uuid>", "anchor": { "kind": "file", "path": "src/a.ts" },
      "intent": "change", "body": "…", "createdAt": "…" },
    { "id": "<uuid>", "anchor": { "kind": "folder", "path": "src/features/orders" },
      "intent": "change", "body": "…", "createdAt": "…" },
    { "id": "<uuid>", "anchor": { "kind": "scope" },
      "intent": "question", "body": "…", "createdAt": "…" },
    { "id": "<uuid>", "anchor": { "kind": "candidate", "name": "split-parsing" },
      "intent": "change", "body": "…", "createdAt": "…" }
  ]
}
```

`revision` is `null` when the root is not in a git repository. `annotations` are stored in the
order they were created, except that a Send moves the candidate notes it withholds after the
notes it stamps; §3 sorts them. Ids are not guaranteed unique, so the table and the
drift check never key on them; §6's reply post must, so notes that share an id are named
wherever they occur.

- **Round view.** Read the round through this script rather than a whole-file `Read`, which
  grows with every round and truncates long lines. Run it with the notes file's absolute path
  (`out`), `<last>` and `<R>`:

  ```bash
  node -e '
  const notes = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const after = Number(process.argv[2]), upto = Number(process.argv[3]);
  const span = ({ kind, path, start, end, name }) => (kind === "scope" ? "scope" : kind === "candidate" ? `candidate ${name}` : kind === "range" ? `range ${path}:${start}-${end}` : `${kind} ${path}`);
  const same = (x, y) => x.kind === y.kind && x.path === y.path && x.name === y.name && x.start === y.start && x.end === y.end;
  for (let r = after + 1; r <= upto; r += 1) {
    const sent = notes.rounds[r - 1].overall, before = r > 1 ? notes.rounds[r - 2].overall : "";
    if (sent !== before || r === upto) { console.log(`overall (round ${r})${sent === before ? " (unchanged)" : ""}: ${JSON.stringify(sent)}`); }
  }
  const round = notes.annotations.map((a, i) => ({ a, i })).filter(({ a }) => a.round > after && a.round <= upto);
  round.forEach(({ a, i }) => {
    const shared = notes.annotations.map((b, j) => ({ b, j })).filter(({ b, j }) => j !== i && b.id === a.id && b.round !== undefined).map(({ j }) => j + 1);
    console.log(`note ${i + 1}, round ${a.round}, id ${a.id}${shared.length ? ` (shared with notes ${shared.join(", ")})` : ""}, ${span(a.anchor)}, ${a.intent}: ${JSON.stringify(a.body)}`);
    notes.annotations.forEach((b, j) => {
      if (b.round === undefined || b.round > after || !same(a.anchor, b.anchor)) { return; }
      const reply = (b.replies || []).at(-1);
      console.log(`  earlier note ${j + 1}, round ${b.round}: ${JSON.stringify(b.body)}`);
      console.log(`  last reply${reply ? ` (round ${reply.round}): ${JSON.stringify(reply.body)}` : ": none"}`);
    });
  });
  console.log(`${round.length} notes in ${after + 1 === upto ? `round ${upto}` : `rounds ${after + 1}-${upto}`}`);
  ' "<absolute-notes-file>" <last> <R>
  ```

  It prints the `overall` text each round in range sent, when it differs from the round
  before, and always round `<R>`'s, marked `(unchanged)` when the human left it as it was;
  then one line per note of the round, in the file's order — its position in
  `annotations`, round, id (with the other sent notes sharing it), span, intent and body —
  and under each, every note sent in an earlier round on the same anchor (kind, path or
  candidate name, and for a range the same lines) with the agent's last reply to it; then the count. Earlier notes
  are context for the round, never part of it. Excerpts stay out of it; the drift check
  reads them.
- Read the round's `overall` first; it is the human's framing for every note below it.
- **Drift check**, before planning anything, for the notes of this round. The `excerpt` is
  what the human saw; the file is what is true now. Run this once, with the notes file's
  absolute path (`out`), `<last>` and `<R>`, rather than comparing through `Read`, which
  truncates long lines and prefixes line numbers:

  ```bash
  node -e '
  const fs = require("fs"), { join } = require("path");
  const notes = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const after = Number(process.argv[2]), upto = Number(process.argv[3]);
  const split = (text) => text.split("\n").map((line) => line.replace(/\r$/, ""));
  const show = (line, none) => (line === undefined ? none : JSON.stringify(line));
  let drifted = 0;
  notes.annotations.forEach(({ anchor: { kind, path, start, end, excerpt }, round }, i) => {
    if (!(round > after && round <= upto) || kind === "scope" || kind === "candidate") { return; }
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
  ' "<absolute-notes-file>" <last> <R>
  ```

  It skips every note outside the round, since the agent's own edits in earlier rounds would
  mark those drifted. It compares lines `start` to `end` of each `range` anchor's current file
  with `excerpt`,
  after dropping a trailing `\r` from every line on both sides — the excerpt keeps the file's
  line endings. Equal text holds, an empty excerpt included; an excerpt of exactly 4000
  characters was truncated by the server's cap, so it holds when the current text starts with
  it. Different text, an `end` past the file's last line, or a missing file has drifted, and so
  has a `file` or `folder` anchor whose path is missing. A `scope` or `candidate` note points
  at no code, so it has nothing to drift. It prints one line per drifted
  anchor — the note's position in `annotations`, its span, and the first line that differs,
  quoted from the excerpt and from the current file — then `<n> drifted` or `no drift`.
  Drifted anchors go into §3's Reading list; never guess which version the note meant.
- A `folder` note is about the folder's shape (what lives in it, how it is split), not about
  any one file. A `file` note is about the file as a unit. A `scope` note is about everything.
  A `candidate` note is about the overview's deepening candidate of that name.

## §3 Plan before touching anything

Open with the count: "N notes read (round <R>)", or "(rounds <last+1>–<R>)" when the wait
covered more than one Send — the same N as the round view's count, so the human can see
nothing was dropped. Then one table for the round, **one row per note of the round**; notes of
earlier rounds are context and never become rows. Rows are sorted as the viewer
lists them: scope notes first, then candidate notes by name, then by path, then folder before
file before range on the same path, then by start line; notes that tie keep the file's order.
Names and paths compare as the viewer compares them, with JavaScript's `localeCompare`, not by code point: case only breaks ties
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
- **candidate** — a `change` note on a `candidate` anchor; a `question` note on one is an
  **answer**. Its body is read as accepting the candidate or declining it. Accepted → action
  `offer: /feature:discover or /deepen:run --pin`; declined, or anything else → action
  `noted: <the reading>`. A reading that is not the literal note gets a Reading bullet. A
  candidate is never implemented in this session, whatever the note asks: an accepted one
  leaves through §5, as a ticket or as a deepen run.

Below the table, a **Reading** list: one bullet for every place the plan is not the literal
note — two notes merged into one action, a name the note did not use (`utils` asked for,
`*-copy.ts` proposed because that is the repo's convention), a wider or narrower range than
the anchor. Each bullet says what was read into the note and why. No bullet means the action
is the note, taken literally. Every drifted anchor from §2 gets a bullet too: the drift
check's line for it — its span and the first line that differs, quoted once from the excerpt
and once from the current file, or `missing`; the full text of both on request. A follow-up —
a note on the same anchor as a note of an earlier round — gets a bullet quoting the earlier
note and the agent's last reply to it, from the round view. Notes that share an id get a
bullet naming them, since §6 answers them in one reply. Omit the list only when it would be
empty.

A round that sent no notes — only a changed `overall` — opens with "0 notes read (round
<R>)" and has no table. Its `overall` is answered in §6, or planned like a row, and put to the
gate, when it asks for edits.

Then ask one question: do the structural rows here, hand everything to `/feature:discover`,
or adjust the table? A `held:` row is done in §4 only when the answer names it; otherwise it is
left out of §4 and stays available to §5. When the table holds accepted candidate rows, the
same question asks which route each takes: a `/feature:discover` ticket or a `/deepen:run --pin`
run. Handing everything to `/feature:discover` sends them as tickets. An accepted candidate
whose route the answer does not name is handed nowhere, and an answer that asks to implement a
candidate here names no route for it. Wait for the answer. That is the only gate of the
round. An answer that ends the review is §1 step 9.

## §4 Act in this session

Order: answers first, then structural actions, file by file in table order. Candidate rows
are never acted on here: §5 hands them off.

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
anchor whose code had drifted from its excerpt and how that was resolved. Each row's outcome
here is what §6 replies to its note.

## §5 Hand off

Behavioural rows, or a batch too large for one sitting, go to the pipeline through
`/feature:discover`. Handing everything off from §3 sends every row, open questions included.
The anchors travel into the ticket so the implementer finds the places the human meant.
Accepted candidate rows take the route §3's answer named for each: the discover route joins
this hand-off, and the deepen route is printed for the human to run (step 5).

1. **Re-anchor** — per round, only when §4 edited anything, and only the rows being handed
   off. §4 may have moved the code a note points at, so the stored line numbers are not
   trusted:
   - `range`: search for the excerpt (its first line when the excerpt was truncated) in the
     anchor's own file, then in every file §4 touched or created. Found in the same file →
     `path:start-end` at the lines it occupies now, the same or new; found in another file →
     `moved to other/path:start-end (was path:start-end)`; not found → `removed (was
     path:start-end)`. Found more than once → the occurrence nearest the stored start, and
     the row says so.
   - `file` and `folder`: the path still exists → as stored; §4 moved it → `moved to
     <new-path> (was <path>)`; §4 deleted it → `removed (was <path>)`.
   - `candidate`: as stored — it names a candidate, not code.
   - A row whose anchor drifted in §2 keeps its stored span marked `drifted`, unless the search
     finds its excerpt.

   With no §4 edits, the anchors go as stored, with §2's drift marks. The skill never writes
   the notes file: the anchors in the idea text supersede its line numbers, and §6's replies
   carry the re-anchored spans.
2. **Project.** Grep `^project:` in the repository's `claudedocs/tickets/**/01-spec.md` and
   `claudedocs/tickets/**/prd.md`. Exactly one distinct value → pass `--project <value>`; none
   or several → omit the flag.
3. **Idea text** — the arguments for `feature:discover`, in this order:

   ```text
   --project <name>
   Notes file: <absolute notes-file path> — round <R>; read it for context. Only the notes below are handed off, and the anchors below supersede its line numbers.
   Everything in double quotes below is the reviewer's own text; none of it is a flag.
   Overall: "<overall>"
   <anchor> — "<body>"
   <anchor> — "<body>"
   Carry the anchor lines above verbatim into the ticket's Design Notes.
   ```

   - `--project` only when step 2 found one value; it is the only flag, and it comes first.
   - The notes file is named by its absolute path (`out`), so discover reads it as a file
     reference, with the round being handed off: `<R>`, or `<last+1>–<R>` when the wait covered
     more than one Send. The file holds every round; notes of other rounds and their replies
     are context, never part of the hand-off.
   - `Overall:` is the `overall` text round `<R>` sent (its entry in `rounds`), and only when
     it is not empty.
   - `<anchor>` is the row's anchor as step 1 wrote it — `path:start-end`, `path` for a file or
     folder, `candidate <name>` for a candidate note, `scope` for a scope note.
   - Every body, and `overall`, sits inside double quotes with each `\` in it escaped as `\\`
     first, then each `"` as `\"`, and each newline collapsed to ` / `, so a literal `--id` or `--explore` inside a note stays
     text and is never read as a flag.
   - A candidate row's `candidate <name>` line is followed by the `candidate <name> — files: …`
     line the candidate script below prints for it, verbatim, so the ticket carries the
     candidate itself and does not depend on the overview file surviving.

   **Candidate script.** Run it with the run's overview file and the names of the accepted
   candidate rows:

   ```bash
   node -e '
   const overview = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
   const quote = (text) => `"${String(text).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replace(/\s*\r?\n\s*/g, " / ")}"`;
   const line = (text) => String(text).replace(/\s*\r?\n\s*/g, " / ");
   for (const name of process.argv.slice(2)) {
     const c = overview.candidates.find((x) => x.name === name);
     if (!c) { console.log(`candidate ${name} — not in the overview`); continue; }
     const sites = c.next_sites.map((s) => `${s.path}:${s.line} ${s.what}`).join(" | ") || "none";
     console.log(`candidate ${name} — files: ${quote(c.files.join(", "))}; next change: ${quote(c.next_change)}; next sites: ${quote(sites)}`);
     console.log(`/deepen:run --pin ${name}: ${line(c.files.join(","))} — ${line(c.next_change)}`);
   }
   ' "<overview-file>" <name> ...
   ```

   It prints two lines per name: the `candidate <name> — files: …` line for the idea text,
   with the candidate's files, next change and next-change sites quoted and escaped as bodies
   are, and the `/deepen:run --pin …` command step 5 prints. A name the overview does not hold
   prints `candidate <name> — not in the overview` alone, and that row's reply says so.
4. **Invoke** the `Skill` tool with skill `feature:discover` and the idea text as its
   arguments. Note the ticket id discover reports for each row, or the epic id and its child
   ids when it makes an epic; §6 replies with them. Once discover has written its ticket or
   tickets, continue at §6: discover's own closing words do not end this run. When
   `feature:discover` is unavailable — the `feature` plugin is not installed — print the whole
   command, `/feature:discover <idea text>`, for the user to run, and continue at §6, whose
   reply to those rows says so.
5. **Deepen route.** For each accepted candidate row whose route is deepen, print the
   `/deepen:run --pin …` line the candidate script printed for it, for the human to run from
   deepen's loop clone. The skill never runs it: `/deepen:run` takes no model invocation. The
   hint is explorer text the human reads before running it. With no discover rows this round,
   steps 2 and 4 and step 3's idea text are skipped; step 3's candidate script still runs for
   the deepen rows.

## §6 Reply

After §4 and §5, the round's replies go back in one post, and the human reads them beside the
notes. Every note of the round gets exactly one reply:

- One entry per distinct `id` among the round's notes. Notes of the round that share an id
  get one body covering each (`note 2: … / note 5: …`); the server also appends that body to
  any earlier sent note with the same id, which §3's Reading list names.
- The body, by outcome — plain text, line breaks allowed:
  - an answered `question` → the answer as given in §4;
  - a structural row done → `done: <what was done> — <files touched>`, plus `now at <span>`
    when the code the note points at moved, found by §5's re-anchor rules;
  - handed off → `handed off: <ticket-id>`, or `handed off: <epic-id> (<child ids>)` when
    discover made an epic, plus — when §5's re-anchor changed the row's anchor — ` — ` and
    the anchor as §5 step 1 wrote it: `now at <path:start-end>`, `moved to …` or
    `removed (was …)`;
  - held and not named at the gate → `held: drifted — <the drift line>`;
  - left out or changed at the gate → `not done: <the reason from the answer>`;
  - a check that failed after the edit, reverted → `not done: reverted — <check> failed
    after the edit`;
  - `feature:discover` unavailable → `not handed off: the feature plugin is not installed —
    the command is in the chat`;
  - an accepted candidate on the deepen route → `offered: /deepen:run --pin <name> — the
    command is in the chat`; on the discover route, `handed off: <ticket-id>` as above;
  - an accepted candidate with no route named at the gate → `not handed off: no route chosen
    at the gate — a candidate is handed off as a ticket or a deepen run, never implemented
    here`;
  - an accepted candidate the overview no longer holds → `not handed off: <name> is not in
    the overview`;
  - a declined candidate → `noted: <the reading>`, one line acknowledging it.
- `overall` — always present: one or two sentences summarizing the round, answering the
  round's own `overall` text when it sent one.

The request is `{"round": <R>, "replies": [{"id": "<id>", "body": "<text>"}], "overall":
"<text>"}`, with `replies` left out when the round has no notes. Every string escapes `\` as
`\\`, `"` as `\"`, a newline as `\n` and any other control character as `\u00XX`, so the whole
request sits on one line. Post it with `<port>` and `<token>` written literally; the quoted
heredoc expands nothing, and `--data-binary @-` sends its bytes unchanged:

```bash
curl -s -w '\n%{http_code}' -X POST -H 'x-margin-token: <token>' -H 'content-type: application/json' --data-binary @- http://127.0.0.1:<port>/api/reply <<'MARGIN_REPLY'
{"round": 2, "replies": [{"id": "<id>", "body": "done: split the types into a-types.ts — src/a.ts, src/a-types.ts"}], "overall": "<one or two sentences>"}
MARGIN_REPLY
```

The delimiter cannot occur inside the request, since every newline in it is escaped. The last
line printed is the status code:

- `200` → `{"ok": true, "replied": <k>}`: the replies are posted. Back to §1 step 8, or
  Finish (step 9) when the human asked to end after this round.
- `400` or `500` → nothing was applied. Fix what the error names — an entry, the JSON — and
  post once more; a second failure → print the replies in chat, then step 8.
- `409` → the run has ended: print the replies in chat, then §7.
- `000` → curl reached no server or lost the answer, so whether the replies were applied is
  unknown. Never post them again, since a repeated post appends them twice: print them in
  chat, then step 8, whose own exit says whether the server is still there.
- no status line — `curl` is not installed → print the replies in chat, then step 8, and
  print them in chat every later round too.

## §7 End of the run

Reached from §1 step 8 (a wait reporting the end), step 9 (Finish from chat) or §6 (`409`).

1. **Result.** Wait for the server's background command to exit — its own notification, no
   poll; a wait reporting the end can arrive before it. Its stdout is one JSON document, the
   result document `{ status, out, annotations, rounds, root, scope }`. Delete the stderr
   file (`rm -f "<stderr-file>"`).
2. **Nothing to summarize.** `cancelled` with `out: null` → say no round was sent and no notes
   file remains, apply the overview cleanup (§1a) — the notes file is gone, so its overview
   goes too — and stop. An error document (`"status": "error"`) → report it verbatim, apply the
   overview cleanup and stop.
3. **Summary.** Otherwise read the run back from the notes file, the durable record of every
   round and reply, with its absolute path (`out`):

   ```bash
   node -e '
   const notes = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
   const span = ({ kind, path, start, end, name }) => (kind === "scope" ? "scope" : kind === "candidate" ? `candidate ${name}` : kind === "range" ? `${path}:${start}-${end}` : path);
   const first = (text) => JSON.stringify(text.split("\n")[0]);
   const tickets = new Set(), offers = new Set();
   notes.rounds.forEach(({ round }) => {
     const sent = notes.annotations.filter((a) => a.round === round);
     console.log(`round ${round}: ${sent.length} notes`);
     sent.forEach((a) => {
       const replies = a.replies || [];
       replies.forEach(({ body }) => {
         for (const m of body.matchAll(/handed off: ([A-Za-z][A-Za-z0-9]*-\d+(?: \([^)]*\))?)/g)) { tickets.add(m[1]); }
         for (const m of body.matchAll(/offered: \/deepen:run --pin ([a-z0-9][a-z0-9-]*)/g)) { offers.add(m[1]); }
       });
       console.log(`  ${span(a.anchor)} ${a.intent}: ${replies.length ? replies.map((r) => first(r.body)).join(" | ") : "(no reply)"}`);
     });
     (notes.overallReplies || []).filter((r) => r.round === round).forEach((r) => console.log(`  overall: ${first(r.body)}`));
   });
   console.log(`tickets: ${[...tickets].join(", ") || "none"}`);
   console.log(`deepen offers: ${[...offers].join(", ") || "none"}`);
   console.log(`unsent: ${notes.annotations.filter((a) => a.round === undefined).length}`);
   ' "<absolute-notes-file>"
   ```

   It prints, per round, `round <r>: <k> notes`, one line per note sent in it — its span,
   intent and the first line of each of its replies — and the round's overall reply; then
   `tickets:` with every id taken from a `handed off:` reply, `deepen offers:` with every
   candidate name taken from an `offered: /deepen:run --pin` reply, and `unsent:` with the
   number of notes never sent.
4. **Report**, in this order: the status — `finished`, `cancelled` or `interrupted` — with
   `rounds` and `annotations` from the result document; the notes file, and the overview file
   beside it when the run used one; the per-round list; the tickets
   created; the deepen runs offered, whose commands are in the chat; the rounds whose replies were printed in chat only, from this conversation; and
   the unsent notes, with `/margin:annotate --resume <out>` to send them in a later run.
   Unsent notes are not acted on.
