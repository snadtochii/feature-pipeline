// Argument parsing for the insights extractor (../CONTRACT.md §1): one verb,
// `extract`, taking no flags, or `--self-test` alone. Anything else is an
// invocation error, detected before any verb runs.
//
// Private to the implementation: only insights.mjs is a command.

import { UsageError, oneLine } from '../../lib/output.mjs';

export const VERBS = ['extract'];

const shown = (arg) => oneLine(arg).slice(0, 40);

/** Parse argv (without node and the script path) into `{ selfTest: true }` or `{ verb }`. Pure. */
export function parseArgv(argv) {
  if (argv.length === 0) {
    throw new UsageError(`no verb given (expected one of: ${VERBS.join(', ')}, or --self-test)`);
  }
  if (argv.includes('--self-test')) {
    if (argv.length > 1) {
      throw new UsageError('--self-test takes no verb and no other flag');
    }
    return { selfTest: true };
  }
  const [verb, ...rest] = argv;
  if (verb.startsWith('-')) {
    throw new UsageError(`no verb given before ${shown(verb.split('=')[0])}`);
  }
  if (!VERBS.includes(verb)) {
    throw new UsageError(`unknown verb: ${shown(verb)}`);
  }
  if (rest.length > 0) {
    throw new UsageError(`${verb} takes no arguments: ${shown(rest[0])}`);
  }
  return { verb };
}
