# The readiness report

Format and rules for `<state_dir>/readiness.md`, the report `deepen:setup` writes after its probe
and refreshes under `--check`. It answers one question before the first run: which of the
loop's checks can this project support, and what would it take to support the rest.

The rows, their order and their `effect if missing` lines come from the capability table in
[profile.md](profile.md) §6 — this file owns only how they are scored and laid out. A run reads
one line of the report, the tier line (§3), through its preflight
([preflight.md](../../run/references/preflight.md) §5).

---

## §1 Status rule

Each row gets exactly one status, decided from the static probe and the user's answers:

- **`found`** — static evidence names the capability: a manifest script, a config file, a route
  file, an env var **name** read by server code or listed in an env example file.
- **`unverified`** — a value the user or the existing profile supplies that the static probe
  cannot confirm: a command the user typed, an env var name no file mentions, a seam auth the
  user declared `none`.
- **`missing`** — neither.

**Combined rows** (dev command and URL, seam and seam auth, fixture seed and reset) are `found`
only when both parts are `found`, `missing` when either part is `missing`, and `unverified`
otherwise. The evidence cell names the part that fell short.

**Evidence** is a repo-relative file path, a script name, a route file or an env var name —
never a value read from an env file, and never a secret. Several entries are sorted and joined
with `; `. A `missing` row's evidence says what was looked for (`no script named like seed or
reset in <manifest>`).

The probe is static: it reads files and runs read-only git commands, and never starts the app.
The report says so once, under its title, so no reader takes `found` for "exercised".

---

## §2 Report block

The file is exactly this block — title, probe date, the static-probe note, the table, the tier
line, the ticket draft:

```markdown
# Deepen readiness — <repo-name>

Probed: <YYYY-MM-DD>

Static probe: files and git only. No row was exercised at runtime.

| capability | status | evidence | effect if missing | what would supply it |
|---|---|---|---|---|
| dev command and URL | found | <manifest> script `dev`; <framework config> port | run cannot start — profile validation fails on app.dev / app.url | one command that serves the app locally, and the address it serves on |
| base branch | found | origin/HEAD → `main` | run cannot start — profile validation fails on base | a default branch on the remote that every change starts from |
| readiness probe | missing | no route file named like health or ready under <routes dir> | readiness probe absent — the run waited for app.url to answer and took the first answer as ready | a route that answers success once the app can serve requests |
| ... | | | | |
| ADR directory | missing | no `docs/adr/` | no ADR filter — candidates are not checked against recorded decisions | a `docs/adr/` directory of recorded architecture decisions |

Tier: browser only

## Ticket draft

<§4 block>
```

- **Rows** — one per row of [profile.md](profile.md) §6, in that table's order, all twelve every
  time. The run-only rows under §6 are not rendered.
- **`effect if missing`** and **`what would supply it`** — copied verbatim from
  [profile.md](profile.md) §6, and shown on every row, so a `found` row still says what it
  protects.
- **Determinism** — fixed row order and sorted evidence entries, so a `--check` diff shows only
  real changes. The probe date sits on its own line: a refresh on a later day that changed
  nothing else shows as a one-line diff.

---

## §3 Tier rule

The tier line is the one line of the report a run reads. Its format is fixed — one of exactly:

```
Tier: tier 2 available
Tier: browser only
Tier: cannot run
```

It is the only line in the file that matches `^Tier: `.

- **`cannot run`** — row 1 (dev command and URL) or row 2 (base branch) is `missing`.
- **`tier 2 available`** — otherwise, when row 4 (seam and seam auth) is `found` or
  `unverified`.
- **`browser only`** — otherwise.

`unverified` counts as present for the tier. Rows 3 and 5–12 never change the tier; each adds
its degradation line to a run instead.

---

## §4 Ticket draft

A ready-to-paste ticket for the project's own tracker, written in the repo's own terms — its
package manager, its script names, its route and directory layout — so the gaps read as ordinary
test-mode infrastructure. It names nothing from this plugin's vocabulary: no "seam", "tier",
"inventory", "profile", "degradation" or "deepen".

```markdown
Title: Test-mode infrastructure for automated behavior checks

Automated behavior checks run this app locally against known data. The gaps below make some
of those checks unavailable or weaker; each criterion closes one.

Acceptance criteria:
- [ ] <one criterion per `missing` row, from its "what would supply it" line, restated with the
      repo's names — for example "a `<package-manager> run <name>` script that loads a fixture
      file into the development database">

To confirm (present, but not verified by a static probe):
- <the row's "what would supply it" line, restated with the repo's names>: <evidence>
```

- One acceptance criterion per `missing` row, in table order. Rows 1 and 2 are criteria like
  any other when missing.
- `unverified` rows go under **To confirm**, never under acceptance criteria. No `unverified`
  row → the **To confirm** list is omitted.
- No `missing` row → the section body is the single line `No gaps — nothing to ticket.`, with
  the **To confirm** list after it when there is one.

---

## §5 Writing and refreshing the report

Both setup modes write the report through this procedure, so a re-run always shows what
changed. It writes nothing but `<state_dir>/readiness.md`.

1. Render the new report per §2–§4 in conversation.
2. Create a scratch directory with `mktemp -d` and `Write` the new report to
   `<scratch>/readiness.md`.
3. In one `Bash` call, with both paths held in shell variables:

   ```bash
   new="<scratch>/readiness.md"; old="<state_dir>/readiness.md"
   if [ -f "$old" ]; then diff -u "$old" "$new" && echo "no changes"; else echo "no previous report"; fi
   mv "$new" "$old" && rmdir "<scratch>"
   ```

4. Print the diff output: the unified diff, `no changes`, or `no previous report`.

A diff that shows only the `Probed:` line means nothing else changed.
