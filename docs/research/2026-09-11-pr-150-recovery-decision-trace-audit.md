# PR #150: decision traces for B2–B5

Date: 2026-09-11

Status: analysis for discussion. Product code, runner behavior, skills, ticket state and Git history have not been changed. The accompanying probe and results are audit evidence, not an installed regression suite.

This continues the [first three-case audit](2026-09-11-pr-150-decision-trace-audit.md) and [runner reflections](2026-09-11-pr-150-runner-reflections.md), using the IDs from the [original review and corrections](/Users/serhiinadtochii/Projects/personal-server/claudedocs/analysis/pr-150-codex-quality-review.md).

## Conclusions

| Finding | Decision provenance | Classification | Evidence and limit | Remedy proposed for discussion |
| --- | --- | --- | --- | --- |
| B2: recovery guard before authentication | PS-114 explicitly chose an HTTP freeze guard; neither inspected plan records a decision to evaluate recovery state before authentication | **Implementation/integration defect**, contrary to the established authentication-first contract; missing combined access/recovery test cases | Real HTTP confirms a recovery-state query before access checks on `/projects`; while frozen, all three tested caller classes get 503 without reaching the access guard. This is not true of every route | Make access ordering explicit; verify caller × recovery-state combinations through the assembled application |
| B3: freeze exemption on Todoist decisions | PS-115 explicitly requires frozen acceptance and rollback; implementation exempts the necessary decision route | **Deliberate exception with an insufficiently explicit policy**, not a demonstrated authentication bypass | Anonymous caller gets 401, assistant 403, authenticated human 201 for valid acceptance; wrong freeze identity gets 409 | Enumerate allowed recovery operations, callers, states and identity preconditions; reject undeclared exemptions |
| B4: whole SQLite snapshot in JSON; GET writes | PS-114 explicitly chooses protected export plus local encryption. The wire representation and GET side effects have no rationale in the inspected plan | **Deliberate architecture with unassessed resource costs and an incomplete operation contract**; not evidence that encrypted backups are missing | Snapshot decodes to SQLite and GET adds a metadata row. Finite size limits exist. No maximum-size memory benchmark or cross-site exploit was performed | Decide transfer/memory budgets and export semantics explicitly; retain operator-owned encryption keys; distinguish export initiation from retrieval and incidental expiry maintenance |
| B5: operator imports API `dist` internals | Offline sealed-target restoration is explicitly planned; consuming private compiled API paths is visible in code but has no recorded boundary exception in the inspected plans | **Architectural boundary debt in a justified offline workflow**; confirmed private-module coupling, not an observed unauthorized mutation of the live source | Restore/reopen import three database transformation functions; rehearsal additionally imports migrations. Source authority is obtained through HTTP; transformation targets a private offline database | Establish a supported offline recovery entry point with a compatibility contract; prohibit arbitrary API-internal imports after deciding that boundary |

Confidence is high in the demonstrated behavior and direct dependencies. Claims about why the agent or reviewer missed them remain inferences from saved artifacts. Absence of a recorded decision is not proof that no reasoning occurred.

## Method and preserved evidence

Inspected repository: `/Users/serhiinadtochii/Projects/personal-server`, branch `integration/PS-103`, HEAD `875078fefc4f55822153de740c59cd34aa905808`. Relevant introduction commits are `bf5fa94` (PS-114 recovery) and `77e204d` (PS-115 Todoist). The authentication-first description already exists at predecessor `de1ae7e`; it is not a new rule invented for this audit.

For each finding I inspected the governing guidance, accepted constraints, ticket plan, implementation, verification scripts and saved review iterations. The HTTP probe uses current source, not a historical checkout. Plans are local ticket records and links remain mutable; selected file hashes are preserved below.

- [Probe source](2026-09-11-pr-150-recovery-evidence/probe.cjs)
- [Observed HTTP results](2026-09-11-pr-150-recovery-evidence/results.json)
- [Source and evidence digest manifest](2026-09-11-pr-150-recovery-evidence/manifest.json)
- [Reproduction notes and limits](2026-09-11-pr-150-recovery-evidence/README.md)

