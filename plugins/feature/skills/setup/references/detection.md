# Repository Detection

Contract for `scripts/detect.sh`, the setup skill's detection script. The script inspects one repository, never writes to it, and prints one JSON document: the evidence a setup dialogue proposes `claudedocs/tickets/config.yaml` defaults from, plus the facts the dialogue asks about. The script implements every rule below; the fixtures under `fixtures/`, run by `scripts/check-setup-detect.sh` at the plugin repository's root, exercise them.

**Null, never a guess.** Every fact starts as `null` and is set only by positive evidence the repository declares — a manifest script, a tool section, a make target, a lockfile, a published port, an ignore rule. A missing script, target or section maps to `null`; the script never fills a gap with a conventional default. A consumer treats `null` as "ask or leave unset", never as "use the usual value".

## §1 Invocation

```bash
bash "<plugin-root>/skills/setup/scripts/detect.sh" [<root>]
```

- `<root>` defaults to the current directory. It is canonicalized (`pwd -P`) before any rule runs, so symlinked temp paths resolve.
- Requirements: `bash` 3.2 or newer and `jq`. `git` is optional — without it, the repository counts as not a git repository (§4).
- Invoke it through `bash` by path, as above: the call works identically on every runtime whatever file mode the plugin cache preserved.
- The script has no knowledge of ticket storage modes and reads no `config.yaml` contents.

## §2 Exit codes

| Exit | Meaning | stdout |
|---|---|---|
| `0` | Detection ran | The JSON document |
| `1` | `jq` is not installed | Nothing; one `[detect]` line on stderr |
| `2` | `<root>` is not a directory, or more than one argument | Nothing; one `[detect]` line on stderr |

A per-rule failure — malformed `package.json`, an unreadable file, a failing `git` call — degrades only that rule's facts to `null`; the run still exits `0` with a complete document. A detector that printed nothing is therefore always distinguishable from one that found nothing.

## §3 Output schema

Keys are emitted in this order:

```json
{
  "prefix": "PVA",
  "package_manager": "pnpm",
  "validate": { "lint": "pnpm run lint", "typecheck": "pnpm run typecheck", "test": "pnpm run test" },
  "test": { "url": "http://localhost:5173", "start": "pnpm run dev" },
  "worktree_setup": "pnpm install --frozen-lockfile",
  "worktreeinclude_candidates": [".env", ".env.local", "claudedocs/tickets/config.yaml"],
  "claudedocs_ignored": true,
  "instruction_files": {
    "CLAUDE.md": { "exists": true, "commands_section": true },
    "AGENTS.md": { "exists": false, "commands_section": false }
  },
  "compose_file": null,
  "workspace_shape": "single-repo"
}
```

| Key | Type | Rule |
|---|---|---|
| `prefix` | string or null | §5 |
| `package_manager` | `pnpm` \| `yarn` \| `bun` \| `npm` \| `uv` \| `poetry` \| null | §6 |
| `validate.lint`, `validate.typecheck`, `validate.test` | string or null | §7 |
| `test.url`, `test.start` | string or null | §8 |
| `worktree_setup` | string or null | §9 |
| `worktreeinclude_candidates` | array of strings, or null outside git | §10 |
| `claudedocs_ignored` | boolean, or null outside git | §10 |
| `instruction_files` | object, both keys always present | §11 |
| `compose_file` | string (path relative to the root) or null | §8 |
| `workspace_shape` | `single-repo` \| `multi-repo` | §4 |

## §4 Repository shape and the git test

