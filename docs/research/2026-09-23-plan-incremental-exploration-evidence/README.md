# Plan incremental-exploration evidence

Captured on 2026-09-23 for the [plan incremental-exploration note](../2026-09-23-plan-incremental-exploration.md).

- `explorer_reads.py`: the one-off parser. For each run in its `RUNS` table it reads the incremental `code-explorer` child's transcript and the ticket's `01-spec.md`, `02-plan.md` and `exploration.md`, and derives what the explorer read, which of those files `exploration.md` already cited, which new files reached `02-plan.md`, and how the Step 1.2 coverage-and-freshness test would have decided on the spec's named paths. Standard library only; its module docstring is the full contract.
- `results.json`: its output for six runs — FP-109, FP-120, FP-116, and the three FP-84 epic children FP-85, FP-86 and FP-87 from the `measure-session.py` anchor session.
- `verification.json`: the FP-109 replay on the new Step 1.2 rule (the note's §6) — the replay session's per-agent rows copied from `measure-session.py --json`, the decision line, the explorer's tool-call counts, and the cited-file comparison of the replay's `02-plan.md` against the original. Same privacy audit as `results.json`.

## Re-running

From the repo root, with the four session transcripts still under `~/.claude/projects/-Users-serhiinadtochii-Projects-feature-pipeline/`:

```bash
mkdir -p /tmp/fp119-reports
for s in 9f881c61-3955-49f2-8996-f63f451ae33c cf946ddc-c732-4847-97d2-9567a36bc87d \
         13957db5-4e18-419c-b9d0-04e0b52cdc11 012fe8f0-de55-467d-bedd-5746510a34e7; do
  python3 scripts/measure-session.py "$s" --project -Users-serhiinadtochii-Projects-feature-pipeline \
    --json --out "/tmp/fp119-reports/$s.json"
done
python3 docs/research/2026-09-23-plan-incremental-exploration-evidence/explorer_reads.py \
  --reports /tmp/fp119-reports --out docs/research/2026-09-23-plan-incremental-exploration-evidence/results.json
```

`turns`, `weighted_units` and `first_turn_floor` are copied from the `measure-session.py` reports, so the units are that script's weighted input-token equivalents. Without `--reports` the parser still runs and those three fields are absent.

The ticket artifacts are read from `claudedocs/tickets/`, which is gitignored: the parser needs a checkout that still holds those ticket folders, and exits 1 when one is missing.

## What is and is not in `results.json`

Session IDs, agent IDs, repo-relative paths, counts, the explorer's start timestamp, the commit the paths were resolved against, and units. No transcript text, no prompt text, no absolute path, no home directory or username.

## Known limits

- **Paths resolve against main's first-parent history.** `tree_at_run` is the last first-parent commit on `HEAD` before the explorer started. The FP-84 children ran on an integration branch, where a blocker's new files already existed; resolved against main, those files read as `to_create`. That affects FP-86's and FP-87's `to_create` lists, not their read counts.
- **Citations are matched by path suffix.** `flow/SKILL.md:180` resolves to `plugins/feature/skills/flow/SKILL.md`. A short citation that matches several tracked files (`storage-fs.md`) counts as ambiguous and covers nothing, so `reads_already_cited` is a lower bound.
- **Only file paths are items.** Named areas without a path are the half of the Step 1.2 test that needs plan's judgment; the parser does not attempt it.
