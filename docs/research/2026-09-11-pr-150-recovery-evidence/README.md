# Recovery audit evidence

Captured on 2026-09-11 for the [B2–B5 decision-trace audit](../2026-09-11-pr-150-recovery-decision-trace-audit.md).

- `probe.cjs`: exact successful probe source, copied from the temporary audit workspace.
- `results.json`: recorded output of that probe. Request identities and content are synthetic; no credentials are included.
- `manifest.json`: inspected Git HEAD, Node version, selected source hashes, source/compiled workspace tree digests and probe/result hashes. This is a provenance record, not a hermetic dependency archive.

The probe uses the Personal Server checkout path declared near its beginning. With that checkout's existing installed dependencies and built workspace packages available, it can be run with Node:

```sh
node /Users/serhiinadtochii/Projects/feature-pipeline/docs/research/2026-09-11-pr-150-recovery-evidence/probe.cjs
```

It opens a loopback listener and creates an owned temporary fixture. A restricted sandbox may require permission for the listener; it must not be redirected to a live server. The probe clears inherited `PERSONAL_SERVER_*` settings in its own process, uses a private working/data directory and unpredictable credentials, and cleans the directory and application on exit. It transpiles API source in memory with the repository's SWC configuration. It uses real application providers and migrations; guard/store wrappers only record calls before delegating to the original methods.

The output is an observation report. Its assertions establish login, fixture import, wrong-freeze refusal, resulting accepted state and snapshot properties; several matrix statuses are intentionally reported for inspection rather than hard-coded as expected behavior. A fixed implementation can therefore produce different matrix output without making every difference an assertion failure. The probe is not a production regression suite or a complete security test.

The successful run used Node v24.18.0. Earlier setup attempts exposed a harness/compiler mismatch, a sandbox listener restriction and a mismatched synthetic login origin; those are not product findings. The final harness used the production SWC configuration and a matching loopback origin. A missing required confirmation field was then retained as a separate negative case because its 500 response had a source-confirmed filter cause.

Coverage limits: selected anonymous/assistant/human requests only; no full connector matrix, browser cross-site attack, maximum-size memory test, full historical build reproduction, fresh whole-project test run, live recovery or crypto audit. Existing compiled workspace packages were used and hashed, not rebuilt. Snapshot byte counts may change with schema changes. The manifest intentionally does not capture package-manager caches, credentials or user data.
