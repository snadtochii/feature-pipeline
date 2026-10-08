// Process helpers shared by the driver's modules (CONTRACT.md §9).
//
// Liveness, start-time identity and group teardown for the processes launch
// starts. Teardown sends SIGTERM only, then waits a bounded time, so a process
// that stops its own children on the signal can finish. SIGKILL is never sent.
//
// Private to the implementation: only cli.mjs is a command.

import { spawnSync } from 'node:child_process';

/** Resolve after `ms` milliseconds. */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when a process with this id exists (EPERM counts as alive). */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Wait until `pid` is gone or `waitMs` passes; true when it is gone. */
export async function waitExit(pid, waitMs) {
  const deadline = Date.now() + waitMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(200);
  }
  return true;
}

/**
 * The start time `ps` reports for `pid`, as an opaque string, or null when the
 * process does not exist. A recorded process id is signalled only while its
 * start time still matches, so a recycled id is never mistaken for it.
 */
export function processStart(pid) {
  if (!isAlive(pid)) {
    return null;
  }
  // A fixed locale, so launch and cleanup format the same time identically.
  const res = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  const text = res.status === 0 ? res.stdout.trim() : '';
  return text === '' ? null : text;
}

/** SIGTERM a process group led by `pid`, then wait up to `waitMs` for the leader. */
export async function stopGroup(pid, waitMs) {
  if (!isAlive(pid)) {
    return true;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    if (err.code !== 'ESRCH') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  }
  return waitExit(pid, waitMs);
}
