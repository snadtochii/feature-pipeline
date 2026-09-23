# Validation Chain

Build runs the checks the project documents on its own edits as one `&&`-chained command per plan step, after the step's edit message — the collection is [`../SKILL.md`](../SKILL.md) §1b, the run is §1c item 3, and the chain's exact shape, with the step's handoff entry appended onto it, is [`implementation-handoff.md`](implementation-handoff.md) §5. This reference explains where the commands come from, why the chain runs per step, and why the review and close stages run a narrower set.

## Where the commands come from

Build reads the project instruction files for both runtimes — `CLAUDE.md` and `AGENTS.md` — at build start, the current runtime's primary file first (`AGENTS.md` when `$PLUGIN_ROOT` is set and `$CLAUDE_PLUGIN_ROOT` is not, else `CLAUDE.md`), then the other. It collects every check they document — lint, typecheck, and format or tests where declared:

- **Headings** — a heading counts when its text *contains* `Commands`, `Validation` or `Testing`, so `## Validation and extension checklists` matches as well as `## Commands`.
- **Inline references** — a command named in prose, such as `npm run lint`, `pnpm test`, `cargo check` or `pytest`, counts too.

A pointer to further documentation is not followed; a check the instruction files do not document is not collected. When neither file documents a command, build logs a one-line warning and implements without validation — the skill still works on a project with no documented setup.

## Why per step

The chain runs once per plan step, after the step's edit message, so each check sees a finished change set rather than the transient state between two edits of one batch — a typecheck mid-batch reports errors the next edit in the same message resolves. A formatting check runs first when the project documents one, so a check that ran before a reformat never has to run again after it. The run's output lands in the conversation that made the edits, which is where the fix happens.

## Fix scope in review and close

The collected set is build's alone. The review stage's fix step and the close stage's bounded fixes run lint and typecheck after each fix edit: a fix there touches a handful of lines, and re-running a project's whole documented set per fix is disproportionate. The divergence is intentional.

## Verdict-side handling

A red run inside the implement checkpoint is an observation the loop consumes: fix it in-context, then re-issue the same chain. A red run appends no handoff entry, so every recorded step is a green one. Validation failures do not exit the loop with a verdict; [`stuck-detection.md`](stuck-detection.md) covers the case where they repeat (action↔error repetition) and the loop cannot recover.
