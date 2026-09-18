# Catalog fixture

Keep persistence access inside CatalogStore. CatalogService owns caller scoping
and cache invalidation. Public reads return detached snapshots. Existing rename
semantics (scope isolation, revision conflict, and cache freshness) must remain.
Use Python standard library and unittest. No dependency installation or network.
Use one independent read-only reviewer per the runner skill. Commits are authorized
inside this disposable fixture branch; no remote/PR/merge is authorized.
