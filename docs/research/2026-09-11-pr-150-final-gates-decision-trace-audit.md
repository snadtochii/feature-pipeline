# PR #150: decision traces for A1, B7 and B8

Date: 2026-09-11

Status: analysis and isolated reproduction, for discussion. No product code, runner, skill, ticket state or Git history changed. The probes below are saved audit artifacts, not installed product tests.

Related: [original review and corrections](/Users/serhiinadtochii/Projects/personal-server/claudedocs/analysis/pr-150-codex-quality-review.md), [first three-case audit](2026-09-11-pr-150-decision-trace-audit.md), and [B2–B5 audit](2026-09-11-pr-150-recovery-decision-trace-audit.md).

## Result

| Finding | Governing evidence | Reproduced behavior | Classification | Consequence for remediation |
| --- | --- | --- | --- | --- |
| A1: preview/decision scope checks | PS-105 plan explicitly lists wrong-scope approval cases; the store interface carries caller scope and adjacent request/receipt paths enforce it | A second synthetic scope reads the owner's preview and identifying task, approves it, or denies the owner's operation. Wrong-scope receipt consumption still fails; execution in the owner's scope accepts the foreign decision | **Implementation defect against an existing isolation contract**, with incomplete scope-path coverage | Check ownership before reading or changing approval/request state; regress preview read, approve and deny independently of receipt consumption |
| B7: receipt action handling | PS-112 says reuse existing preview/decision/Undo controls; accepted brief distinguishes pre-dispatch failure from uncertain execution; existing hook handles lifecycle and targeted invalidation | Opening a preview invalidates unrelated queries; a not-dispatched failure displays uncertainty; an Undo dispatch continues after unmount while registration was pending | **Behavioral drift from an existing action workflow**, plus over-broad cache invalidation | Restore the lifecycle, certainty and recovery invariants, with operation-specific invalidation; do not fix only the query key |
| B8: history purges | PS-112 requires explicit user purge actions, but inspected plan/brief do not specify a second confirmation; baseline destructive dialogs provide a reusable precedent | First click calls each purge client, no confirmation appears, buttons remain enabled while pending, and a second click calls each again | **Missing explicit UX requirement and failure to carry forward an established interaction pattern**, with missing pending-state handling | Apply the user's now-explicit purge-confirmation merge gate; make consequences, cancellation and pending behavior testable |

All three remain actionable. Their evidence and origins differ: A1 violates an already expressed scope invariant; B7 loses existing behavior during reuse; B8 implements the literal “user-initiated purge” requirement without a consequence-confirmation contract. The current user decision to require B8 confirmation is clear; it should not be retroactively presented as wording found in the original ticket.

## Method and evidence boundaries

Repository: `/Users/serhiinadtochii/Projects/personal-server`, HEAD `875078fefc4f55822153de740c59cd34aa905808`, branch `integration/PS-103`. Its working tree was clean before and after the audit. A1 belongs to the Phase A PS-105 foundation; B7 and B8 files were introduced by PS-112 commit `abe6571`. Baseline `d19f5e0` already contains the scoped invalidation guidance and the Project removal confirmation pattern cited below.

I traced current behavior, original plans and accepted source snapshots, existing tests, and saved review reports. Plans and source snapshots under `claudedocs` are local artifacts; selected hashes are preserved. Missing recorded rationale or findings does not prove the agent never thought about the issue.

Evidence:

- [Scope probe](2026-09-11-pr-150-final-gates-evidence/scope.cjs) and [results](2026-09-11-pr-150-final-gates-evidence/scope-results.json).
- [Component probe](2026-09-11-pr-150-final-gates-evidence/ui.cjs) and [results](2026-09-11-pr-150-final-gates-evidence/ui-results.json).
- [Provenance manifest](2026-09-11-pr-150-final-gates-evidence/manifest.json) and [reproduction notes](2026-09-11-pr-150-final-gates-evidence/README.md).

The scope probe ran production `SqliteAssistantStore`, its default `DomainCommands`, real migrations and actual task create/delete operations against in-memory databases. It did not override the approval policy or invent a protected handler. The two trusted local-human scopes are deliberately synthetic; they do not claim the current HTTP application exposes multiple human accounts.

