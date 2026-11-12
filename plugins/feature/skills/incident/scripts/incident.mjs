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
//                      [--request-id <id> [--id-field <name>]]
//   incident.mjs search --project-root <abs-path> --run <run> --scope repo|incidents|tickets
//                       [--repo <dir-name>] [--output lines|files]
//   incident.mjs --self-test
// Output: exactly one sorted-key JSON document on stdout.
// Exit: 0 answered, 1 could not compute, 2 bad invocation.
//
// Zero dependencies: Node 22+ built-ins only.
// This file is the only command; lib.mjs, search.mjs and the selftest*.mjs
// modules beside it are private, as are the plugin's shared script modules
// they import.

import { exitCodeFor, render, writeOut } from '../../../scripts/lib/output.mjs';
import { errorDoc, parseArgv, preflight, query } from './lib.mjs';
import { search } from './search.mjs';

const VERBS = { preflight, query, search };

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
