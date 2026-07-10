# Exploration Mode — Vague or Outcome-Uncommitted Input

Canonical logic for discover's exploration mode. Read when the mode is entered — vague/outcome-uncommitted input, or the `--explore` flag (entry detection lives under "Very vague or outcome-uncommitted input" in SKILL.md). Referenced by `discover` only.

- Switch to **exploration mode**: ask probing questions **one at a time**, depth-first — each answer informs the next question, and you restate what you understood in one line before asking the next
- Every question still leads with a recommended default (per Phase 3's "Recommend, don't just elicit"); flag genuinely undefaultable ones with `**Default**: (no default — your call)`
- Ground questions in the codebase with lightweight reads (Read/Grep/Glob) when the code can answer them; defer the Phase 2 explorer spawn until the idea is concrete enough to commit to
- Help the developer narrow toward an outcome. When they commit ("make this a ticket", or the idea has clearly firmed up), run the deferred Phase 0 infrastructure setup, then continue through the normal phases with everything learned as context
- The developer may instead choose to leave without a ticket ("that's enough", "let me think about it") — end with a one-line acknowledgment and no artifact; the dialogue is the deliverable. This branch is the one carve-out from the create-don't-discuss rule (SKILL.md Important Rules). Closure is theirs to signal; never proactively ask "should we save this or leave it?"