- **`workspace_shape`** follows [discover's workspace-shape predicate](../../discover/SKILL.md): `multi-repo` iff the root has no `.git` entry and at least one immediate child directory has one (a `.git` file, as in a git worktree, counts). Immediate children only, no recursion. Anything else is `single-repo`.
- **Git-derived facts** (§10) require `git` on `PATH` and `git -C <root> rev-parse --is-inside-work-tree` printing `true`. A subdirectory of a repository passes this test; its shape still comes from the `.git` entries alone. Outside a git repository every git-derived field is `null` — not `false`, not `[]`.
- **The two tests are independent.** A multi-repo root is usually not inside any repository, so its git-derived fields are `null` and the root-level manifest rules usually find nothing. The exception is a root that sits inside a repository without its own `.git` and has a child holding one (a submodule or worktree): the shape is `multi-repo`, as discover sees it, while the git test passes and the git-derived fields are set from the enclosing repository. A consumer wanting per-repository facts runs the script once per child: `bash …/detect.sh <root>/<child>`.

## §5 `prefix`

From the root directory's name: split on `-` and `_`, drop every non-alphanumeric character from each word, drop empty words. Two or more words → the uppercase initials (`feature-pipeline` → `FP`, `pnpm-vite-app` → `PVA`); one word → its first two characters uppercased (`workspace` → `WO`, a one-character word → that character). Nothing left → `null`.

## §6 `package_manager`

- **Node** — decided when `package.json` exists and parses as a JSON object. The lockfile at the root picks the manager, first match wins: `pnpm-lock.yaml` → `pnpm`; `yarn.lock` → `yarn`; `bun.lockb` or `bun.lock` → `bun`; `package-lock.json` → `npm`; no lockfile → `npm`. The manifest's `packageManager` field is not read.
- **Malformed `package.json`** — every Node-derived fact (`package_manager`, the Node `validate` commands, the dev-script `test` facts, `worktree_setup`) is `null`; the other rules still run.
- **Python** — only when Node did not decide it: `uv.lock` → `uv`, else `poetry.lock` → `poetry`. A Python project with neither lockfile has `package_manager: null`.

## §7 `validate`

Each of `lint`, `typecheck` and `test` is resolved on its own, from the first source that declares it, in this order:

1. **`package.json` scripts** — a non-empty string script named `lint`; for `typecheck` the first present of `typecheck`, `type-check`, `tsc`; `test`. The command is `<package_manager> run <script-name>` for every manager (`npm run test`, `pnpm run lint`, `bun run test`). The `run` form is uniform because a manager's built-in of the same name is a different command — `bun test` is bun's own test runner, not the project's `test` script.
2. **`pyproject.toml` tool sections** — a table header line: `[tool.ruff]` or `[tool.ruff.<sub>]` → `ruff check .` for `lint`; `[tool.mypy…]` → `mypy .`, else `[tool.pyright…]` → `pyright`, for `typecheck`; `[tool.pytest…]` → `pytest` for `test`. With `uv.lock` present the command is prefixed `uv run `; else with `poetry.lock` present, `poetry run ` — lockfile evidence of how the project runs its tools.
3. **`Makefile` targets** — an unindented rule line naming the target among the space-separated words before its first `:` (`test:`, or a multi-target rule such as `lint typecheck:`), where that colon does not start a `:=` or `::=` assignment and no `=` precedes it → `make <target>`.

No source declares it → `null`.

These are the same commands a `## Commands` snippet in `CLAUDE.md` / `AGENTS.md` would carry, so the per-step validation build collects from those files ([validation-hook.md](../../build/references/validation-hook.md) §Layer 2) and this document agree. Only `lint` and `typecheck` belong in `config.yaml`'s `validate:` block, the per-edit hook's deliberately narrower set; `test` feeds the `## Commands` snippet alone and has no `config.yaml` key.

## §8 `test` and `compose_file`

- **Dev script** — when `package.json`'s `dev` script names `vite` as a word → `http://localhost:5173`; else names `next` as a word → `http://localhost:3000`. An explicit numeric port in the script (`--port N`, `--port=N`, `-p N` as separate tokens) replaces the framework default; a non-numeric one (`--port $PORT`) leaves the default. A URL derived here sets `test.start` to `<package_manager> run dev`. Any other dev server → no evidence.
- **Compose** — `compose_file` is the first existing of `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml` (Docker's own lookup order), relative to the root, reported whenever one exists. When the dev script produced no URL, `test.url` is `http://localhost:<H>` for the first host port published in the file, in file order, inside a block-style `ports:` list: short syntax `H:C`, `IP:H:C` or `H:C/proto`, quoted or not; long syntax `published: H`. Container-only entries (`"80"`), port ranges, interpolated values (`${PORT:-8080}:80`) and flow-style lists are skipped. `test.start` stays `null` — the compose stack is what the dialogue offers as an isolated-stack `test.start`, from `compose_file`.
- No evidence → `test.url` and `test.start` are both `null`.

## §9 `worktree_setup`

The detected Node manager's frozen-lockfile install: `pnpm install --frozen-lockfile`; `npm ci` (only with `package-lock.json` — a frozen install without a lockfile always fails); `yarn install --frozen-lockfile` when `yarn.lock`'s header reads `yarn lockfile v1`, else `yarn install --immutable`; `bun install --frozen-lockfile`. Anything else, Python managers included → `null`.

## §10 Ignore facts

- **`claudedocs_ignored`** — `git -C <root> check-ignore -q claudedocs/` (the trailing slash lets a directory-only pattern match a directory that does not exist yet): exit `0` → `true`, `1` → `false`, anything else → `null`.
- **`worktreeinclude_candidates`** — a fixed allowlist is the only thing scanned: `.env`, `.env.*`, `.envrc` at the root, and `claudedocs/tickets/config.yaml`. A name is listed when it is a regular file and `git -C <root> check-ignore -q -- <name>` succeeds. Tracked files are never reported ignored by `git check-ignore`, so they are never candidates. Names are sorted in byte order (`LC_ALL=C`). The script tests existence and asks git; it never opens, reads or prints the content of any allowlisted file.

## §11 `instruction_files`

For each of `CLAUDE.md` and `AGENTS.md` at the root: `exists` is whether the file exists; `commands_section` is whether it holds a Markdown ATX heading (one to six `#`) whose text contains `commands`, `validation` or `testing`, case-insensitively, outside fenced code blocks — the heading predicate build's Layer 2 collects checks from ([validation-hook.md](../../build/references/validation-hook.md) §Layer 2). A missing file has both fields `false`.

## Boundaries

- **Read-only** — no file is written, created or modified; no command from the repository is executed.
- **No secret reads** — dotenv-family and `config.yaml` contents are never read. The files whose contents are read are `package.json`, `pyproject.toml`, `Makefile`, the compose file, the first lines of `yarn.lock`, and the two instruction files.
- **No network, no `yq`** — manifests are parsed with `jq` and line-oriented `grep` / `awk`; forms outside the ones named here map to `null`.
- **Deterministic** — the same tree yields the same document, keys in §3's order and candidates sorted.
