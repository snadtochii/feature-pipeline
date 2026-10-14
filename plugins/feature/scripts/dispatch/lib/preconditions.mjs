// Preconditions for the dispatcher (CONTRACT.md §9).
//
// Checks that need no side effect: `claude` and `gh` executable on PATH (a
// scan of PATH entries, never a shell `which`), Node 22 or newer, the server
// list call's result, and whether the state directory is writable. Each check
// is `{name, ok, detail}`; the list is sorted by name.
//
// Private to the implementation: only dispatch.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';

/** The first executable regular file `name` on `env.PATH`, or null. */
export function onPath(name, env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir === '' || !path.isAbsolute(dir)) {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Not here; keep scanning.
    }
  }
  return null;
}

/**
 * The precondition list. `gh` is the open-PR listing's result
 * (`{ok, detail?}`), `server` and `stateDir` are `{ok, detail}`.
 */
export function checkPreconditions({ env, gh, server, stateDir }) {
  const claudePath = onPath('claude', env);
  const ghPath = onPath('gh', env);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const checks = [
    { name: 'claude', ok: claudePath !== null, detail: claudePath ?? 'not found on PATH' },
    {
      name: 'gh',
      ok: ghPath !== null && gh.ok,
      detail: ghPath === null ? 'not found on PATH' : gh.ok ? ghPath : gh.detail,
    },
    { name: 'node', ok: nodeMajor >= 22, detail: `v${process.versions.node}` },
    { name: 'server', ok: server.ok, detail: server.detail },
    { name: 'state_dir', ok: stateDir.ok, detail: stateDir.detail },
  ];
  return checks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
