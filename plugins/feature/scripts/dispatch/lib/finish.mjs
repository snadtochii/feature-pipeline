// Item and run outcomes from session facts and server state (CONTRACT.md §10,
// Finish predicate and Inbox item).
//
// Pure. An item is `shipped` only when its session ended cleanly — exit 0, no
// cap fired, a `result` of subtype `success` that is not an error — and every
// ticket of the item has landed: its row re-read from the server is `in-review`
// and its pull request is open into the base branch, or merged into an
// `integration/*` branch that has an open pull request into the base branch.
// An epic's other non-terminal children, walked by the same session, must have
// landed or become terminal too. Everything else is `stuck` with the first
// reason that applies, in a fixed precedence.
//
// Private to the implementation: only dispatch.mjs is a command.

import { TERMINAL } from './select.mjs';

const SIGTERM_EXIT = 143;

export function mergedIntoIntegration(state, base, baseBranch) {
  return state === 'MERGED' && base !== baseBranch && base?.startsWith('integration/') === true;
}

function landing(ticket, baseBranch) {
  if (ticket === null || ticket.unknown === true) {
    return { reason: 'state unknown' };
  }
  if (ticket.row.status !== 'in-review') {
    return { reason: `not in review (${ticket.row.status})` };
  }
  if (ticket.pr === 'OPEN') {
    return ticket.base === baseBranch ? { reason: null, url: ticket.row.pr_url } : { reason: 'pull request open into another branch' };
  }
  if (mergedIntoIntegration(ticket.pr, ticket.base, baseBranch)) {
    return ticket.last ? { reason: null, url: ticket.last } : { reason: 'no open integration pull request' };
  }
  return { reason: 'pull request not open' };
}

function otherLanding({ id, read }, baseBranch) {
  if (TERMINAL.has(read?.row?.status)) {
    return { reason: null };
  }
  const entry = landing(read, baseBranch);
  return entry.reason === null ? entry : { reason: `child ${id} not landed: ${entry.reason}` };
}

/**
 * Decide one item. `session` is the session runner's result
 * (`{ exit_code, cap, spawnError, facts }`); `tickets` holds one re-read per
 * ticket of the item: `{ row: { status, pr_url }, pr, base, last }`, `pr` the
 * pull request's state or null, `base` its base branch, `last` the open pull
 * request from an integration branch it merged into or null, with
 * `unknown: true` when the row was read but the rest was not; or null when the
 * row could not be read. `others` holds `{ id, read }` per other non-terminal
 * child of an epic item, `read` in the same form. Returns
 * `{ outcome, reason, pr_url, note }`; a stuck item keeps the first `pr_url`
 * among its tickets' rows.
 */
export function decideItem({ session, tickets, others = [], baseBranch }) {
  const prUrl = tickets.find((ticket) => ticket?.row?.pr_url)?.row.pr_url ?? null;
  const stuck = (reason) => ({ outcome: 'stuck', reason, pr_url: prUrl, note: null });
  const facts = session.facts;
  const exit = session.exit_code;

  if (session.cap === 'timeout' || session.cap === 'rate_limit' || session.cap === 'interrupted') {
    return stuck(session.cap);
  }
  if (session.spawnError) {
    return stuck('no session');
  }
  if (exit !== 0 && facts.rate_limit_retries > 0) {
    return stuck('rate_limit');
  }
  if (exit === SIGTERM_EXIT) {
    return stuck('SIGTERM');
  }
  if (exit !== 0) {
    return stuck(`exit ${exit}`);
  }
  if (facts.session_id === null) {
    return stuck('no session');
  }
  if (facts.result === null) {
    return stuck('no result');
  }
  if (facts.result.is_error) {
    return stuck('result error');
  }
  if (facts.result.subtype !== 'success') {
    return stuck(`result ${facts.result.subtype ?? 'unknown'}`);
  }
  const denied = deniedTools(facts);
  const landings = [...tickets.map((ticket) => landing(ticket, baseBranch)), ...others.map((other) => otherLanding(other, baseBranch))];
  const unlanded = landings.find((entry) => entry.reason !== null);
  if (tickets.length > 0 && unlanded === undefined) {
    return {
      outcome: 'shipped',
      reason: null,
      pr_url: landings[0].url,
      note: denied.length > 0 ? `shipped with permission denials: ${denied.join(', ')}` : null,
    };
  }
  if (denied.length > 0) {
    return stuck('permission_denied');
  }
  return stuck(unlanded?.reason ?? 'state unknown');
}

/** The distinct denied tool names from the stream and the result, sorted. */
export function deniedTools(facts) {
  return [...new Set([...facts.permission_denied, ...(facts.result?.permission_denials ?? [])])].sort();
}

/**
 * Whether a `sync` session succeeded: `{ ok, reason }`. `session` is the
 * runner's result; `result` the parsed json document, or null.
 */
export function syncStatus({ session, result }) {
  const fail = (reason) => ({ ok: false, reason });
  if (session.cap) {
    return fail(session.cap);
  }
  if (session.spawnError) {
    return fail('no session');
  }
  if (session.exit_code === SIGTERM_EXIT) {
    return fail('SIGTERM');
  }
  if (session.exit_code !== 0) {
    return fail(`exit ${session.exit_code}`);
  }
  if (result === null) {
    return fail('no result');
  }
  if (result.is_error) {
    return fail('result error');
  }
  if (result.subtype !== 'success') {
    return fail(`result ${result.subtype ?? 'unknown'}`);
  }
  if (result.permission_denials.length > 0) {
    return fail('permission_denied');
  }
  return { ok: true, reason: null };
}

/**
 * The inbox item's first line: `Night dispatch <run-id>: <n> shipped, <m>
 * stuck, <k> skipped`, where skipped counts the selection skips, the
 * candidates not admitted and the admitted items never dispatched.
 */
export function summaryLine({ runId, items, skips, notAdmitted }) {
  const count = (outcome) => items.filter((item) => item.outcome === outcome).length;
  const skipped = skips.length + notAdmitted.length + count('not dispatched');
  return `Night dispatch ${runId}: ${count('shipped')} shipped, ${count('stuck')} stuck, ${skipped} skipped`;
}

/** The inbox item's body: the summary line, a blank line, the report. */
export function inboxBody(summary, reportMarkdown) {
  return `${summary}\n\n${reportMarkdown}`;
}

/** The command that resumes a child session from any directory. */
export function resumeHint(sessionId) {
  return `claude --resume ${sessionId}`;
}
