# Stuck Detection

Each stage — implement (`build`), review (`review-stage`) and close (`close-stage`) — watches its own conversation transcript for the patterns below and stops at its own hard maximum as a backup. Pattern matching runs entirely in conversation; the one input read from disk is the arbiter's (pattern 6), so it judges the same state a fresh context would see.

## What counts as a "turn"

One full assistant response (one model turn) inside a stage. Not one tool call (a stage can dispatch several independent roles in one turn). Not one whole stage (a stage takes many turns).

## Hard maximum per stage

| Stage | Hard maximum | On reaching it |
|---|---|---|
| Implement (`build`) | 25 turns. Build emits `Turn N/25` at every iteration boundary; the count is recoverable from the most recent visible `Turn N/25` line. | `Turn 26` → the `## Stuck` exit, pattern `turn cap exceeded`, regardless of semantic-pattern detection. |
| Review (`review-stage`) | 2 edit-validate attempts per accepted finding. | After the second red run, revert that fix and record it `fix-failed`. |
| Close (`close-stage`) | 2 fix-loop iterations. | The remaining failures stay under `## Failed Criteria`; the verdict is `partial`. |

Each maximum counts within one invocation of its stage and is never persisted: a later invocation of the same stage starts its own.

**Scope decision — review and close.** Review's maximum is stated per accepted finding, so its stage total scales with the finding count; that count is itself fixed when the round's decisions are written, before any fix starts, so the stage stays bounded. Pattern 6 runs in implement only. Review and close fix loops apply one bounded fix at a time against a fixed finding or failed-criterion list, and cycling between two fixes there surfaces as pattern 4 (ping-pong) or as the per-finding cap reverting the fix; an arbiter spawn per fix would cost a child at the per-agent context floor to catch what those already stop.

**Compaction caveat.** If Claude Code summarizes/compacts the conversation mid-implement, older `Turn N/25` lines drop out of the working transcript. Defer to the most recent visible `Turn N/25` line; if compaction happened, the budget effectively renews. This is acceptable: compaction means the phase has produced enough work to fill the context window, and continuing from what `03-implementation.md` already records is the right posture.

## Semantic patterns

The hybrid stop rule treats these patterns as primary and each stage's hard maximum as belt-and-suspenders. Patterns 1–5 apply in all three stages; pattern 6 runs in implement only. Watch the transcript for:

### 1. Action ↔ observation repetition
Same action issued twice in a row, returning the same observation, without intervening progress. Example: re-running the same failing lint command three times because the fix didn't take. The signal is *no new information* between iterations.

### 2. Action ↔ error repetition
Same error message returned twice in a row to two different actions, without progress on the underlying cause. Example: getting "module not found" after both an install and an import-path change. The signal is *the error survives the fix*.

### 3. Agent monologue
The model produces multiple consecutive assistant turns of pure planning text without tool calls. Example: three turns of "Let me think through this..." with no Edit, Read, or Bash. The signal is *deliberation crowding out action*.

### 4. Ping-pong between two states
The model alternates between two near-identical states without converging. Example: edit → revert → edit → revert. The signal is *the system has more than one local minimum the model can't escape*.

### 5. Repeated context errors
Multiple turns in a row report a context-related error (file not found, function not in scope, can't resolve import) without the model acting to fix the context (refreshing reads, expanding scope, checking the canonical reference). The signal is *the model is operating on stale or wrong context*.

### 6. Logical oscillation (outer-loop arbiter)
Patterns 1–5 are syntactic — they detect repetition by matching tool/action/error strings. Logical oscillation is the case where each iteration is technically different (no string match) but the work isn't converging on the acceptance criteria. The model alternates between two valid-looking approaches; the fix for one step breaks another and vice versa. Fingerprint-matching can't see this; a small LLM check can.

**When the arbiter fires.** In the implement stage only: when 4 turns pass without a new `### Step` entry landing in `03-implementation.md`, build invokes one generic read-only arbiter child through the selected runtime, with this prompt (it is not a registered `feature:` role):

```
You are reviewing the recent iteration history of an implement phase on ticket <ticket-id>.

Acceptance criteria from 01-spec.md:
<ACs verbatim>

Last <N> ## Steps entries from 03-implementation.md (most recent first):
<entries>

Question: is the phase making progress toward the acceptance criteria, or cycling without convergence?
Respond with strict JSON only: {"status": "progress" | "stuck", "reason": "<one short sentence>"}
```

`<entries>` is the newest-steps view of `03-implementation.md` per [`implementation-handoff.md`](implementation-handoff.md) §6: the last `<N>` `### Step` entries under `## Steps`, newest first, or all of them when fewer exist. `## Rationale` is never included. Both inputs are on disk, so the arbiter judges what a fresh context would read.

**On `status: stuck` from the arbiter.** Treat as a stuck-pattern detection — take the stuck exit below. Record the arbiter's `reason` field verbatim in the `## Stuck` record's `reason` line; the close stage carries it into `06-summary.md` under "Detected pattern."

**On `status: progress`.** Continue normally. The verdict holds until a new `### Step` entry lands — the arbiter's only changing input — so it fires at most once per stall; the next entry re-arms it.

Cost: one generic child spawn per fire, at the runtime's per-agent context floor. The 4-turn gate keeps it from firing on the happy path, where most steps land an entry in 1–3 turns, and the hold keeps a long step from paying for it more than once.

## On detection

**Implement.** End the implement phase stuck: as build's last action, append the `## Stuck` record to `03-implementation.md` per [`implementation-handoff.md`](implementation-handoff.md) §9, naming:
- The detected pattern (which of the six above, or "turn cap exceeded")
- The last 3-5 iterations' actions, briefly
- A suggested next move for the user (e.g., "fix the import path manually then re-run `/feature:build <id> --hint \"<note>\"` (auto-resumes from the ticket's existing artifacts)", or "the plan's step N may need a smaller break-down")

The close stage then writes `06-summary.md` from that record and surfaces the human gate (`close-stage/SKILL.md`, verdict gate). The user picks: accept-as-partial, continue-with-hint (re-enter implement with a user note), or abort.

**Review and close.** Each stage takes its own stuck exit as its skill states — review returns `stuck` with the remaining findings `not attempted`; close sets the verdict `stuck` — naming the pattern.
