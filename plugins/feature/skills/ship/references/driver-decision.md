# Ship — driver decision

Read this file only when ship's [`SKILL.md`](../SKILL.md) SETUP step 2 points here. That happens on a run whose `config.yaml` `test:` block declares `driver` on some entry, flat or `test.repos`, and that was not given `--no-ui-testing`: ship's own `--no-ui-testing` turns every browser pass of the run off, the per-ticket ones included. Without both conditions this file is never read and every per-ticket build runs `flow … --no-ui-testing`.

The decision names the run's **driver tickets**. A driver ticket's per-ticket build drops `--no-ui-testing` (PER TICKET Step 1), so its close stage runs the browser checkpoint through the driver. Every other ticket keeps the flag.

## §1 When it runs

The decision is made once per run, before the first ticket is built, and only on a run that walks serially:

- **No `--parallel`** → at SETUP step 2.
- **`--parallel`** → at SETUP step 4, and only when the whole run takes the serial walk before its first dispatch: step 4's no-`worktree:` degradation outside a multi-lane run, or a solo run ([`parallel-walk.md`](parallel-walk.md) §1).

In every other case it is never made, and every ticket keeps `--no-ui-testing`. That covers a concurrent walk, whose workers cannot each run a pass ([`parallel-walk.md`](parallel-walk.md) §4), a multi-lane run, and a walk that degrades after its first dispatch. In all three, another worker or lane may still be running.

## §2 Driver ticket

For each ticket, apply [`test-preflight.md`](../../close-stage/references/test-preflight.md) [Entry selection](../../close-stage/references/test-preflight.md#entry-selection) to its `repos:` (bound at SETUP step 1) and to the `test:` block. Here read only that subsection and the Browser driver subsection's **Driver location** bullet, never the whole reference.

The ticket is a driver ticket when at least one entry is selected and every selected entry declares `driver: browser-cli`. It is not one when no entry is selected, when the selection mixes driver and MCP entries, or when a `driver` value is unrecognized. An epic run judges each child on its own.

## §3 Driver probe

When at least one ticket is a driver ticket, probe the driver once for the run. This one check replaces a failing pre-flight in every driver ticket's close stage.

1. Resolve `<driver>` per [Browser driver](../../close-stage/references/test-preflight.md#browser-driver)'s Driver location.
2. Run `node '<driver>' doctor` in exactly that form, with no session. Give its shell call the `doctor` timeout from the runtime reference's Tool results section.

Exit 0 with `ok: true` passes. Anything else fails: a denied call, an unusable home directory, a non-zero exit, unparseable output, or `ok: false`. On a failure no ticket is a driver ticket, and the run prints:

`driver probe failed (<denied | the failing doctor fields | the error's first line>) — per-ticket builds keep --no-ui-testing.`

## §4 Record

Record each ticket's driver-ticket result and the probe result in the run's todo. The end-of-run pass reuses both: [`ui-verification.md`](ui-verification.md) step 1 reads the driver-ticket results, and step 5 takes a failed probe as its setup gap without re-running it.
