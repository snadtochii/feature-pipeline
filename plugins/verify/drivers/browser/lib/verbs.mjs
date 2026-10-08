// The verb table (CONTRACT.md §5–§10).
//
// One entry per verb holds everything about it: the flags it takes, which are
// required, which are mutually exclusive, how its input files are read and
// validated before anything runs (so an invocation error exits 2 with nothing
// started, CONTRACT.md §3), and the module that runs it — loaded only when that
// verb runs. Adding a verb is adding an entry.
//
// Private to the implementation: only cli.mjs is a command.

import { validateEntry } from './entry.mjs';
import { readJsonFile, validateSteps } from './steps.mjs';

export const VALUE = 'value';
export const BOOL = 'bool';

const asGiven = (flags) => ({ ...flags });

export const VERBS = {
  launch: {
    flags: { entry: VALUE },
    required: ['entry'],
    load: (flags) => ({ ...flags, entry: validateEntry(readJsonFile(flags.entry, 'entry')) }),
    run: async (input) => (await import('./lifecycle.mjs')).launch(input),
  },
  doctor: {
    flags: { session: VALUE },
    required: [],
    load: asGiven,
    run: async (input) => (await import('./doctor.mjs')).doctor(input),
  },
  drive: {
    flags: { session: VALUE, steps: VALUE, evidence: VALUE },
    required: ['session', 'steps', 'evidence'],
    load: (flags) => ({ ...flags, steps: validateSteps(readJsonFile(flags.steps, 'steps')) }),
    run: async (input) => (await import('./drive.mjs')).drive(input),
  },
  evidence: {
    flags: { session: VALUE },
    required: ['session'],
    load: asGiven,
    run: async (input) => (await import('./evidence.mjs')).evidence(input),
  },
  cleanup: {
    flags: { session: VALUE, all: BOOL },
    required: [],
    exactlyOne: ['session', 'all'],
    load: asGiven,
    run: async (input) => (await import('./lifecycle.mjs')).cleanup(input),
  },
  install: {
    flags: {},
    required: [],
    load: asGiven,
    run: async (input) => (await import('./install.mjs')).install(input),
  },
};
