# Build review checkpoint: cutting context without cutting coverage

Research date: 2026-09-16. Scope: the `feature` plugin's build-stage review checkpoint (four parallel reviewer subagents merged into `04-review.md`), evaluated against (a) Matt Pocock's `code-review` skill, (b) other reshapes (consolidated reviewer, two-role split, sequential, cheaper models, trimmed/by-reference inputs, Claude Code built-ins, find-then-verify), and (c) a recommendation. Sources are the plugin files on disk, the local and upstream copies of Pocock's skill, the Claude Code and Claude API docs, and the Claude Code 2.1.271 binary for bundled-skill text. No new token measurements were taken; the only existing numbers are the stage-subagent A/B in [`model-selection.md`](model-selection.md), which does not isolate the reviewer checkpoint. Claims marked *inference* are reasoning from the cited sources, not documented facts.

Repo paths below are relative to the repo root; `build/SKILL.md` means `plugins/feature/skills/build/SKILL.md`.

## 1. What the checkpoint does today

### 1.1 Control flow

- **Triviality short-circuit** — skipped entirely when `complexity: S`, `< 50` lines and `< 3` files ([`build/SKILL.md:164-178`](../../plugins/feature/skills/build/SKILL.md)). Everything else pays the full fan-out.
- **Diff** — branch-scope `git diff "$base"...HEAD` concatenated with unstaged `git diff` ([`build/SKILL.md:180-195`](../../plugins/feature/skills/build/SKILL.md)). Uncommitted work is included, which matters for §3.1.
- **Shared base** (composed once, sent to all four): full contents of `01-spec.md`, `02-plan.md`, `03-implementation.md`; the diff; the project root path; the blocker-context block (verbatim `01-spec.md` + `06-summary.md` of every blocker); and `references/confidence-scale.md` verbatim ([`build/SKILL.md:197-203`](../../plugins/feature/skills/build/SKILL.md); [`confidence-scale.md:1-15`](../../plugins/feature/skills/build/references/confidence-scale.md)).
- **Four spawns** — each role gets the shared base plus a two-to-six-line suffix; "another reviewer's findings never enter that prompt"; all four are collected before merging; capacity-queued roles are pending, never skipped ([`build/SKILL.md:205-224`](../../plugins/feature/skills/build/SKILL.md); Claude runtime [`runtime-claude.md:29`](../../plugins/feature/skills/flow/references/runtime-claude.md); Codex runtime [`runtime-codex.md:53`](../../plugins/feature/skills/flow/references/runtime-codex.md)). Every prompt is prefixed with the runtime block ([`runtime.md:23-33`](../../plugins/feature/skills/flow/references/runtime.md)).
- **Merge** — group by CRITICAL → IMPORTANT → SUGGESTION, de-duplicate overlaps ("if both code-reviewer and code-architect flag the same issue"), tag by lens, per-reviewer counts, graceful partial merge; all four failing → `verdict: stuck` ([`build/SKILL.md:226-232`](../../plugins/feature/skills/build/SKILL.md), [`:290`](../../plugins/feature/skills/build/SKILL.md), [`:447`](../../plugins/feature/skills/build/SKILL.md)).
- **Apply** — fixes in build's own context; tiebreak `security > correctness > architecture > performance`; unresolvable conflicts recorded as `deferred (conflict)` ([`build/SKILL.md:234-236`](../../plugins/feature/skills/build/SKILL.md)).
- **Re-entry** — the resumption router re-runs "the 4 reviewers against the current diff" when implementation diverged after review ([`build/SKILL.md:414`](../../plugins/feature/skills/build/SKILL.md)).

### 1.2 The four roles

| Role | Tools | Model | Body shape | Source |
|---|---|---|---|---|
| `code-reviewer` | read-only set | `opus` | Diff-review body: reads `CLAUDE.md`, the diff, surrounding code; scores on the injected scale; reports ≥ 80 only; explicitly *will not* "overlap with security or performance concerns — those have their own reviewers" | [`agents/code-reviewer.md:4-13`](../../plugins/feature/agents/code-reviewer.md), [`:34-40`](../../plugins/feature/agents/code-reviewer.md), [`:59`](../../plugins/feature/agents/code-reviewer.md) |
| `security-engineer` | read-only set | `opus` | Generic security-persona body: threat modeling, compliance verification, "Security Audit Reports", "Compliance Reports" as outputs | [`agents/security-engineer.md:28-46`](../../plugins/feature/agents/security-engineer.md) |
| `performance-engineer` | read-only set | `opus` | Generic performance-persona body: "Measure first… always profile and analyze with real data", "Profile Before Optimizing", before/after benchmarking | [`agents/performance-engineer.md:25`](../../plugins/feature/agents/performance-engineer.md), [`:35-38`](../../plugins/feature/agents/performance-engineer.md) |
| `code-architect` | read-only set + three Serena tools | `opus` | Diff-review body: sibling-pattern comparison, layer boundaries, reinvention; severity vocabulary `CRITICAL / WARNING / SUGGESTION` | [`agents/code-architect.md:13-15`](../../plugins/feature/agents/code-architect.md), [`:30-34`](../../plugins/feature/agents/code-architect.md), [`:56`](../../plugins/feature/agents/code-architect.md) |