The probe loaded the real `AppModule` and `configureApp`, transpiling API TypeScript in memory with the project's SWC configuration. It used installed dependencies and existing compiled workspace packages, real migrations, a disposable SQLite database, synthetic credentials and an explicitly loopback-bound HTTP server. It did not override providers. Observation wrappers recorded guard/store calls and then invoked the original methods. The fixture was removed on completion. No live database, deployment, external provider or production account was used.

### Observed request matrix

All paths below have the `/api` prefix. The human used an actual issued session; mutation requests included its CSRF proof. The assistant used its restricted bearer token.

| Mode | Request | Anonymous | Assistant | Human |
| --- | --- | --- | --- | --- |
| Active | `GET /projects` | 401 | 403 | 200 |
| Frozen | `GET /projects` | 503 | 503 | 503 |
| Frozen | `GET /recovery/status` | 401 | 403 | 200 |
| Frozen | `GET /todoist-imports/:id/state` | 401 | 403 | 200 |
| Frozen | `POST /todoist-imports/:id/decision`, valid acceptance | 401 | 403 | 201 |

Additional observations: an authenticated decision with the wrong freeze identity returned 409; accepted state was persisted; omission of required `confirmed` returned 500; snapshot export returned 200 and decoded to a SQLite file. This is a selected matrix, not coverage of every route, connector capability, malformed credential or recovery state.

## B2 — recovery-state work precedes authentication

### Contract and implementation

[Assistant access guidance](/Users/serhiinadtochii/Projects/personal-server/docs/assistant-access.md:5) says restricted mode authenticates domain HTTP routes before domain validation. PS-114's [plan items 1–2](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/tasks/PS-114/02-plan.md:2) require reuse of scoped human authentication and a guard that freezes normal reads, writes and processing. Those requirements can coexist; the plan does not authorize moving domain recovery-state work ahead of access checks.

[AppModule](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/app.module.ts:28) imports `RecoveryModule` before `AccessModule`. Both register global guards. [RecoveryGuard](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/recovery/recovery.module.ts:67) exempts recovery metadata and access bootstrap capabilities; otherwise it reads the store's mode and throws when it is not active.

The assembled-application probe establishes the actual order on `/projects`:

```text
Active: recovery guard → recovery status query → access guard
Frozen: recovery guard → recovery status query → 503
```

This confirms the finding beyond an inference from import order. While frozen, the anonymous request is rejected before authentication runs. The observed consequences are pre-authentication database work and disclosure of frozen availability through the response distinction. The probe does not demonstrate disclosure of personal records or quantify a denial-of-service impact.

The original phrase “every anonymous request” is too broad. Recovery routes and bootstrap capabilities take the exemption branch; unknown routes and other routing behavior were not exhaustively probed. The stale statement that no global guard exists is also not a valid reason to reject the implementation: the accepted auth design already introduced one.

### Why the checks did not establish this invariant

[PS-114 verification](/Users/serhiinadtochii/Projects/personal-server/scripts/verify-ps114.mjs) tests denied recovery access and blocked normal operations while frozen. Those checks do not establish the combined expectation “an anonymous normal request is authenticated before consulting freeze state.” The saved [initial independent review](/Users/serhiinadtochii/.codex/runs/personal-server/PS-103/ps114-review-1.json) found three real restore problems—Undo evidence, privacy lineage and obsolete submission bindings—but no guard-order finding. Its [follow-up](/Users/serhiinadtochii/.codex/runs/personal-server/PS-103/ps114-review-2.json) passed after repairs.

The implementation report also records adapting legacy controller fixtures to share a migrated recovery store. Fixture churn demonstrates a new global dependency; by itself it does not prove the global guard is architecturally wrong. Tests that override a store also cannot substitute for verifying assembled guard order.

**Classification:** the guard was deliberate; the ordering defect is not recorded as an approved trade-off. Correct the ordering in the application and protect it with a small real-application access/recovery matrix. A prompt saying “review security” or adding another reviewer does not mechanically enforce the order.

