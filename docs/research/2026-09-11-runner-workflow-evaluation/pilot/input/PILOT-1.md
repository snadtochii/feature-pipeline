# PILOT-1: Atomic batch rename through the catalog service

Add CatalogService.rename_many(owner, edits), where edits is a nonempty list of
objects with id, label and expected_revision. Return detached updated snapshots
in input order. A successful batch changes each named owned record once and
increments its revision once. Reject duplicate IDs and invalid labels. A missing
or foreign record raises Unavailable with the same public message; stale revision
raises Conflict. Any rejected batch leaves every row and previously cached read
unchanged. Successful batches refresh affected cached reads while retaining
unrelated cache entries. Preserve existing single-rename behavior. Keep database
ownership and service boundaries described in AGENTS.md, with no new dependency.
Tests must exercise this feature together with existing cached reads and scoping.
Implement only catalog.py and test_catalog.py. No delivery beyond local commit.
