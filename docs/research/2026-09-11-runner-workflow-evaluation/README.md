# Workflow revision evidence

See the [evaluation report](../2026-09-11-runner-workflow-revision.md) for claims and limitations.

## Runner verification

- [Initial suite](initial-suite.log): 47 tests; one bound-instruction drift failure during editing.
- [Exact publication-test rerun](publication-rerun.log): passed after instructions stabilized.
- [Core tests](core-tests.log): 21 passed.
- [Quality tests](quality-tests.log): eight passed.
- [Workflow tests](workflow-tests.log): eleven passed, including the final rerun-log preservation change.
- [Historical replay script](historical_replay.py) and [results](historical-results.json): three expected failures from production-source probes prevented commit. The script requires the local Personal Server checkout and its dependencies; this is not a standalone portable fixture.

## Independent new-ticket pilot

- [Ticket](pilot/input/PILOT-1.md) and [manifest](pilot/input/manifest.json).
- [Original source](pilot/base-source/catalog.py), [final source](pilot/final-source/catalog.py), [tests](pilot/final-source/test_catalog.py), and [project rules](pilot/final-source/AGENTS.md).
- [Plan](pilot/run/plan.json), [independent cases](pilot/run/challenge.json), [work evidence](pilot/run/work.json), and [final review](pilot/run/review.json).
- [Initial reviewer packet](pilot/run/challenge-packet.json) and [final reviewer packet](pilot/run/review-packet.json).
- [Unit log](pilot/run/evidence/PILOT-1/d91b7485ad21d9167ece3fad1934e9c22dbe967c/unit.log) and [final integration log](pilot/run/evidence/epic/d91b7485ad21d9167ece3fad1934e9c22dbe967c/integration.log).
- [Final state](pilot/run/state.json), [finish receipt](pilot/run/finish-result.json), and [implementer observations](pilot/run/pilot-notes.md).
- [Copied runtime entry point](pilot/runner/runner.py) and [provenance hashes](provenance.json).

Archived receipts deliberately retain their original absolute paths and identifiers. This directory is an evidence archive, not a relocated resumable run. The original fixture is `/private/tmp/runner-workflow-pilot`; the runtime snapshot differs from the final prototype by the later log-preservation change documented in the report. No credentials or live user data were used in the fixture.
