// Session-to-project mapping (../CONTRACT.md §3): a session's recorded working
// directory, resolved from a git worktree to its main checkout, then walked up
// to the nearest ancestor holding `claudedocs/tickets/`.
//
// Private to the implementation: only insights.mjs is a command.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GIT_TIMEOUT_MS = 10_000;
const WORKTREES_SEGMENT = /^(.+)-worktrees$/;
const TICKETS_DIR = path.join('claudedocs', 'tickets');

const UNMAPPED = Object.freeze({ project: null, project_via: null });

/** `{ gitDir, commonDir }` of the checkout holding `dir`, or null when git is missing, fails or times out. */
export function gitDirs(dir, runner = spawnSync) {
  const result = runner('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  const [gitDir, commonDir] = (result.stdout ?? '').split('\n').map((line) => line.trim());
  if (!path.isAbsolute(gitDir ?? '') || !path.isAbsolute(commonDir ?? '')) {
    return null;
  }
  return { commonDir, gitDir };
}

export function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export const defaultProbe = Object.freeze({ gitDirs: (dir) => gitDirs(dir), isDir });

function linkedWorktreeMain(cwd, probe) {
  const dirs = probe.gitDirs(cwd);
  if (dirs === null || dirs.gitDir === dirs.commonDir || path.basename(dirs.commonDir) !== '.git') {
    return null;
  }
  return path.dirname(dirs.commonDir);
}

function worktreeSibling(cwd, probe) {
  const segments = cwd.split(path.sep);
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const match = WORKTREES_SEGMENT.exec(segments[index]);
    if (match !== null) {
      const sibling = path.join(path.sep, ...segments.slice(1, index), match[1]);
      if (probe.isDir(sibling)) {
        return sibling;
      }
    }
  }
  return null;
}

function ticketsAncestor(start, probe) {
  let dir = start;
  for (;;) {
    if (probe.isDir(path.join(dir, TICKETS_DIR))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

/** `{ project, project_via }` for a recorded working directory; both null when it maps to no project. */
export function mapProject(cwd, probe = defaultProbe) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return UNMAPPED;
  }
  const normalized = path.resolve(cwd);
  let start = normalized;
  let via = 'cwd';
  if (probe.isDir(normalized)) {
    const main = linkedWorktreeMain(normalized, probe);
    if (main !== null) {
      start = main;
      via = 'worktree';
    }
  } else {
    const sibling = worktreeSibling(normalized, probe);
    if (sibling !== null) {
      start = sibling;
      via = 'worktree-sibling';
    }
  }
  const project = ticketsAncestor(start, probe);
  return project === null ? UNMAPPED : { project, project_via: via };
}

/** `mapProject` memoized per working directory, for one run. */
export function makeMapper(probe = defaultProbe) {
  const seen = new Map();
  return (cwd) => {
    if (!seen.has(cwd)) {
      seen.set(cwd, mapProject(cwd, probe));
    }
    return seen.get(cwd);
  };
}
