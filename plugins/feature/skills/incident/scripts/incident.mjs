#!/usr/bin/env node
// feature incident log reader: `incident.mjs`.
// The contract this command implements is ../references/log-query.md — verbs,
// flags, the configuration keys it reads, the credential sources and their
// origin binding, the query file, the output documents and the exit codes.
// This header explains mechanics only.
//
// Usage:
//   incident.mjs preflight --project-root <abs-path> [--repo <dir-name>]
//   incident.mjs query --project-root <abs-path> --run <run> --start <RFC3339> --end <RFC3339>
//                      [--limit <n>] [--direction forward|backward]
//   incident.mjs --self-test
// Output: exactly one sorted-key JSON document on stdout.
// Exit: 0 answered, 1 could not compute, 2 bad invocation.
//
// Zero dependencies: Node 22+ built-ins only.
// This file is the only command; lib.mjs and selftest.mjs beside it are private.

import { errorDoc, exitCodeFor, parseArgv, preflight, query, render, writeOut } from './lib.mjs';

const VERBS = { preflight, query };

async function main(argv) {
  try {
    const parsed = parseArgv(argv);
    const doc = parsed.selfTest ? await (await import('./selftest.mjs')).runSelfTest() : await VERBS[parsed.verb](parsed);
    writeOut(render(doc));
    return 0;
  } catch (err) {
    writeOut(render(errorDoc(err)));
    return exitCodeFor(err);
  }
}

process.exit(await main(process.argv.slice(2)));
