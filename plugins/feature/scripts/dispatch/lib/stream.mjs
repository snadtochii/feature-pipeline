// Child-session output, folded into facts (CONTRACT.md §10, Child sessions).
//
// Pure functions over the structured events a `claude -p` child prints: one
// `stream-json` line at a time for a `ship` session, one `json` document for a
// `sync` session. Only named fields are read — the session id, `api_retry`
// rate-limit events, permission denials and the `result` record. Message text
// and tool input are never stored or interpreted; an event of another type is
// counted and otherwise left alone, and a line that is not JSON is counted as
// unparsed.
//
// Private to the implementation: only dispatch.mjs is a command.

const SESSION_ID = /^[A-Za-z0-9-]{1,128}$/;
const TOOL_NAME_MAX = 100;

/** Empty facts for a session that has printed nothing yet. */
export function newSessionFacts() {
  return {
    session_id: null,
    rate_limit_retries: 0,
    permission_denied: [],
    result: null,
    events: 0,
    unparsed_lines: 0,
  };
}

const sessionId = (value) => (typeof value === 'string' && SESSION_ID.test(value) ? value : null);

const toolName = (value) =>
  typeof value === 'string' && value.trim() !== '' ? value.replace(/\s+/g, ' ').trim().slice(0, TOOL_NAME_MAX) : 'unknown';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The fields kept from a `result` record. */
function resultFields(event) {
  const denials = Array.isArray(event.permission_denials) ? event.permission_denials : [];
  return {
    subtype: typeof event.subtype === 'string' ? event.subtype : null,
    is_error: event.is_error === true,
    session_id: sessionId(event.session_id),
    total_cost_usd: typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : null,
    permission_denials: denials.map((entry) => toolName(isObject(entry) ? entry.tool_name : undefined)),
  };
}

/**
 * Fold one stdout line into `facts`. Returns `{ facts, rateLimitEvent }`, a
 * new facts object; `rateLimitEvent` is true when the line was an `api_retry`
 * event caused by a rate limit. A blank line changes nothing.
 */
export function applyLine(facts, line) {
  const text = String(line).replace(/\r$/, '');
  if (text.trim() === '') {
    return { facts, rateLimitEvent: false };
  }
  let event;
  try {
    event = JSON.parse(text);
  } catch {
    event = undefined;
  }
  if (!isObject(event)) {
    return { facts: { ...facts, unparsed_lines: facts.unparsed_lines + 1 }, rateLimitEvent: false };
  }
  const next = { ...facts, events: facts.events + 1 };
  let rateLimitEvent = false;
  if (event.type === 'result') {
    next.result = resultFields(event);
    next.session_id = next.result.session_id ?? next.session_id;
    return { facts: next, rateLimitEvent };
  }
  if (event.type === 'system' && event.subtype === 'api_retry' && event.error === 'rate_limit') {
    next.rate_limit_retries = facts.rate_limit_retries + 1;
    rateLimitEvent = true;
  } else if (event.type === 'system' && event.subtype === 'permission_denied') {
    next.permission_denied = [...facts.permission_denied, toolName(event.tool_name)];
  }
  if (next.session_id === null) {
    next.session_id = sessionId(event.session_id);
  }
  return { facts: next, rateLimitEvent };
}

/** The `result` fields of a `--output-format json` document, or null when it is not one. */
export function parseJsonResult(text) {
  let doc;
  try {
    doc = JSON.parse(String(text).trim());
  } catch {
    return null;
  }
  if (!isObject(doc) || (doc.type !== undefined && doc.type !== 'result')) {
    return null;
  }
  return resultFields(doc);
}
