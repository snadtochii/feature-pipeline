# Setup — server-native Storage Mechanics

Canonical logic for setup's ticket-store and config writes in server-native storage mode. Read when the storage mode chosen at the skill body's mode question (Process step 5) is server-native — an fs-native run never needs this file. Referenced by `setup`. Sections are numbered so the skill body cites `§N`.

## §1 Ground rules

- **Tickets are rows on the personal server**, reached through the `pipeline_*` tools ([`../../flow/references/storage-server.md`](../../flow/references/storage-server.md)). `claudedocs/tickets/config.yaml` stays local in this mode: it holds the mode marker and the project's execution config, never ticket data.
- `config.yaml` is model-read with `Read` and changed in place with `Edit`. The mode-neutral write rules — key order, quoting, insertion, never deleting a key — are the skill body's Process step 6; this file adds only the keys this mode owns.
- Every value written is a path, a command, a name or the project UUID. No secret is read or written.

## §2 Ticket store

- Setup creates no local ticket store in this mode. The project's tickets live on the server, and nothing under `claudedocs/tickets/` other than `config.yaml` is written.

## §3 Config file

- The keys this mode owns are the marker: `mode: server-native` plus `project: <server-project-uuid>` — the UUID every `pipeline_*` tool takes verbatim as `project_id`. A `project` value that is not a UUID is a config error per [`../../flow/references/storage.md`](../../flow/references/storage.md) §Mode detection.
- An existing `mode:` / `project:` pair is never rewritten.

## §4 ID allocation

- Setup allocates no ID and creates no ticket. The server allocates IDs at create time from the registry-configured prefix, so the `prefix` key affects nothing in this mode and setup does not ask it.
