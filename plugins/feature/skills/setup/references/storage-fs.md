# Setup — fs-native Storage Mechanics

Canonical logic for setup's ticket-store and config writes in fs-native storage mode. Read when the storage mode chosen at the skill body's mode question (Process step 5), or detected by `--check`'s check 1 ([check.md](check.md) §3), is fs-native — a run in the other storage mode never needs this file. Referenced by `setup` and [check.md](check.md). Sections are numbered so the skill body cites `§N`.

## §1 Ground rules

- **The folder tree is the ticket store**, and `claudedocs/tickets/config.yaml` is its configuration. Both are local: this mode makes no network call of any kind.
- `config.yaml` is model-read with `Read` and changed in place with `Edit`. The mode-neutral write rules — key order, quoting, insertion, never deleting a key — are the skill body's Process step 6; this file adds only the keys and folders this mode owns.
- Every value written is a path, a command or a name. No secret is read or written.

## §2 Ticket store

- Create whichever of `claudedocs/tickets/backlog/`, `claudedocs/tickets/in-progress/` and `claudedocs/tickets/done/` are missing, with one `mkdir -p` naming only the missing ones. This is the tree discover's Phase 0 creates ([`../../discover/references/storage-fs.md`](../../discover/references/storage-fs.md) §2), so discover's next run finds it in place.
- `claudedocs/tickets/review/` is not pre-created: the stage that first opens a PR for a ticket creates it.
- Never move, rename or delete an existing folder or anything inside one. A folder already present is listed as unchanged in the diff.
- The directories to create are shown in the same diff as `config.yaml` and approved with it — the first write of Process step 6.

## §3 Config file

- The keys this mode owns are `prefix` and `mode`. `prefix` is the first key and is written bare (`prefix: FP`). `mode: fs-native` is written explicitly, directly after `prefix`. No `project` key is written.
- An existing `mode: fs-native` is left as is. An existing file with no `mode` key gains `mode: fs-native` after `prefix`, shown in the diff like any other added key.
- The prefix value, first match wins: an existing `prefix` in `config.yaml`; else the prefix inferred from existing ticket folders (§4); else the answer to the prefix question.

## §4 ID allocation

- Setup allocates no ID and creates no ticket.
- Discover allocates `<PREFIX>-<N>` by scanning every folder name under `claudedocs/tickets/` for the configured prefix ([`../../discover/references/storage-fs.md`](../../discover/references/storage-fs.md) §3). A prefix that already names ticket folders is therefore fixed: changing it would leave those tickets outside the scan and restart the numbering. Setup shows it as fixed and does not ask.
- With no `config.yaml` but existing ticket folders, the prefix is inferred as discover's §2 step 3 does: the `<PREFIX>` of the `<PREFIX>-<N>` folder names Process step 3 found. Folder names carrying more than one prefix leave it open: the prefix question lists them, with no default.

## §5 Doctor

- `--check`'s check 2 ([check.md](check.md) §3) in this mode. The ticket store is local, so the check reads only what check 1 already read and makes no call.
- The line is `ok storage: fs-native — local ticket store`, with `; no prefix — discover asks for one on its first run` appended when `config.yaml` has no `prefix` key. Neither case fails: discover's first run supplies a missing prefix.