## B3 — necessary frozen operations lack an explicit exception policy

### What is exempt today

The metadata is discoverable in source, but it is a boolean exemption, not an operation policy. Current holders are:

- The entire [RecoveryController](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/recovery/recovery.module.ts:28): status, freeze, resume, snapshot, evidence and backup-status. Future handlers on this class inherit the exemption.
- Four [Todoist handlers](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/todoist/todoist.module.ts:41): receipt, state, decision and changes. The import handler is not exempt.
- Separately, the guard exempts the access `status` and `session-create` capabilities.

Calling this a freeze bypass describes the guard branch, but does not establish an authentication bypass. Both controllers require human access. The real HTTP results show those restrictions remain in effect on the sampled exempt routes.

### Why a mutating decision exists while frozen

[PS-115 plan item 7](/Users/serhiinadtochii/Projects/personal-server/claudedocs/tickets/review/PS-103/tasks/PS-115/02-plan.md) explicitly requires freeze, candidate review, acceptance and guarded rollback. Forbidding every mutation while frozen would also forbid advancing the recovery workflow itself. The useful invariant is that ordinary domain activity is frozen while specifically authorized recovery operations remain possible.

[SqliteTodoistStore.decide](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/todoist/sqlite-todoist-store.ts:55) validates the decision schema, uses an immediate transaction, and checks the current import fingerprint, frozen mode and matching freeze identity. Acceptance rejects incompatible state or intervening changes. Abandonment has additional restored-state/evidence and empty-target conditions. The probe confirmed human acceptance succeeds under the valid freeze and a different freeze identity fails with 409; it did not independently execute every abandonment branch.

The [first PS-115 review](/Users/serhiinadtochii/.codex/runs/personal-server/PS-103/ps115-review-1.json) explicitly required a guarded abandoned-candidate replacement path. Therefore some of this complexity follows from catching a real missing recovery transition. Later review rounds found a cloned-fixture exposure problem and interrupted-backup recovery problems. The reviews were substantive; their saved findings do not establish an assessment of the exemption policy as a whole.

**Classification:** deliberate workflow exception with missing explicit policy. Retain the need for authenticated control operations. Define a finite inventory of operations, permitted callers, recovery states, freeze/installation identities and allowed effects; test undeclared additions as well as the permitted paths. Merely banning the decorator on every POST would break the accepted workflow. No unauthorized frozen mutation was demonstrated on the route tested.

## B4 — separate snapshot transport, encryption and GET effects

### Encryption placement is an explicit design

PS-114's plan puts encryption, local keys, archive rotation and restore orchestration in operator tooling, with protected server-owned database export. The [runbook](/Users/serhiinadtochii/Projects/personal-server/docs/assistant-recovery.md:51) explains that split and the 128 MiB database limit. [captureArchive](/Users/serhiinadtochii/Projects/personal-server/scripts/recovery/archive.mjs:163) validates the snapshot, builds the archive body, and encrypts it using AES-256-GCM with an external key.

The probe confirmed that the API's base64 content itself is a SQLite image. That fact does not disprove encrypted backups: encryption occurs at the planned operator boundary. Moving the recovery key into the API merely to make its response encrypted would change that boundary. This audit did not reassess the cryptography or deployment transport protection.

### The transfer is size-limited, but fully materialized

[snapshot()](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/recovery/sqlite-recovery-store.ts:73) makes a SQLite backup, checks its size and integrity, reads the whole file, encodes it as base64, and returns it in JSON. It has an export-in-progress guard and a backup deadline. A size check after the backup does not prevent the temporary backup file from first exceeding the response limit.

[RecoveryClient](/Users/serhiinadtochii/Projects/personal-server/packages/client/src/recovery-client.ts:59) enforces a response-byte limit but retains every chunk, copies them into a contiguous array, decodes text and parses JSON. The operator subsequently decodes the snapshot and creates another archive representation before encryption. These are multiple materialization stages; their exact simultaneous memory cost has not been measured.

