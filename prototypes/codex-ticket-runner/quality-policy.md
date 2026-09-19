# Explicit quality policy

Every new run declares `quality`, even when its external skill lists are empty.
The built-in [baseline rubric](quality-rubric.md) always applies. Additional
implementation skills and reviewer rubrics are named by stable IDs and real local
paths. Relative paths resolve against the manifest (or import profile) directory.
The runner fingerprints their contents and rejects drift during the run.

```json
{
  "quality": {
    "implementation_skills": [
      {"id": "project-tdd", "path": "/absolute/path/to/tdd/SKILL.md"}
    ],
    "review_rubrics": [
      {"id": "project-maintainability", "path": "/absolute/path/to/maintainability-rubric.md"}
    ],
    "required_checks": [
      {"name": "typecheck", "argv": ["npm", "run", "typecheck"], "timeout": 300}
    ]
  }
}
```

These are illustrative paths/commands: use installed, applicable skills and actual
project scripts. Read implementation skills before writing code and follow their
process. For Matt Pocock's skills, a selected TDD skill can guide implementation;
a design reference can guide the reviewer. For orchestration skills such as a
multi-agent code-review wrapper, select its applicable rubric/reference as reviewer
input instead of nesting the wrapper. Do not silently replace an explicitly
requested workflow: resolve conflicts with the serial one-reviewer contract before
initialization. No skill is downloaded, installed or executed by the Python helper.

`quality.required_checks` applies to every ticket. Each ticket's `checks` adds its
own acceptance checks; duplicate names are rejected. Ticket `quality` may add
`implementation_skills` and `review_rubrics`; it cannot remove global entries.
Final epic checks remain the manifest's explicit `final_checks`. Neither the
helper nor the adapter infers lint, typecheck, browser or coverage commands.

An empty external-skills list is an explicit choice to use project guidance and
the built-in rubric. It does not waive requirements imposed by the user or project.
Choose meaningful command gates and justify their acceptance coverage in the work
report. For UI acceptance, a real current-build browser command must be declared.

## Plan and independent cases

Before implementation, use the plan and case-selection receipts in
[workflow-contract.md](workflow-contract.md). Required command gates may be added
there without rewriting the frozen manifest. Their names must remain unique.
The selected reviewer chooses failure cases independently, then assesses the
implemented assertions at final review.

## Work receipt

After implementation, obtain `context` and save this JSON outside the checkout.
Use actual values from that context; provide substantive Markdown in the prose
fields. Then call `work REPORT`. Update it after every source change.
After checks finish, replace pending-check wording with actual results/log paths
and submit the refreshed receipt before review; same-tree checks remain valid.

```json
{
  "ticket": "DEMO-1",
  "tree": "actual current tree SHA",
  "quality_fingerprint": "actual value from context",
  "skills_used": ["project-tdd"],
  "plan_digest": "actual value from context",
  "challenge_digest": "actual value from context",
  "behavior_evidence": [
    {"obligation": "case:request-refused", "check": "unit",
     "evidence": "Actual test/assertion location and what it establishes; execution recorded in the acceptance map."}
  ],
  "summary": "Describe the implemented behavior and material decisions.",
  "acceptance_evidence": "Map every child acceptance criterion and applicable parent constraint to code and verification; state pending checks honestly."
}
```

`behavior_evidence` must cover every boundary, reuse and case ID in context,
using its assigned check name. Replace the illustrative entry above with actual
obligations. The helper derives the plan text from the recorded approach.
`skills_used` must account for exactly the selected implementation IDs. A current
work receipt is required alongside checks and review to commit. The structured plan and work fields become
the feature adapter's `02-plan.md` and `03-implementation.md`; a self-reported plan
or acceptance claim does not substitute for passing commands or independent review.

The reviewer must similarly return the exact selected `rubrics_applied` IDs and
`quality_fingerprint`; see [review.md](review.md). The helper rejects missing IDs
and mismatched snapshots. It cannot prove the model read a file or applied a rule;
the reviewer must assess actual code quality and evidence, and report any gap.
