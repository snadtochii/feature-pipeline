# Adapter forward test — 2026-09-09

The revised runner completed an isolated two-child filesystem epic through import, quality-bound implementation receipts, independent review, one review-driven repair, two verified ticket commits, final integration, and local finish. The final checkout is clean and the epic and both children are `done`. This is evidence for the ordinary local adapter path, not a claim about unsupported storage modes or recovery cases.

## Retained fixture and protocol

- Consuming repository: [/private/tmp/codex-adapter-forward-20260909-cr36p36v/repo](/private/tmp/codex-adapter-forward-20260909-cr36p36v/repo).
- External run directory: [/private/tmp/codex-adapter-forward-20260909-cr36p36v/run](/private/tmp/codex-adapter-forward-20260909-cr36p36v/run).
- Full runner stdout/stderr, argv and exit statuses: [commands.log](/private/tmp/codex-adapter-forward-20260909-cr36p36v/run/commands.log).
- Final machine-readable assertions and Git output: [final-audit.json](/private/tmp/codex-adapter-forward-20260909-cr36p36v/run/final-audit.json).
- Branch: `codex/DUR-10-duration-report`; owner: `/root/adapter_forward_test`; Python: 3.14.0.
- The initial fixture commit contains only guidance, ignore rules, README, ticket config and a test package marker. Ticket subtrees are ignored in all four state directories. No existing/live project was used as the consumer.

The runner entry skill and its adapter, manifest, quality-policy and review references were read before entry. The runner was invoked by absolute path through an external logging wrapper. No prototype files were edited by this test agent. No Goal, remote Git write, PR, installation, deployment or live-service change occurred. A read-only check of official Python documentation supported the review-driven repair.

The entry sentence “Use an active Goal; create one only when explicitly requested” conflicted with the explicit no-Goal test scope. The parent clarified that a finite normal task was authorized, so the same protocol was executed without a Goal. This was the only interpretation requiring clarification.

The runtime was frozen during execution. `runner.py` SHA-256 at completion was `3179b8b653ff99d70f21f261e5b688c7d219e2969d40fbf4539e748037c70b5b`, matching the starting digest. A [starting digest inventory](/private/tmp/codex-adapter-forward-20260909-cr36p36v/run/prototype-digests.json) and final audit detected concurrent edits to `review.md` and `test_feature_adapter.py` by the parent: the former added an optional instruction about `work_evidence`, which this frozen helper did not supply; the latter adjusted a separate fault-injection test that this fixture never executed. Neither changed this run's required review inputs or helper behavior. Subsequent prototype hardening is outside this trial.

## Fixture and explicit quality profile

The epic uses the current `prd.md` / nested `tasks/ID/01-spec.md` template shape, an authoritative YAML block `children` roster, quoted titles containing colons, dates, tags, child `parent` linkage and explicit `blocked_by` edges.

| Ticket | Scope | Dependency |
| --- | --- | --- |
| DUR-10 | Exact duration reports for Unicode labels | Parent epic |
| DUR-11 | `summarize(records)` library with validation and grouped totals | None |
| DUR-12 | `python3 -m duration_cli`, JSON stdin/stdout and clean errors | DUR-11 |

Parent-only constraints require whitespace trimming plus Unicode casefold, lexically sorted keys, arbitrary integer precision, boolean rejection and no caller-input mutation. Shared exploration specifies `Straße`/`STRASSE`, meaningful record fields, empty input, indexed errors, readable JSON Unicode and the CLI error contract. Child specs reference this context instead of duplicating the constraints.

The [profile](/private/tmp/codex-adapter-forward-20260909-cr36p36v/run/profile.json) explicitly requires:

- [duration-contracts implementation skill](/private/tmp/codex-adapter-forward-20260909-cr36p36v/run/skills/contracts/SKILL.md): every public production function starts its docstring with `Contract:` and documents inputs, output and failure behavior; implementation receipts account for each function.
- [duration-review rubric](/private/tmp/codex-adapter-forward-20260909-cr36p36v/run/duration-review.md), in addition to `runner-baseline`: verify that skill rule, parent constraints, shared validation ownership and observable CLI assertions.
- Global `project-tests`: `python3 -m unittest discover -s tests -v`, explicitly carrying the validation command from consuming guidance/config.
- Ticket-specific `library` and `cli` checks, plus an explicit final `integration` check running the full suite.

Both receipts declare exactly `duration-contracts`; all review reports declare exactly `runner-baseline` and `duration-review`. Final AST inspection confirms the rule is observable in `summarize()` and `main()`. No existing plan was supplied: the agent planned inline and the receipts generated `02-plan.md`.

## Observed execution and review-driven repair