Two observations that matter later:

- The security and performance bodies were not written as diff reviewers. A reviewer with no `Bash` cannot "profile with real data"; "Compliance Reports" and "Threat Models" are not outputs the merge step consumes. Their spawn *suffix* ([`build/SKILL.md:210-214`](../../plugins/feature/skills/build/SKILL.md)) is what actually scopes the work. *Inference:* the body text is paid on every spawn and adds little beyond the suffix.
- Severity vocabularies diverge: build merges on `CRITICAL / IMPORTANT / SUGGESTION` ([`build/SKILL.md:227`](../../plugins/feature/skills/build/SKILL.md)), `code-reviewer` emits `CRITICAL → IMPORTANT` only ([`agents/code-reviewer.md:40`](../../plugins/feature/agents/code-reviewer.md)), `code-architect` emits `CRITICAL / WARNING / SUGGESTION` ([`agents/code-architect.md:56`](../../plugins/feature/agents/code-architect.md)). The merge step normalizes silently.

### 1.3 What the runtime and scripts hard-code

- `scripts/check-runtime-contract.sh:57-69` greps `build/SKILL.md` for `**[a-d]. \`feature:<role>\`` and requires the set to equal exactly `{code-reviewer, security-engineer, performance-engineer, code-architect}` with each once, each `agents/<role>.md` present, and no `Bash|Write|Edit|Agent|Task` in the role frontmatter ([`scripts/check-runtime-contract.sh:57-69`](../../scripts/check-runtime-contract.sh)). Its success line says "4 read-only reviewer roles" ([`:74`](../../scripts/check-runtime-contract.sh)). Any roster change must edit this script.
- `runtime-codex.md` loads each `agents/<role>.md` **body** into a generic fresh child (`fork_turns: "none"`) and translates the tool budget into prose boundaries ([`runtime-codex.md:23`](../../plugins/feature/skills/flow/references/runtime-codex.md), [`:31-39`](../../plugins/feature/skills/flow/references/runtime-codex.md)). On Codex the role body is therefore prompt text, and the plugin's model pins are ignored ([`CLAUDE.md:269`](../../CLAUDE.md)).
- `runtime.md:5` binds `<PLUGIN_ROOT>` to *this* plugin's installation and forbids resolving plugin files elsewhere; `runtime-codex.md:7` implements "Invoke skill" as "Read `<PLUGIN_ROOT>/skills/<name>/SKILL.md`". A skill that lives in another plugin has no Codex invocation path under this contract.
- `CLAUDE.md` conventions that a change must keep or update: reviewers read-only ([`CLAUDE.md:176`](../../CLAUDE.md), [`:255-256`](../../CLAUDE.md), expectation 7 at [`:405`](../../CLAUDE.md)); read-only set definition ([`:259`](../../CLAUDE.md)); "Serena … Not added to reviewers" ([`:261`](../../CLAUDE.md), contradicted by `code-architect` carrying Serena — pre-existing drift); `model: opus` for every agent ([`:263-269`](../../CLAUDE.md)); the build tool-budget row naming "the 4 reviewer subagents" ([`:185`](../../CLAUDE.md)); expectation 12 naming the "complete read-only reviewer roster" ([`:410`](../../CLAUDE.md)); the deferred fifth reviewer ([`:440`](../../CLAUDE.md)).
- Under flow, build is itself a stage subagent; flow receives only build's final report, "no diff, no reviewer reports, no test transcript" ([`stage-briefs.md:12`](../../plugins/feature/skills/flow/references/stage-briefs.md), [`:141`](../../plugins/feature/skills/flow/references/stage-briefs.md)). The reviewer payloads land in **build's** window, which is the window that hits the 25-turn loop.

## 2. Cost model — two different quantities

The user's goal is "reduce context consumption". The existing measurement says the invoking window is what governs build's peak and that "the next lever for build's peak is inside build itself — its skill and reference loads, and re-reads across checkpoints" ([`model-selection.md:212-224`](model-selection.md); memory note `project_stage_subagent_measurement.md`). So the two quantities must be kept apart:

