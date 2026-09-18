# Codex ticket runner prototype: implementation and verification

Date: 2026-09-08.

Update: the [September 9 implementation](2026-09-09-quality-policy-and-ticket-adapter.md)
adds the explicit quality policy and filesystem feature-ticket adapter. The results
below describe the original September 8 prototype.

The executable prototype implements the proposed serial ticket protocol. A main
Codex agent plans and implements inline; one independent reviewer can be reused
across tickets. A small Python helper records explicit gates and reconciles Git
state. Native Goal continuation remains the outer execution mechanism; the helper
does not launch another model, scheduler, or Goal.

## Sandcastle decision

[Sandcastle](https://github.com/mattpocock/sandcastle) is the project the user
remembered. It is not archived; its latest observed main commit and release,
`v0.12.0`, were dated June 29, 2026. That shows recent historical development,
without establishing ongoing maintenance commitments. The
[source review](2026-09-08-sandcastle.md) records pinned primary sources.

Borrowed ideas: stable workspace ownership, explicit phase results, actual command
exit evidence, and cancellation cleanup that preserves work. No Sandcastle
dependency was added. Its external-agent/container orchestration is unnecessary
for this native Codex experiment. Its illustrative loops also do not establish
our completion contract: zero commits or a model completion string cannot prove
acceptance, and ticket closure before independent review is premature.

## What was implemented

- [Skill](../../prototypes/codex-ticket-runner/SKILL.md): serial execution and review
  instructions, capacity behavior, completion policy, and resumption boundaries.
- [Manifest contract](../../prototypes/codex-ticket-runner/manifest.md): immutable
  specs, dependency roster, owned paths, required commands, local/epic-PR delivery.
- [Runner](../../prototypes/codex-ticket-runner/runner.py): locked atomic state,
  ticket selection, checks, review evidence, commit recovery, and completion gates.
- [Git adapter](../../prototypes/codex-ticket-runner/git_state.py): complete working
  tree snapshots through a temporary index, ticket-relative patches, scoped
  staging, and read-only PR verification.
- [Reviewer contract](../../prototypes/codex-ticket-runner/review.md): actionable,
  read-only, snapshot-specific reports with honest context-reuse disclosure.

The progression is `next → implement → check → review → fix if needed → commit`,
repeated in dependency order, followed by final integration checks and the selected
delivery gate. Tests and review are tied to the actual tree; edits invalidate
previous evidence. A requested PR must match the repository, branch, base and
verified head and be open. A missing PR cannot silently become local completion.

This lives under `prototypes/`, outside the installed plugin and both marketplaces.
It does not change feature skills, manifests, ticket statuses, or personal-server
code. Prototype and research files remain uncommitted in this repository.

## Verification performed

**21 black-box regression tests passed.** The suite uses disposable Git repositories
and real helper invocations. It covers dependency ordering, staged/unstaged/untracked
changes, stale reviews and checks, self-review rejection, unresolved findings,
dirty boundaries, scoped staging, commit crash recovery, unexpected commits,
changed specs/manifests, capacity blocks, check timeout/cancellation, check-side
source mutation, commit hooks, multiline commit messages, final-check invalidation,
and missing PR delivery.

Reproduce from the prototype directory:

```sh
python3 -m unittest -v test_runner.py
```

**An independent executor completed a real three-ticket fixture.** It created a
text-normalization library, a subprocess CLI, and escaped HTML output in a separate
throwaway consuming repository. One independently spawned reviewer reviewed all
three snapshots; the latter two reused that reviewer's context. The run produced
three ticket commits, passed 13 integration tests, returned `complete`, and left a
clean checkout. The [forward-test report](2026-09-08-prototype-forward-test.md)
contains exact commits, commands, artifacts and observed friction.

That trial found and verified a fix for normal commit-message bodies. It also
demonstrated that accidentally writing the next ticket's files after a failed
commit could not sweep those files into the current ticket. The executor preserved
the files and recovered. The trial spans the original and corrected helper; it is
not a run against one frozen revision. Unit-suite reviewer reports are synthetic
protocol fixtures; only the forward trial used an actual separate reviewer agent.

**Supplementary browser verification passed.** At final fixture HEAD
`8e3799c12b4923c1736eadfcc44ec2586e1c057e`, the root executor generated HTML through
the actual CLI and loaded those bytes into Chrome using Playwright CLI. Browser
assertions confirmed the expected title and literal text, zero script elements,
and no injected-script execution. Screenshot inspection agreed. Evidence remains
at `/private/tmp/codex-runner-forward-odyltj05/browser-proof.log` and
`/private/tmp/codex-runner-forward-odyltj05/browser-proof.png`. The dedicated browser
was closed; the fixture remained clean. This was supplementary verification,
not an execution of a browser check declared in the runner manifest.

Existing runtime-contract, storage-mode split, and tool-parity repository checks
passed. Skill frontmatter and local links were checked. The bundled Python skill
validator could not run because PyYAML was unavailable; Ruby YAML provided the
frontmatter validation without installing a dependency.

## Next use and remaining evidence

Load the skill by its absolute path in a separate consuming project. Prepare the
manifest and immutable specs in a durable external run directory. A suitable Goal
instruction, after replacing the placeholders and selecting actual delivery, is:

> Implement the complete refined epic described by MANIFEST using
> /Users/serhiinadtochii/Projects/feature-pipeline/prototypes/codex-ticket-runner/SKILL.md.
> Plan and implement tickets inline in dependency order. Use one independent
> reviewer, fix accepted findings, and execute the declared checks. Commit each
> accepted ticket on the dedicated epic branch. Create one final open epic PR.
> Continue through all tickets and delivery; a finished ticket is not the finished
> Goal. Preserve state and report concrete recovery conditions for actual blockers.

That prompt authorizes the stated commits/PR when the user chooses to run it; this
document does not initiate them. Local delivery can be selected instead.

Not yet established: native Goal continuation through compaction, a large real
epic, a live GitHub PR, actual capacity-exhaustion recovery, and browser-required
manifest execution. Reviewer identity and review substance remain agent
responsibilities; the helper verifies mechanics, not those claims. Check caching
hashes source, not external environment; changed environment requires `--rerun`.

The prototype intentionally requires a clean exclusive checkout and code delta
per ticket. It does not import server-native storage, reconcile old dirty runs,
migrate manifests, handle already-satisfied/no-change tickets, provision worktrees,
support parallel writers, or merge PRs. Before packaging a separate Codex plugin,
run one modest real epic under Goal, then add only the ticket-storage adapter and
recovery cases demonstrated necessary by that trial.
