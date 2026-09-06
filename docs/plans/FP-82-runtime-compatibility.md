# FP-82 — runtime compatibility follow-up

## Codebase Context

- `plugins/feature/skills/flow/references/stage-briefs.md:7` owns the stage spawn and response contract; its shared templates currently embed Claude tool calls.
- `plugins/feature/skills/flow/SKILL.md:155` fills and runs those templates; plan/build handoff and ticket routing already work through artifacts.
- `plugins/feature/skills/plan/SKILL.md:106` delegates exploration and then requirements analysis. Build's review checkpoint (`plugins/feature/skills/build/SKILL.md:202`) requires four independent roles; the UI checkpoint delegates one additional role.
- `plugins/feature/skills/ship/references/parallel-walk.md:33` caps ticket workers but does not reserve capacity for their nested stages and reviewers.
- `plugins/feature/agents/*.md` contains the shared role instructions plus Claude frontmatter. Codex cannot depend on those files being registered as native custom agents.

## Open Questions Resolved

- Keep one plugin and shared stage behavior; isolate runtime operations in two conditionally loaded references. Approved in the conversation.
- Preserve Claude's native skill and agent invocation, role models, stage order, artifacts, and gates. Codex uses its exposed tool schema and inherits role models unless explicitly selected for a stage.
- Treat current PR #94 as the destination. This follow-up does not re-run the feature pipeline against its own plugin repository or move FP-82 out of review.
- Explicitly report missing runtime capabilities and incomplete smoke tests; never replace an unavailable independent reviewer with the implementer's own review.

## Architecture Decision

Add a shared runtime selector and one implementation per runtime under flow's references. Skills retain their behavioral contracts; the selected runtime owns skill invocation, child creation, model mapping, wait/resume, role loading, and capacity handling. Bind the absolute plugin root and selected runtime before spawning and carry them into each child. Fresh Codex children receive a complete brief with no parent-history fork.

This adds a small runtime dispatch cost but avoids duplicating stage skills. Claude-specific role frontmatter remains authoritative on Claude; Codex uses the role body and explicit capability boundaries with its native generic child. No provider model aliases are translated across runtimes.

## Implementation Steps

1. **Runtime operations:** create `runtime.md`, `runtime-claude.md`, and `runtime-codex.md`. Follow `storage.md`'s conditional-load pattern without coupling runtime selection to storage mode. Cover fresh context, model fallback, absolute skill lookup, idle resumption, capacity/depth failures, and all nested roles.
2. **Consumer wiring:** update flow's templates and setup plus plan/build/ship entry points. Render the stage invocation per runtime, carry the binding to descendants, batch all four reviewers as capacity allows, and reserve ship worker capacity for descendants. Preserve hint data and existing overrides.
3. **Documentation and checks:** update README, advanced docs and AGENTS/CLAUDE in lockstep. Keep the existing PR's manifest bump in lockstep. Add focused structural checks for the new runtime seam and a repeatable smoke-test recipe with explicit evidence requirements.
4. **Verify and publish:** run structural checks and independent review, exercise available runtimes in throwaway consuming projects, record exact results/limitations, commit the changes and push to PR #94.

## Build Sequence

- [x] Runtime references
- [x] Shared briefs and consumer wiring
- [x] Documentation and structural validation
- [x] Runtime smoke tests and independent review (available surfaces; limitations recorded)
- Publication: follow-up commit on PR #94; no merge requested.

## Critical Details

- Runtime detection uses active tools, never ticket content, model brand, storage mode, or the mere presence of both installed manifests.
- Model fallback retries only a rejected model; a capacity, permission, or missing-tool error is not a model error.
- Preserve the paused child's identity and complete decision history. A fallback must restart at a valid point even when a stop happened before `06-summary.md` exists.
- Capacity includes ancestors and other active agents. Queue remaining reviewers; reserve one nested leaf per active ship worker. Never occupy every slot with parents waiting for children.
- Use shell only for permitted read operations in Codex read-only roles; generic-child instructions do not claim native tool filtering or sandbox enforcement.
- Test hint text with quotes, newlines, and flag-like content; retain direct build hints and the stage-brief hint contract.
- Structural checks cannot prove runtime behavior. Record real tool calls for context isolation, model override, nested role execution and pause/resume; server-native and browser integration remain unverified unless exercised.

## Verification record

See [FP-82-runtime-verification.md](FP-82-runtime-verification.md) for the repeatable fixture, observed runtime results, and unverified cases.
