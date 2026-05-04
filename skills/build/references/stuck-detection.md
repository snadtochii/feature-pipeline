# Stuck Detection

Build runs as a single continuous loop with no cross-stage rewinds. To prevent infinite spinning, build watches for the patterns below in its own conversation transcript and enforces a hard turn ceiling as a backup. Stuck detection runs entirely in conversation — turn count and pattern hashes are derived from the transcript, not persisted to disk.

## What counts as a "turn"

One full assistant response (one model turn). Not one tool call (a single review checkpoint dispatches four parallel `Task` calls in one turn). Not one full implement → review → test cycle (a cycle takes many turns).

## Turn-counter mechanic

At the start of every implement / review / test iteration, build emits a `Turn N/25` line. The count is recoverable from transcript inspection — read the most recent visible `Turn N/25` line and compare to the budget.

The hard ceiling is **25 turns per build invocation**. On hitting `Turn 26`, exit with `verdict: stuck` regardless of semantic-pattern detection.

**Compaction caveat.** If Claude Code summarizes/compacts the conversation mid-loop, the turn counter visibly resets — older `Turn N/25` lines drop out of the working transcript. Defer to the most recent visible `Turn N/25` line; if compaction happened, the budget effectively renews. This is acceptable: compaction means the loop has produced enough work to fill the context window, and starting fresh with the artifacts already on disk (`03-implementation.md`, `04-review.md`, `05-tests.md`) is the right posture.

## Semantic patterns

The hybrid stop rule (per the redesign's Q4-b decision) treats these patterns as primary and the 25-turn ceiling as belt-and-suspenders. Either trigger fires `verdict: stuck`. Watch the transcript for:

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

## On detection

Exit the build loop with `verdict: stuck`. Write `06-summary.md` describing:
- The detected pattern (which of the five above, or "turn cap exceeded")
- The last 3-5 iterations' actions, briefly
- A suggested next move for the user (e.g., "fix the import path manually then re-run with `--continue`", or "the plan's step N may need a smaller break-down")

Surface the human gate per `build/SKILL.md`'s Verdict Semantics section. The user picks: accept-as-partial, continue-with-hint (re-enter the loop with a user note, fresh 25-turn budget), or abort.
