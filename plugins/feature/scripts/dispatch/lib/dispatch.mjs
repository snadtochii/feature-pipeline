// The dispatch step and the `sync` sessions (CONTRACT.md §10).
//
// Each admitted item runs as one `claude -p "/feature:ship <ID> --worktree"`
// child, serially, and each `sync` as one `claude -p "/feature:sync"` child.
// After a ship child exits, the item's ticket row is re-read from the server
// and its pull request's state from `gh`; the finish predicate decides the
// outcome. The run stops at the first stuck item. Results are written into the
// caller's pre-filled array as each session ends, and a teardown hook records
// the in-flight session as interrupted when the dispatcher is signalled, so
// every exit path keeps what finished.
//
// Private to the implementation: only dispatch.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';

import { decideItem, syncStatus } from './finish.mjs';
import { holdsLock } from './lock.mjs';
import { gitClean, onPath } from './preconditions.mjs';
import { prState } from './prs.mjs';
import { getTicket } from './server.mjs';
import { startSession } from './session.mjs';
import { logPathFor } from './state.mjs';
import { parseJsonResult } from './stream.mjs';
import { addTeardown } from './teardown.mjs';

export const ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MINUTE_MS = 60_000;
const REREAD_RETRY_MS = 2_000;

/** The `sync` child's argument vector. */
export function syncArgv() {
  return ['-p', '/feature:sync', '--output-format', 'json', '--permission-prompts', 'none'];
}

/** The `ship` child's argument vector for a checked item id. */
export function shipArgv(id, home) {
  if (!ITEM_ID_RE.test(id)) {
    throw new Error(`not an item id: ${JSON.stringify(String(id).slice(0, 40))}`);
  }
  return [
    '-p',
    `/feature:ship ${id} --worktree`,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-prompts',
    'none',
    '--add-dir',
    path.join(home, '.feature-pipeline'),
  ];
}

/**
 * Run one `sync` session (`phase` is `before` or `after`) and return its
 * entry: `{ ok, reason, session_id, exit_code, cost_usd, log }`. `record`
 * receives the entry when the session ends, and an `interrupted` entry when
 * the dispatcher is signalled while it runs.
 */
export async function runSync(phase, { projectRoot, env, logDir, config, record = () => {} }) {
  const logPath = logPathFor(logDir, `sync-${phase}.json`);
  const handle = startSession({
    command: onPath('claude', env),
    argv: syncArgv(),
    cwd: projectRoot,
    env,
    logPath,
    stderrPath: logPathFor(logDir, `sync-${phase}.stderr.log`),
    capMs: config.dispatch.max_session_minutes * MINUTE_MS,
  });
  const dispose = addTeardown(() => {
    const facts = handle.stopNow();
    record({ ok: false, reason: 'interrupted', session_id: facts.session_id, exit_code: null, cost_usd: null, log: logPath });
  });
  let session;
  try {
    session = await handle.done;
  } finally {
    dispose();
  }
  let text = '';
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    text = '';
  }
  const result = parseJsonResult(text);
  const status = syncStatus({ session, result });
  const entry = {
    ok: status.ok,
    reason: status.reason,
    session_id: result?.session_id ?? session.facts.session_id,
    exit_code: session.exit_code,
    cost_usd: result?.total_cost_usd ?? null,
    log: logPath,
  };
  record(entry);
  return entry;
}

/**
 * Re-read an item's ticket row and its pull request's state, retrying once:
 * `{ row, pr }`; `{ row, pr: null, unknown: true }` when the row was read but
 * the pull request's state failed twice, so the row's `pr_url` is kept; or
 * null when the row itself could not be read (a 404 included).
 */
async function readTicket(item, { projectRoot, env, access, projectId, fetchImpl, retryMs }) {
  let lastRow = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
    let got;
    try {
      got = await getTicket({ access, projectId, ticketId: item.id, ...(fetchImpl ? { fetchImpl } : {}) });
    } catch {
      continue;
    }
    if (!got.found) {
      continue;
    }
    if (got.row.pr_url === null) {
      return { row: got.row, pr: null };
    }
    lastRow = got.row;
    const pr = prState({ projectRoot, env, url: got.row.pr_url });
    if (pr.ok) {
      return { row: got.row, pr: pr.state };
    }
  }
  return lastRow === null ? null : { row: lastRow, pr: null, unknown: true };
}

/**
 * Dispatch the admitted items one after another. `ctx.results` is the
 * caller's array of `not dispatched` entries, one per item, replaced in place
 * as each session ends. Returns `{ started, stopReason }` — the number of
 * ship sessions started and why the loop stopped early, or null.
 */
export async function dispatchItems(items, ctx) {
  const { projectRoot, env, logDir, config, results, lock, notes, retryMs = REREAD_RETRY_MS } = ctx;
  const leaveRest = (from, reason) => {
    for (let j = from; j < items.length; j += 1) {
      results[j] = { ...results[j], reason };
    }
  };
  let started = 0;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (i > 0) {
      if (!holdsLock(lock)) {
        notes.push('the lock no longer names this run, so dispatch stopped');
        leaveRest(i, 'lock lost');
        return { started, stopReason: 'lock lost' };
      }
      if (!gitClean(projectRoot, env).ok) {
        leaveRest(i, 'working tree not clean');
        return { started, stopReason: 'working tree not clean' };
      }
    }
    const base = { id: item.id, kind: item.kind, tickets: [...item.tickets] };
    if (!ITEM_ID_RE.test(item.id)) {
      results[i] = { ...results[i], outcome: 'stuck', reason: 'invalid id' };
      leaveRest(i + 1, `run stopped at ${item.id}`);
      return { started, stopReason: 'invalid id' };
    }
    const logPath = logPathFor(logDir, `${item.id}.jsonl`);
    const handle = startSession({
      command: onPath('claude', env),
      argv: shipArgv(item.id, env.HOME),
      cwd: projectRoot,
      env,
      logPath,
      stderrPath: logPathFor(logDir, `${item.id}.stderr.log`),
      capMs: config.dispatch.max_session_minutes * MINUTE_MS * Math.max(1, item.tickets.length),
      maxRateLimitRetries: config.dispatch.max_rate_limit_retries,
    });
    started += 1;
    const dispose = addTeardown(() => {
      const facts = handle.stopNow();
      results[i] = {
        ...base,
        outcome: 'stuck',
        reason: 'interrupted',
        pr_url: null,
        session_id: facts.session_id,
        exit_code: null,
        cost_usd: facts.result?.total_cost_usd ?? null,
        rate_limit_retries: facts.rate_limit_retries,
        log: logPath,
      };
    });
    let session;
    try {
      session = await handle.done;
    } finally {
      dispose();
    }
    const ticket = await readTicket(item, { ...ctx, retryMs });
    const decision = decideItem({ session, ticket });
    results[i] = {
      ...base,
      outcome: decision.outcome,
      reason: decision.reason,
      pr_url: decision.pr_url,
      session_id: session.facts.session_id,
      exit_code: session.exit_code,
      cost_usd: session.facts.result?.total_cost_usd ?? null,
      rate_limit_retries: session.facts.rate_limit_retries,
      log: logPath,
    };
    if (decision.note !== null) {
      notes.push(`${item.id}: ${decision.note}`);
    }
    if (decision.outcome === 'stuck') {
      leaveRest(i + 1, `run stopped at ${item.id}`);
      return { started, stopReason: decision.reason };
    }
  }
  return { started, stopReason: null };
}
