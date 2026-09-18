# Proposed Big Leaves runner profile

Inspection date: 2026-09-09. Recommendation only: no Big Leaves code, tickets,
branches, environments or runner state were changed. Package scripts, guidance,
test configuration and local Git state were inspected. Admin Playwright test
discovery was run; builds and tests were not executed. GitHub PR state was not
queried, so ticket statuses below are local metadata, not verified merge status.

## Recommendation

Use one workspace policy and four repository profiles. Start with one refined,
single-repository Admin ticket. Keep implementation in the main agent and use
one independent read-only reviewer for both requirements and maintainability.
Use an additional serial specialist only for a concrete security or integration
risk. Do not invoke feature:flow/build or a multi-agent review wrapper inside
the runner.

The current prototype cannot directly import this workspace. Big Leaves has no
root Git repository. Its four sibling repositories share tickets at
`/Users/serhiinadtochii/Projects/big-leaves/claudedocs/tickets`. The adapter requires
`<git-root>/claudedocs/tickets` inside its single code repository. It also binds
completion and prerequisite commit evidence to one repository. An external
ticket-root option alone would not support an epic spanning several repositories.

Do not move shared tickets, introduce a root Git repository or symlink the
tickets into a component to satisfy this assumption. A manual manifest can run
one repository with immutable external spec/context copies, but it does not
publish feature ticket status/artifacts. Label that as a separate pilot, not
full workspace support.

## Common policy

- Inputs: root `AGENTS.md`, the selected repository's authoritative guidance,
  accepted ticket, parent PRD and relevant ADRs. Resolve explicit open decisions
  before entry. Snapshot these inputs outside the checkout for both implementer
  and reviewer.
- Scope: one clean, exclusive branch per participating repository, from an
  explicitly selected base containing verified prerequisites. No automatic
  adoption of unrelated dirty files or open-review work.
- Implementation: plan inline, implement, run applicable checks, review, fix,
  rerun invalidated checks and review, then commit. A receipt identifies actual
  acceptance evidence; a successful command is insufficient if it selected the
  wrong tests or exercised a stale server.
- Review: mandatory runner baseline plus repository conventions, acceptance
  criteria, error paths, meaningful test coverage, existing abstractions and
  cross-repository contracts. Review the actual tree and command logs.
- Git: apply the installed `git-workflow` skill, uppercase BL identifiers,
  2–5-word branch slug and a commit body. Establish scope, branch and commit
  authorization before the unattended run; the skill's confirmation language
  must not become a surprise per-ticket gate. Setting a JSON flag is not consent.
- Delivery: local commits for the pilot; PR delivery when requested. For a
  multi-repository epic, each changed repository needs its own PR and evidence.
  Deployment, live DB changes and external service operations are separate from
  implementation completion.
- Checks must not format source or regenerate shared types. Such edits belong
  before validation and invalidate the previous review/check evidence.

## Repository profiles

Commands below run in the named repository unless another directory is stated.
Timeouts are initial suggestions, not measured runtimes.

| Profile | Implementation/review sources | Per-ticket checks | Final integration |
| --- | --- | --- | --- |
| Admin | `big-leaves-admin/CLAUDE.md`, relevant `docs/adr/`, installed `angular-developer`; baseline reviewer | `npm run lint`, `npm run test:ci`, `npm run build`; focused browser acceptance for UI tickets | Same three checks on final tree; applicable desktop/mobile browser flows |
| Storefront | `big-leaves-astro/CLAUDE.md` and `.cursorrules`, resolving conflicts against workspace rules and actual configuration | `npm run build`; selected Playwright specs with one worker and list reporter | Vercel build plus Node build/browser suite; both configurations when integration changes |
| Go API | `big-leaves-api/CLAUDE.md`; baseline plus authentication, idempotency and external-client error handling | `go vet ./...`, `go test ./...`, `go build ./...` | Same, with `go test -race ./...` as the proposed additional concurrency gate |
| DB / Edge Functions | `big-leaves-db/CLAUDE.md`, migration/RLS/role contracts and ticket constraints | Edge code: `deno task verify` from `supabase/functions`; SQL: ticket-specific migration and role/behaviour verification | Relevant schema/ACL acceptance plus compatibility with generated app types; Deno checks alone do not validate SQL |

Suggested timeout: 600 seconds for lint/build/vet, 900 for Admin/API unit tests,
1200 for targeted browser or Deno verification, 3600 for the Storefront final
browser suite. Storefront's current Playwright global timeout is 50 minutes;
the runner's default 120 seconds is unsuitable.

Admin quality fields and final checks are provided in
[big-leaves-admin-quality.json](2026-09-09-big-leaves-admin-quality.json).
This is a reusable fragment, not an importable profile: add a real refined
ticket roster, owned paths, acceptance checks and authorized delivery settings.
It deliberately grants no commit/push permission.

### Skill choices

Use `angular-developer` for Admin implementation, with existing typed reactive
forms and repo ADRs taking precedence over generic new-form preferences. Its
build requirement is included in the suggested checks.

