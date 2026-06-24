---
name: debug
description: "Reactive runtime-evidence root-cause debugger. Generates hypotheses, instruments suspect code with temporary logging to a JSONL sink, has you reproduce the bug, reads the real runtime values, applies a targeted fix behind a confirmation gate, verifies, then strips all instrumentation to a clean diff. Use when 'debug this', 'find the root cause', 'why is this failing', 'this crashes intermittently', 'track down this bug', 'this test fails and I can't tell why', 'instrument and reproduce'. NOT for building new features (use /feature:discover), NOT for static code review (that is build's review checkpoint), NOT for writing an implementation plan (use /feature:plan)."
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - TodoWrite
  - mcp__playwright__browser_console_messages
  - mcp__playwright__browser_network_requests
  - mcp__playwright__browser_snapshot
  - mcp__playwright__browser_take_screenshot
  - mcp__chrome-devtools__list_console_messages
  - mcp__chrome-devtools__take_screenshot
argument-hint: "[bug description | failing-test command | stack trace] [ticket-id]"
---

# Debug

Reactive, runtime-evidence root-cause debugger. The deliverable is a verified, minimal fix — runtime evidence over reading code.

Use when a bug resists static reasoning: race conditions, wrong runtime values, intermittent or environment-specific failures, a test that fails for reasons the code doesn't reveal. This skill instruments the suspect code with temporary logging, has the bug reproduced for real, reads what actually happened, fixes the root cause behind a confirmation gate, and strips every probe so you ship a clean diff. It is a standalone skill — a peer of `/feature:discover` and `/feature:explore`, **not** a pipeline stage. If you want a new feature, use `/feature:discover`. If you want a static read of a diff, that's build's review checkpoint.

## Arguments

```
/feature:debug $ARGUMENTS
```

- `$ARGUMENTS` — the bug, in any form: a free-text description, a failing-test command, a pasted stack trace or error, screenshots, plus optional file/area hints.
- **Optional trailing ticket ID** (e.g. `FP-9`) — when present, non-`fixed` exits persist a report into that ticket folder and a lesson is filed under the ticket's ID. Resolve it via **Step 1 only** of [`../flow/references/ticket-resolution.md`](../flow/references/ticket-resolution.md) (resolve arg → folder); do **not** apply epic refusal or blocker validation — those are pipeline concerns and this skill is not a pipeline stage.
- **Empty input** → ask: "What's the bug, and how do you reproduce it?" Don't instrument before you have a reproduction path.

## Conventions

These are fixed for the whole session; establish them once at intake.

- **Sink** — a structured JSON-lines file at `claudedocs/debug/<session>/sink.jsonl`. It is the transport for runtime evidence (the filesystem replaces a debug-server socket). `<session>` = `<UTC-yyyyMMdd-HHmmss>` standalone, or `<ticket-id>-<UTC-HHmmss>` when a ticket arg is in scope. One event per line:
  ```json
  {"ts":"<ISO8601>","marker":"<token>","hyp":<round-int>,"loc":"<file>:<line>","label":"<short-name>","value":<any-json>}
  ```
  Read it back at turn boundaries with `grep -F <marker> claudedocs/debug/<session>/sink.jsonl` — no streaming, no daemon. **The sink can hold real runtime values, so it must never be committed**: before writing the first probe, confirm the target project's `.gitignore` ignores `claudedocs/` (pipeline projects already do); if it doesn't, add the entry — or refuse to write the sink.
- **Marker** — one token per session, `DEBUG_PROBE_<8hex>` (e.g. `DEBUG_PROBE_a1b3c9f2`). It is project- and runtime-agnostic on purpose (this skill runs in arbitrary codebases). Every injected line carries the marker — inside the log call **and** in a trailing comment so comment-only edits still match. The strip assertion (`grep -rF DEBUG_PROBE_<thisHex>` → 0) keys on **this session's** token only, never the bare `DEBUG_PROBE_` prefix — a crashed prior session must not block this one's clean exit.

## The Debug Loop

Six beats (PHASE 1–6); PHASE 0 INTAKE is the precondition gate, not a beat. Beats 1–4 (hypothesize → analyze) repeat as a **bounded loop** — at most **5 hypothesis-test rounds**, with an earlier stuck-exit when a round produces no new evidence (same hypothesis re-tested, nothing learned). Every round must eliminate or confirm a hypothesis **on evidence**, never on a hunch.

