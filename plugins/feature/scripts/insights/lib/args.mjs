// Argument parsing for the insights extractor (../CONTRACT.md §1): the verb
// `extract`, taking no flags; the verb `report`, taking `--project`,
// `--since`, `--compare` and `--cwd`, each at most once with a value; or
// `--self-test` alone. Anything else is an invocation error, detected before
// any verb runs.
//
// Private to the implementation: only insights.mjs is a command.

import path from 'node:path';

import { UsageError, oneLine } from '../../lib/output.mjs';
import { versionParts } from './compare.mjs';

export const VERBS = ['extract', 'report'];

const REPORT_FLAGS = { '--compare': 'compare', '--cwd': 'cwd', '--project': 'project', '--since': 'since' };
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_PROJECT_LENGTH = 4096;

export const shown = (arg) => oneLine(arg).slice(0, 40);

/** The UTC midnight, in ms, of a `YYYY-MM-DD` calendar date; null when the text is not a real date. */
export function dateMs(text) {
  const match = DATE.exec(text);
  if (match === null) {
    return null;
  }
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === text ? ms : null;
}

const VALUE_CHECKS = {
  compare: (value) => (versionParts(value) === null ? 'expects a version X.Y.Z' : null),
  cwd: (value) => (path.isAbsolute(value) ? null : 'expects an absolute path'),
  project: (value) => (value.length <= MAX_PROJECT_LENGTH ? null : `expects at most ${MAX_PROJECT_LENGTH} characters`),
  since: (value) => (dateMs(value) === null ? 'expects a calendar date YYYY-MM-DD' : null),
};

function parseReportFlags(rest) {
  const flags = { compare: null, cwd: null, project: null, since: null };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const key = REPORT_FLAGS[flag];
    if (key === undefined) {
      const hint = flag.startsWith('--') && flag.includes('=') ? ` (write ${shown(flag.split('=')[0])} <value>)` : '';
      throw new UsageError(`report: unknown argument ${shown(flag)}${hint}`);
    }
    if (flags[key] !== null) {
      throw new UsageError(`report: ${flag} given twice`);
    }
    const value = rest[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new UsageError(`report: ${flag} needs a value`);
    }
    const problem = VALUE_CHECKS[key](value);
    if (problem !== null) {
      throw new UsageError(`report: ${flag} ${problem}: ${shown(value)}`);
    }
    flags[key] = value;
  }
  return flags;
}

/** Parse argv (without node and the script path) into `{ selfTest: true }`, `{ verb: 'extract' }` or `{ verb: 'report', flags }`. Pure. */
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
  if (verb === 'report') {
    return { flags: parseReportFlags(rest), verb };
  }
  if (rest.length > 0) {
    throw new UsageError(`${verb} takes no arguments: ${shown(rest[0])}`);
  }
  return { verb };
}
