---
name: explore
description: "Open-ended Socratic exploration of an idea when you don't yet know the outcome. Asks probing questions one at a time with a recommended answer per question. Grounds in the codebase only when the conversation is about code. Three exits — leave with no artifact, save the conversation as a note, or promote to a feature ticket via /feature:discover. Use when 'let's explore', 'I want to think through X', 'poke holes in this', 'not sure yet'. NOT for features ready to spec — use /feature:discover instead."
disable-model-invocation: true
allowed-tools:
  - Read
  - Glob
  - Grep
  - Bash
  - TodoWrite
  - Skill
argument-hint: "[topic]"
---

# Explore

Open-ended Socratic exploration of an idea. The output is shared understanding — not necessarily a file.

Use when the user has a vague idea and wants to be probed, surface gaps, or "think out loud" with help. If they already know they want a ticket, redirect to `/feature:discover`. If they have an existing plan and want it stress-tested rather than formed, this skill isn't the right fit — suggest using other approaches.

## Arguments

```
/feature:explore $ARGUMENTS
```

- `$ARGUMENTS` — optional rough idea, topic, or pasted context (text, file references, screenshots). If empty, ask the user what's on their mind before starting Q1.

## Cadence

Ask probing questions ONE at a time, depth-first. Each answer informs the next question. After each user answer, restate what you understood in one line before asking the next question.

For every question, propose your recommended answer with a one-line rationale, in this format:

```
N. <question>
   **Default**: <your proposed answer> — <rationale>
```

If a question genuinely has no defensible default (pure preference, business judgment, personal taste), flag it explicitly: `**Default**: (no default — your call)`. Don't fabricate a recommendation when you don't have one.

Match depth to the idea. Simple ideas may resolve in 3–5 questions; coupled or ambiguous ones may take many more. Don't pad. Don't survey.

## Grounding

If a question can be answered by exploring the codebase, explore it instead of asking. Use Read, Grep, Glob, and Bash for lightweight grounding.

Do **NOT** spawn the `code-explorer` subagent. If grounding needs grow past a few file reads — multi-file architecture sweep, dependency tracing across features — that's the signal to suggest promoting to `/feature:discover`, which has Phase 2 codebase exploration designed for that scope.

For non-code ideas (life plans, business decisions, learning paths), don't reach for grounding tools at all — just run the dialogue.

## Three Exits

The session ends when the user signals one of three exits. **Never proactively ask "should we save this or leave it?"** — the user drives closure.

### Exit 1: Leave (no artifact)

Signals: "ok done", "let me think about it", "that's enough", "thanks", silence.

Action: end the session. No file written. A brief one-line acknowledgment is fine.

### Exit 2: Save the conversation as a note

Signals: "save this", "note this", "save the session", "let's note it", or any explicit save command the user invokes.

Action: do **nothing programmatically**. `/explore` does not write notes itself and does not ship a note-saving mechanism. If the user has a note-saving skill or workflow installed separately, it will pick up these signals on its own and read the conversation directly. Don't invoke anything, don't announce metadata, don't pre-synthesize. Stay out of the way.

If the user has no note-saving workflow, the save signals are no-ops on `/explore`'s side — the conversation stays in chat. Say so plainly if asked, and offer to print a synthesis to chat (the mid-session checkpoint mechanism below) so the user can copy it manually.

### Exit 3: Promote to a feature ticket

Signals: "make this a ticket", "promote this", "let's spec this", "turn this into a ticket". (If the user explicitly invokes `/feature:discover` themselves, that fires `/discover` directly — `/explore` doesn't need to detect it.)

Action:

1. **Announce metadata for one-shot confirmation:**
   ```
   Promoting to /feature:discover.
   - Project: <auto-detect from cwd or ask>
   - Topic: <one-line summary of the idea from conversation>
   Confirm, edit, or cancel?
   ```

2. **On confirmation, invoke `/feature:discover`** via the Skill tool with these args (verbatim, with the topic substituted at the end):

   ```
   [continuation from /explore session — the prior conversation contains a Socratic exploration of this idea. Run your FULL flow including Phase 2 codebase exploration. For Phase 3, use the "Very detailed input" branch: ask gap questions only — covering both (a) topics not yet covered in /explore and (b) NEW questions surfaced by Phase 2 codebase findings. Phase 2's job to reveal new questions remains intact and valuable.] <topic>
   ```

3. **Do not pre-synthesize** the conversation into the args. `/discover` has access to the same conversation context (same agent, same session) and reads it directly. Pre-synthesis would flatten the nuance `/discover` needs to identify gaps.

## Mid-session Checkpoint

If the user says "summarize what we covered" / "recap" / similar, print a synthesis to chat without writing any file. This is a content-checkpoint hatch — useful for review before triggering an exit.

Don't volunteer this — only do it on explicit request.

## Important Rules

- **Never pre-synthesize** for either exit. The downstream skill (note-saver or `/discover`) synthesizes from the live conversation.
- **Never proactively ask "save or leave?"** — user-driven closure only.
- **One question at a time**, with a recommended default per question.
- **Read what the user hands you.** If the input contains file references, screenshots, or pasted code, read them before asking Q1.
- **Don't write files yourself.** The dialogue is the deliverable. Files come from the chosen exit, not from `/explore` directly.
- **Don't run the codebase explorer subagent.** That's `/discover`'s job; if exploration needs are that big, suggest promoting.

## Examples

```bash
# Vague idea, no commitment
/feature:explore I'm thinking about reworking how rate limiting works

# With pasted context
/feature:explore (with auth.service.ts pasted) Should I split this?

# No topic — agent asks "what's on your mind?"
/feature:explore
```
