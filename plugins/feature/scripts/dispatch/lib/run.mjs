// The `run` verb (CONTRACT.md §10).
//
// Order of work: common dir and project name → lock → state directory →
// assess → preconditions → the dispatch step → runs.json record → report →
// release → document. Once the lock is held, every exit path records the run:
// a thrown error and a signal both write a `stopped` record and report (best
// effort) before the lock is released, through a teardown hook registered
// after the lock's own, so it runs first.
//
// Private to the implementation: only dispatch.mjs is a command.

import { assess } from './assess.mjs';
import { acquireLock, gitCommonDir, holdsLock, releaseLock } from './lock.mjs';
import { ComputeError, errorDoc } from './output.mjs';
import { checkPreconditions } from './preconditions.mjs';
import { renderReport } from './report.mjs';
import {
  appendRun,
  ensureStateDir,
  newRunId,
  projectNameFor,
  readRuns,
  stateDirFor,
  stateDirWritable,
  writeReport,
} from './state.mjs';
import { addTeardown } from './teardown.mjs';

/** An admitted item as recorded before any session ran for it. */
export function notDispatched(item) {
  return {
    id: item.id,
    kind: item.kind,
    tickets: [...item.tickets],
    outcome: 'not dispatched',
    pr_url: null,
    session_id: null,
    exit_code: null,
    cost_usd: null,
  };
}

/**
 * The dispatch step: take the admitted items one after another and return one
 * result per item, in order. It starts no session.
 */
export async function dispatchItems(items) {
  return items.map(notDispatched);
}

export async function run({ projectRoot, env = process.env, now = new Date(), fetchImpl, dispatch = dispatchItems }) {
  const commonDir = gitCommonDir(projectRoot);
  const name = projectNameFor(commonDir);
  const stateDir = stateDirFor(env.HOME, name);
  const runId = newRunId(now);
  const { lock, notes: lockNotes } = acquireLock({ commonDir, runId, now });

  const facts = {
    run_id: runId,
    project: { id: null, name },
    started: now.toISOString(),
    items: [],
    not_admitted: [],
    skips: [],
    caps: null,
    preconditions: [],
    notes: [...lockNotes],
  };
  let finalized = null;

  // Record the run once: runs.json first, then the report. Returns the report
  // path (or null) and the write failures, so a caller can surface them
  // without letting them replace the run's own error.
  const finalize = (outcome, error) => {
    if (finalized !== null) {
      return finalized;
    }
    const finished = new Date().toISOString();
    const failures = [];
    let reportPath = null;
    try {
      appendRun(stateDir, { run_id: runId, started: facts.started, finished, outcome, error, items: facts.items });
    } catch (err) {
      failures.push(`runs.json not written: ${errorDoc(err).error}`);
    }
    try {
      reportPath = writeReport(stateDir, runId, renderReport({ ...facts, finished, outcome, error }));
    } catch (err) {
      failures.push(`report not written: ${errorDoc(err).error}`);
    }
    finalized = { reportPath, failures };
    return finalized;
  };
  const disposeStopped = addTeardown((reason) => {
    finalize('stopped', reason);
  });

  try {
    ensureStateDir(stateDir);
    const runs = readRuns(stateDir);
    const result = await assess({ projectRoot, env, now, runs, fetchImpl });
    facts.project.id = result.config.project;
    facts.not_admitted = result.notAdmitted;
    facts.skips = result.skips;
    facts.caps = result.caps;
    facts.notes.push(...result.notes);
    if (!result.gh.ok) {
      throw new ComputeError(`cannot count open pull requests: ${result.gh.detail}`);
    }
    facts.preconditions = checkPreconditions({
      env,
      gh: result.gh,
      server: result.server,
      stateDir: stateDirWritable(stateDir),
    });

    let outcome;
    if (result.admitted.length === 0) {
      outcome = 'nothing to dispatch';
    } else if (!facts.preconditions.every((check) => check.ok)) {
      outcome = 'preconditions failed';
      facts.items = result.admitted.map(notDispatched);
    } else {
      facts.items = await dispatch(result.admitted, { projectRoot, env, runId, stateDir });
      outcome = 'completed';
    }

    if (!holdsLock(lock)) {
      facts.notes.push('the lock no longer names this run, so release leaves it in place');
    }
    const { reportPath, failures } = finalize(outcome, null);
    if (failures.length > 0) {
      throw new ComputeError(`run ${runId} ended ${outcome}, but ${failures.join('; ')}`);
    }
    disposeStopped();
    releaseLock(lock);
    return {
      verb: 'run',
      run_id: runId,
      outcome,
      project: facts.project,
      config: result.config.dispatch,
      items: facts.items,
      not_admitted: facts.not_admitted,
      skips: facts.skips,
      caps: facts.caps,
      preconditions: facts.preconditions,
      report: reportPath,
      notes: facts.notes,
    };
  } catch (err) {
    if (finalized === null) {
      const { failures } = finalize('stopped', errorDoc(err).error);
      if (failures.length > 0) {
        throw new ComputeError(`${errorDoc(err).error}; also ${failures.join('; ')}`);
      }
    }
    throw err;
  } finally {
    disposeStopped();
    releaseLock(lock);
  }
}
