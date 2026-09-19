# Existing feature tickets

The adapter imports the filesystem layout documented by the feature plugin's
`flow` skill: solo `01-spec.md`, or an epic `prd.md` with `tasks/ID/01-spec.md`.
It uses real safe YAML parsing through Ruby, including block lists, quoted titles,
multiline values and dates. Duplicate keys and aliases fail. Source bodies and
metadata are preserved; only the ordinary top-level `status` line is rewritten.

## Prepare and import

Use a clean, dedicated consuming-project branch. The ticket subtree must be
untracked and ignored by Git under all four state directories. Import never
modifies `.gitignore`, tracked ticket files, project configuration or source code.
Keep the run directory external and durable. The full epic roster must already be
refined and materialized. Import the parent epic when targeting one of its children.

Create an external JSON profile with the existing run settings plus operational
details for exactly the active ticket IDs. IDs/dependencies/specs are imported from
the source tickets; do not duplicate them in this profile.

```json
{
  "version": 1,
  "commit_authorized": true,
  "delivery": "local",
  "quality": {
    "implementation_skills": [],
    "review_rubrics": [],
    "required_checks": []
  },
  "tickets": {
    "DEMO-1": {
      "paths": ["src/greeting.py", "tests/test_greeting.py"],
      "checks": [{"name": "unit", "argv": ["python3", "-m", "unittest", "discover", "-s", "tests"]}]
    }
  },
  "final_checks": [{"name": "integration", "argv": ["python3", "-m", "unittest", "discover", "-s", "tests"]}]
}
```

Replace the example with the actual roster, code paths, skills/rubrics and checks
derived from requirements and project guidance. Read [quality-policy.md](quality-policy.md).
The source spec remains requirements-focused; paths and commands belong here.
For an epic PR use `delivery: "epic-pr"` and the actual `pr_base`.

Run, with real absolute paths substituted:

```sh
python3 RUNNER --state RUN_DIR/state.json import-feature --repo REPO --ticket EPIC_ID --profile PROFILE
python3 RUNNER --state RUN_DIR/state.json init --repo REPO --branch BRANCH --manifest RUN_DIR/manifest.json --owner OWNER
python3 RUNNER --state RUN_DIR/state.json next
```

Import writes `manifest.json` and immutable `inputs/` snapshots in the external
run directory. It preserves prior numbered artifacts there before publication.
Initialization binds that manifest. Every ticket/review context includes its
parent PRD, shared exploration and existing plan when present, plus predecessor
specs. Runtime predecessor commits/results are included in `context` and `packet`.

The authoritative `children` roster must match materialized child specs exactly;
missing or extra children, duplicate IDs, mismatched parent linkage and dependency
cycles fail before source mutation. Previously `done` children require explicit
`completed: {"ID": "full commit SHA"}` evidence reachable from the starting HEAD.
The agent must confirm that commit represents the prerequisite; ancestry alone
does not prove its content. Cancelled children are preserved, but cannot satisfy a
blocking dependency. Unresolved external dependencies and partial/open-review
imports require reconciliation before entry. No roster is silently shortened.

## Publication and state

Publication follows runner commands automatically. The entire epic subtree moves
together; children remain under `tasks/`. Specs are re-resolved by ID after moves.

| Boundary | Filesystem result |
| --- | --- |
| `next` selects a ticket | Container moves to `in-progress/`; selected child and parent become `in-progress` |
| Recorded plan | `02-plan.md`, including structured boundary/reuse decisions |
| Current work receipt | `03-implementation.md`, including independent cases and obligation evidence |
| Check/review evidence | `05-tests.md` / `04-review.md`, with actual logs, tree and reviewer/rubric declarations |
| Active or committed ticket | `06-summary.md`, including commit, branch and honest delivery status |
| Local ticket commit, with more work pending | Child becomes `done`; epic remains `in-progress` |
| Last local commit, before final integration | Last child remains `in-progress`; epic cannot finish early |
| Successful local `finish` | Active roster and parent become `done`; subtree moves to `done/` |
| Successful epic-PR `finish` | Built children and parent become `in-review`; subtree moves to `review/`; summaries carry the shared PR URL |

In epic-PR mode, committed children stay `in-progress` until the actual final PR
is verified. Preexisting done/cancelled children retain their statuses. `verdict:`
is the first body line of result artifacts, following feature conventions. Review
artifacts describe the actual single reviewer; they do not pretend four roles ran.
Missing or stale evidence stays `partial`; no browser-skip pass is manufactured.

State is saved before publication. A failed move/write returns blocked; `sync-feature`
replays publication after the cause is resolved. Preflight detects source/context
changes, status conflicts, destination collisions, symlinks and externally edited
artifacts. A partial replay accepts only previously bound or intended output bytes.
Original inputs remain in `inputs/`; unexpected live edits are preserved.

## Compatibility boundaries

This is a filesystem adapter, not a replacement for all feature storage modes.
Tracked ticket folders, server-native storage and just-in-time roster expansion
are unsupported and fail explicitly. Project `git.commit: never` conflicts with
this profile. Project `validate:` commands must be deliberately included in the
quality policy; they are not implicitly executed or translated from shell strings.

Use this runner exclusively until delivery. Canonical filenames/status values are
compatible, but native flow/build use different resumption and review contracts.
An open epic PR is shared by its children; native `feature:sync`'s title-based
per-ticket PR lookup may not discover that relationship. This adapter does not
perform merge synchronization or mark an open PR as done. Post-merge integration
with that lookup is a separate extension; no compatibility is implied there.
