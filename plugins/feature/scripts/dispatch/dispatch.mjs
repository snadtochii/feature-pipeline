#!/usr/bin/env node
// feature night dispatcher: `dispatch.mjs`.
// The contract this command implements is CONTRACT.md beside it — verbs, flags,
// configuration keys, selection and cap rules, the output documents, the exit
// codes, the lock and the state layout. This header explains mechanics only.
//
// Usage:
//   dispatch.mjs plan --project-root <abs-path>
//   dispatch.mjs run  --project-root <abs-path>
//   dispatch.mjs --self-test
// Output: exactly one sorted-key JSON document on stdout.
// Exit: 0 answered (nothing to dispatch included), 1 could not compute, 2 bad invocation.
//
// Zero dependencies: Node 22+ built-ins only.
// Everything under lib/ is private; this file is the only command.

import { parseArgv } from './lib/args.mjs';
import { emit, errorDoc, exitCodeFor } from './lib/output.mjs';
import { installTeardown } from './lib/teardown.mjs';

// First, before anything can register its own exit handler: the lock release
// rides on this one.
installTeardown();

/** The verb table; each module loads only when its verb runs. */
const VERBS = {
  plan: async (input) => (await import('./lib/plan.mjs')).plan(input),
  run: async (input) => (await import('./lib/run.mjs')).run(input),
};

async function main(argv) {
  try {
    const parsed = parseArgv(argv);
    const doc = parsed.selfTest
      ? await (await import('./lib/selftest.mjs')).runSelfTest()
      : await VERBS[parsed.verb]({ projectRoot: parsed.projectRoot });
    emit(doc);
    return 0;
  } catch (err) {
    emit(errorDoc(err));
    return exitCodeFor(err);
  }
}

// Exit explicitly: an open socket or timer must not keep the process alive
// after the one document is written.
process.exit(await main(process.argv.slice(2)));