Do not enable the installed `test-writer` / `test-verifier` wholesale. Their
BEN/Sparkz conventions include `@ngneat/falso`, which Admin does not declare,
and blanket class-only assertions; Admin has its own detailed zoneless Vitest
and overlay testing rules. Keep those local rules authoritative rather than
adding dependencies to satisfy an unrelated checklist.

Matt Pocock's `codebase-design` is a useful optional design/review reference for
domain-logic or abstraction changes. It is unnecessary for a vocabulary ticket.
Use it as reference material for the existing reviewer, without launching its
optional design exploration workflow. TDD is appropriate when a behavioural
regression merits a failing test first; it need not be a mandatory workflow for
every copy or layout edit.

### Browser and environment gates

Admin E2E uses dev Supabase and seeded fixtures. Preserve its URL guard and
current-build server requirement; do not reuse an unknown server on port 4200.
Use `--reporter=list` and a serial worker for shared fixture writes. Required
env/fixtures must be ready before claiming the run is unattended.

Admin's actual configured sizes include compact 1280×800, desktop 1440×900 and
mobile 390×844. Guidance also asks for 1920×1080 inspection; that size is not
covered by the configured desktop project. Retain the 1440 breakpoint test and
add/perform large-desktop acceptance where required. Mobile applies to the
documented dashboard, Orders, Payments and new-order surfaces, not every page.

Storefront has no configured lint/typecheck scripts or unit runner. Do not
invent `npm run lint`, `npm run typecheck` or `npm run test:ci` gates for it.
Use existing Playwright helpers for Qwik first-interaction waits and mock
checkout/shipping/email boundaries. Tests build the Node target locally through
`npm run preview`; with `CI` set the config previews an existing build instead.
Use a fresh matching build/server and `--workers=1 --reporter=list` explicitly.

DB scripts `types:gen` and `types:gen:local` both invoke `types:sync`, which writes
into Admin and Storefront. They cannot be treated as read-only checks for a
single-repository run. The current helper has no check `cwd` field; Deno checks
need an explicit wrapper for the functions directory, not an ignored invented
configuration key.

## Concrete findings before a pilot

1. **Admin test selection gap.** `playwright.config.ts` matches
   `simple-order-line.spec.ts`, but the existing file is
   `e2e/goods-order-line.spec.ts`. Running
   `npm run test:e2e -- --list --reporter=list` selected 22 tests in 12 files and
   none from the goods-line spec. Fix selection and verify discovery before
   relying on this suite for BL-289-related acceptance. This was not fixed here.
2. **Guidance conflicts.** Storefront `.cursorrules` both prohibits and recommends
   `@apply`, and includes Tailwind integration guidance inconsistent with the
   actual v4 Vite setup. Workspace guidance explicitly prohibits `@apply`.
   Storefront CLAUDE.md also says CI retries, while config sets `retries: 0`.
   Clarify these before freezing policy inputs.
3. **Current branches need deliberate selection.** Admin is clean on
   `feature/BL-289-simple-order-lines`; API is clean on `main`. Storefront is on
   `main` with modified `src/types/database.types.ts`. DB is on
   `feature/BL-288-telegram-order-drafts` with a modified `.gitignore`. These
   existing changes were not inspected for adoption or modified.
4. **BL-285 is a reconciliation case.** Its declared DB child BL-281 is `done`;
   Admin children BL-282, BL-283 and BL-284 are all `in-review`. Resolve actual
   PR/commit/deployment state before treating any as work remaining. It is not
   a fresh implementation-loop pilot, and DB prerequisite evidence cannot be
   checked by ancestry in an Admin repository.
5. **BL-291 is a plausible Admin pilot after refinement.** It explicitly blocks
   on the owner's umbrella wording decision (AC3). Keep identifiers/routes/query
   values unchanged; check Ukrainian grammar and affected E2E text selectors.
   Do not bulk-format the repo. Verify the chosen base includes BL-289 and
   other prerequisite UI work even though metadata has no `blocked_by` entry.
6. **BL-290 cannot currently finish unattended.** It reserves Supabase/psql
   execution to the owner and requires a real storefront basket compatibility
   check before merge. Authoring a migration or passing Deno checks cannot
   satisfy that acceptance. Preserve the owner verification gate.

## Smallest useful runner extension

First add explicit external ticket-root support for a single code repository,
with ownership, snapshots and crash-safe publication appropriate to untracked
workspace tickets. This would enable an Admin pilot without changing Big Leaves'
layout. Add preflight for unresolved ticket decisions and selected test discovery.

Then add repository-keyed state and evidence: map existing `project` / `repos`
metadata, record branch/base/tree/commit/checks/PR per repository, express
prerequisites as repository-plus-commit, and let one workspace coordinator own
shared ticket transitions. Serialize cross-repository type generation and only
complete the parent when every required repository and integration gate passes.
Keep existing ticket IDs, roster, dependencies and numbered artifacts; the
workspace coordinator extends execution, not ticket requirements.

Sources: Big Leaves root AGENTS.md and ticket config; all four repository
CLAUDE.md files; Storefront .cursorrules; package.json/go.mod; both Playwright
configs and frontend CI workflows; DB functions/deno.json; BL-285 and its child
metadata; BL-290/BL-291 specs; installed Angular/Git/test/design skill files;
prototype manifest, quality policy and feature_adapter.py.
