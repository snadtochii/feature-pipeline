// Preconditions for the dispatcher (CONTRACT.md §9).
//
// Checks with no side effect: `claude` and `gh` executable on PATH (a scan of
// PATH entries, never a shell `which`), `gh auth status`, Node 22 or newer,
// the configuration, the working tree clean and on the base branch, the server
// list call's result, and whether the state directory is writable. Each check
// is `{name, ok, detail}`; the list is sorted by name. Every subprocess is an
// argument vector.
//
// Private to the implementation: only dispatch.mjs is a command.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXEC_TIMEOUT_MS = 30_000;
const DIRTY_PATHS_SHOWN = 5;

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

function runArgv(command, args, { cwd, env }) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: EXEC_TIMEOUT_MS });
}

/** `git status --porcelain` is empty — untracked files count as changes. `{ ok, detail }`. */
export function gitClean(projectRoot, env) {
  const result = runArgv('git', ['-C', projectRoot, 'status', '--porcelain'], { env });
  if (result.error || result.status !== 0) {
    return { ok: false, detail: 'git status could not run' };
  }
  const lines = result.stdout.split('\n').filter((line) => line !== '');
  if (lines.length === 0) {
    return { ok: true, detail: 'working tree clean' };
  }
  const shown = lines.slice(0, DIRTY_PATHS_SHOWN).map((line) => line.slice(3));
  const more = lines.length > DIRTY_PATHS_SHOWN ? `, and ${lines.length - DIRTY_PATHS_SHOWN} more` : '';
  return { ok: false, detail: `working tree not clean: ${shown.join(', ')}${more}` };
}

/** The checked-out branch is `origin/HEAD`'s branch. `{ ok, detail }`. */
export function gitBase(projectRoot, env) {
  const head = runArgv('git', ['-C', projectRoot, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { env });
  if (head.error) {
    return { ok: false, detail: 'git could not run' };
  }
  if (head.status !== 0) {
    return { ok: false, detail: 'HEAD is detached' };
  }
  const base = runArgv('git', ['-C', projectRoot, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { env });
  if (base.error || base.status !== 0) {
    return { ok: false, detail: 'origin/HEAD not set — git remote set-head origin --auto' };
  }
  const branch = head.stdout.trim();
  const baseBranch = base.stdout.trim().replace(/^origin\//, '');
  if (branch !== baseBranch) {
    return { ok: false, detail: `on ${branch}, base branch is ${baseBranch}` };
  }
  return { ok: true, detail: `on ${branch}` };
}

/** `gh` on PATH and `gh auth status` exits 0; a failed open-PR listing fails it too. */
function ghCheck({ env, projectRoot, listing }) {
  const ghPath = onPath('gh', env);
  if (ghPath === null) {
    return { name: 'gh', ok: false, detail: 'not found on PATH' };
  }
  const auth = runArgv(ghPath, ['auth', 'status'], { cwd: projectRoot, env });
  if (auth.error || auth.status !== 0) {
    return { name: 'gh', ok: false, detail: 'gh auth status failed' };
  }
  if (listing !== undefined && !listing.ok) {
    return { name: 'gh', ok: false, detail: listing.detail };
  }
  return { name: 'gh', ok: true, detail: ghPath };
}

/**
 * The precondition list. `gh` is the open-PR listing's result (`{ok,
 * detail?}`) when one was made; `server` and `stateDir` are `{ok, detail}`;
 * `config` is the effective configuration.
 */
export function checkPreconditions({ env, projectRoot, gh, server, stateDir, config }) {
  const claudePath = onPath('claude', env);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const clean = gitClean(projectRoot, env);
  const base = gitBase(projectRoot, env);
  const checks = [
    { name: 'claude', ok: claudePath !== null, detail: claudePath ?? 'not found on PATH' },
    { name: 'config', ok: true, detail: `server-native, project ${config.project}` },
    ghCheck({ env, projectRoot, listing: gh }),
    { name: 'git_base', ok: base.ok, detail: base.detail },
    { name: 'git_clean', ok: clean.ok, detail: clean.detail },
    { name: 'node', ok: nodeMajor >= 22, detail: `v${process.versions.node}` },
    { name: 'server', ok: server.ok, detail: server.detail },
    { name: 'state_dir', ok: stateDir.ok, detail: stateDir.detail },
  ];
  return checks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