- **(i) Build's own window** — what lands in build's transcript and therefore counts toward its peak and toward compaction ([`stuck-detection.md:15`](../../plugins/feature/skills/build/references/stuck-detection.md)).
- **(ii) Total tokens across the reviewer subagents** — isolated windows; cost and rate-limit exposure, but not build's peak. Subagents run "in its own context window" and return "only the summary" ([Claude Code: subagents](https://code.claude.com/docs/en/sub-agents), "Create custom subagents" / "Manage subagent context").

### 2.1 What lands in build's window (i)

Per checkpoint run, in order (*inference* from the skill text plus the Agent tool's `prompt` parameter, which is a tool-call argument build itself emits):

1. Tool results build already holds or reads at 2b: the diff output (`git diff` result), `confidence-scale.md`, and per blocker `01-spec.md` + `06-summary.md` — one copy each. Spec/plan/implementation are usually already in the window from earlier checkpoints.
2. **Four `Agent` tool calls whose `prompt` argument contains the whole shared base.** The skill says "Every role receives the same shared base" ([`build/SKILL.md:205`](../../plugins/feature/skills/build/SKILL.md)) and the base is *contents*, not references ([`:199`](../../plugins/feature/skills/build/SKILL.md), [`:202`](../../plugins/feature/skills/build/SKILL.md): "the block inlines the artifact text, never a reference"). Each call is an output-token emission by build and persists as a `tool_use` block. *Inference:* this is four additional copies of spec + plan + implementation + diff + rubric + blocker context in build's own window, on top of the one copy from step 1. This is the largest avoidable item and is not counted by any existing measurement.
3. Four result payloads — unbounded length today (no word cap; the roles' output sections ask for summaries, findings, confidence, clean verdict — [`agents/code-reviewer.md:42-46`](../../plugins/feature/agents/code-reviewer.md)).
4. The merged `04-review.md` `Write` — a fifth copy of the findings.
5. The fix pass: reads and edits, as with any checkpoint.

The 25-turn budget is *not* the concern here: the four spawns in one message count as one turn ([`stuck-detection.md:7`](../../plugins/feature/skills/build/references/stuck-detection.md)). Window size is.

### 2.2 What the subagents spend (ii)

Per reviewer (*inference*, using the measured harness baseline): a fresh Claude subagent starts near 32.6k tokens before its brief content is counted ([`model-selection.md:216`](model-selection.md)) — that floor is harness, not plugin, and only fewer agents reduce it. On top: the agent body, the runtime block, the full shared base, then the agent's own `Read`/`Grep` re-reads of the changed files and surrounding code (the bodies instruct "Read surrounding code", "Find sibling code" — [`agents/code-reviewer.md:37`](../../plugins/feature/agents/code-reviewer.md), [`agents/code-architect.md:47-48`](../../plugins/feature/agents/code-architect.md)), each in its own window, so files are re-read up to four times across the fan-out. Every reviewer is `model: opus` on Claude.

**Does prompt caching make four identical bases cheap?** Mostly no, for three documented reasons:

- Cache prefixes are built in the order `tools`, `system`, then `messages`, and hits require "100% identical prompt segments … up to and including the block marked with cache control" ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Each Claude subagent runs "with a custom system prompt" ([subagents docs](https://code.claude.com/docs/en/sub-agents)). *Inference:* four roles with four different system prompts share no prefix, so the shared base in `messages` cannot be a cross-role cache hit even if the spawns were serialized. Whether Claude Code applies breakpoints in a way that changes this is not documented (unverified).
- "For concurrent requests, note that a cache entry only becomes available after the first response begins. If you need cache hits for parallel requests, wait for the first response before sending subsequent requests" ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Parallel spawns race.
- Minimum cacheable length is 512 tokens for Fable 5.1 / Opus 5 and 1,024 for Opus 4.8 / Sonnet 5 ([Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)) — the base clears that, so *within* a single reviewer's multi-turn run its own prefix is cached at 0.1× on later turns (0.025× on Fable 5.1). Cache writes are 1.25× base input ([Pricing](https://platform.claude.com/docs/en/about-claude/pricing)).

So (ii) is roughly 4 × (baseline + body + base) at write price plus each agent's own reads, not 1 × base + 3 cache reads. Per-model base input / output rates for reasoning about the multiplier (not for inventing numbers for this repo): Opus 5 and 4.8 $5 / $25, Sonnet 5 $2 / $10, Haiku 4.5 $1 / $5 per MTok ([Pricing](https://platform.claude.com/docs/en/about-claude/pricing)). The 5.x models use a tokenizer that produces roughly 30% more tokens for the same text than 4.6-and-earlier ([Pricing](https://platform.claude.com/docs/en/about-claude/pricing)), so older measurements under-count today's token totals.

### 2.3 Existing data

The only measured run had **zero reviewer findings on both arms** ([`model-selection.md:212`](model-selection.md)), so there is no findings-quality baseline to compare a redesign against, and no per-checkpoint attribution of the 118,978-token build peak. `docs/research/` and `prototypes/` contain no other reviewer-cost numbers (grep over both trees). Transcript JSONLs for this project exist locally (25 files) and were not mined here.

## 3. Pocock's `code-review` skill

### 3.1 What it is

Sources: local plugin copy [`mattpocock-skills/1.2.3/…/code-review/SKILL.md`](file:///Users/serhiinadtochii/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.2.3/skills/engineering/code-review/SKILL.md) and the upstream file ([raw main](https://raw.githubusercontent.com/mattpocock/skills/main/skills/engineering/code-review/SKILL.md)). The two are the same procedure; the only differences are punctuation (upstream replaces em dashes with colons/parentheses) and line 13 — local says "run `/setup-matt-pocock-skills` if `docs/agents/issue-tracker.md` is missing", upstream says "tell the user to run" it. The upstream wording matches the copy at `~/.claude/skills/code-review` (a symlink to `~/.agents/skills/code-review`), which corroborates the fetched text. `agents/openai.yaml` holds only a display name and short description.

| Aspect | Pocock `code-review` | Build today |
|---|---|---|
| Inputs | A **fixed point** the user supplies — "If they didn't specify one, ask for it" (L19); a **spec source** found via commit-message issue refs → `docs/agents/issue-tracker.md` → user-passed path → `docs/`/`specs/`/`.scratch/` → "ask the user where the spec is" (L27-32); **standards sources** (`CODING_STANDARDS.md`, `CONTRIBUTING.md`) plus a fixed Fowler smell baseline (L36-56) | Base branch auto-detected, asks only if neither `origin/HEAD` nor `main` exists ([`build/SKILL.md:195`](../../plugins/feature/skills/build/SKILL.md)); spec is `01-spec.md`; standards are project `CLAUDE.md` via `code-reviewer` |
| Diff scope | `git diff <fixed-point>...HEAD` — committed changes only (L21); the earlier note in [`2026-09-08-goals-and-matt-pocock.md:33`](2026-09-08-goals-and-matt-pocock.md) already flagged that this excludes uncommitted work | Branch diff **plus** unstaged diff ([`build/SKILL.md:187-190`](../../plugins/feature/skills/build/SKILL.md)); build reviews before any commit, so Pocock's scope would review nothing on a fresh build |
| What each subagent receives | The diff **command** and commit list (not the diff text), the standards file list + smell baseline, a brief (L60-64); Spec agent gets the diff command + commit list + spec path or contents + brief (L66-70) | Full inlined base per role (§1.1) |
| Subagent tools / model | Unspecified — the subagents must run `git diff` themselves, so they need shell access; no model pin (inherit) | Read-only roles, `model: opus` |
| Output | Two sections `## Standards` and `## Spec`, "verbatim or lightly cleaned", **not merged, not reranked**, one-line totals per axis (L74-78); each report "Under 400 words" (L64, L70) | Merged, deduped, severity-grouped, lens-tagged `04-review.md` |
| Severity / confidence | "Distinguish hard violations from judgement calls" only (L64); no numeric confidence | 0–100 scale, ≥ 80 threshold |
| Security / performance | Absent. The smell baseline is structural (naming, duplication, feature envy, data clumps, …); security or performance would appear only if a repo's standards doc mentions them | Dedicated roles |
| Architecture / sibling patterns | Partly via smells (Duplicated Code, Shotgun Surgery, Divergent Change, Speculative Generality) — diff-local, no codebase search | `code-architect` searches sibling code (Serena) |
| Spec conformance | **Yes** — missing/partial requirements, scope creep, wrong-looking implementations, quoting the spec line (L70) | Not asked for by any suffix; the spec is in the base but no role is told to check AC coverage or scope creep ([`build/SKILL.md:207-224`](../../plugins/feature/skills/build/SKILL.md)). `ship`'s independent reviewer does ask for it ([`reviewer-prompt.md:17`](../../plugins/feature/skills/ship/references/reviewer-prompt.md)) |
| Unattended safety | Two ask-the-user points (fixed point, spec) and a dependency on `docs/agents/issue-tracker.md` (L13). Safe only if build pre-supplies both inputs and the tracker file's absence is tolerated | No user questions in the checkpoint |
| Codex parity | None under this plugin's runtime: `Skill` maps to reading `<PLUGIN_ROOT>/skills/<name>/SKILL.md` ([`runtime-codex.md:7`](../../plugins/feature/skills/flow/references/runtime-codex.md)) and `runtime.md:5` forbids resolving another plugin's files | Role bodies load from `<PLUGIN_ROOT>/agents/` on both runtimes |

### 3.2 Verdict on (a)

Adopting the skill as a dependency fails four hard constraints: diff scope (uncommitted work invisible), unattended inputs, Codex parity, and the runtime-contract roster. It also drops security, performance and codebase-aware architecture review, and its subagents are not read-only by this plugin's definition. The user's global dependency policy ("wrap it behind a small owned abstraction so it stays swappable", `~/.claude/CLAUDE.md`) applies to code, but the same reasoning holds: a runtime dependency on a third-party skill's file path and prompt shape is a liability with no owned seam.

What is worth taking from it: the explicit **Spec axis** (coverage gap in build today), the **400-word cap per report** (directly shrinks item 3 of §2.1), and the idea of giving a reviewer **references plus a brief rather than the whole base inlined** (its subagents get a diff *command*, not the diff).

## 4. Claude Code built-ins

- **`/code-review` (alias `/review`)** — bundled skill: "Review the current diff, or a PR number, branch, or path you pass, for correctness bugs and cleanup opportunities", with effort levels `low|medium|high|xhigh|max|ultra`, `--fix` to apply, `--comment` to post to a PR ([Commands reference](https://code.claude.com/docs/en/commands)). The 2.1.271 binary shows it sizing "finder subagents" from the committed diff — "start with about ⌈lines/150⌉ finder subagents (min 2, max 8)", noting "Uncommitted changes aren't counted here, so treat this as a floor" — and a `uses_report_findings_tool` flag and `willRunAsFork` field (observed strings in `~/.local/share/claude/versions/2.1.271`; the full prompt body was not extracted, so the exact phases are unverified). Two blockers for using it as the checkpoint: the docs list only `/init` and `/security-review` as "built-in commands … also available through the Skill tool" ([Skills docs](https://code.claude.com/docs/en/skills)) — `/code-review`'s Skill-tool invocability is not documented either way (unverified); and on this machine `/code-review` is **shadowed** by the user-level Pocock skill (`~/.claude/skills/code-review` symlink), since "Your skill replaces the bundled command, but not its aliases" ([Skills docs](https://code.claude.com/docs/en/skills)). No Codex equivalent. Its agent count also *grows* with diff size, the opposite of the goal.
- **`/simplify`** — bundled: "Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply the fixes. Quality only — it does not hunt for bugs; use /code-review for that." Its prompt launches "4 independent review agents" (Reuse plus three more angles), then "fix each remaining one directly", with a single-pass inline fallback when the Agent tool is unavailable (binary strings, 2.1.271). It is a mutating cleanup pass, not a reviewer, and it would add four agents rather than remove any.
- **`/security-review`** — "checks the diff for security vulnerabilities" and is Skill-tool-invocable ([Commands](https://code.claude.com/docs/en/commands), [Skills](https://code.claude.com/docs/en/skills)). Whether it spawns agents is undocumented. It could stand in for `security-engineer` on Claude only; no Codex path.
- **Anthropic's `code-review` plugin** (`claude-plugins-official/code-review/commands/code-review.md`, a different thing from the bundled skill) is the origin of build's rubric: three Haiku pre-checks, **five parallel Sonnet** review agents, then **one Haiku scorer per finding** on a 0–100 scale with a `< 80` filter (L11-26). Build's `confidence-scale.md` is that rubric condensed. The plugin's design separates *finding* (cheaper model) from *scoring* (cheaper still), which is the "ReportFindings-style verify pass" pattern.

Other documented facts used below: subagent frontmatter has `model` (aliases `sonnet|opus|haiku|fable`, full ID, `inherit`) and `effort` (`low|medium|high|xhigh|max`, "Overrides the session effort level"); the default concurrent-subagent limit is 20; a skill can run in a fork with `context: fork` + `agent` ([subagents docs](https://code.claude.com/docs/en/sub-agents); [Skills docs](https://code.claude.com/docs/en/skills)).

## 5. Coverage matrix

What each lens is asked to catch (from the spawn suffixes and bodies), and where the alternatives land it. ✓ asked for explicitly; ~ partial/incidental; — absent.

| Concern | code-reviewer | security-engineer | performance-engineer | code-architect | Pocock Standards | Pocock Spec | `review` rubric (standalone) | `ship` reviewer |
|---|---|---|---|---|---|---|---|---|
| Logic bugs, null handling, races | ✓ | — | ~ (leaks) | — | — | ~ ("looks wrong") | — | ✓ |
| Project-convention adherence (`CLAUDE.md`) | ✓ | — | — | ~ | ✓ (documented standards) | — | — | ✓ |
| OWASP / injection / auth / data exposure | — (explicitly excluded, L59) | ✓ | — | — | — | — | — | ✓ (priority 6) |
| N+1, re-renders, bundle size, complexity | — (excluded) | — | ✓ | — | — | — | ~ (orchestration) | ✓ (priority 6) |
| Sibling-pattern fit, layer boundaries, reinvention | ~ | — | — | ✓ (codebase search) | ~ (diff-local smells) | — | ✓ (structural, ambitious) | ✓ (priority 3) |
| Duplication | ✓ | — | — | ✓ | ✓ | — | ✓ | — |
| Spec coverage / scope creep vs AC | — | — | — | — | — | ✓ | — | ✓ (priority 1) |
| Test coverage of new paths | ✓ | — | — | — | — | — | — | ✓ |
| Numeric confidence filter | ✓ | ✓ | ✓ | ✓ | — | — | — | severity only |

Sources: [`build/SKILL.md:207-224`](../../plugins/feature/skills/build/SKILL.md); agent bodies cited in §1.2; Pocock L45-70; [`review-rubric.md:17-70`](../../plugins/feature/skills/review/references/review-rubric.md); [`reviewer-prompt.md:17-23`](../../plugins/feature/skills/ship/references/reviewer-prompt.md).

Overlap that the dedupe step exists for ([`build/SKILL.md:228`](../../plugins/feature/skills/build/SKILL.md)): duplication and convention drift are flagged by both `code-reviewer` and `code-architect`; leaks sit between correctness and performance. Unique value per role: security and performance are *only* covered by their roles; codebase-aware pattern search is only in `code-architect`; the Spec axis is covered by nobody in build today.

Two in-repo precedents show that a single context can carry every lens: the standalone `review` skill runs inline, "spawns no subagents (no `Task`) and uses no MCP, so it behaves identically on Claude Code and Codex" ([`review/SKILL.md:18`](../../plugins/feature/skills/review/SKILL.md)), and `ship`'s independent reviewer covers correctness, bugs, architecture, conventions, tests, security and performance in one prioritized brief ([`reviewer-prompt.md:17-20`](../../plugins/feature/skills/ship/references/reviewer-prompt.md)). Neither has a measured quality comparison against the four-role fan-out.

## 6. Option table

"(i)" = build's window, "(ii)" = subagent totals, per §2. "Roster" = whether `check-runtime-contract.sh:57-69`, `CLAUDE.md:185/255-256/405/410` and the agent files change.

| Option | Changes | (i) build window | (ii) subagent totals | Quality risk | Unattended | Codex parity | Roster |
|---|---|---|---|---|---|---|---|
| **A. Pocock `code-review` via `Skill`** | Replace 2b–2d with a Skill call; pre-supply fixed point + spec; tolerate missing tracker file | Down: 2 result payloads ≤ 400 words each; the skill's own step text lands in build's window | Down: 2 agents, but each re-runs `git diff` | High: loses security, performance, codebase-aware architecture; reviews committed diff only (§3.1) | Only if both inputs are injected; two ask-points otherwise | None ([`runtime-codex.md:7`](../../plugins/feature/skills/flow/references/runtime-codex.md), [`runtime.md:5`](../../plugins/feature/skills/flow/references/runtime.md)) | Fails the 4-role check |
| **B. One consolidated reviewer** (new role or `code-reviewer` with an all-lens suffix, in the `ship`/`review` style) | 2c becomes one spawn; 2d loses per-reviewer counts and dedupe; L290/L447 "all four failing" → "reviewer failing"; new or rewritten agent body | Down: 1 spawn-prompt copy of the base, 1 result | Down ~4×: one harness baseline, one base, one set of re-reads | Medium: attention split across lenses in one pass; no independent cross-check; *inference* that security findings get crowded out on large diffs. Mitigate with a fixed per-lens output section that must say "none" | Yes | Yes (one body) | Script + `CLAUDE.md` tables + agent files |
| **C. Two roles** — "works and is safe" (correctness + security + spec) and "fits" (architecture + performance + conventions, keeps Serena) | 2c halves; suffixes rewritten; two agent bodies; merge keeps dedupe | Down ~2× on spawn copies and results | Down ~2× | Low–medium: keeps a second independent eye; security shares a window with correctness, which is the pairing `ship` already uses in one window | Yes | Yes | Script + `CLAUDE.md` + agents |
| **D. Same four roles, sequential** | Capacity handling only | **No change**: same 4 prompts, 4 results | **No change**: same 4 baselines and bases; no cross-role cache sharing (§2.2) | None | Yes | Already supported (batches) | None |
| **E. Cheaper models / lower `effort`** on some roles (`performance-engineer` → `sonnet` was already proposed in [`model-selection.md:14`](model-selection.md)); `effort: low|medium` on scan roles | Agent frontmatter; `CLAUDE.md:263-269` rule | No change | Same tokens, lower $ (Sonnet 5 input is 0.4× Opus; Haiku 4.5 0.2×) | Medium for security/correctness; low for performance/architecture scans | Yes | Ignored on Codex ([`CLAUDE.md:269`](../../CLAUDE.md)) | None |
| **F. Trim the base and pass it by reference** — drop `02-plan.md`/`03-implementation.md` from the base (reviewers judge diff vs spec, as `ship` does: "judge the diff against the spec yourself", [`reviewer-prompt.md:12-13`](../../plugins/feature/skills/ship/references/reviewer-prompt.md)); write the composed base once to a scratch file and put the absolute path plus a short brief in each spawn; cap each return to a fixed structured format | 2b writes one file; 2c prompts shrink to ~a paragraph; 2d parses a fixed shape | **Down the most for (i)**: removes the 4 inlined base copies (§2.1 item 2) and bounds the 4 results (item 3) | Down: base loses plan + implementation prose; baseline unchanged | Low: reviewers still read the same material in their own windows; losing the plan removes implementer bias (a stated goal in `ship`) but also the "deviation from plan" signal — keep `03-implementation.md`'s deviations section if wanted | Yes | Yes (Codex reviewers may read files; [`runtime-codex.md:35`](../../plugins/feature/skills/flow/references/runtime-codex.md)) | None — but `build/SKILL.md:199/202` ("contents", "never a reference") and the `storage-*` §7 wording change; server-native mode must write the scratch file too since artifacts are not on disk |
| **G. Bundled `/code-review` / `/simplify` / `/security-review`** | Skill call inside build | Unknown; `/code-review` scales 2–8 agents by diff size | Up on large diffs | `/simplify` mutates; `/code-review` Skill-invocability undocumented and shadowed locally (§4) | Unclear | None | Fails |
| **H. Find-then-verify** (cheap finders, per-finding scorer, as Anthropic's plugin) | Extra scorer spawns after 2c; merge consumes only ≥ 80 | Down: fewer, pre-filtered findings reach build | **Up**: more agents | Lower false-positive rate; more moving parts and more capacity pressure on Codex (four-slot surfaces per [`2026-09-08-goals-and-matt-pocock.md:17`](2026-09-08-goals-and-matt-pocock.md)) | Yes | Possible but capacity-hostile | Adds roles |
| **I. Trim the two persona bodies** (`security-engineer`, `performance-engineer`) to diff-review shape | Two agent files | No change | Down a little per spawn; on Codex the body is inlined prompt text ([`runtime-codex.md:31`](../../plugins/feature/skills/flow/references/runtime-codex.md)) | Improves: removes "profile with real data" instructions a `Bash`-less reviewer cannot follow | Yes | Yes | None |

## 7. Recommendation

**Do F + I first, keep the four-role roster, and measure. Move to C only if (ii) or cost is still the complaint after F lands.** Do not adopt A or G.

Why this order:

1. The stated problem is context, and the existing measurement points inside build ([`model-selection.md:224`](model-selection.md)). The four inlined copies of the shared base in build's own spawn calls (§2.1) are, by *inference*, the largest checkpoint-attributable item in build's window, and they are removable with zero roster change, zero script change, and no coverage loss. Collapsing roles (B/C) does not touch that item at all if the base stays inlined — a two-role split with the base still inlined leaves two full copies in the window.
2. F is reversible and mode-neutral: one scratch-file write (fs-native and server-native alike, since build has `Write` and reviewers have `Read` on both runtimes), paths already being how build hands worktree roots to subagents ([`worktree.md:170-173`](../../plugins/feature/skills/build/references/worktree.md)). The only doc edits are the two "contents / never a reference" sentences at [`build/SKILL.md:199`](../../plugins/feature/skills/build/SKILL.md) and [`:202`](../../plugins/feature/skills/build/SKILL.md) and `storage-fs.md`/`storage-server.md` §7.
3. The 400-word / fixed-shape return cap is the one part of Pocock's design that transfers cleanly and bounds item 3 of §2.1 without touching coverage. Pair it with a normalized severity vocabulary so the merge stops silently translating `WARNING` → `IMPORTANT`.
4. Add the missing **Spec axis** to `code-reviewer`'s suffix (missing/partial requirements, scope creep, quoting the AC). This is a coverage gain at no token cost and closes the one lens where Pocock's skill beats build.
5. E (`performance-engineer` → `sonnet`, optionally `effort: medium` on the two scan roles) is a cost lever, not a context lever; it is independent and already argued in `model-selection.md`. It requires amending the `CLAUDE.md:263-269` rule and has no Codex effect.

Trade-offs accepted: F keeps four harness baselines (~4 × 32k on Claude per the measured floor) — (ii) stays high until the roster shrinks; C is the follow-on that halves it while keeping an independent second pass, at the price of editing `check-runtime-contract.sh:57-69`, the `CLAUDE.md` tables, and two agent bodies. B (one reviewer) is the cheapest on (ii) but gives up the only cross-check the dedupe step encodes, with no quality data to justify it yet.

What to measure to confirm, on the same M-or-larger ticket both arms (headless recipe per the lessons log, as in the prior A/B):

- Build-window peak (`input + cache_creation + cache_read` per assistant message) before/after, and specifically the token length of each `Agent` `tool_use.input.prompt` and of each Agent `tool_result` in build's transcript — the two items F targets.
- Subagent totals: per-reviewer input/output tokens and cost from the four child transcripts.
- Findings parity: count by severity and by lens tag in `04-review.md`, how many were applied vs deferred, and any post-review defects caught at the test checkpoint or PR review. Pick a ticket that is known to produce findings; the prior A/B had zero on both arms and cannot serve as a quality baseline.
- On Codex: confirm the four reviewers still read the scratch file under the read-only boundary and that no role is skipped under a four-slot surface.

## 8. Addendum (2026-09-17) — measured ship run

Source: local transcripts of one `ship FP-84 --plan-model fable --build-model opus --parallel 2` session (`~/.claude/projects/-Users-serhiinadtochii-Projects-feature-pipeline/012fe8f0-…jsonl` plus its 33 `subagents/*.jsonl` and `*.meta.json`), three tickets processed (FP-85, FP-87, FP-86). Usage summed per API message id. "Units" = input + 1.25 × cache write + 0.1 × cache read + 5 × output, the same weights for every model, so the Fable share is understated if Fable counts more against plan limits (multiplier unverified).

| Group | Share of units |
|---|---|
| Build stage subagent (3 runs, Opus, 68–116 turns, peak 288k–400k) | 33% |
| Four reviewers (12 runs, Opus) | 17% |
| Plan stage + explorer + analyst | 18% |
| Ship implementer wrapper (3 runs, Fable) | 10% |
| Ship independent review + address (6 runs, Fable) | 14% |
| Ship orchestrator (Fable, 79 turns, peak 276k) | 8% |

Corrections to sections 2 and 7:

- **Reviewer prompts are small.** Measured spawn prompts were 3.5k–6k characters (about 1k–1.5k tokens). The shared base reached reviewers by path, not as inlined contents, so "base inlined four times in build's window" did not occur in this run. Option F's main saving is already in effect.
- **The per-agent floor is the fixed cost.** First-turn context before any work: about 46k tokens for every restricted-tool role (reviewers, explorer, analyst) and about 84k–89k for every `general-purpose` child (stages, ship wrapper, ship reviewer, address). Of that, about 26k is instruction files: the repo `CLAUDE.md` (about 15.6k) plus the user-level SuperClaude imports (about 10.6k). The floor is written once per agent and re-read on every turn; across 34 agents and about 840 turns it is roughly a quarter of the run's units (estimate).
- **Reviewer cost is floor plus their own file reading.** Reviewer peaks were 115k–192k against a 46k start, in 6–25 turns each.
- **The largest single item is the build loop itself**: turns × context, not nesting. One build stage read 29.8M cached tokens over 116 turns.

## 9. Addendum (2026-09-17) — what fills the build stage's window

Source: the same session's build-stage transcripts (`subagents/agent-a1ce35a10f6124e6d.jsonl` for FP-86, `agent-aa90ff57d8ab86b0d.jsonl` for FP-85, `agent-a8bf5cfe5cb1d5c98.jsonl` for FP-87). Token sizes are characters ÷ 4, so they are approximate and undercount code.

**FP-86 build: 116 turns, window 89k → 400k.** About half of all tokens re-read over the run are the 89k start floor carried through 116 turns; the rest is growth.

- Start floor, from the transcript's attachment records: instruction files about 27.7k, system prompt and tool schemas about 17.5k, skill listing 6.7k, deferred-tool list 4k, agent listing 3k.
- Growth, about 311k: model output about 147k (about 60k visible as Edit/Write/Bash arguments and text, the remainder thinking — that thinking stays in the window is an inference from the growth total), tool results about 51k, file-change notices after edits about 18k, the build skill body about 13k loaded at turn 2, queued subagent results about 11k.
- Costliest single items by size × remaining turns: the build skill body (13k held for 114 turns), one 10.6k read of an oversized tool result at turn 4, a 6k Write at turn 24.

**Turn count.** FP-86 had 84 Bash calls out of 116 turns: 43 ran checks or tests, 20 read files through `cat`/`sed`, 12 read git state, 4 wrote git/`gh`, 5 waited (`sleep` polls for reviewers, each re-reading the full window). FP-85 had the same shape (42 check runs of 78 Bash calls). FP-87 ran 4 check runs in 68 turns. Check-run results are small (about 7.5k tokens total in FP-86); their cost is the turn, not the output.
