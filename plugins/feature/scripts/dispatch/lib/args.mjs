// Argument parsing for the dispatcher.
//
// Long flags only, `--flag value` and `--flag=value` both accepted; an unknown,
// repeated or valueless flag, a positional argument, a relative path or a path
// that is not an existing directory is an invocation error (CONTRACT.md §4) —
// all detected here, before any verb runs.
//
// Private to the implementation: only dispatch.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';

import { UsageError } from './output.mjs';

/** Each verb's flags; every flag takes a value. */
export const VERB_FLAGS = {
  plan: ['project-root'],
  run: ['project-root'],
};

const REQUIRED = ['project-root'];

/**
 * Parse argv (without node and the script path).
 * Returns `{ selfTest: true }` or `{ verb, projectRoot }`.
 */
export function parseArgv(argv) {
  const verbs = Object.keys(VERB_FLAGS);
  if (argv.length === 0) {
    throw new UsageError(`no verb given (expected one of: ${verbs.join(', ')}, or --self-test)`);
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
  if (!Object.hasOwn(VERB_FLAGS, verb)) {
    throw new UsageError(`unknown verb: ${verb}`);
  }
  const allowed = VERB_FLAGS[verb];
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
    if (!allowed.includes(name)) {
      throw new UsageError(`unknown flag for ${verb}: --${name}`);
    }
    if (Object.hasOwn(flags, name)) {
      throw new UsageError(`flag given twice: --${name}`);
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
  for (const name of REQUIRED) {
    if (!Object.hasOwn(flags, name)) {
      throw new UsageError(`${verb} needs --${name}`);
    }
  }
  return { verb, projectRoot: checkDirectory('project-root', flags['project-root']) };
}

/** An absolute path to an existing directory, normalised; anything else is a UsageError. */
function checkDirectory(name, value) {
  if (!path.isAbsolute(value)) {
    throw new UsageError(`--${name} must be an absolute path: ${value}`);
  }
  let stat;
  try {
    stat = fs.statSync(value);
  } catch {
    throw new UsageError(`--${name} does not exist: ${value}`);
  }
  if (!stat.isDirectory()) {
    throw new UsageError(`--${name} is not a directory: ${value}`);
  }
  return path.resolve(value);
}
