// The `plan` verb (CONTRACT.md §9).
//
// Answers what `run` would do now: no lock, no directory, no file written,
// and no child process beyond `git rev-parse` and `gh pr list`.
//
// Private to the implementation: only dispatch.mjs is a command.

import { assess } from './assess.mjs';
import { gitCommonDir } from './lock.mjs';
import { checkPreconditions } from './preconditions.mjs';
import { projectNameFor, readRuns, stateDirFor, stateDirWritable } from './state.mjs';

export async function plan({ projectRoot, env = process.env, now = new Date(), fetchImpl }) {
  const commonDir = gitCommonDir(projectRoot);
  const name = projectNameFor(commonDir);
  const stateDir = stateDirFor(env.HOME, name);
  const runs = readRuns(stateDir);
  const result = await assess({ projectRoot, env, now, runs, fetchImpl });
  const preconditions = checkPreconditions({
    env,
    gh: result.gh,
    server: result.server,
    stateDir: stateDirWritable(stateDir),
  });
  return {
    verb: 'plan',
    project: { id: result.config.project, name },
    config: result.config.dispatch,
    candidates: result.candidates,
    admitted: result.admitted,
    not_admitted: result.notAdmitted,
    skips: result.skips,
    caps: result.caps,
    preconditions,
    notes: result.notes,
    ok: preconditions.every((check) => check.ok),
  };
}
