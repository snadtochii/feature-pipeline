// The run lock (CONTRACT.md §11).
//
// `mkdir <git-common-dir>/feature-dispatch.lock` is the atomicity: it creates
// the directory or fails, with no window between the two. The owner file
// records the run id and start time; a lock younger than 24 hours is live, an
// older one is taken over with exactly one more `mkdir`. A lock whose owner is
// missing or unparseable is aged by the directory's modification time and taken
// over once that is a minute old — long past the moment between a live run's
// `mkdir` and its owner write. A takeover is exclusive: it first `mkdir`s the
// reclaim marker beside the lock, and only while holding it re-reads the owner,
// removes the stale directory, creates it again and writes the new owner, so a
// second run taking over the same stale lock is refused rather than removing
// the first one's fresh lock. A marker left by a run that died inside that
// moment is never aged away — aging it would reopen the same race — so it
// refuses every takeover until it is removed by hand. Release removes the lock
// only while the owner still names this run, and rides on the teardown
// registry so it runs on every exit path and on SIGINT, SIGTERM and SIGHUP.
//
// Private to the implementation: only dispatch.mjs is a command.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ComputeError } from './output.mjs';
import { RUN_ID_RE, writeAtomic } from './state.mjs';
import { addTeardown } from './teardown.mjs';

export const LOCK_NAME = 'feature-dispatch.lock';
export const RECLAIM_NAME = `${LOCK_NAME}.reclaim`;
export const STALE_MS = 24 * 60 * 60 * 1000;
export const UNREADABLE_GRACE_MS = 60 * 1000;

/** The repository's absolute git common directory. */
export function gitCommonDir(projectRoot, runner = spawnSync) {
  const result = runner('git', ['-C', projectRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
  if (result.error) {
    throw new ComputeError(result.error.code === 'ENOENT' ? 'git not found on PATH' : `git could not run (${result.error.code ?? 'error'})`);
  }
  const dir = (result.stdout ?? '').trim();
  if (result.status !== 0 || !path.isAbsolute(dir)) {
    throw new ComputeError('project root is not a git repository');
  }
  return dir;
}

/** The lock's owner as `{ runId, started, startedMs }`, or null when missing or unparseable. */
export function readOwner(lockDir) {
  let text;
  try {
    text = fs.readFileSync(path.join(lockDir, 'owner'), 'utf8');
  } catch {
    return null;
  }
  const runId = /^run_id: *(\S+) *$/m.exec(text)?.[1];
  const started = /^started: *(\S+) *$/m.exec(text)?.[1];
  const startedMs = started === undefined ? Number.NaN : Date.parse(started);
  if (runId === undefined || !RUN_ID_RE.test(runId) || Number.isNaN(startedMs)) {
    return null;
  }
  return { runId, started, startedMs };
}

/** `mkdir` the lock (or the reclaim marker) once: true when created, false when it already exists. */
function tryMkdir(dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      return false;
    }
    throw new ComputeError(`cannot create the lock ${dir} (${err.code ?? 'error'})`);
  }
}

/** Write this run's owner file into a lock directory it just created; on failure remove the directory. */
function writeOwner(lockDir, runId, now) {
  try {
    writeAtomic(path.join(lockDir, 'owner'), `run_id: ${runId}\nstarted: ${now.toISOString()}\n`);
  } catch (err) {
    fs.rmSync(lockDir, { recursive: true, force: true });
    throw new ComputeError(`cannot write the lock owner in ${lockDir} (${err.code ?? 'error'})`);
  }
}

/**
 * Take over the stale lock last seen as `owner` (or, unreadable, as `mtime`)
 * while holding the reclaim marker, and write this run's owner before the
 * marker is released. `hooks.reclaiming` runs once the marker is held (a
 * self-test seam). Throws ComputeError when another run holds the marker or
 * changed the lock since it was read.
 */
function reclaimStale({ lockDir, owner, mtime, runId, now, hooks }) {
  const markerDir = path.join(path.dirname(lockDir), RECLAIM_NAME);
  if (!tryMkdir(markerDir)) {
    throw new ComputeError(`lock takeover in progress by a concurrent run — if no dispatch run is in progress, remove ${markerDir}`);
  }
  try {
    hooks.reclaiming?.();
    const again = readOwner(lockDir);
    const unchanged =
      owner !== null
        ? again !== null && again.runId === owner.runId && again.started === owner.started
        : again === null && mtimeOf(lockDir) === mtime;
    if (!unchanged) {
      throw new ComputeError('lock taken by a concurrent run');
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
    if (!tryMkdir(lockDir)) {
      throw new ComputeError('lock taken by a concurrent run');
    }
    writeOwner(lockDir, runId, now);
  } finally {
    fs.rmSync(markerDir, { recursive: true, force: true });
  }
}

/** The lock directory's modification time, or null when it is gone. */
function mtimeOf(lockDir) {
  try {
    return fs.statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Acquire the lock for `runId`. Returns `{ lock, notes }`; throws ComputeError
 * when a live run holds it or a concurrent run wins a takeover. `hooks.stale`
 * runs once a takeover is decided and `hooks.reclaiming` once its marker is
 * held — self-test seams for concurrent takeovers.
 */
export function acquireLock({ commonDir, runId, now, hooks = {} }) {
  const lockDir = path.join(commonDir, LOCK_NAME);
  const nowMs = now.getTime();
  const notes = [];
  if (tryMkdir(lockDir)) {
    writeOwner(lockDir, runId, now);
  } else {
    const owner = readOwner(lockDir);
    const mtime = mtimeOf(lockDir);
    if (owner === null && mtime === null) {
      // Released between our mkdir and our read: one more attempt, never a loop.
      if (!tryMkdir(lockDir)) {
        throw new ComputeError('lock taken by a concurrent run');
      }
      writeOwner(lockDir, runId, now);
    } else {
      const age = owner !== null ? nowMs - owner.startedMs : nowMs - mtime;
      if (age < (owner !== null ? STALE_MS : UNREADABLE_GRACE_MS)) {
        throw new ComputeError(owner !== null ? `lock held by run ${owner.runId}` : 'lock held (owner unreadable)');
      }
      hooks.stale?.();
      reclaimStale({ lockDir, owner, mtime, runId, now, hooks });
      notes.push(
        owner !== null
          ? `took over a stale lock from run ${owner.runId} (started ${owner.started})`
          : `took over a lock with an unreadable owner (last modified ${new Date(mtime).toISOString()})`,
      );
    }
  }
  const lock = { dir: lockDir, runId, released: false, dispose: () => {} };
  lock.dispose = addTeardown(() => releaseLock(lock));
  return { lock, notes };
}

/** Whether the lock's owner still names this run. */
export function holdsLock(lock) {
  return !lock.released && readOwner(lock.dir)?.runId === lock.runId;
}

/**
 * Release the lock: remove it only while its owner still names this run.
 * Idempotent. Returns true when this call removed it.
 */
export function releaseLock(lock) {
  if (lock.released) {
    return false;
  }
  lock.released = true;
  lock.dispose();
  const owner = readOwner(lock.dir);
  if (owner === null || owner.runId !== lock.runId) {
    return false;
  }
  fs.rmSync(lock.dir, { recursive: true, force: true });
  return true;
}