### PHASE 0: INTAKE

Be permissive on the input's *form*, strict on one thing: a **reproduction path**.

1. Read whatever was handed over — description, stack trace, failing-test command, screenshots, file hints. If a ticket ID trails the args, resolve its folder (Step 1 of ticket-resolution only).
2. Establish three things before touching code: the **symptom**, the **reproduction**, and **expected vs actual**. A failing test is the ideal input — it is the repro *and* the pass/fail oracle in one.
3. If the reproduction is missing or vague, ask one focused question to get it. This is the only hard gate — do not instrument blind.

### PHASE 1: HYPOTHESIZE

Read the relevant code and generate a ranked list of root-cause theories — include the non-obvious ones (a value that's wrong upstream, a race, a stale cache, an env/config coupling), not just the first plausible read. Pick the top one or two to probe this round. Hypotheses are generated inline, in this conversation — there is no subagent fan-out in this version.

### PHASE 2: INSTRUMENT

Add temporary probes that will *prove or kill* the current hypotheses.

- **Added whole lines only.** Insert complete new statements; never wrap, edit, or inline-splice an existing expression. This is what makes the strip a clean whole-line delete with no expression reassembly.
- **Native idiom per language**, each line appending one JSONL record to the sink and carrying the marker. Examples:
  - JS/TS — `console.error(JSON.stringify({marker:"DEBUG_PROBE_a1b3c9f2",hyp:1,loc:"cart.ts:42",label:"qty",value:qty})); // DEBUG_PROBE_a1b3c9f2`
  - Python — `print(json.dumps({"marker":"DEBUG_PROBE_a1b3c9f2","hyp":1,"loc":"cart.py:42","label":"qty","value":qty}), file=sys.stderr)  # DEBUG_PROBE_a1b3c9f2`
  - Go — `fmt.Fprintln(os.Stderr, "DEBUG_PROBE_a1b3c9f2", ...) // DEBUG_PROBE_a1b3c9f2`
  - Prefer appending to the sink file directly (open-append) so multi-process repros aggregate into one stream; stderr/stdout is an acceptable fallback the user pastes back.
- **Tolerate transient validation noise.** A `PostToolUse` validator (where configured) fires on each injection and may report a lint/typecheck failure (unused import, stray log) — it exits non-fatally and never rolls the edit back. Expect this during instrument/repro; the strip phase is responsible for leaving the tree clean.

### PHASE 3: REPRODUCE

Get real runtime data, by the most automated path available:

1. **Agent-driven (default)** — if the repro runs from a shell (a failing test, a CLI, a script, a service that logs), run it via `Bash` and capture the sink / stdout directly. No human needed.
2. **Browser** — for UI bugs, the read/observe browser tools (console, network, snapshot, screenshot) are **additive-optional**: use them to observe after the bug is triggered. Driving the UI is the user's part of the loop.
3. **Human-in-the-loop fallback** — when neither applies (or the browser MCP isn't installed), print a numbered block: (1) the exact files+lines instrumented (with the marker), (2) literal repro steps to run, (3) "paste the new `sink.jsonl` lines (or the stderr) back here." Then wait for the paste before advancing. This keeps the evidence-per-round invariant intact with zero automation.

### PHASE 4: ANALYZE

Read the sink (`grep -F <marker> …`). Compare the captured values/paths/timing against what each hypothesis predicted. Eliminate or confirm — on evidence. Then:

- **Root cause found** → go to PHASE 5.
- **Not yet, rounds remain** → narrow the hypotheses with what you just learned and loop back to PHASE 2 (next round).
- **No new evidence this round, or round 5 reached** → stop; exit `exhausted` (or `cannot-reproduce` if the bug never manifested under instrumentation).

### PHASE 5: FIX (gated)

1. State the root cause and propose a **targeted, minimal fix** (typically a few lines).
2. **Confirmation gate — required.** Do not edit any non-instrumentation code until the user approves the fix. Root-cause fixes are judgment calls about *the right* fix, not just *a* fix.
3. On approval, apply the fix. The fix is real code and **never carries the marker** — it must survive cleanup.
4. **Verification is the user re-reproducing.** Have the bug re-run; only once it's confirmed gone do you proceed to cleanup. If the user declines the fix, or the right fix is risky/out-of-scope, exit `diagnosed-unfixed`.

### PHASE 6: VERIFY & CLEANUP

1. Strip **every** instrumentation line carrying this session's marker (whole-line deletes).
2. **Cleanup is not done until** `grep -rF DEBUG_PROBE_<thisHex>` returns **zero** matches **and** the project's lint/typecheck pass (where configured). Evidence, not assumption.
3. On a `fixed` exit, delete the sink directory (`claudedocs/debug/<session>/`) — the clean diff is the deliverable. On non-`fixed` exits, leave the sink in place as evidence **but warn the user it may contain sensitive runtime values, and offer to delete or redact it** — never leave it silently.

## Exits

Always report state on exit — one of four:

- **`fixed`** — root cause confirmed, fix applied + verified, instrumentation stripped. Deliverable: the clean minimal diff + a chat summary.
- **`diagnosed-unfixed`** — root cause found, but the fix is declined / risky / out of scope. Hand off the diagnosis + suggested patch.
- **`cannot-reproduce`** — the bug won't manifest under instrumentation. Honest stop — you can't debug what won't repro.
- **`exhausted`** — hypotheses kept failing / the 5-round cap hit. Report the narrowed suspects and what was ruled out.

## Output

Output is keyed to **whether there's a transferable lesson**, not to the exit type.

- **Lessons log** — if the root cause is a *project-specific, would-recur constraint that static reasoning missed* (a non-obvious runtime behavior, a config/env coupling, a framework footgun specific to this codebase), append one line to `claudedocs/tickets/_lessons.md`. Write nothing for a self-contained bug (typo, local off-by-one, missing null check) even on `fixed`. Test: "would the next ticket's planning re-derive this the hard way if it weren't written?"
  - Mirror build's producer mechanics: create the file with header `# Lessons learned across tickets` if missing, then append a line that starts with `## ` (so the existing curator parses it as an entry) and backtick any path token:
    - With a ticket in scope: `## <ticket-id> (debug): <one-sentence lesson>`
    - Standalone: `## debug/<short-slug> (<exit>): <one-sentence lesson>`
  - Don't run curation — that's build-owned; the next build verdict gate reconciles any duplicate/stale entry.
- **Non-`fixed` exits**:
  - With a ticket in scope → persist a report to `<ticket-folder>/07-debug.md`: exit type, hypotheses tried and which were eliminated/confirmed (with evidence), root cause if reached, concrete next steps. Plain report, no frontmatter.
  - Standalone → chat-only; no file.
- **`fixed` exit** → the verified diff + a chat summary; sink deleted. No report artifact.

## Important Rules

- **Reproduction before instrumentation.** The one hard gate. No repro path → ask, don't guess.
- **Evidence per round.** Each round eliminates or confirms a hypothesis from the sink, never from a hunch. No thrashing — 5 rounds max, stop early when a round teaches nothing.
- **The fix is gated; instrumentation is not.** Inject probes freely (they're temporary and cleaned up); never touch non-instrumentation code without explicit approval.
- **Never log secrets.** Instrumentation must not capture credentials, tokens, keys, passwords, or PII into the sink. When a suspect value could be sensitive, log a redacted form — its length, type, presence boolean, or a hash — never the raw value.
- **Strip is the single source of cleanup.** The validator never rolls edits back, so the tree is clean only when you've stripped to `grep`-zero and validators pass. The fix never carries the marker.
- **Additive-optional tooling.** Browser capture degrades to human-in-the-loop when the MCP servers aren't present. Never hard-depend on them.
- **Not a pipeline stage.** No folder/status transitions, no flow wiring. The optional ticket arg only routes the report + lesson; it doesn't move the ticket.

## Examples

```bash
# Free-text bug, agent will ask for a repro path if it's missing
/feature:debug the cart total is wrong when a coupon is applied twice

# A failing test is the ideal input — repro + oracle in one
/feature:debug npm test -- cart.spec.ts -t "coupon stacking"

# Pasted stack trace
/feature:debug (with stack trace pasted) intermittent NPE in checkout

# Tie the session to a ticket so a non-fixed exit lands a 07-debug.md report
/feature:debug the dark-mode toggle flickers on first paint FP-9
```
