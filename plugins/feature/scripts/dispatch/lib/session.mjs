// One `claude -p` child session (CONTRACT.md §10, Child sessions).
//
// The child is spawned from an argument vector, never a shell string, in its
// own process group, with the project root as its working directory and the
// environment passed through unchanged. Its stdout is read line by line: each
// line is appended to the session log through a held descriptor, then folded
// into the session facts. Its stderr goes straight to a file descriptor and is
// never buffered. Nothing it prints reaches the dispatcher's stdout.
//
// Two caps end a session early — the wall-clock cap and the rate-limit retry
// cap — through one escalation: SIGINT to the child, SIGTERM after a grace
// period, SIGKILL to its whole process group after a further backstop. Once
// the child exits, any process still holding its stdout is killed with the
// group after a short drain window. `stopNow` is the synchronous form the
// teardown hook calls when the dispatcher itself is signalled.
//
// Private to the implementation: only dispatch.mjs is a command.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';

import { applyLine, newSessionFacts } from './stream.mjs';

export const GRACE_MS = 120_000;
export const KILL_MS = 30_000;
export const DRAIN_MS = 5_000;
export const STOP_WAIT_MS = 10_000;
const STOP_KILL_WAIT_MS = 2_000;
const POLL_MS = 100;

/** Send `signal` to `pid` (a negative pid names its group); a gone process is not an error. */
function signal(pid, sig) {
  try {
    process.kill(pid, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `pid` is still running. A process that exited but has not been
 * reaped — the event loop cannot reap while a synchronous wait blocks it —
 * shows as a zombie, which counts as gone.
 */
function running(pid) {
  if (!signal(pid, 0)) {
    return false;
  }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
  if (ps.error || ps.status !== 0) {
    return ps.error !== undefined;
  }
  const stat = ps.stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
}

/** Block the thread for `ms` without spinning. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Append `text` to `fd`, looping over partial writes. */
function appendAll(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    offset += fs.writeSync(fd, buf, offset, buf.length - offset);
  }
}

function openLog(file) {
  const fd = fs.openSync(file, 'a', 0o600);
  fs.fchmodSync(fd, 0o600);
  return fd;
}

/**
 * Start one session. `command` is the absolute path of `claude` (null when it
 * is not on PATH); `argv` its arguments. Returns a handle:
 * `{ done, facts(), stopNow(waitMs) }`. `done` resolves to
 * `{ exit_code, signal, cap, spawnError, facts, log, stderr }` — `exit_code`
 * is `128 + n` for a child ended by signal n, null when it never ran; `cap` is
 * `timeout`, `rate_limit`, `interrupted` or null. The log files are opened
 * before the spawn, so an unwritable log directory throws here.
 */
export function startSession({
  command,
  argv,
  cwd,
  env,
  logPath,
  stderrPath,
  capMs,
  graceMs = GRACE_MS,
  killMs = KILL_MS,
  drainMs = DRAIN_MS,
  maxRateLimitRetries = Number.POSITIVE_INFINITY,
  onFacts = () => {},
}) {
  const logFd = openLog(logPath);
  let errFd;
  try {
    errFd = openLog(stderrPath);
  } catch (err) {
    fs.closeSync(logFd);
    throw err;
  }

  let facts = newSessionFacts();
  let cap = null;
  let exited = false;
  const timers = new Set();
  const later = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  };
  const clearTimers = () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
  };
  const closeFds = () => {
    for (const fd of [logFd, errFd]) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  };
  const base = { log: logPath, stderr: stderrPath };

  const notStarted = (code) => {
    closeFds();
    const done = Promise.resolve({ ...base, exit_code: null, signal: null, cap: null, spawnError: code, facts });
    return { done, facts: () => facts, stopNow: () => facts };
  };
  if (command === null) {
    return notStarted('ENOENT');
  }

  let child;
  try {
    child = spawn(command, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', errFd] });
  } catch (err) {
    return notStarted(err.code ?? 'error');
  }
  const pid = child.pid;

  const escalate = (reason) => {
    if (cap !== null || exited) {
      return;
    }
    cap = reason;
    signal(pid, 'SIGINT');
    later(() => {
      signal(pid, 'SIGTERM');
      later(() => signal(-pid, 'SIGKILL'), killMs);
    }, graceMs);
  };

  const done = new Promise((resolve) => {
    let exitInfo = null;
    let linesDone = false;
    let spawnError = null;
    const finish = () => {
      if (exitInfo === null || !linesDone) {
        return;
      }
      clearTimers();
      closeFds();
      resolve({ ...base, ...exitInfo, cap, spawnError, facts });
    };

    child.on('error', (err) => {
      spawnError = err.code ?? 'error';
      if (pid === undefined) {
        exited = true;
        exitInfo = { exit_code: null, signal: null };
        linesDone = true;
        finish();
      }
    });

    if (pid !== undefined) {
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      lines.on('line', (line) => {
        appendAll(logFd, `${line}\n`);
        const applied = applyLine(facts, line);
        facts = applied.facts;
        onFacts(facts);
        if (applied.rateLimitEvent && facts.rate_limit_retries > maxRateLimitRetries) {
          escalate('rate_limit');
        }
      });
      lines.on('close', () => {
        linesDone = true;
        finish();
      });
      child.on('exit', (code, sig) => {
        exited = true;
        clearTimers();
        const signo = sig ? os.constants.signals[sig] : undefined;
        exitInfo = { exit_code: code ?? (signo !== undefined ? 128 + signo : null), signal: sig ?? null };
        // A process that inherited stdout keeps the stream open past the exit:
        // give it a moment, then end the whole group.
        // A destroyed stream emits no `end`, so the reader is closed by hand.
        later(() => {
          signal(-pid, 'SIGKILL');
          child.stdout.destroy();
          lines.close();
        }, drainMs);
        finish();
      });
      later(() => escalate('timeout'), capMs);
    }
  });

  const stopNow = (waitMs = STOP_WAIT_MS) => {
    if (pid === undefined || exited) {
      return facts;
    }
    cap = cap ?? 'interrupted';
    signal(pid, 'SIGINT');
    for (let waited = 0; waited < waitMs && running(pid); waited += POLL_MS) {
      sleepSync(POLL_MS);
    }
    if (running(pid)) {
      signal(pid, 'SIGTERM');
      for (let waited = 0; waited < STOP_KILL_WAIT_MS && running(pid); waited += POLL_MS) {
        sleepSync(POLL_MS);
      }
    }
    signal(-pid, 'SIGKILL');
    return facts;
  };

  return { done, facts: () => facts, stopNow };
}
