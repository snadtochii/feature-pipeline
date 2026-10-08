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

import { parseArgv } from './lib/args.mjs';
import { errorDoc, exitCodeFor, render, writeOut } from './lib/output.mjs';
import { VERBS } from './lib/verbs.mjs';

async function main(argv) {
  try {
    const parsed = parseArgv(argv);
    let doc;
    if (parsed.selfTest) {
      doc = await (await import('./lib/selftest.mjs')).runSelfTest();
    } else {
      const verb = VERBS[parsed.verb];
      doc = await verb.run(verb.load(parsed.flags));
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
