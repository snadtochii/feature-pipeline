# Entry binding

The rules every `verify` skill applies when it binds a `test:` entry from
`claudedocs/tickets/config.yaml`: the entry's label and root, which `test.repos` keys are
valid, which `feature_map` values are valid, and how `auth.storage_state` becomes a path
below the entry root. `verify:setup` writes with them, `verify:run` reads with them and
`verify:map-check` checks with them, so all three agree on the same entry. This file fixes the
rules only; each skill decides what a value that fails one of them does to its run.

---

## §1 Label and root

An entry is the flat `test:` block or one `test.repos.<dir>` entry.

- `<entry-label>` — `test` for the flat block, `test.repos.<dir>` for an entry.
- `<entry-root>` — `<project-root>` for the flat block, `<project-root>/<dir>` for an entry.
  The feature map, every repository search and the `start` launch directory resolve against
  it.

## §2 `test.repos` keys

A `test.repos` key is valid when it:

- matches `^[A-Za-z0-9._-]+$`;
- is neither `.` nor `..`;
- names an existing directory under `<project-root>`, checked with `Glob`.

## §3 `<map-path>`

A `feature_map` value is a valid `<map-path>` when it:

- matches `^[A-Za-z0-9._/-]+\.md$`;
- is relative and carries no empty, `.` or `..` segment;
- sits under neither `.git/` nor `claudedocs/`.

## §4 `<storage-state>`

When the entry declares `auth.storage_state`, `<storage-state>` is its path relative to
`<entry-root>`:

- the value itself, when it is relative with no `..` segment;
- the part below `<entry-root>` of an absolute value that lies under it.

Any other value lies outside `<entry-root>` and leaves `<storage-state>` unbound. A bound
`<storage-state>` is excluded from every repository search
([feature-map.md](feature-map.md) §3), and its content is never read.
