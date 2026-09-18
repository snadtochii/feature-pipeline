# Codex ticket runner: independent forward test

Date: 2026-09-08. Executor: `/root/prototype_forward_test`.

The experimental skill completed a three-ticket dependency chain in a new disposable consuming repository, including independently reviewed snapshots, one local commit per ticket, a final integration gate, and a successful `finish`. This establishes the small serial local-delivery path; it does not establish production scale, PR delivery, or browser-gate execution.

## Fixture and isolation

- Run directory: `/private/tmp/codex-runner-forward-odyltj05`.
- Code checkout: `/private/tmp/codex-runner-forward-odyltj05/repo`.
- Dedicated branch: `codex/forward-test`.
- Manifest: `/private/tmp/codex-runner-forward-odyltj05/manifest.json`.
- Immutable specs: `/private/tmp/codex-runner-forward-odyltj05/specs/FT-1.md`, `FT-2.md`, `FT-3.md`.
- State: `/private/tmp/codex-runner-forward-odyltj05/state.json`.
- Actual command argv, cwd, exit status, stdout and stderr: `/private/tmp/codex-runner-forward-odyltj05/commands.jsonl`.
- Review packets, reports, commit-message files and evidence are outside the code checkout in the same run directory.

The fixture and synthetic ticket roster were created for this test, not copied from a consuming project or the feature plugin's ticket storage. README and ignore policy were committed as the initial base. Local Git identity was configured only in this disposable repository. There were no installs, remote mutations, pushes, PR posts, goals, deployments, or personal-server changes. This executor did not modify prototype code. The fixture is preserved for inspection.

The higher-priority Codex branch convention selected `codex/forward-test`; explicit task authorization supplied the branch/commit authorization otherwise requested interactively by the git-workflow skill.

## Delivery and acceptance evidence

| Ticket | Dependency | Implemented behavior | Executed gate | Reviewer |
|---|---|---|---|---|
| FT-1 | None | Unicode whitespace normalization; preserves other characters; empty input; rejects non-strings | `python3 -m unittest -v test_text_format`: 3 test methods passed, with multiple edge-case subtests | Pass, fresh context |
| FT-2 | FT-1 | Real CLI, positional input or stdin, explicit empty handling, newline output, help and argument errors | `python3 -m unittest -v test_cli`: 6 subprocess tests passed | Pass, reused context |
| FT-3 | FT-2 | Full HTML5 output, UTF-8 metadata, one pre element, all five required characters escaped, text mode preserved | `python3 -m unittest -v test_html`: 4 subprocess/serialization test methods passed | Pass, reused context |

Final integration command: `python3 -m unittest discover -v`; all 13 tests passed in 0.323 seconds. Its recorded tree is `9b55406e3614ebf6a1a9b2b17cebcf3f7091d57b`; log: `/private/tmp/codex-runner-forward-odyltj05/evidence/epic/9b55406e3614ebf6a1a9b2b17cebcf3f7091d57b/integration.log`.

FT-3 exercises hostile closing tags, script markup, image/onerror markup, ampersands, both quote types, Unicode stdin, empty argument overriding stdin, whitespace-only stdin, and plain-mode regression. Python HTMLParser verifies serialized document structure and recovered text. This is not browser evidence. The manifest was already initialized before supplementary browser capability was proposed; its bound FT-3 spec explicitly scopes acceptance to source and serialization checks. No actual browser test was run by this executor or claimed by its reviewer. The parent executor was given the immutable final fixture for an optional separately reported real-browser check.

## Independent review

Actual reviewer identity: `/root/prototype_forward_test/fixture_reviewer`.

One reviewer was spawned with fresh context for FT-1 and reused through `followup_task` for FT-2 and FT-3. It never authored or designed code, executed tests, mutated Git, or delegated. Each brief supplied absolute packet/spec/patch/repository/review-contract paths and scope without an implementation justification. Product-code edits were paused for review. The reviewer checked actual contents, modes, HEAD, spec digest, and packet tree, including untracked additions. All three reports returned `pass` with no actionable findings; their summaries explicitly distinguish source inspection from executed testing and mark context reuse. Reports are `review-FT-1.json`, `review-FT-2.json`, and `review-FT-3.json` under the run directory. Independence here comes from an actual separate reviewer agent, not an asserted primary-agent self-review.

