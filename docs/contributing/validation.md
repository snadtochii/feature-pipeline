# Validation and extension checklists

Checklists for changing the `feature` plugin's skills and agents. Unqualified `skills/` and `agents/` paths follow the root guidance file's path convention (`plugins/feature/…`).

## Validation expectations

Before committing changes to skills or agents:

1. **Lint the frontmatter** — no angle brackets, no markdown in descriptions, valid YAML, every tool listed in `allowed-tools`/`tools` actually exists. The server-tool entries — `pipeline_*` and `ping` — are the exception: they are declared intent, and each must appear in both forms — bare and plugin-scoped (the derived prefix, per the dual-listing note in [tool-budgets.md](tool-budgets.md)) — with the two lists holding the same tool set. Run `scripts/check-tool-parity.sh` rather than eyeballing it: it walks both `plugins/feature/skills/*/SKILL.md` and `plugins/feature/agents/*.md`, and the scoped prefix is derived from `plugins/server-native/.claude-plugin/plugin.json`, so the check also catches a connector rename. A bare-only entry grants nothing on Claude Code and raises no error.
2. **Check tool budget** against [tool-budgets.md](tool-budgets.md) — reviewers must not have write access.
3. **Check invocation control** — skills that are only ever user-invoked (`debug`, `sync`, `review`, `ship`, `lessons-consolidate`, `guide`, `setup`) set `disable-model-invocation: true` (user-only; description not loaded into context). Skills invoked programmatically by another skill via the Skill tool (`flow`, `plan`, `build`, `review-stage`, `close-stage`, `discover`, `address-review` — the last invoked by `ship`'s address hop) stay model-invocable but carry a terse one-line description with no auto-trigger phrases.
4. **Walk the stage contract in `skills/flow/SKILL.md`** — if you changed inputs/outputs, update the Stage Contract table *and* every consuming stage's `Required Input` section.
5. **Sweep for cross-skill drift** — when a filename, skill name, or schema changes, grep across `plugins/feature/skills/` and `plugins/feature/agents/` for stale references and update them. The "Editing discipline" section of the root guidance file applies.
6. **Build skill tool-budget audit** — check Claude-native tool references in `plugins/feature/skills/build/SKILL.md` against its `allowed-tools` (Read, Write, Edit, Glob, Grep, Bash, Agent, Task, TodoWrite, SendMessage, plus the `pipeline_*` tools its frontmatter lists, in either the bare or the plugin-scoped form). Do the same for `plugins/feature/skills/review-stage/SKILL.md` against its `allowed-tools` (Read, Write, Edit, Glob, Grep, Bash, Agent, Task, TodoWrite, plus the `pipeline_*` read and artifact-write tools its frontmatter lists — no transition, update or lesson tools). Do the same for `plugins/feature/skills/close-stage/SKILL.md` (the review stage's native set — no `SendMessage` — plus the `pipeline_*` read, artifact-write, transition and lesson tools its frontmatter lists — no update tool). Check Codex equivalents against `skills/flow/references/runtime-codex.md`; each operation must preserve the skill's budget.
7. **Agent tool-budget audit, both directions** — confirm `plugins/feature/agents/code-reviewer.md`, `plugins/feature/agents/security-engineer.md`, `plugins/feature/agents/performance-engineer.md`, and `plugins/feature/agents/code-architect.md` list no `Bash` or `Edit` in their `tools:`; reviewers must not mutate the tree they review. Confirm the converse for `plugins/feature/agents/finalizer.md`: it keeps `Bash` (a budget without it leaves the child unable to commit while still reporting success) and holds none of `Agent`/`Task`/`TodoWrite`/`WebFetch`/`WebSearch` — it is a leaf that never delegates, which is what keeps the depth counts in `skills/flow/references/runtime-claude.md` unchanged. `scripts/check-runtime-contract.sh` asserts all of this.
8. **Tool-parity check** — run `scripts/check-tool-parity.sh`; it must exit 0. This is the executable form of expectation 1 and an automated check in the repo.
9. **Failed-criteria placement** — failed test criteria live inside `05-tests.md` under a `## Failed Criteria` section. Verify close-stage output stays consistent with this placement.
10. **Mode-split check** — run `scripts/check-mode-split.sh`; it must exit 0. It is the executable form of the per-mode reference convention: no other-mode token in a `-fs`/`-server` file, no half pair, bound to `plugins/feature/skills`.
11. **Markdown links** — run `scripts/check-md-links.sh`; it must exit 0. It is the only guard against a dangling relative `.md` link, over every documentation tree listed in its `roots` array (today `plugins/feature/skills` and `plugins/tidy-loop`); vendored and generated directories are pruned from the walk. Adding a documentation tree is one line there.
12. **Mode-pair lockstep** — when you edit a shared section of a `-fs`/`-server` pair (the Epic-completion predicate, the decision table, the status query, error handling), apply the same edit to the sibling; the two files' `##` heading sets must stay identical.
13. **Runtime contract** — run `bash scripts/check-runtime-contract.sh`; it must exit 0. This checks the six runtime consumers, required runtime operations, neutral stage-template placeholders, the complete read-only reviewer roster in `review-stage` with its confidence-scale injection, and the mutating finalizer role — that `close-stage` names `feature:finalizer`, that its definition exists, and that its budget keeps `Bash` while holding no delegating tool. Real runtime behavior still needs a smoke run in a separate consuming project.
14. **Tidy-loop checks** — run `node scripts/check-tidy-checks.mjs`; it must exit 0 with every `ok` line. It installs each fixture's pinned toolchain with `npm ci` (Node ≥ 20, npm, and git on PATH) and diffs every checks command's JSON document against the committed expected one. CI runs it too, on changes touching the checks subtree or the runner (`.github/workflows/tidy-checks.yml`).

15. **Setup detection** — run `bash scripts/check-setup-detect.sh`; it must exit 0 with an `ok` line per fixture. It materializes every fixture under `plugins/feature/skills/setup/fixtures/` into a throwaway directory (jq and git on PATH), with the developer's own git configuration kept out of the run, and diffs `detect.sh`'s document against the fixture's committed `expected.json`.

16. **CI mirror** — `.github/workflows/validation.yml` runs expectations 8, 10, 11, 13, and 15 on every pull request and on every push to `main` or an `integration/**` branch (both workflows filter `push` that way, so a pull-request commit is checked once). Adding a validation script means adding a step there, or it stays a manual-only check.

The skills and agents have no automated test suite; validation there is by manual pipeline runs on real tickets. Two scripts are the exception, each covered by its fixtures: the tidy-loop checks through `scripts/check-tidy-checks.mjs`, which CI runs in its own workflow, and the setup detection script through `scripts/check-setup-detect.sh`.

## Adding a new stage

The implement, review and close stages own artifact slots `03-implementation.md` through `06-summary.md`: `build` writes `03-implementation.md`, the review stage writes `04-review.md`, and the close stage writes `05-tests.md` and `06-summary.md` — review and close reuse the `04`–`06` slots rather than taking new ones. Slot `07-debug.md` is reserved by the standalone `debug` skill (its optional ticket-context report on non-`fixed` exits); `debug` is **not** a flow stage, so it does not follow the checklist below. The next free slot for a new *stage* is `08-*.md`.

1. Create `skills/<stage>/SKILL.md`.
2. Reserve the next free artifact number (`08-*.md` — `07-debug.md` is taken by the standalone `debug` skill) — update the "Artifact Convention" section in `skills/flow/SKILL.md`.
3. Add the stage to flow's pipeline order and stage list.
4. Add auto-resumption rules: when this stage is re-invoked on an existing ticket, which on-disk artifact signals "resume from here" vs "start fresh." Document the routing table in the stage skill body and in flow's Resumption auto-detection section.
5. Document the stage's input/output contract in the stage's `Required Input`/`Output` sections *and* in flow's Stage Contract table.
6. Update `skills/flow/SKILL.md`'s Artifact invalidation downstream table for the new stage.
7. If the stage performs state transitions (folder moves, frontmatter `status` updates), add the relevant transition(s) to both `skills/flow/references/state-transitions-fs.md` and `state-transitions-server.md` and invoke them inline from the stage skill body. Do not write state-machine logic inline.
8. If the stage spawns subagents, create them in `agents/` and wire them up.
9. If the stage operates on a ticket (most do), reference the `flow/references/ticket-resolution-fs.md` / `ticket-resolution-server.md` pair for resolution + epic refusal + blocker validation, and add the stage to the consumer list in both files.

## Adding a new agent

1. Create `agents/<name>.md` using the canonical body template (Template B).
2. Set `tools` explicitly based on [tool-budgets.md](tool-budgets.md).
3. Set `model` — default to `opus`.
4. Reference the agent from a skill (otherwise it's dead weight — unused agents shouldn't ship).
