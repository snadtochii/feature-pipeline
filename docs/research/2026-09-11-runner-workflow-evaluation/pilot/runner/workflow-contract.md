# Ticket workflow contract

Read at entry and when recording or reviewing a plan change. This contract applies
to new prototype runs; older state requires its original runner or an explicitly
reconciled new run. The helper never upgrades an active run silently.

## Decision rules

Before editing product code, record a plan and obtain independently selected
failure cases. One read-only reviewer can select cases and later review the
implementation; selecting falsification cases is review work, not authoring the
implementation. The main agent remains the sole implementer. Specialists are
conditional on a concrete risk and run one at a time.

**Boundaries:** for a change touching a documented transaction, persistence,
transport, authorization or other project law, cite the authoritative rule and
its current accepted revision. Explain the decision, alternative, consequence,
and a reviewer check that would reject an incorrect implementation. Surface this
record to the user. Mark it `preserved`, `approved_exception` with an actual prior
user-decision reference, or `pending_exception`. Only the last state requires a
new user decision before dependent implementation. Existing authorization remains
valid within its scope; an agent's rationale is not user approval. Reconcile stale
rules with their accepted replacements rather than applying both as conflicting
requirements. Ordinary changes with no boundary impact need only an assessment
explaining that conclusion, not a permission request.

**Reuse:** when adapting/replacing existing behavior, inspect its implementation
and relevant tests. Identify the invariant to retain, not just the component to
import: caller scope, transaction ownership, error certainty, cancellation,
request identity, retry/recovery, resource lifetime or cache ownership as relevant.
Explain which behavior is reused/adapted/replaced and why. A different UI shape can
justify an adapter while retaining the action protocol. New standalone behavior
can use an empty reuse list with a substantive applicability assessment.

**Failure cases:** the independent reviewer first reads the spec, parent rules,
current source and predecessor behavior, and chooses cases that could disprove
compliance. It then reconciles those cases with the plan's decisions and reuse
claims. Prefer intersections (caller × state, cancellation × dispatch, malformed
input × error translation) when relevant. Choose cases proportionate to the
change; avoid a universal matrix for trivial tickets. At least one observable
case is required per implementation ticket. Record selection before product edits
and before accepting the implementer's tests as evidence. A later discovered
risk can add cases through an explicit revision; retain the history and explain
removed/changed obligations for final review.

**Evidence:** every boundary, reuse item and selected case names a required check.
The implementer records the test/assertion or dependency rule enforcing it; the
reviewer assesses its adequacy against actual code and check logs. A dependency
check can establish an architectural rule; a UI snapshot alone cannot establish
cancel/no-dispatch or pending behavior. If an exception cannot be meaningfully
checked, refine the decision before treating it as implementation-ready.

The helper checks structure, coverage, check execution and evidence bindings. It
cannot infer omitted boundaries, verify a cited approval came from the user,
authenticate agent identities, prove that an assertion is meaningful, or guarantee
complete state-space coverage. These remain review responsibilities.

## Plan receipt: `plan REPORT`

Use actual `ticket`, `base`, `tree` and `quality_fingerprint` from `context`.
The initial receipt must precede product edits. Lists are required, even empty.
`checks` optionally adds argv checks to the ticket's manifest gates.

```json
{
  "ticket": "DEMO-1", "base": "BASE", "tree": "TREE",
  "quality_fingerprint": "POLICY",
  "approach": "Implementation sequence and intended observable behavior.",
  "boundary_assessment": "Explain affected project rules or why none are affected.",
  "boundaries": [{
    "id": "transport", "rule": "docs/architecture.md: transport ownership",
    "decision": "Keep request mechanics in the shared transport.",
    "rationale": "Domain-specific errors remain above it.",
    "alternative": "A separate client transport would duplicate those mechanics.",
    "disposition": "preserved",
    "surfaced_to_user": "Reference to the visible decision record/message.",
    "reviewer_check": "Reject a client that bypasses the shared transport.",
    "check": "unit"
  }],
  "reuse_assessment": "The new client adapts the existing transport contract.",
  "reuse": [{
    "id": "client", "source": "src/client.py and its contract tests",
    "choice": "adapt", "invariants": ["Preserve not-dispatched versus uncertain outcomes"],
    "rationale": "The new operation has different result semantics.",
    "reviewer_check": "Pre-dispatch refusal must not be reported as possible execution.",
    "check": "unit"
  }],
  "checks": []
}
```

