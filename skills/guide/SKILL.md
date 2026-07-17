---
name: guide
description: "Index of the plugin's standalone skills — what each one does and when to reach for it."
disable-model-invocation: true
allowed-tools:
  - Read
---

# Guide — which standalone skill do I want?

An index of the plugin's standalone skills. Each entry links to the skill itself — read that for how it works.

| Skill | What it is | Reach for it when |
|---|---|---|
| [`/feature:debug`](../debug/SKILL.md) | Runtime-evidence root-cause debugger — instruments, reproduces, fixes behind a confirmation gate, strips every probe | A bug resists static reasoning: race conditions, wrong runtime values, intermittent or environment-specific failures, a test that fails for reasons the code doesn't reveal |
| [`/feature:sync`](../sync/SKILL.md) | Reconciles every ticket in `backlog/`, `in-progress/`, and `review/` with its GitHub PR state — promotes merged PRs' tickets to done, flags closed-unmerged ones | You want merged reviews finalized in one pass, wherever the ticket sits; it never builds a ticket, opens a PR, or reverts anything |
| [`/feature:review`](../review/SKILL.md) | Repo-scoped PR reviewer — applies the embedded maintainability rubric to open PRs and posts signed findings | Open PRs need review comments; it never approves, merges, or edits code — addressing posted feedback is `/feature:address-review` |
| [`/feature:address-review`](../address-review/SKILL.md) | Validates a PR's review feedback — automated findings and human comments — fixes the accepted ones, posts signed replies; the mutating sibling of `/feature:review` | A PR's posted review comments need triage, fixes, and responses; interactive by default, `--auto` for the unattended path; it never approves or merges |
| [`/feature:ship`](../ship/SKILL.md) | Autonomous build → independent review → address loop over a ticket, an epic, or several solo tickets, ending at open PRs | You want end-to-end autonomy with the resulting PRs as the only human gate; to gate every ticket's merge yourself, use `/feature:flow --pr` per ticket instead |
| [`/feature:lessons-consolidate`](../lessons-consolidate/SKILL.md) | Sweeps `claudedocs/tickets/_lessons.md` to the atomic entry format via a human-approved diff | The lessons log has bloated into dense multi-topic entries; not for capturing a new lesson (build's verdict gate, debug) or reading lessons (plan and ship grep on demand) |

**Feature work is not on this list** — new features go through the pipeline: `/feature:discover` to create tickets, then `/feature:flow` (plan → build). Those skills are model-invocable and not part of this index.
