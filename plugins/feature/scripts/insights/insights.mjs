#!/usr/bin/env node
// feature session-insights extractor: `insights.mjs`.
// The contract this command implements is CONTRACT.md beside it — the verb,
// the transcript store it reads, the project mapping, the digest schema, the
// recognition rules, the cache, the summary document and the exit codes.
// This header explains mechanics only.
//
// Usage:
//   insights.mjs extract
//   insights.mjs --self-test
// Output: exactly one sorted-key JSON document on stdout.
// Exit: 0 answered, 1 could not compute, 2 bad invocation.
//
// Zero dependencies: Node 22+ built-ins only.
// Everything under lib/ is private; this file is the only command.

import { errorDoc, exitCodeFor, render, writeOut } from '../lib/output.mjs';
import { parseArgv } from './lib/args.mjs';

/** The verb table; each module loads only when its verb runs. */
const VERBS = {
  extract: async () => (await import('./lib/extract.mjs')).extract({ home: process.env.HOME }),
};

async function main(argv) {
  try {
    const parsed = parseArgv(argv);
    const doc = parsed.selfTest ? await (await import('./lib/selftest.mjs')).runSelfTest() : await VERBS[parsed.verb]();
    writeOut(render(doc));
    return 0;
  } catch (err) {
    writeOut(render(errorDoc(err)));
    return exitCodeFor(err);
  }
}

process.exit(await main(process.argv.slice(2)));