A 128 MiB raw image becomes 178,956,972 base64 characters, about 170.7 MiB of ASCII content before JSON overhead. “Bounded” is therefore true as a size ceiling, but does not mean streaming memory use. The small fixture produced 602,112 raw bytes and 802,816 base64 characters. It cannot establish performance at the maximum or under concurrent operator activity.

The inspected plan does not explain why this wire format fits an agreed memory or latency budget. **Classification:** a deliberate format choice with missing resource-budget evidence, not a reproduced out-of-memory failure. Decide supported database size, concurrency, memory and timeout budgets; then compare a streamed binary export with the current design. Streaming only the HTTP response would not resolve all later archive buffering.

One factual refinement to the previous transport discussion: this recovery client imports `resolveFetch`, but implements its own bounded reader rather than importing `readBoundedJson`. Reuse varies by client. The broader conclusion—shared mechanics with explicit domain-specific policy—still applies.

### GET effects need an operation-level decision

The probe counted `recovery_snapshots` before and after `GET /recovery/snapshot`: the request added one metadata row. Source inspection additionally shows snapshot and evidence retrieval invoke expiry maintenance; this probe did not seed expired rows to demonstrate those deletions. The earlier review's separate chat-GET claim is not independently retraced here.

The [session access implementation](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/access/access.service.ts:146) enforces a synchronizer CSRF proof for methods other than GET/HEAD/OPTIONS, while retaining Host/Origin/site checks for all session requests. Thus a GET doing export work and durable bookkeeping takes a different request-proof path from explicit mutations. This is a contract mismatch worth deciding; it is not evidence of an exploitable cross-site request on its own.

Not every incidental write automatically makes a read endpoint invalid: logging or expiry enforcement can accompany retrieval. The decisions are which effects are incidental, whether creating an export is an explicit command, how retries/prefetches affect it, and what proof its invocation requires. A possible remedy is authenticated export initiation with the mutation proof, followed by retrieval of a defined result. Expiry-before-disclosure must remain enforced whichever design is chosen.

## B5 — private API imports implement a planned offline recovery boundary

### Confirmed coupling

[operator.mjs](/Users/serhiinadtochii/Projects/personal-server/scripts/recovery/operator.mjs:18) requires `apps/api/dist/src/recovery/restore-database.js`. Restore uses `sealSnapshot` and `sanitizeRestoredDatabase`; reopen uses `releaseRestoredDatabase`. [Todoist rehearsal](/Users/serhiinadtochii/Projects/personal-server/scripts/todoist/rehearsal.mjs:118) uses the same functions and imports compiled migrations to inspect the restored fixture directly.

These scripts depend on an API output-directory layout and internal functions instead of a declared public entry point. The restore implementation in turn knows many feature tables, policies and identity rules. This reinforces the earlier concern about who owns cross-domain persistence behavior.

However, the called functions operate on a newly extracted private target. The current source is frozen and supplies authority/evidence through authenticated HTTP. Restore returns a sealed report; reopening validates current source evidence and explicit reconciliation, and does not itself deploy the target. This is different from a client secretly editing the live server database.

### Rule and plan conflict

The [root law](/Users/serhiinadtochii/Projects/personal-server/AGENTS.md:50) puts file-touching work in clients that call HTTP and confines the server to its own volume. The accepted recovery plan also requires a private offline target to be sanitized before it can serve. A normal running API cannot be assumed to exist on that target yet. PS-114 therefore creates a real architectural question: what supported surface owns offline database transformation?

The plan authorizes offline restoration in substance. It does not record an exception allowing operator code to consume arbitrary private API build paths. PS-115 additionally promises recovery exercises through real public boundaries, which does not describe the direct compiled helper imports. The defensible finding is private-module coupling and an unresolved public boundary, rather than claiming all offline database work was forbidden.

The migration workflow includes source/build fingerprints and compatibility checks; [runtime-build.mjs](/Users/serhiinadtochii/Projects/personal-server/scripts/recovery/runtime-build.mjs) hashes compiled runtime material. Those measures reduce some artifact mismatch risks. They do not turn internal filesystem paths into a stable supported interface, and this audit does not claim every operator path has identical fingerprint enforcement.

