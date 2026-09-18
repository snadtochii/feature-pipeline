# PR #150: decision-trace audit of three quality concerns

Date: 2026-09-11

Status: evidence-backed initial classification, for discussion. No product code, runner behavior, project rules or ticket states changed. This is a focused audit of three cases, not validation of every finding in the original review.

Related documents:

- [Original review and appended corrections](/Users/serhiinadtochii/Projects/personal-server/claudedocs/analysis/pr-150-codex-quality-review.md)
- [Earlier reflections](2026-09-11-pr-150-runner-reflections.md)

## Result

The three concerns have different origins and need different remedies.

| Case | Applicable rule or requirement | Recorded decision | Observed verification gap | Classification | Proposed prevention | Confidence |
| --- | --- | --- | --- | --- | --- | --- |
| Transactional store composition | Keep persistence swappable; keep SQLite out of controllers/wire contracts; atomically commit domain changes, receipts and inverses | PS-105 explicitly selected an async `AssistantStore` owning a connection, with synchronous concrete domain adapters inside its SQLite implementation | Existing review addressed a schema mismatch, but the saved findings do not establish an assessment of the growing replacement boundary or cross-module dependency direction | **Deliberate design with architectural debt and an ambiguous boundary**, not a proven accidental bypass merely because concrete classes are used | Explicitly define the persistence replacement boundary and transaction owner; review dependency direction before expanding this pattern | High on intentionality; medium on the classification of every dependency as a violation |
| Client transport proliferation | One shared fetch/error-handling boundary was an established documented design; new assistant behavior requires safe uncertainty, bounded parsing and original-ID recovery | PS-105 identified capabilities missing from the old helper and introduced specialized assistant behavior; PS-113 later added another read-only client transport | Assistant behavior has targeted tests; the sampled new status client has no adjacent spec; no saved review finding establishes that shared transport ownership was reconciled | **Justified specialization followed by duplication and drift**; not a defensible blanket demand to use the old helper unchanged | Separate common HTTP mechanics from domain-specific receipt semantics; test both and review exceptions when adding clients | High on the capability mismatch and duplication; medium on the complete intended exception policy |
| B1 retention loop | Cleanup must finish or fail safely before serving; PS-113 explicitly planned bounded cleanup | Repeatedly call `sweep()` until its numeric return becomes zero | Tests cover normal multi-batch cleanup and thrown errors, but not a selected chat whose joined submission is missing; reviews found other expiry problems but not this one | **Implementation defect plus a missing adversarial case**, with an underspecified low-level progress contract | Define progress semantics; detect non-progress; add an orphan-state regression and a safe readiness failure path | High for the conditional non-progress defect; production occurrence and full-boot reproduction not established |

## Method and evidence boundaries

For each case I traced: the behavior, rules that existed at introduction, the plan's rationale, the implementation, and available review/test evidence. A documented agent choice is evidence of intentional implementation, not evidence of explicit user approval. A final review pass is not proof that a particular design trade-off was considered.

Repository inspected: `/Users/serhiinadtochii/Projects/personal-server`, head `875078fefc4f55822153de740c59cd34aa905808` on `integration/PS-103`.

Historical anchors:

- `d19f5e05dfec5b731b419f2be5f01777734250ef`: before PS-103 implementation.
- `eec0612dc3237cb61fbf5ae7b707e2a8efbdf2d3`: combined Phase A implementation checkpoint. Its squash granularity prevents reconstructing individual source-edit timing from commits alone.
- `561329ae98a1cdf44b1347245ffa6d966703fbb0`: final Phase A checkpoint.
- `7af3d78`: ignore-rule preparation before the runner's Phase B work.
- `de1ae7e9891bebfe1ff339b97b9aae730dc17539`: PS-113, introducing the retention implementation and sampled status client.

I read historical files with `git show`, not only current instructions. `git diff d19f5e0 7af3d78 -- AGENTS.md apps/api/CLAUDE.md docs/stack-decision.md` showed no changes to those files over Phase A. The accepted PS-103 brief nevertheless supersedes the old no-auth rule. Historical guidance must be read with that explicit exception; not every old statement remains authoritative.

Local artifact links below are mutable navigation references. Ticket plans/reviews are ignored local records, and I did not reconstruct the full original conversation or authenticate every reviewer spawn. Findings about what reviews considered are limited to the saved reports.

## Case 1 — transactional store composition

### What happened