## Actual command sequence

Every runner invocation used:

```sh
python3 /private/tmp/codex-runner-forward-odyltj05/run.py python3 /Users/serhiinadtochii/Projects/feature-pipeline/prototypes/codex-ticket-runner/runner.py --state /private/tmp/codex-runner-forward-odyltj05/state.json COMMAND
```

The logging wrapper executes each argv at the fixture repo root and preserves its result externally. Initialization used `init --repo /private/tmp/codex-runner-forward-odyltj05/repo --branch codex/forward-test --manifest /private/tmp/codex-runner-forward-odyltj05/manifest.json --owner /root/prototype_forward_test`.

For each ticket the flow was `next`, implementation, `check ftN`, `packet`, independent review, `review /private/tmp/codex-runner-forward-odyltj05/review-FT-N.json`, then commit and immediate `next`. FT-1 committed with `--message 'FT-1: Add Unicode whitespace normalization'`. FT-2 and FT-3 used `--message-file /private/tmp/codex-runner-forward-odyltj05/commit-FT-N.txt`, containing subject and explanatory body. After FT-3, `next` reported `integration_required`; `check integration --final` passed; `finish` returned:

```json
{"outcome":"complete","head":"8e3799c12b4923c1736eadfcc44ec2586e1c057e","pr":null}
```

`git status --porcelain=v1 --branch` showed only `## codex/forward-test`, confirming a clean delivery boundary.

## Commit chain

| Commit | Subject |
|---|---|
| `1b7dd4bf78109322f6a9fef2f86e8c794a2e8e47` | Initialize isolated forward-test fixture |
| `6cf62047140ddd1f64bd6f93b4a063cc2fc19c2f` | FT-1: Add Unicode whitespace normalization |
| `73350d60d801ef1dc4f8c9e1dc33e49b0ba772b9` | FT-2: Add text argument and stdin CLI |
| `8e3799c12b4923c1736eadfcc44ec2586e1c057e` | FT-3: Add escaped HTML output |

The helper staged only each ticket's declared delta. The first two ticket commits became the exact next-ticket bases. FT-2 and FT-3 commit bodies were preserved by the newly added message-file path.

## Observed friction and recovery

1. The original helper rejected a normal multiline commit message with exit 1 and `Use a single-line ticket-prefixed commit subject`. This conflicted with the loaded git-workflow convention to include a body for nontrivial changes. The parent author subsequently added multiline message support and `--message-file`. FT-2 and FT-3 successfully exercised that fix; it is no longer an unresolved limitation.
2. The executor initially batched a dependent write after that rejected commit without inspecting the result first. FT-2 files were consequently created while FT-1 remained current. The helper correctly rejected `check ft2` and `packet` with `Changes outside this ticket's owned paths: cli.py, test_cli.py`. This was an operator sequencing error, not spontaneous helper advancement. Both untracked files were preserved in the external `pending-ft2` directory, FT-1 committed without touching its reviewed snapshot, `next` confirmed FT-2, and the files were restored. All later mutation boundaries were inspected sequentially. No work was lost or wrong-ticket commit created.
3. Packet/reviewer handoff and report persistence are manual agent responsibilities. The helper validates the claimed snapshot mechanics, while truthful reviewer identity and substantive review required the separate agent and observed transcript.

## Remaining limits

This single modest fixture does not establish large-epic durability, realistic consuming-project hooks, crash recovery, full-session/context-compaction resumption, capacity-exhaustion recovery, review findings/fix loops, external dependencies, browser-required gate behavior, server-native storage, or PR delivery. It used one simple dependency chain, no concurrent code writers, and only local commits. The initial observed failure prompted a live helper change, so the successful run spans the original and corrected commit-message implementation; it is not a test of one frozen helper revision. Helper black-box probes and supplementary browser evidence, if available, must be reported separately.
