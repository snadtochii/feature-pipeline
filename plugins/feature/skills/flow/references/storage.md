# Storage — Mode Detection and Per-Mode References

A project runs in exactly one of two **storage modes** — **fs-native** (tickets are files under `claudedocs/tickets/`) or **server-native** (tickets are rows on a personal server, reached through the pipeline MCP tools). This file owns mode detection and names the reference to read for each storage concern in the detected mode; the procedures themselves live in those files.

## Mode detection

Detect the mode **once per skill run**, locally, from `claudedocs/tickets/config.yaml` (model-read with the `Read` tool — never `yq`/`jq`):

- `mode: server-native` **and** `project: <server-project-id>` both present → **server-native**.
- Missing file, missing `mode` key, or `mode: fs-native` → **fs-native**.
- `mode: server-native` with no `project` key → **config error**: stop with a message naming the missing key. Never proceed in either mode on a half-declared server project.
- Any other `mode` value → stop and ask the user. Never guess a storage backend.

The detected mode applies to **every storage operation** in the run — no per-operation mixing, no mid-run re-detection. An fs-native run performs no server call of any kind, detection included: the personal server lives in a separate `server-native` connector plugin that an fs-native machine does not install (see [`../../../docs/advanced.md`](../../../docs/advanced.md#storage-mode-and-the-personal-server)). `config.yaml` itself — and `hooks/validate.sh`, which parses only its `validate:` block — stays a local file in both modes: project execution config plus the mode marker, not ticket data.

## Per-mode references

Read exactly one file per concern, for the detected mode:

| Concern | fs-native | server-native |
|---|---|---|
| Storage operations | [`storage-fs.md`](storage-fs.md) | [`storage-server.md`](storage-server.md) |
| Ticket resolution | [`ticket-resolution-fs.md`](ticket-resolution-fs.md) | [`ticket-resolution-server.md`](ticket-resolution-server.md) |
| State transitions | [`state-transitions-fs.md`](state-transitions-fs.md) | [`state-transitions-server.md`](state-transitions-server.md) |
| Lessons log | [`lessons-log-fs.md`](lessons-log-fs.md) | [`lessons-log-server.md`](lessons-log-server.md) |
| Epic walk (flow only) | [`epic-walk-fs.md`](epic-walk-fs.md) | [`epic-walk-server.md`](epic-walk-server.md) |