`approved_exception` additionally requires `approval_reference` citing an actual
user decision, including predecessor approval when applicable. A proposed but
unapproved departure is stored as `pending_exception`; `next` then reports
`decision_required`. The helper blocks work acceptance, checks and final review
until it is resolved. It cannot stop an editor from changing the checkout.

## Independent cases: `challenge-packet`, then `challenge REPORT`

Give the read-only reviewer `challenge-packet` and the selection instructions in
[review.md](review.md). Supply raw requirements and source, without coaching the
expected findings. Save its actual report:

```json
{
  "ticket": "DEMO-1", "base": "BASE", "tree": "TREE",
  "quality_fingerprint": "POLICY", "plan_digest": "FROM PACKET",
  "reviewer": "ACTUAL INDEPENDENT AGENT ID",
  "selection_basis": "Requirements and existing behavior inspected; why these cases matter.",
  "cases": [{
    "id": "request-refused", "invariant": "Failure certainty matches dispatch state.",
    "setup": "Reject locally before the mutation transport is called.",
    "expected": "No transport call and a not-dispatched result.", "check": "unit"
  }],
  "checks": []
}
```

The reviewer can add a required check using `checks` (same argv/name/timeout shape
as the manifest). The main agent runs it. Check names across the manifest, plan
and challenge must be unique. Every obligation must reference one of those gates.
Read-only reviewers select and assess cases; they do not write tests or run them.

## Implementation and final review

`context` lists the canonical `obligations`: `boundary:ID`, `reuse:ID`, `case:ID`.
A work report retains the fields in [quality-policy.md](quality-policy.md), adds
`plan_digest` and `challenge_digest`, and provides exact coverage:

```json
{"behavior_evidence": [
  {"obligation": "case:request-refused", "check": "unit",
   "evidence": "tests/test_client.py::test_local_rejection asserts zero sends and not-dispatched."}
]}
```

Include one entry for every obligation, not just the illustrated case. Before
checks run, describe the actual assertions and mark execution pending in the
acceptance narrative; after successful checks refresh it with their log evidence.
The helper derives the legacy plan prose from the recorded approach.

Final `packet` includes both receipts, their revision history, obligations, work
and logs. Review returns `plan_digest`, `challenge_digest`, `work_digest`, `checks_digest`, plus
one `assessments` entry per obligation: `obligation`, matching `check`, concrete
`evidence`, and `verdict` (`satisfied` or `gap`). A pass requires all satisfied;
a gap accompanies an actionable finding and `changes_required`. Review can still
find issues outside the selected cases. Complete all configured checks on the
reviewed tree; per-case prose cannot waive a failing/missing command.

## Revisions and recovery

When new information changes a boundary or behavior, stop dependent edits and
revise `plan REPORT` with current context and a nonempty `revision_reason`.
The old plan stays in history. A changed plan invalidates case selection, work
and final review, even on the same code tree. The reviewer revisits its cases;
changed `challenge REPORT` also needs `revision_reason` and retains history.
Mid-ticket revisions may inspect changed code and must disclose that timing.
The initial plan/case selection cannot be backfilled after implementation.

Work narrative/coverage changes and changed check receipts invalidate the final
review at the same tree.
Repeated identical reports are idempotent. Check evidence remains reusable only
for the same tree, argv and timeout; `--rerun` handles external environment drift.
Failed commands and capacity shortages remain pending with concrete recovery
conditions. Missing workflow evidence calls for producing that evidence, not a
user question. Human input is required for an unresolved exception, not for a
routine case revision or repair.

Filesystem tickets retain `01-spec.md` and the usual `02`–`06` artifacts. The
adapter publishes the structured plan in `02-plan.md`, case/evidence coverage in
`03-implementation.md`, and final assessments in `04-review.md`; JSON/Git remains
the runner's source of truth. This changes no ticket roster or storage mode.
