# A1/B7/B8 audit evidence

Captured 2026-09-11 for the [decision-trace audit](../2026-09-11-pr-150-final-gates-decision-trace-audit.md).

Files:

- `scope.cjs` / `scope-results.json`: production SQLite store and domain commands, real migrations, two synthetic local-human scopes and actual task creation/deletion in in-memory fixtures.
- `ui.cjs` / `ui-results.json`: actual production ChatReceipt/HistoryPage components and providers rendered with installed React, TanStack Query and JSDOM; injected synthetic client responses and controlled promise timing.
- `manifest.json`: repository HEAD, Node version, selected source hashes, source/workspace-output tree digests and probe/result hashes. Not a hermetic dependency archive.

Both scripts name the inspected checkout near their beginning. With its existing installed dependencies and workspace builds available:

```sh
node /Users/serhiinadtochii/Projects/feature-pipeline/docs/research/2026-09-11-pr-150-final-gates-evidence/scope.cjs
node /Users/serhiinadtochii/Projects/feature-pipeline/docs/research/2026-09-11-pr-150-final-gates-evidence/ui.cjs
```

Neither script connects to a service. The first uses only in-memory SQLite databases; the second uses only an in-memory DOM and synthetic clients. No user data, credentials, network listener, deployment or product-source write is involved. API source uses the production SWC configuration in memory. UI source uses an in-memory TypeScript/JSX transform with the existing `@/` alias, not a Vite production build. Both use the checkout's existing compiled workspace packages rather than rebuilding them.

The output records observed behavior; assertions check selected fixture/control conditions. These are audit probes, not complete regressions asserting all desired post-fix behavior. A corrected implementation may intentionally change output or cause the current reproduction to reject a foreign call. The future product tests should assert the repaired contract.

Limits: A1 is not a multi-account HTTP exploit; the known preview ID and second trusted scope are supplied by the fixture. UI cases do not exercise a real router, browser layout/accessibility, actual network failures or backend purge. In particular, controlled parent replacement demonstrates loss of component-owned error presentation, not the exact timing of production navigation. The not-dispatched error is injected using the actual typed error class; the probe does not establish a normal user input that produces it in registration.

The UI harness's initial attempt mixed Node's global Event constructor with JSDOM events; Radix rejected that setup. The successful probe uses JSDOM Event/CustomEvent/EventTarget together. This harness error is not counted as a product defect. DOM, query caches/observers and in-memory databases are closed or cleared after the successful cases. The successful runs used Node v24.18.0.
