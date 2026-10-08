// App reachability and boot (CONTRACT.md §5).
//
// Reachable means an HTTP request, not following redirects, answers 200, 301,
// 302, 401 or 403 — the feature pipeline's reachable set. A boot writes the
// entry's `start` verbatim to start.sh and runs `bash start.sh` in a new
// process group; its process id is the group id teardown signals (proc.mjs),
// and only while that id still has the start time recorded at boot.
//
// Private to the implementation: only cli.mjs is a command.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { ComputeError } from './output.mjs';
import { sleep } from './proc.mjs';

export const REACHABLE = new Set([200, 301, 302, 401, 403]);

/** True when `url` answers with a status in the reachable set. */
export async function probe(url, timeoutMs = 3000) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (res.body) {
      await res.body.cancel().catch(() => {});
    }
    return REACHABLE.has(res.status);
  } catch {
    return false;
  }
}

/**
 * Start the entry's `start` command from its `cwd`, detached, output to
 * server.log. Returns the boot process id (= its process group id).
 */
export function bootServer(entry, dir) {
  let cwdOk = false;
  try {
    cwdOk = fs.statSync(entry.cwd).isDirectory();
  } catch {
    cwdOk = false;
  }
  if (!cwdOk) {
    throw new ComputeError(`app unreachable at ${entry.url} and its start directory does not exist: ${entry.cwd}`);
  }
  const script = path.join(dir, 'start.sh');
  fs.writeFileSync(script, `${entry.start}\n`, { mode: 0o700 });
  fs.chmodSync(script, 0o700);
  const log = fs.openSync(path.join(dir, 'server.log'), 'a', 0o600);
  let child;
  try {
    child = spawn('bash', [script], { cwd: entry.cwd, detached: true, stdio: ['ignore', log, log] });
  } finally {
    fs.closeSync(log);
  }
  child.on('error', () => {});
  child.unref();
  if (!Number.isInteger(child.pid)) {
    throw new ComputeError('could not start bash for the entry\'s start command');
  }
  return child.pid;
}

/** Poll `url` once a second until it answers or `timeoutSec` passes. */
export async function waitReachable(url, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (await probe(url, 2000)) {
      return true;
    }
    await sleep(1000);
  }
  return false;
}