The component probe rendered the actual `ChatReceipt`, `HistoryPage`, shared UI components and context providers using installed React, TanStack Query and JSDOM. Clients were injected through the production providers, as the web guidance permits for tests. It used real cache observers but synthetic client responses, deferred promises and a controlled parent replacement. No HTTP, live browser navigation, user data or external provider was involved. Source was transpiled in memory; no product build output was written. Existing compiled workspace packages were used and hashed.

## A1 — scoped approval consumption does not secure preview access or decisions

### Rule and recorded design

The [AssistantStore interface](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/assistant/assistant-store.ts:14) takes `AssistantContext` with a scope for preview lookup and decisions, as well as registration, execution and result lookup. [PS-105's plan](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/tasks/PS-105/02-plan.md:61) identifies wrong-scope/operation approval handling as an explicit edge case. Its trusted-registration design binds identity and instruction to caller scope. The [accepted API boundary snapshot](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/sources/5573354175.md:44) likewise binds deduplication to trusted caller scope.

There is no recorded design exception saying every trusted human scope may inspect or decide every other scope's approvals. This is not the earlier transaction-composition ambiguity: the API already accepts a scope, and adjacent operations reject mismatches.

### Implementation trace

[getPreview()](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/assistant/sqlite-assistant-store.ts:367) authorizes the context, reads the approval by preview ID, and uses the row's stored scope for expiry handling. It does not compare that scope with the caller's scope before returning the preview.

[decide()](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/assistant/sqlite-assistant-store.ts:315) requires local-human processing, calls that same preview lookup, then reads the approval again inside a transaction. It uses the stored scope to locate and, for denial, update the owner's operation. [SqliteApprovalStore.decide()](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/assistant/sqlite-approval-store.ts:91) receives no caller scope. By contrast, `consume()` explicitly rejects a scope mismatch.

### Reproduction

Two fresh production-store fixtures created a real task and an owner-scoped deletion preview. The other context knew the synthetic preview ID.

| Probe step | Result |
| --- | --- |
| Other scope reads ordinary owner request | `record_unavailable` |
| Other scope reads owner preview | Returned the owner request and identifying task |
| Other scope approves owner preview | `approved`, with an approval receipt |
| Other scope tries to consume that receipt in its own request | `approval_invalid` |
| Owner scope executes its original deletion using the foreign-issued decision | `applied`; task no longer exists |
| Separate fixture: other scope denies owner preview | Owner operation becomes `denied`; task remains |

The final owner execution does not mean the other scope can directly execute arbitrary owner requests. It shows why the consumption check is insufficient: it binds the receipt to the stored request, but does not prove the correct scope authorized its creation. Denial changes the owner's workflow without any receipt consumption at all.

### Present reachability and missed coverage

The current [access service](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/access/access.service.ts:78) issues human callers with ID `human`. The [AssistantController](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/assistant/assistant.controller.ts:30) derives scope from that trusted caller and refuses nonhuman callers. Therefore the demonstrated scope separation is a latent store-boundary defect, not evidence of current multi-account HTTP exploitation or preview-ID enumeration. Knowledge of another preview ID was supplied by the probe.

[approvals-undo.spec.ts](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/assistant/approvals-undo.spec.ts:99) already has a wrong-scope case, but it obtains approval under the owner and tests foreign receipt consumption. It does not exercise foreign `getPreview` or `decide`. This is incomplete coverage of a named invariant, not a total absence of scope tests.

The [four-role PS-105 review](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/tasks/PS-105/04-review.md) found four real issues, including a purge security bug; none of its recorded findings concerns this scope mismatch. Reviewer count does not explain away the missing path.

**Repair contract:** require the caller's scope to own the preview before returning identifying data, invoking owner-specific expiry cleanup, issuing approval or persisting denial. Keep the check inside the relevant transaction for decisions. Verify that a rejected foreign request leaves approval, ledger and payload state unchanged, while same-scope approve/deny/consume/replay behavior continues working. Defining a new error convention is unnecessary if the existing unavailable/invalid conventions can be used consistently.

## B7 — the new receipt wrapper dropped parts of an existing action protocol

### What the plan asked to reuse

[PS-112 plan item 6](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/tasks/PS-112/02-plan.md:7) says to reuse existing exact preview/approve/deny and legal Undo controls. The [accepted chat brief](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/sources/5574978845.md:34) requires preserving the distinction between pre-dispatch failure and uncertain dispatch.

The predecessor [useAssistantCommand](/Users/serhiinadtochii/Projects/personal-server/apps/web/src/features/assistant/use-assistant-command.ts) carries lifecycle checks, a busy ref, request/session identity, phase-aware failure handling and [targeted domain invalidation](/Users/serhiinadtochii/Projects/personal-server/apps/web/src/lib/task-queries.ts:113). Its [tests](/Users/serhiinadtochii/Projects/personal-server/apps/web/src/features/assistant/use-assistant-command.spec.tsx:50) explicitly prevent dispatch when registration completes after unmount, and exercise original-ID recovery for uncertain Undo.

Chat receipts can contain multiple operations, whereas much of that hook's flow is built around one selected operation. It is reasonable to adapt the UI/controller interface rather than blindly reuse a single-operation hook. The plan does not explain why adaptation should discard the same lifecycle and failure invariants. Sharing `ApprovalDialog` and `RequestResult` preserves presentation, but not the action protocol implemented around them.

### B7a: invalidation is broader than the acknowledged effects

[ChatReceipt.act()](/Users/serhiinadtochii/Projects/personal-server/apps/web/src/features/chat/chat-receipt.tsx:27) calls unkeyed `invalidateQueries()` after every successfully completed action, including obtaining an approval preview. The cache probe seeded one unrelated active query and one unrelated inactive query, then clicked the actual preview control.

Observed: one unrelated active refetch; the inactive query became invalidated; its original cached data remained intact. The dialog opened. This confirms the corrected terminology: invalidation does not delete the cache.

The [web guide](/Users/serhiinadtochii/Projects/personal-server/apps/web/CLAUDE.md:34) establishes scoped invalidation for the existing Inbox flow. It is not a literal universal rule prescribing the same key for every new domain, but it and the task helper provide an established alternative to invalidating the entire application. Preview acquisition changes approval/request state; that can justify refreshing those views without refreshing every unrelated query.

**Classification:** over-broad invalidation and missing effect-to-query ownership. The probe establishes cache behavior, not a production latency or request-volume measurement. A fix must refresh request/approval/chat state and actually affected domain lists/details; merely substituting one arbitrary key could leave legitimate views stale.

### B7b: failure certainty is flattened

The component's catch branch treats every error as “Failed to confirm; may have been applied.” The probe injected the real `AssistantTransportError('not_dispatched')` at registration: Undo was never called, but the component displayed that uncertain-execution message.

This is a component contract test, not proof that ordinary valid Undo input currently causes local validation to fail. The distinction still exists in the typed client and is explicitly required by the accepted brief. Registration uncertainty also needs a different explanation from a dispatched domain mutation: losing an instruction-registration acknowledgement is not evidence that Undo ran.

**Classification:** failure-contract regression. Preserve certainty, operation phase and whether any earlier execution remains unresolved. A later failure marked not-dispatched must not erase uncertainty from an earlier dispatched operation. The existing hook contains that distinction; a new wrapper must carry it forward.

### B7c: a pending registration can outlive the component and dispatch Undo

The probe deferred `assistant.register`, clicked Undo, unmounted the actual receipt, and then resolved registration. Recorded order:

```text
register-start → unmounted → recovery-callback → undo-dispatched
```

The earlier hook tests the opposite behavior. This is more than a late React state update: a domain command is initiated after its originating component has disappeared, without the predecessor's lifecycle check. The initial click did authorize Undo; this audit is not alleging a completely unrequested action. The problem is inconsistent cancellation/navigation semantics and loss of the visible controller for subsequent recovery.

For an operation already sent, unmount cannot establish cancellation or rollback. The remediation must distinguish “registration completed, mutation not yet sent” from “mutation sent, outcome unresolved”; it must not pretend an in-flight command can simply be cancelled by leaving the page.

### B7d: recovery selection precedes Undo dispatch

The [Undo handler](/Users/serhiinadtochii/Projects/personal-server/apps/web/src/features/chat/chat-receipt.tsx:106) calls `onRecovery` before awaiting `assistant.undo`. [ChatPage](/Users/serhiinadtochii/Projects/personal-server/apps/web/src/features/chat/chat-page.tsx:304) forwards that to selection, and the [route](/Users/serhiinadtochii/Projects/personal-server/apps/web/src/routes/hermes.tsx) turns selection into navigation. Receipt rendering is keyed by the selected result's request identity.

The controlled-parent probe selected a replacement view at the callback, then rejected Undo with uncertainty. Callback preceded dispatch, and no receipt error remained visible after replacement. This establishes that the component does not own a durable error/recovery presentation across replacement. It does not independently prove the exact scheduling or visible result of the real router and network under every timing.

Selecting the new request early is not intrinsically wrong: retaining the new Undo identity is valuable for recovery. The required contract is that selection, pending execution, failure and same-ID lookup remain coordinated if the old component disappears. Do not fix this by losing the new identity until success, and do not automatically replay Undo after an ambiguous result.

### Why the review/acceptance passed

[PS-112 browser acceptance](/Users/serhiinadtochii/Projects/personal-server/scripts/verify-ps112.mjs:446) executes successful Undo and approval/denial flows and verifies authoritative outcomes. It also exercises lost acknowledgements in the chat-submission flow. Those are useful checks, but they do not establish the receipt wrapper's unmount, not-dispatched and cache-impact behavior. I found no adjacent chat/history component specs in the inspected source tree.

The [initial independent review](/Users/serhiinadtochii/.codex/runs/personal-server/PS-103/ps112-review-1.json) found catalog compatibility, derived-source privacy lineage, missing conversation continuation and missing disclosure indication. Its [follow-up](/Users/serhiinadtochii/.codex/runs/personal-server/PS-103/ps112-review-2.json) passed after repairs. The saved findings do not assess parity between the existing action hook and this new receipt wrapper.

**Repair contract:** treat B7 as an action-state/recovery defect with a cache symptom. Reuse or extract the established lifecycle/identity/failure rules while preserving multi-operation receipts. Add independent cases for pending registration then unmount, pre-dispatch refusal, uncertain dispatch then navigation/recovery, and unrelated-cache stability. A query-key-only patch would leave confirmed behavioral defects behind.

## B8 — one-click history purge was accepted without a confirmation contract

### What is implemented and what it removes

[HistoryPage](/Users/serhiinadtochii/Projects/personal-server/apps/web/src/features/history/history-page.tsx:108) directly awaits request purge in the button's click handler. The [disclosure button](/Users/serhiinadtochii/Projects/personal-server/apps/web/src/features/history/history-page.tsx:177) does the same for metadata. Neither introduces a confirmation step or pending/disabled state.

Request purge is not just removal of a line from this page. The [ledger purge](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/assistant/sqlite-request-ledger.ts:362) erases retained instruction/input/outcome/inverse/approval payloads and references while keeping content-free identity/terminal state; the store also cancels active execution bookkeeping. Disclosure purge deletes the selected audit row. The application offers no Undo for either purge. Removing a request's inverse payload also removes that retained basis for Undo; domain records are not themselves deleted by this history action.

The component probe found the following for both controls:

| State | Request purge | Disclosure purge |
| --- | --- | --- |
| Calls after first click | 1 | 1 |
| Confirmation dialog before dispatch | None | None |
| Button disabled while promise pending | No | No |
| Calls after another click while pending | 2 | 2 |

This proves the UI dispatch behavior with injected clients. It does not execute destructive HTTP against user data. The production clients call DELETE endpoints; source implements idempotent payload clearing/deletion, so repeated calls should not be described as proof of twice the data loss. Duplicate dispatch still creates avoidable requests and overlapping completion/error handling.

### Is it a broken rule or a missing rule?

[PS-112 item 7](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/tasks/PS-112/02-plan.md:8) asks for “explicit user purge actions.” The accepted [API boundary snapshot](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/sources/5573354175.md:28) and [retention decision](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/sources/5531668110.md:42) require user-initiated earlier purge; they do not explicitly prescribe two clicks or a dialog. A clearly labelled purge button satisfies the narrow reading of user initiation.

There was nevertheless a strong existing interaction precedent. The [Inbox delete dialog](/Users/serhiinadtochii/Projects/personal-server/apps/web/src/features/inbox/delete-confirm-dialog.tsx) and baseline [Project removal dialog](/Users/serhiinadtochii/Projects/personal-server/apps/web/src/features/board/manage-projects-dialog.tsx:627) identify the target/consequences, require confirmation, disable controls while pending and retain errors. The reusable dialog's existence is evidence of available design vocabulary, not proof that every destructive action had a written universal mandate to use it.

The crucial verification detail: [PS-112 acceptance](/Users/serhiinadtochii/Projects/personal-server/scripts/verify-ps112.mjs:510) clicks “Purge request payload” once and immediately waits for the purged-state text. It positively accepts the one-click design. No amount of rerunning that test would uncover a missing confirmation requirement; after a fix, it must change to exercise confirmation rather than merely accommodate another click.

**Classification:** missing explicit consequence-confirmation/pending contract, reinforced by implementation-aligned acceptance. No decision rationale or approved exception for omitting the established pattern was found. This is a UX/data-loss protection issue, not an authentication or CSRF bypass: an authenticated deliberate request still goes through the existing API boundary.

The user has now explicitly included purge confirmation in the merge gates. **Repair contract:** first click presents the exact target and the real consequences, including retained payload/Undo effects where applicable; cancel sends no request; confirmation sends one request; repeated activation while pending sends none; failure remains visible and recovery checks the same target. The backend should remain idempotent. Do not require a typed phrase or add a second authorization system unless the product decision calls for one.

## Merge-gate disposition and next implementation contract

The audit does not remove any of the user's six merge gates:

| Gate | Evidence status | Reviewer check that must reject an incorrect repair |
| --- | --- | --- |
| B1 sweep non-progress | Production-method orphan reproduction in first audit | Schema-admitted non-progress cannot keep boot cleanup looping indefinitely; it fails readiness safely and preserves the failure evidence |
| B2 guard ordering | Assembled-app HTTP trace in second audit | Protected ordinary requests authenticate before recovery-state access; active/frozen caller matrix and intended exemptions both hold |
| Filter 400 → 500 | HTTP malformed-input reproduction in second audit | Pre-handler invalid input yields validation semantics, not execution uncertainty; existing 401/403/freeze handling survives |
| A1 scope | Production-store reproduction here | Foreign preview read/approve/deny all fail without changing owner state; valid owner flow and wrong-scope consumption controls still pass |
| B7 receipt actions | Real component/cache reproduction here | Unrelated cache remains untouched, no mutation starts after pre-dispatch unmount, and original/new Undo identity plus phase-aware failure survive recovery/navigation |
| B8 purge confirmation | Real component reproduction here; user has now stated the policy | Opening/cancelling sends nothing, confirmed purge sends once, pending prevents duplicates, and failure/consequences stay visible |

For B7, the final navigation regression should use the real route/query composition; the controlled-parent audit case is not sufficient release evidence for that timing-sensitive behavior. For B1, a bare iteration cap is not the progress contract. For B8, a dialog snapshot without assertions on dispatch/cancellation is not sufficient.

These are ready to become focused repair tickets. They do not require first deciding the larger persistence, frozen-operation inventory, snapshot or offline-recovery boundaries. Those architectural decisions from the earlier audits remain a separate workstream.

The user's addition to exception records applies directly: name a reviewer check that would fail if the exception is wrong. These traces show why “tests passed” cannot fill that field. A1 had the wrong scope test at only one stage; B7 had comparable tests in another controller; B8 had a test affirming the deficient interaction. Review must choose the failure condition independently and then require executable evidence for that condition. Where the concern is architectural dependency direction, that evidence can be a mechanical dependency check rather than an artificial behavioral unit test.

This audit authorizes no code or runner modification by itself. It supplies the classifications, repair contracts and evidence needed for the next implementation batch.
