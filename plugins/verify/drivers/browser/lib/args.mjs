// Argument parsing for the browser driver.
//
// Long flags only, `--flag value` and `--flag=value` both accepted; an unknown,
// repeated or misused flag is an invocation error (CONTRACT.md §4). Path flags
// must be absolute and session ids well-formed — both checked here, before any
// verb runs. Each verb's flags come from the verb table in verbs.mjs.
//
// Private to the implementation: only cli.mjs is a command.

import path from 'node:path';

import { UsageError } from './output.mjs';
import { validateId } from './session.mjs';
import { BOOL, VERBS } from './verbs.mjs';

const PATH_FLAGS = new Set(['entry', 'steps', 'evidence']);

/**
 * Parse argv (without node and the script path).
 * Returns `{ selfTest: true }` or `{ verb, flags }`.
 */
export function parseArgv(argv) {
  if (argv.length === 0) {
    throw new UsageError(`no verb given (expected one of: ${Object.keys(VERBS).join(', ')}, or --self-test)`);
  }
  if (argv[0] === '--self-test') {
    if (argv.length > 1) {
      throw new UsageError('--self-test takes no verb and no other flag');
    }
    return { selfTest: true };
  }
  const verb = argv[0];
  if (verb.startsWith('-')) {
    throw new UsageError(`no verb given before ${verb.split('=')[0]}`);
  }
  if (!Object.hasOwn(VERBS, verb)) {
    throw new UsageError(`unknown verb: ${verb}`);
  }
  const spec = VERBS[verb];
  const flags = {};
  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--self-test') {
      throw new UsageError('--self-test takes no verb and no other flag');
    }
    if (!arg.startsWith('--') || arg.length === 2) {
      throw new UsageError(`unexpected argument: ${arg}`);
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = Object.hasOwn(spec.flags, name) ? spec.flags[name] : undefined;
    if (kind === undefined) {
      throw new UsageError(`unknown flag for ${verb}: --${name}`);
    }
    if (Object.hasOwn(flags, name)) {
      throw new UsageError(`flag given twice: --${name}`);
    }
    if (kind === BOOL) {
      if (eq !== -1) {
        throw new UsageError(`--${name} takes no value`);
      }
      flags[name] = true;
      i += 1;
      continue;
    }
    let value;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
      i += 1;
    } else {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        throw new UsageError(`--${name} needs a value`);
      }
      value = argv[i + 1];
      i += 2;
    }
    if (value === '') {
      throw new UsageError(`--${name} needs a value`);
    }
    flags[name] = value;
  }
  for (const name of spec.required) {
    if (!Object.hasOwn(flags, name)) {
      throw new UsageError(`${verb} needs --${name}`);
    }
  }
  if (spec.exactlyOne) {
    const given = spec.exactlyOne.filter((name) => Object.hasOwn(flags, name));
    if (given.length !== 1) {
      throw new UsageError(`${verb} needs exactly one of ${spec.exactlyOne.map((n) => `--${n}`).join(', ')}`);
    }
  }
  for (const name of Object.keys(flags)) {
    if (PATH_FLAGS.has(name) && !path.isAbsolute(flags[name])) {
      throw new UsageError(`--${name} must be an absolute path: ${flags[name]}`);
    }
  }
  if (Object.hasOwn(flags, 'session')) {
    validateId(flags.session);
  }
  return { verb, flags };
}