`InboxCommands` directly constructs `SqliteInboxStore` with a supplied connection and calls synchronous methods. `SqliteAssistantStore` owns the connection and composes ledger, approval and command behavior. There is an async `AssistantStore` interface and a separate `AssistantCommands` interface whose methods do not expose database types.

Sources:

- [InboxCommands](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/assistant/inbox-commands.ts)
- [SqliteAssistantStore](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/assistant/sqlite-assistant-store.ts)
- [AssistantStore port](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/assistant/assistant-store.ts)
- [AssistantCommands interface](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/assistant/assistant-commands.ts)

Therefore “a concrete store is constructed, so the port is decorative” skips a necessary question: is this code inside the intended persistence implementation, or outside it? A persistence adapter may legitimately compose database-specific helpers. A five-line port is also not inherently defective.

The actual maintenance concern is the amount of business behavior and cross-module knowledge inside that database-specific implementation, plus unclear ownership of shared revisions, privacy and lifecycle effects. A future storage implementation would need to replace considerably more than a small set of SQL queries.

### What rule applied

Historical root guidance required persistence behind the `InboxStore` port and no SQLite-specific details in API/contracts. The API guide specifically described not crossing the store boundary into controllers/contracts. The locked stack decision anticipated per-dialect adapters. The accepted epic also required atomic domain changes, results and conditional inverses.

These requirements do not automatically prescribe how a new multi-domain transaction should compose existing stores. They do establish constraints that an extension must explain and preserve.

Historical commands used:

```sh
git show d19f5e0:AGENTS.md
git show d19f5e0:apps/api/CLAUDE.md
git show d19f5e0:docs/stack-decision.md
```

### Was it intentional?