| Boundary | Actual outcome |
| --- | --- |
| `import-feature` | `imported`, roster `[DUR-11, DUR-12]` |
| `init` | `ready`, both children remaining |
| First `next` | `implement`, DUR-11, parent PRD and shared exploration included |
| DUR-11 `work` | `verify` |
| DUR-11 checks | Project tests: 4 passed; library: 4 passed |
| DUR-11 independent review | `pass`; runner returns `commit` |
| DUR-11 commit / immediate `next` | `ready` with DUR-12 / `implement` DUR-12 |
| DUR-12 context | Parent/shared context, predecessor spec, exact DUR-11 commit and all five predecessor result artifact paths |
| Initial DUR-12 checks | Project tests: 8 passed; CLI: 4 passed |
| Initial DUR-12 independent review | `changes_required`; runner keeps review gate pending |
| Regression check before fix | Exit 1; 6 tests, 2 failures |
| Changed-tree `context` | `document`; both checks missing and review no longer current |
| Updated receipt and checks | Project tests: 10 passed; CLI: 6 passed |
| Final DUR-12 independent review | `pass`; runner returns `commit` |
| Last commit / immediate `next` | `integration_required`, remaining `[]` |
| `check integration --final` | Exit 0; 10 tests passed |
| `finish`, then `status` | Both return `complete` with final HEAD and `pr: null` |

Exactly one read-only reviewer was created: `/root/adapter_forward_test/independent_reviewer`, using a fresh context without inherited implementation conversation. It read actual code, patches, specs, parent/shared context, guidance, quality inputs and check logs, and verified snapshots through read-only path/mode/blob comparisons. It did not execute tests or mutate files/Git. Its DUR-11 report explicitly states first context; both DUR-12 reports disclose context reuse. Actual JSON responses are preserved: [DUR-11 pass](/private/tmp/codex-adapter-forward-20260909-cr36p36v/run/review-DUR-11.json), [DUR-12 changes required](/private/tmp/codex-adapter-forward-20260909-cr36p36v/run/review-DUR-12-first.json), [DUR-12 final pass](/private/tmp/codex-adapter-forward-20260909-cr36p36v/run/review-DUR-12-final.json).

The reviewer independently found that a 4301-digit decimal input exceeded Python's default integer-string conversion limit, while two accepted 4300-digit values could sum to a result that failed serialization outside the error handler. This contradicts the parent arbitrary-integer contract despite the original green suite. Python documents both the configurable conversion limit and disabling it with zero. [Python integer conversion documentation](https://docs.python.org/3/library/stdtypes.html#integer-string-conversion-length-limitation).

Two subprocess regressions reproduced the finding before repair. The [actual failing log](/private/tmp/codex-adapter-forward-20260909-cr36p36v/run/evidence/DUR-12/64f547c61a17f82de3a57b16b71fe025f0468b09/cli.log) contains:

```text
AssertionError: 2 != 0 : error: Exceeds the limit (4300 digits) for integer string conversion: value has 4301 digits
AssertionError: 1 != 0 : Traceback (most recent call last):
...
ValueError: Exceeds the limit (4300 digits) for integer string conversion
...
Ran 6 tests in 0.279s
FAILED (failures=2)
```

The fix temporarily removes the CLI process's decimal conversion limit during parsing and serialization, restoring the prior setting in `finally`. Expected large decimal strings in the tests are constructed textually, avoiding the conversion under test in the oracle. The new tree received an updated receipt, both required checks, a new packet and a new independent pass before commit. Final integration recorded:

```text
Ran 10 tests in 0.228s
OK
```

[Full final integration log](/private/tmp/codex-adapter-forward-20260909-cr36p36v/run/evidence/epic/50ab94e43f1810809604a68bd9d08e09b182f46f/integration.log).

## Final inspection

Actual Git history:

```text
ef0d88211a8dffec279677edc72300bcf46853da DUR-12: Add JSON duration report command
a1a19f6f1491023f48d656fbaf5dbdf7e46e9752 DUR-11: Add exact duration aggregation
f923d361d92f9aa7c602cf22bcba833392dd2cb6 DUR-10: Create duration report test fixture
```

The final tree `50ab94e43f1810809604a68bd9d08e09b182f46f` equals the reviewed and final-check tree. `git status --porcelain=v1` returns an empty string. Only `claudedocs/tickets/config.yaml` is tracked under ticket storage; no imported ticket or generated artifact entered either implementation commit.

Before final integration, the last committed child and parent were still `in-progress`, while DUR-11 was `done`. After successful finish, the entire subtree exists only under [done/DUR-10](/private/tmp/codex-adapter-forward-20260909-cr36p36v/repo/claudedocs/tickets/done/DUR-10), with parent and both children `done`. Each child has `02-plan.md` through `06-summary.md`; all result artifacts start with `verdict: pass`, actual reviewer declarations are present, and summaries record the correct individual commit. No artificial browser or four-reviewer evidence was produced.

The final audit compares the original parent PRD, both child specs and shared exploration with the delivered files after normalizing only top-level status lines. All four comparisons pass: titles, metadata, dependency linkage, source bodies and shared context remain intact. Final source inspection confirms that the CLI calls the library's validation/aggregation and that parent-only normalization, ordering and precision rules reach observable output.

The helper required no manual state repair. Small procedural friction remained: receipts need a separate `context` lookup to obtain current tree/policy values; a truthful pre-check receipt retains historical “checks pending” wording even after its separate test artifact passes. This did not block the documented path. Negative import cases, publication recovery, PR delivery, existing done/cancelled children and live UI checks were outside this bounded trial.