### Verification and remedy

Tests and operator acceptance exercise real restore transformations, including privacy and identity cases. The PS-114 reviewer directly found defects inside this implementation. The saved findings do not address whether those functions should be a public offline API or private server code. A test passing through the same private import demonstrates functionality, not acceptable dependency direction.

**Classification:** confirmed architectural debt in a justified offline workflow. Decide whether recovery is a supported package or a documented operator entry point distributed with a compatible runtime. Give it a narrow contract for snapshot/schema compatibility, evidence validation, sealing, sanitization and release. Keep offline targets inaccessible until those checks pass. Once chosen, enforce that scripts cannot reach arbitrary `apps/api/dist/src` paths.

Forcing these transformations through ordinary live HTTP merely to satisfy a literal boundary slogan could undermine the offline-restoration requirement. The boundary needs an explicit project decision, followed by code enforcement; another wrapper around the same private paths would not settle ownership.

## Additional confirmed defect encountered: validation becomes uncertainty

An authenticated Todoist decision omitting required `confirmed` returned **500**, not a validation response. The valid decision succeeded and the wrong-freeze decision returned 409, so this was not a general fixture authentication failure.

[ZodValidationPipe](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/common/zod-validation.pipe.ts:42) throws `BadRequestException` for invalid input. The controller's [AssistantHttpFilter](/Users/serhiinadtochii/Projects/personal-server/apps/api/src/assistant/assistant-http.filter.ts:11) preserves selected domain errors, HTTP 401/403 and recovery freeze errors, but an HTTP 400 falls into its default 500 `execution_uncertain` / `lookup_same_request` response.

That is a concrete validation/filter integration defect: input rejected before the handler is represented as uncertain execution. It supports a narrower version of the original generic-error concern; it does not mean every error becomes 500. A focused invalid-input request through the real controller/filter boundary would catch it. No fix was made.

## What this changes about the runner discussion

These traces reinforce three distinct prevention mechanisms:

1. **Explicit design decisions for changed boundaries.** Store replacement, shared transport, freeze authority and offline restore ownership cannot be settled by declaring a ticket complete. A reviewer needs the intended boundary and the proposed exception, not just the implementation's explanation of itself.
2. **Independently selected failure cases across features.** Combine existing auth with new freeze state; combine malformed input with the real exception filter; combine restored state with current identities. These cases expose defects that isolated happy-path or same-assumption tests can miss.
3. **Mechanical enforcement after policy is decided.** Enforce dependency direction and exemption inventories; use application-level regressions for ordering and error translation. Mechanically asserting today's undecided architecture could preserve the wrong design.

The saved PS-114 review found three substantive issues; PS-115 found five finding entries over three repair rounds before passing. Neither “there were no reviewers” nor “one reviewer cannot catch hard bugs” fits those records. What remains unproven is whether a different prompt, skill or reviewer count would have caught these particular omissions.

The user's requested addition is recorded as the direction for a future runner revision: **auto-resolved plan decisions touching a documented monorepo law must surface explicitly to the user rather than silently creating an exception.** This has not been implemented in the runner or skill.

For a concrete proposal, the plan should identify the law and its current authoritative revision; show the affected transaction, transport or authorization boundary; explain the proposed design, alternative and consequence; and state whether an exception is being requested or an existing approval already covers it. An agent rationale is not approval. A departure requiring a new exception must be resolved before dependent implementation. Already approved exceptions should remain attached to subsequent tickets so the same decision is not repeatedly reopened. A stale superseded rule should be reconciled with its accepted replacement, as the no-auth/global-guard example demonstrates.

Skills can make this evidence mandatory and help choose better checks. A runner can refuse completion when the required evidence is absent. Neither can guarantee correct architecture, complete state-space coverage or sound interpretation of a rule. The remaining human decisions are the boundaries and exceptions themselves, and the operational resource budgets—not manual reconstruction of every code trace. This audit demonstrates that the tracing and targeted reproduction can be done by the agent before those decisions are requested.
