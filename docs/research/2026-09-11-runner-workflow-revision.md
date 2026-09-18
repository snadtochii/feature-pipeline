# Codex ticket runner: workflow revision and evaluation

Date: 2026-09-11. Scope: the experimental runner in `prototypes/codex-ticket-runner`, with disposable test repositories. Personal Server product repairs remain separate.

The prototype now requires recorded boundary decisions and independently selected failure cases before implementation, followed by evidence for each obligation before a ticket can be committed. The serial runner and filesystem feature-ticket adapter remain in place. This is a tested workflow revision, not evidence that the model will discover every important risk.

## What changed

The main agent still implements one ticket at a time. One read-only reviewer now participates twice: selecting failure cases before code changes, then assessing the implementation and actual check evidence. Selection is review work; the reviewer does not design or author the implementation. A specialist is optional for a concrete risk, rather than a universal additional review layer.

The [skill](../../prototypes/codex-ticket-runner/SKILL.md) loads the new [workflow contract](../../prototypes/codex-ticket-runner/workflow-contract.md). Its sequence is:

`next → plan → challenge-packet → challenge → implement/work → check → packet/review → commit → next → integration → finish`

| Audit failure mechanism | Revised rule | Mechanical enforcement |
| --- | --- | --- |
| A boundary decision silently treated as resolved | Cite the project law, decision, alternative and falsifiable reviewer check; surface the decision. A departure needs an actual user approval reference. Existing approval remains valid within its scope. | A pending exception blocks work acceptance, checks and final review. Missing decision/check fields are rejected. |
| Reuse judged by imports rather than preserved behavior | Inspect the existing implementation and name the scope, transaction, error, lifetime or cache invariants that adaptation must preserve. | Every declared reuse item must identify invariants and a required check, with work evidence and final assessment. |
| Tests inherit the implementation's blind spots | Reviewer selects observable failure cases from requirements and current behavior before product edits, then reconciles the plan. | Initial selection cannot be backfilled after code changes; it must come from a declared non-owner reviewer and bind the recorded plan. |
| Passing commands or prose substitute for acceptance | Tie every boundary, reuse item and selected case to actual assertions and check logs. | Exact obligation coverage is required in work and final review. A passing review cannot contain an obligation gap. |
| Old review survives changed evidence | Reassess after plan, cases, work narrative or executed-check receipts change. | Final review binds their digests as well as the code tree. Reruns preserve previous logs under unique filenames. |

The helper validates declarations, freshness and command results. It cannot detect an omitted boundary, authenticate a claimed user approval or reviewer identity, or decide whether a test assertion is meaningful. Those remain agent/reviewer responsibilities; this is not a tamper-resistant authorization system.

## Skills, tickets and stopping rules

The existing quality policy still selects required implementation skills, review rubrics and check commands. The runner does not automatically add unrelated external skills. Missing required skills require reconciliation. The pilot used only repository guidance and the baseline rubric, so it does not establish that any external skill improves outcomes.

Filesystem feature tickets retain their roster, dependencies, `01-spec.md` and numbered artifacts. The adapter publishes the structured plan into `02-plan.md`, case and implementation evidence into `03-implementation.md`, and final assessments into `04-review.md`. Predecessor boundary decisions are included in subsequent context so accepted decisions can be reused. JSON/Git remains the runner's authoritative resume state. The existing limitations on ignored filesystem storage, exclusive branch ownership and supported delivery modes remain.

Missing evidence calls for producing it, and ordinary failures call for repair. Neither automatically becomes a user question. A genuinely unresolved departure from a project law requires a concrete user decision. Capacity failures keep review pending rather than silently replacing independent review with self-review.

This revision adds a workflow version to new state. Existing states are rejected rather than silently upgraded. An active run needs its original runner or explicit reconciliation into a new run; do not point a running epic at these changed files as an implicit migration.

## Evaluation

### Mechanical tests

There are **58 distinct passing tests across the suite and focused reruns**, not one uninterrupted final 58-test run:

- The initial 47-test suite had 46 passes and one quality-fingerprint failure because this editing task changed a bound workflow document while the suite was running. The gate correctly rejected changed instructions. That exact publication test passed when rerun after files were stable.
- The 21 core and eight quality tests passed in focused runs.
- Eleven new workflow tests passed, including pending exceptions, independent selection, obligation coverage, revision histories, changed command definitions, stale review invalidation, preservation of previous rerun logs and rejection of legacy state.

Python compilation and equivalent YAML/frontmatter/name/link checks passed. The official skill quick-validator could not run because PyYAML was absent in both inspected Python environments; no dependency was installed. That limitation is not counted as a successful official-validator run.

### Known-case replay against Personal Server

Three checks invoked the saved production-source probes using synthetic in-memory fixtures and asserted the desired repaired behavior:

| Case | Observed result | Runner response |
| --- | --- | --- |
| A1: foreign-scope approval preview | Owner preview remained readable; assertion failed. | Required scope check stayed pending. |
| B7: receipt lifecycle | Undo dispatch occurred after unmount; assertion failed. | Required receipt check stayed pending. |
| B8: purge confirmation | First click dispatched the request; assertion failed. | Required purge check stayed pending. |

The runner remained at `verify`, rejected commit, and left fixture HEAD unchanged. This is a **known-case mechanical replay**, using a synthetic reviewer declaration. It demonstrates that supplied checks prevent advancement; it does not demonstrate independent discovery of these bugs. It does not claim coverage of all audited merge gates. Personal Server source was read, not changed, and the probes used no live service or user data.

### New-ticket forward pilot

A separate implementer received a small synthetic ticket to add atomic batch rename to a scoped, cached catalog. It was not given the PR150 findings as expected answers. One independent reviewer selected five cases and later reviewed the resulting patch.

- Two preserved boundaries, one reuse item and five independent cases produced eight obligations.
- Cases covered late batch rejection, foreign/missing scope behavior, cache/order/detachment, invalid containers and existing single-rename compatibility.
- Unit and final integration commands each passed six tests with subcases. Both commands ran the same fixture suite; they are not twelve distinct tests or broad system integration coverage.
- Final review assessed all eight obligations and returned pass with no findings.
- One local ticket commit was created: `adde7dd568f9fc27e9eb858246387f71be3729e7`.
- `finish` returned `complete`; the fixture checkout was clean. No unexpected stops, unnecessary confirmation questions or gate workarounds were reported.

The reviewer disclosed that the initial packet exposed the plan before raw-file inspection. Selection preceded implementation and implementer tests, but was **not blinded to the plan**. The same reviewer context handled selection and final assessment. This is independence from the code author, not two independent reviewers or a fresh-context final review.

The pilot used an immutable runner snapshot taken before the final unique-log-filename/log-digest change. That final change was exercised by the new focused workflow tests; the pilot does not test it. The pilot also does not exercise a real epic, capacity exhaustion, PR delivery or feature-adapter publication. Existing adapter tests provide the publication evidence.

## Interpretation and next use

The revision makes the agreed prevention mechanisms concrete and reviewable without restoring the previous multi-role orchestration. The mechanical replay rejects three supplied real defect cases; the independent pilot establishes that one complete local ticket can pass through the new process without extra human intervention.

Neither result establishes a reduced defect rate, superiority over another coding tool, or reliable operation across a large epic. Models can still omit a boundary, choose weak failure cases, misunderstand requirements or accept inadequate evidence. Incorrect product decisions need decisions, not additional prompt wording. Real browser, authorization and recovery behavior still need appropriate integration checks.

Next, use the revised prototype on one small real ticket after choosing its boundaries and quality policy. Record reviewer findings, escaped defects and unnecessary stops. Keep Personal Server repair work separate, and defer plugin packaging until the revised process has that real-ticket evidence. No plugin installation, feature-pipeline commit, push or Personal Server repair was performed in this revision.

## Evidence

The [evidence index](2026-09-11-runner-workflow-evaluation/README.md) links the test logs, real-case replay, pilot source, reports and completion receipt. [Provenance](2026-09-11-runner-workflow-evaluation/provenance.json) records the Personal Server source HEAD, pilot Git identities and hashes of both the final prototype and copied pilot runtime.
