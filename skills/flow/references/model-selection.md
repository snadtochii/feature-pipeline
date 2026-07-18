# Model tiering — shared contract

The single source of truth for which tier a subagent spawn runs at: the two tiers, the complexity-keyed downgrade rule, the downgradable spawn sites, the never-downgrade set, the harness mapping, the fallback contract, and the vetting obligation. This file is standalone — a consumer reads just it and can comply.

**Consumers:** `plan` applies the rule at its two Phase 1 spawns (§3); `build` applies it at its test checkpoint (§3) and is bound by §4 at its review checkpoint. `discover` and `ship` do **not** use this reference — both spawn outside the complexity key, and §4 records why.

## §1 Tiers

Two plugin-controlled tiers, named abstractly so the contract holds on any harness:

- **Top tier** — the deepest-reasoning model available. Every agent in `agents/` pins it in frontmatter, so it is both the default and the fallback for every spawn.
- **Mid tier** — a cheaper, faster model. Reached only as a per-spawn override, never as a frontmatter pin.

The model the main context itself runs on is the user's session choice and is out of scope — this contract governs subagent spawns only.

## §2 The downgrade rule

A spawn runs at mid tier when **both** conditions hold:

1. The ticket's `01-spec.md` frontmatter `complexity` is exactly `S` or `M`, **and**
2. the spawn is one of the downgradable spawn sites listed in §3.

Otherwise the spawn runs at top tier.

Condition 1 is an **allowlist, not a denylist**: only the exact values `S` and `M` downgrade. A `complexity` field that is absent, empty, lower-case, `L`, `XL`, or any unrecognized value runs at top tier. No unknown value can downgrade a spawn by accident.

## §3 Downgradable spawn sites

Keyed by **spawn site**, not by agent — the same agent can be downgradable at one call site and not at another.

- **`code-explorer` at `plan` Phase 1, Step 1.2** — bounded evidence-gathering against a ticket whose scope is already known.
- **`requirements-analyst` at `plan` Phase 1, Step 1.3** — bounded analysis of a spec against gathered context.
- **`ui-tester` at `build`'s test checkpoint** — bounded acceptance-criteria verification against a running app. Unlike the two above, this agent holds `Write`, `Edit`, and `Bash`: it can save a browser session-state file and codify passing runs into checked-in spec files. Its safety discipline for those writes — most importantly the `git check-ignore` guard before saving any session-state path — is prose in the agent body, not an enforced hook, and a durable side effect is not something §7 can undo after the fact. §7 carries a clause for this site; treat it as binding rather than advisory.

Any spawn not named in this list runs at top tier (§4).

**Ordering note for `plan`:** the requirements-analyst returns a complexity reassessment *after* both Phase 1 spawns have already run, so an upward revision (spec says `M`, analysis says `XL`) does not retroactively change the tier those two spawns ran at, and they are not re-spawned. The one-run lag is deliberate: re-spawning would double Phase 1 cost to correct a rare misestimate, and the reassessment feeds a user proceed/cancel decision rather than a load-bearing technical finding.

## §4 Never downgrade

- **The four reviewers at `build`'s review checkpoint** (`code-reviewer`, `security-engineer`, `performance-engineer`, `code-architect`) — this contract never downgrades them, at any complexity. The §7 vetting obligation cannot recover a finding that was never surfaced; a missed vulnerability or logic error has no downstream check. Note the limit of the guarantee: a globally-set `CLAUDE_CODE_SUBAGENT_MODEL` (§5) outranks frontmatter pins and so reaches the reviewers too. That is outside this contract's control — "reviewers run at top tier" is an invariant of this contract, not of the runtime.
- **`discover`'s Phase 2 explorer spawn** — no ticket exists yet at spawn time, so there is no `complexity` to key on. Ticket creation and complexity assignment happen later in `discover`.
- **`ship`'s `ui-tester` spawn** — one spawn per run rather than per ticket, so no single ticket's `complexity` applies to it.
- **Any spawn not listed in §3** — the list is exhaustive; a spawn site added later is top tier until it is added there.

## §5 Harness mapping

The only section that names a concrete model.

- **Claude Code** — mid tier is `sonnet`, passed as the per-spawn `model` argument on the spawn call. Precedence: the `CLAUDE_CODE_SUBAGENT_MODEL` environment variable overrides the per-spawn argument, which in turn overrides the agent's frontmatter pin. This contract does not attempt to defeat that variable. Be aware it is global and inheritable — a value set in a shell profile, CI config, or devcontainer applies to every spawn, including the §4 reviewers — so a session where it is set is not one in which §4's guarantee holds.
- **Other harnesses** — no per-spawn model mechanism is assumed. Where none exists, the spawn runs at the agent's frontmatter pin (top tier) and the run proceeds normally; nothing about the spawn changes.

## §6 Fallback contract

The fallback direction is always **upward-or-equal**. Where the override cannot be applied — the harness exposes no per-spawn model argument, the named model is unavailable or unrecognized, or anything else is unexpected — the spawn runs at the agent's frontmatter pin.

A tiering failure must never block, delay, retry, or fail a spawn, and must never prompt the user. The worst outcome of the entire mechanism is that a spawn costs what it would have cost without it.

## §7 Vetting

Treat mid-tier spawn output as **leads, not facts**.

**For the two report-only sites** (`code-explorer`, `requirements-analyst`), the obligation is bounded deliberately. Do **not** re-read every cited file — an explorer report is almost entirely `file:line` refs, and verifying all of them would pull the explored files into main context, which is the exact cost the delegation existed to avoid, on the more expensive session model, persisting across every later turn. Verify only the refs the plan will **act on** — those reaching a Build Sequence step's `Files` field. The rest are verified lazily and for free: `build`'s implement checkpoint re-reads each target file before editing it, so a bogus ref surfaces there at no marginal cost.

**For `ui-tester`**, whose output carries no file refs to re-resolve, §7 takes a different shape — a browser run cannot be cheaply re-verified without redoing it, so the check attaches to its consequences instead:

- A mid-tier `failed` verdict is confirmed before build enters its in-context fix loop. Chasing a spurious failure costs main-thread turns at session-model rates, which dwarfs the spawn saving.
- Any spec file a mid-tier run codifies, and any session-state file it saves, is reviewed before it is committed — specifically, confirm the session-state path is genuinely git-ignored. This is the one downgradable site that mutates the tree, and a write is not recoverable by re-reading a report.

The obligation sits with the main thread and is deliberately **not** injected into the spawn prompt. The spawned agent's prompt is identical at either tier — telling an agent it is running downgraded invites hedged, lower-signal reports, which is the opposite of what the vetting step needs to work against.
