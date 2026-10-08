#!/usr/bin/env node
// verify browser driver: `cli.mjs`.
// The contract this command implements is CONTRACT.md beside it — verbs, flags,
// the step-file schema, the output documents, the exit codes, the session
// layout and the evidence-name grammar. This header explains mechanics only.
//
// Usage:
//   cli.mjs launch   --entry <abs-path>
//   cli.mjs doctor   [--session <id>]
//   cli.mjs drive    --session <id> --steps <abs-path> --evidence <abs-dir>
//   cli.mjs evidence --session <id>
//   cli.mjs cleanup  --session <id> | --all
//   cli.mjs install
//   cli.mjs --self-test
// Output: exactly one sorted-key JSON document on stdout.
// Exit: 0 answered (negative answers included), 1 could not compute, 2 bad invocation.
//
// Zero dependencies: Node 22+ built-ins only (global WebSocket for CDP).
// Everything under lib/ is private; this file is the only command.

import { validateEntry } from './lib/entry.mjs';
import { parseArgv } from './lib/args.mjs';
import { errorDoc, exitCodeFor, render, writeOut } from './lib/output.mjs';
import { readJsonFile, validateSteps } from './lib/steps.mjs';

// Each verb's module is loaded only when that verb runs.
const HANDLERS = {
  launch: async (input) => (await import('./lib/lifecycle.mjs')).launch(input),
  cleanup: async (input) => (await import('./lib/lifecycle.mjs')).cleanup(input),
  drive: async (input) => (await import('./lib/drive.mjs')).drive(input),
  evidence: async (input) => (await import('./lib/drive.mjs')).evidence(input),
  doctor: async (input) => (await import('./lib/doctor.mjs')).doctor(input),
  install: async (input) => (await import('./lib/install.mjs')).install(input),
};

// Read and validate every input file before any verb acts, so an invocation
// error exits 2 with nothing started (CONTRACT.md §3).
function loadInputs(verb, flags) {
  const input = { ...flags };
  if (verb === 'launch') {
    input.entry = validateEntry(readJsonFile(flags.entry, 'entry'));
  }
  if (verb === 'drive') {
    input.steps = validateSteps(readJsonFile(flags.steps, 'steps'));
  }
  return input;
}

async function main(argv) {
  try {
    const parsed = parseArgv(argv);
    let doc;
    if (parsed.selfTest) {
      doc = (await import('./lib/selftest.mjs')).runSelfTest();
    } else {
      doc = await HANDLERS[parsed.verb](loadInputs(parsed.verb, parsed.flags));
    }
    writeOut(render(doc));
    return 0;
  } catch (err) {
    writeOut(render(errorDoc(err)));
    return exitCodeFor(err);
  }
}

// Exit explicitly: an open socket or timer must not keep the process alive
// after the one document is written.
process.exit(await main(process.argv.slice(2)));
