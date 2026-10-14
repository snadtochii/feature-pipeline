// The `run` verb (CONTRACT.md §10).
//
// Order of work: common dir and project name → lock → state and log
// directories → runs.json → configuration and server access → server probe →
// preconditions → `sync` → assess → the dispatch step → closing `sync` →
// inbox item → runs.json record → report → release → document. A failed
// precondition or a failed first `sync` stops the run before any item. Once
// the lock is held, every exit path records the run: a thrown error and a
// signal both write a `stopped` record and report (best effort) before the
// lock is released, through a teardown hook registered after the lock's own,
// so it runs first; a session's own hook, registered later still, stops its
// child and records it before that.
//
// Private to the implementation: only dispatch.mjs is a command.

import { assess } from './assess.mjs';
import { loadDispatchConfig } from './config.mjs';
import { dispatchItems, runSync } from './dispatch.mjs';
import { inboxBody, summaryLine } from './finish.mjs';
import { acquireLock, gitCommonDir, holdsLock, releaseLock } from './lock.mjs';
import { ComputeError, errorDoc } from './output.mjs';
import { checkPreconditions } from './preconditions.mjs';
import { renderReport } from './report.mjs';
import { captureInbox, findProjectName, listTickets, resolveServerAccess } from './server.mjs';
import {
  appendRun,
  ensureLogDir,
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
    reason: null,
    pr_url: null,
    session_id: null,
    exit_code: null,
    cost_usd: null,
    rate_limit_retries: 0,
    log: null,
  };
}

export async function run({
  projectRoot,
  env = process.env,
  now = new Date(),
  fetchImpl,
  dispatch = dispatchItems,
  sync = runSync,
}) {
  const commonDir = gitCommonDir(projectRoot);
  const name = projectNameFor(commonDir);
  const stateDir = stateDirFor(env.HOME, name);
  const runId = newRunId(now);
  const { lock, notes: lockNotes } = acquireLock({ commonDir, runId, now });

  const facts = {
    run_id: runId,
    project: { id: null, name },
    started: now.toISOString(),
    sync: { before: null, after: null },
    items: [],
    not_admitted: [],
    skips: [],
    caps: null,
    preconditions: [],
    notes: [...lockNotes],
  };
  let config = null;
  let access = null;
  let finalized = null;
  const fetchOption = fetchImpl ? { fetchImpl } : {};

  // Record the run once: runs.json first, then the report. Synchronous, so a
  // signal arriving during the inbox request either finds it done or does it
  // itself. Returns the report path (or null) and the write failures, so a
  // caller can surface them without letting them replace the run's own error.
  const record = (outcome, error) => {
    if (finalized !== null) {
      return finalized;
    }
    const finished = new Date().toISOString();
    const failures = [];
    let reportPath = null;
    try {
      appendRun(stateDir, { run_id: runId, started: facts.started, finished, outcome, error, sync: facts.sync, items: facts.items });
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

  // Send the inbox item, then record. Only a server-native project whose
  // access resolved, and whose server did not fail the precondition, reaches
  // the server; a capture failure is a note.
  const finalize = async (outcome, error) => {
    if (finalized !== null) {
      return finalized;
    }
    const serverFailed = facts.preconditions.some((check) => check.name === 'server' && !check.ok);
    if (serverFailed) {
      facts.notes.push('no inbox item: the server failed the precondition');
    } else if (config !== null && access !== null) {
      const draft = renderReport({ ...facts, finished: new Date().toISOString(), outcome, error });
      const summary = summaryLine({ runId, items: facts.items, skips: facts.skips, notAdmitted: facts.not_admitted });
      const project = await findProjectName({ access, projectId: config.project, ...fetchOption });
      if (project.note !== null) {
        facts.notes.push(`inbox item sent without a project: ${project.note}`);
      }
      const sent = await captureInbox({
        access,
        body: inboxBody(summary, draft),
        project: project.name,
        metadata: { project_id: config.project, run_id: runId },
        ...fetchOption,
      });
      if (!sent.ok) {
        facts.notes.push(`inbox capture failed: ${sent.detail}`);
      }
    }
    return record(outcome, error);
  };

  const disposeStopped = addTeardown((reason) => {
    if (finalized === null) {
      facts.notes.push(`no inbox item: ${reason}`);
    }
    record('stopped', reason);
  });

  try {
    ensureStateDir(stateDir);
    const logDir = ensureLogDir(stateDir, runId);
    const runs = readRuns(stateDir);
    config = loadDispatchConfig(projectRoot);
    facts.project.id = config.project;
    facts.notes.push(...config.notes);
    access = resolveServerAccess(env, env.HOME);

    let server;
    try {
      const probe = await listTickets({ access, projectId: config.project, ...fetchOption });
      server = { ok: true, detail: `HTTP ${probe.status}, ${probe.rows.length} tickets` };
    } catch (err) {
      server = { ok: false, detail: errorDoc(err).error };
    }
    facts.preconditions = checkPreconditions({ env, projectRoot, server, stateDir: stateDirWritable(stateDir), config });
    const failed = facts.preconditions.filter((check) => !check.ok);
    if (failed.length > 0) {
      throw new ComputeError(`preconditions failed: ${failed.map((check) => `${check.name} (${check.detail})`).join(', ')}`);
    }

    const sessionCtx = { projectRoot, env, logDir, config };
    const before = await sync('before', { ...sessionCtx, record: (entry) => (facts.sync.before = entry) });
    if (!before.ok) {
      throw new ComputeError(`sync failed: ${before.reason}`);
    }

    const result = await assess({ projectRoot, env, now, runs, fetchImpl, config, access });
    facts.not_admitted = result.notAdmitted;
    facts.skips = result.skips;
    facts.caps = result.caps;
    facts.notes.push(...result.notes);
    if (!result.gh.ok) {
      throw new ComputeError(`cannot count open pull requests: ${result.gh.detail}`);
    }

    let outcome = 'nothing to dispatch';
    if (result.admitted.length > 0) {
      outcome = 'completed';
      facts.items = result.admitted.map(notDispatched);
      const { started, stopReason } = await dispatch(result.admitted, {
        ...sessionCtx,
        access,
        projectId: config.project,
        fetchImpl,
        results: facts.items,
        lock,
        notes: facts.notes,
      });
      if (started > 0 && stopReason === 'rate_limit') {
        facts.notes.push('closing sync skipped after a rate-limit stop');
      } else if (started > 0) {
        const after = await sync('after', { ...sessionCtx, record: (entry) => (facts.sync.after = entry) });
        if (!after.ok) {
          facts.notes.push(`closing sync failed: ${after.reason}`);
        }
      }
    }

    if (!holdsLock(lock)) {
      facts.notes.push('the lock no longer names this run, so release leaves it in place');
    }
    const { reportPath, failures } = await finalize(outcome, null);
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
      config: config.dispatch,
      sync: facts.sync,
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
      const { failures } = await finalize('stopped', errorDoc(err).error);
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
