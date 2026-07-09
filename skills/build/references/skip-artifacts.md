# Build — skip-artifact templates (`05-tests.md`)

Read this file only when the test checkpoint is writing a skip artifact (SKILL.md §3 step c) — a run reaches at most one of these variants, most reach none. Each body below is written verbatim to `<ticket-folder>/05-tests.md`, with one `- [ ] AC <n> — …` line per acceptance criterion in the ticket's spec.

## No UI signals in the plan (skip-detection scan found nothing)

```
verdict: skipped (no UI work in plan)

## Reason
Keyword scan of 02-plan.md found no UI signals (component, page, route, screen, form, tsx, jsx, html, view, widget, composable, layout, template, partial).

## Acceptance Criteria
- [ ] AC 1 — not-tested (no UI)
- [ ] AC 2 — not-tested (no UI)
...
```

## Forced by `--no-ui-testing` (the plan may well have UI work — browser verification is deferred, not absent)

```
verdict: skipped (UI testing disabled by --no-ui-testing)

## Reason
Browser/UI verification skipped by the --no-ui-testing flag. Non-browser checks (lint/typecheck) still ran in the implement checkpoint and still gated this verdict. Browser-level acceptance-criteria verification is deferred to human review of the PR.

## Acceptance Criteria
- [ ] AC 1 — not-verified (browser testing skipped by flag)
- [ ] AC 2 — not-verified (browser testing skipped by flag)
...
```

## App unreachable (the reachability pre-flight could not reach or boot the app)

The body for this variant lives in [`test-preflight.md`](test-preflight.md) §6, beside the pre-flight that produces it — write it as prescribed there.
