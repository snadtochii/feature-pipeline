# Prototype manifest

Keep the manifest, referenced specs and state in a durable run directory outside
the code checkout. Run state references the manifest and hashes the specs; moving
or editing them during a run requires manual reconciliation. Start on a dedicated
clean branch created from the explicitly selected base, including prerequisites.

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
  "tickets": [
    {
      "id": "DEMO-1",
      "spec": "specs/DEMO-1.md",
      "blocked_by": [],
      "paths": ["greeting.py", "test_greeting.py"],
      "checks": [
        {"name": "unit", "argv": ["python3", "-m", "unittest", "-v"], "timeout": 120}
      ]
    }
  ],
  "final_checks": [
    {"name": "integration", "argv": ["python3", "-m", "unittest", "-v"]}
  ]
}
```

Use the user's actual ticket IDs, complete declared roster, dependency edges and
accepted specs. Unresolved external dependencies must be satisfied in the starting
base before initialization; the helper accepts only dependencies within the roster.
Tie-breaking follows roster order. Missing specs, duplicate IDs and cycles fail
before implementation. `paths` are exact relative files or directory prefixes,
not glob expressions; include anticipated generated files and regressions.

Before implementation, the [workflow contract](workflow-contract.md) adds a
boundary/reuse plan and independent failure cases. These receipts may add required
checks; they cannot remove manifest gates. No additional manifest fields are needed.

Every run requires the explicit [quality policy](quality-policy.md); empty external
lists select project guidance plus the mandatory built-in review rubric. Global
required checks are added to each ticket's checks. A ticket may add a `quality`
object with implementation skills/reviewer rubrics. IDs and check names must be
unique after composition. Optional ticket `context` is an array of `{kind, path}`
references, all read by both implementer and reviewer and bound to immutable input
digests. Use [the feature adapter](feature-adapter.md) to derive these inputs from
existing feature tickets instead of manually copying their roster and context.

`commit_authorized` records authorization already established with the user.
Setting it does not override project instructions. For PR delivery set `delivery`
to `epic-pr` and add `pr_base` with the actual target branch. Local mode ends with
verified commits. No external mutations are performed by the helper's PR check.

Checks are trusted project commands as nonempty argv arrays, executed at the repo
root. Use actual required commands and fixture inputs. Each ticket needs at least
one check, and the epic needs a final integration check. Checks run serially;
default timeout is 120 seconds. Set a suitable explicit timeout for heavier checks.
Generated caches/output must follow the consuming repo's ignore policy. A check
that changes the code snapshot cannot record a pass.

For browser acceptance, declare a runnable browser test as a required check, with
an isolated current-build server/fixture managed by its command. This prototype
does not manufacture browser evidence from a textual attestation. A project without
a runnable browser test needs one or remains pending at that gate. A source-only
ticket can instead require the relevant HTTP/process/contract checks.

All gates cover the entire current tree fingerprint. This deliberately conservative
prototype invalidates all checks on a source edit; selective dependency-aware
invalidation is an extension to evaluate, not a feature claimed here.
External environment/data changes are not hashed: invalidate affected evidence with
`check NAME --rerun` (and `--final` for epic checks) before relying on it again.
The helper terminates the owned check process group on timeout, SIGTERM or Ctrl-C.
A hard kill of the runner cannot execute cleanup; inspect any surviving processes
before resuming. This is not a general service supervisor.
