// Exit and signal teardown for the dispatcher.
//
// `installTeardown` must be the first thing the entry does: the `exit` handler
// it registers has to run before any handler registered later (registration
// order is run order). Hooks — the lock release, a run's best-effort `stopped`
// record — are added with `addTeardown` and run once each, newest first, on
// normal exit, on a thrown error's exit, and on SIGINT, SIGTERM or SIGHUP. A
// signal runs the hooks, prints {"error": "interrupted by <SIGNAL>"} and exits 1
// (CONTRACT.md §11).
//
// Private to the implementation: only dispatch.mjs is a command.

import { EXIT_CANNOT_COMPUTE, emit } from './output.mjs';

export const TERMINATION_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const hooks = [];
let installed = false;

/** Register the exit handler and the signal handlers. Idempotent. */
export function installTeardown() {
  if (installed) {
    return;
  }
  installed = true;
  process.on('exit', () => {
    runTeardown('process exit');
  });
  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, () => {
      const reason = `interrupted by ${signal}`;
      runTeardown(reason);
      emit({ error: reason });
      process.exit(EXIT_CANNOT_COMPUTE);
    });
  }
}

/**
 * Add a hook, called with the teardown reason. Returns a disposer that removes
 * the hook without running it.
 */
export function addTeardown(fn) {
  hooks.push(fn);
  return () => {
    const index = hooks.lastIndexOf(fn);
    if (index !== -1) {
      hooks.splice(index, 1);
    }
  };
}

/**
 * Run every registered hook once, newest first. A hook that throws does not
 * stop the others: the process is already on its way out. Draining the list is
 * what makes a second call — a second signal, then the exit handler — a no-op.
 */
export function runTeardown(reason) {
  while (hooks.length > 0) {
    const fn = hooks.pop();
    try {
      fn(reason);
    } catch {
      // Best effort.
    }
  }
}