Yes. [PS-105's plan](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/tasks/PS-105/02-plan.md) explicitly says:

- The existing async mutation methods cannot be composed inside the synchronous driver's transaction callback.
- A shared database path is not enough; ledger and domain mutations must use the same connection.
- The async `AssistantStore` owns transaction execution, while its SQLite implementation composes a non-owning `SqliteInboxStore` through synchronous internals.
- Connection ownership prevents a composed store from closing its owner's connection.

The plan labels this an auto-resolved implementation decision. It does not record a user-approved exception abandoning portability. The [implementation report](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/tasks/PS-105/03-implementation.md) likewise presents the async ports as preserved.

### Why did verification accept it?

The available evidence shows deliberate testing of atomicity, rollback, concurrent processes, identity recovery and history cleanup. These are meaningful validations of the chosen transaction design.

The [PS-105 review summary](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/tasks/PS-105/04-review.md) records four role findings. The architecture finding concerned a shared Undo schema/HTTP mismatch. It does not record a finding about the concrete-store composition or a detailed argument about the storage replacement boundary.

That absence does not prove reviewers ignored architecture; it means the saved evidence does not establish that this specific trade-off was evaluated. Existing lint rules primarily enforce package/app boundaries and selected prohibited imports; they do not express ownership boundaries between these API feature directories.

### Classification and remedy

Primary: **deliberate design**. Secondary: **insufficiently explicit architectural boundary and accumulated coupling**. I cannot classify every concrete dependency here as an unambiguous violation of a pre-existing prohibition.

The project decision is: may the entire transactional assistant implementation be database-specific behind one public port, or must domain command behavior remain storage-independent as well?

My proposal is to preserve atomicity and make the replacement boundary explicit first. Then review which domain rules belong outside persistence and which database-specific composition is legitimate. A solution might use a coherent transaction-scoped domain interface, but it should not expose an arbitrary async callback to a synchronous driver or introduce a generic framework simply to hide SQL.

Once that decision is made, enforce the permitted dependency direction mechanically. Require the design evidence to name the transaction owner, rollback boundary, allowed collaborators and code that changes for a new storage engine. This can be an agent-reviewed design checkpoint; it need not become a recurring human permission gate after the project policy is settled.

## Case 2 — specialized transport becoming repeated transport

### What happened

The baseline [http-client.ts](/Users/serhiinadtochii/Projects/personal-server/packages/client/src/http-client.ts) describes one shared fetch/error-handling boundary. Its historical `sendRequest()` mapped fetch rejection to an unavailable error, decoded non-success bodies through an unbounded text read and had no public receipt-identity check, response-size policy or dispatch-certainty contract.

The new [AssistantClient](/Users/serhiinadtochii/Projects/personal-server/packages/client/src/assistant-client.ts) needs more:

- Distinguish invalid input rejected before dispatch from an outcome that cannot be confirmed after possible dispatch.
- Retain original request and operation identities across errors.
- Validate receipt identity, operation order and kind, not only schema shape.
- Bound response decoding and avoid reflecting arbitrary server error content.
- Apply explicit redirect, credential and caching behavior.

The current shared `requestJson` interface cannot simply be substituted unchanged while preserving all these requirements.

However, later clients implement more fetch/status/parse logic separately. [OperationsClient](/Users/serhiinadtochii/Projects/personal-server/packages/client/src/operations-client.ts), introduced by PS-113, is a read-only status client with its own timeout, response-status handling and generic error convention. It reuses `resolveFetch` and `readBoundedJson`, so saying every transport detail is duplicated would also be inaccurate. The remaining duplication is the request/response/error orchestration.

### What rule applied, and what was deliberate?

The baseline helper's source documentation explicitly says fetch/error handling has one home to avoid a second boundary drifting. This is established design intent, though I did not find a root rule literally requiring every client to call a function named `requestJson`.

[PS-105's plan](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/tasks/PS-105/02-plan.md) read the existing helper and explicitly identified the need for uncertainty semantics. It also named shared parsed transport as a pattern. The need for specialization is documented; a deliberate policy permitting repeated transport cores is not established by the inspected records.

[PS-113's plan](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/tasks/PS-113/02-plan.md) requires a typed read-only client and honest unavailable-state presentation, but does not explain why those requirements need another transport implementation.

### Why did verification accept it?

The [assistant client tests](/Users/serhiinadtochii/Projects/personal-server/packages/client/src/assistant-client.spec.ts) cover invalid pre-dispatch input, network and malformed responses, mismatched request/operation/kind, excessive body size, server failure and original-ID recovery. The custom behavior is not untested scaffolding.

For the sampled status client, I found no adjacent `operations-client.spec.ts`. That does not mean the client has no indirect exercise: the broader status/browser verification exists. It means failure behavior at that client interface is not directly covered by a nearby dedicated suite.

The saved PS-105 and PS-113 review findings do not identify shared transport ownership as an issue. Passing browser/API checks cannot establish the absence of duplicated orchestration or consistency across every failure path.

### Classification and remedy

Primary: **a justified specialization that spread into duplication**. Secondary: **drift from documented shared-boundary intent, with an insufficient exception/consolidation policy**.

The remedy is not a blanket replacement with the old `requestJson`. Define a shared transport layer for request options, bounded decoding, cancellation and safe errors, while leaving receipt matching and domain-specific uncertainty in the assistant client. Decide explicitly which differences are policy parameters and which are genuinely separate behaviors.

Acceptance for that refactoring should include malformed/oversized bodies, redirects, network loss, non-success responses, timeout/cancellation and identity retention. A lightweight import/call-site check can discourage new raw transport copies once the shared interface is adequate. Enforcing it before that interface exists would encourage workarounds or regressions.

This is mostly engineering work an agent can carry out. Human judgment is needed only if the project deliberately wants multiple independent transport policies or a compatibility trade-off cannot be inferred from requirements.

## Case 3 — B1 retention progress and startup termination

### Rule and intended design

PS-113's plan explicitly calls for bounded cleanup before serving, periodic cleanup afterward, and no resurrection of expired content. The design deliberately drains batches at startup; that is compatible with the privacy requirement if it terminates or fails safely.

The existing [retention tests](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/operations/retention-store.spec.ts) include more than happy paths: expired approvals, continuation lifetime, older lazy-cleanup state, an injected cleanup failure and draining 105 chats across bounded batches.

### Defect

In [retention-store.ts](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/operations/retention-store.ts):

- `sweep()` selects eligible chats and invokes `expireChat()`.
- Its count includes `chats.length`, irrespective of whether those chats changed.
- `expireBeforeServing()` continues while the returned count is positive.

In [expire-chat.ts](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/chat/expire-chat.ts), a join must find the related submission. If it does not, the function returns without changing the selected chat. The production chat-table definition has no foreign key requiring that submission.

The integer return type `sweep(at): number` does not document whether it means selected rows, changed rows or remaining work. The caller assumes a progress meaning that the implementation does not satisfy for this state.

### Executed verification in this audit

I went beyond the earlier two-query probe and executed the production TypeScript `SqliteRetentionStore.sweep()` and its actual imports. TypeScript was transpiled in memory using the installed compiler; nothing was built or written in the consuming repository.

The final probe used:

- `better-sqlite3` with `:memory:`.
- The literal production `CREATE TABLE assistant_chats` statement from `chat.schema.ts`.
- Empty minimal supporting tables sufficient for the sweep's other queries.
- One expired chat in the valid `completed` state, with UUID-shaped identities and no related submission.
- An empty-database control and two consecutive sweep calls.

Result:

```json
{
  "productionSweepExecuted": true,
  "productionChatDDLUsed": true,
  "state": "completed",
  "sweepReturns": [1, 1],
  "chatUnchanged": true,
  "supportingTables": "minimal empty schemas",
  "fullMigrationOrBoot": false
}
```

The empty-database control returned zero. The orphan row stayed byte-for-byte equivalent at the row-value level while both sweeps returned one. An earlier exploratory probe used a simplified chat schema and a noncanonical state label; the final probe removed those fixture weaknesses and reproduced the same result.

This establishes the conditional non-progress defect in the production sweep implementation. I did not run all migrations or the complete Nest bootstrap, intentionally avoided invoking an infinite loop, and did not establish an ordinary public-API sequence that creates the orphan. The real schema admits it, but its production likelihood and provenance remain separate questions.

### Why did tests and review miss it?

The inspected retention tests create chats through corresponding submission setup. They cover thrown errors and old lifecycle states but do not exercise a selected chat with a missing joined submission. A multi-batch test proves ordinary progress, not progress for every selected state.

The [initial PS-113 review](/Users/serhiinadtochii/.codex/runs/personal-server/PS-103/ps113-review-1.json) found two serious expiry defects: revival of pending operations and retained descendant context. The [follow-up](/Users/serhiinadtochii/.codex/runs/personal-server/PS-103/ps113-review-2.json) accepted their fixes. Neither report identifies this non-progress case. Their broad statements about performance and correctness should not be read as exhaustive proofs.

The reviewer contract prohibited test execution. Allowing isolated probes could improve detection, but does not prove this reviewer would have chosen this particular case.

### Classification and remedy

Primary: **implementation defect violating the intended bounded-cleanup behavior**. Secondary: **a missing adversarial test and an underspecified progress return contract**. No new high-level architectural rule is needed to decide that endless startup is unacceptable.

Recommended repair requirements:

1. Make the sweep result distinguish real progress from unresolved eligible state.
2. Detect non-progress and fail readiness with a content-free diagnostic, or apply an explicitly justified repair/quarantine policy.
3. Do not merely break the loop and expose data whose required cleanup is incomplete.
4. Add a regression using the production schema and actual cleanup boundary for an orphan chat.
5. Preserve existing rollback, multi-batch, tombstone and expiry tests.

The general reviewer improvement is a concrete question: for each loop that drains work, what guarantees that an iteration makes progress or terminates with an error? This is more useful than adding another broad instruction to “check edge cases.”

## What is automatic and what needs judgment?

The agent can gather historical rules, trace calls, inspect plans/reviews, run isolated probes, classify evidence and draft the prevention table. The user does not need to do that legwork manually.

Human confirmation becomes useful where there is a real project-policy choice:

- **Persistence:** should portability mean replacing the whole transactional persistence implementation, or should business command behavior itself be storage-independent? Current records do not settle that distinction clearly enough.
- **Transport:** should new clients share one HTTP mechanism while preserving domain-specific error semantics? That is my recommendation; it follows the existing shared-boundary intent but should be made explicit before enforcing it.
- **Retention:** no policy decision is needed to establish the defect. Choosing repair/quarantine behavior instead of a safe readiness failure could require a domain decision.

These decisions should become durable project guidance once resolved. They should not cause the runner to repeatedly ask for permission on every ticket.

## Consequences for the runner discussion

These cases do not justify one universal remedy:

- The persistence case needs a design boundary and evidence of its consequences.
- The transport case needs a suitable shared interface and checks against renewed drift.
- The retention case needs a corrected progress invariant and a behavioral regression.

Reviewer count is not the common explanation: the deliberate persistence choice passed Phase A's four-role review, and Phase B's single-reviewer loop did find meaningful retention defects. The sampled evidence does not isolate model capability, ticket size or prompt wording as the sole cause.

A future runner improvement could require a short design-impact record for changes to shared transaction/transport/authorization boundaries and independently selected failure cases for high-risk state machines. It should not enforce arbitrary port size, file naming, comment density or numbers of findings.

This audit completes the proposed three-case pilot. Broader findings such as recovery guard ordering, freeze bypasses, snapshot transport and operator/API coupling still need their own decision traces before being assigned the same classifications.
