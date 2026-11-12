#!/usr/bin/env node
// feature address-review thread-state reader: `threads.mjs`.
// The rule this command implements is ../../review/references/pr-comments.md
// §9 (marker grammar and thread states); the document it prints and its exit
// codes are ../SKILL.md Step 2. This header explains mechanics only.
//
// Usage:
//   threads.mjs --repo <owner>/<repo> --pr <number>
//   threads.mjs --self-test
// Output: exactly one sorted-key JSON document on stdout.
// Exit: 0 answered, 1 could not compute, 2 bad invocation.
//
// Zero dependencies: Node 22+ built-ins only.
// This file is the only command; lib.mjs and selftest.mjs beside it are
// private, as are the plugin's shared script modules they import.

import { exitCodeFor, render, writeOut } from '../../../scripts/lib/output.mjs';
import { errorDoc, parseArgv, readAll, shapeDocument, threadStates } from './lib.mjs';

async function main(argv) {
  try {
    const parsed = parseArgv(argv);
    const doc = parsed.selfTest ? await (await import('./selftest.mjs')).runSelfTest() : shapeDocument(threadStates(readAll(parsed)), parsed);
    writeOut(render(doc));
    return 0;
  } catch (err) {
    writeOut(render(errorDoc(err)));
    return exitCodeFor(err);
  }
}

process.exit(await main(process.argv.slice(2)));
