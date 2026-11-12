// Pipeline-run recognition (../CONTRACT.md §5): roles, tickets, stages, the
// close stage's result line, validation check runs and weighted token units.
// Every rule that scripts/measure-session.py also applies is copied from it,
// named after its Python counterpart; scripts/check-insights-parity.mjs holds
// the token-affecting ones equal. Every value returned for storage is drawn
// from a closed vocabulary.
//
// Private to the implementation: only insights.mjs is a command.

export const GENERIC_ROLE = 'general-purpose';
export const GENERIC_FALLBACK_ROLE = 'general-purpose (other)';
export const ROOT_ROLE = 'root-session';
export const UNATTRIBUTED = 'unattributed';
const ROOT_AGENT_ID = 'root';

// measure-session.py DEFAULT_ROLE_MAP. Python's `$` also matches before a final newline.
export const ROLE_MAP = [
  ['build-stage', /^Build stage for /],
  ['plan-stage', /^Plan stage for /],
  ['review-stage', /^Review stage for |^\S+ review stage\n?$/],
  ['close-stage', /^Close stage for |^\S+ close stage\n?$/],
  ['finalize-child', /^Finalize /],
  ['ship-implementer', / implementer via flow\n?$/],
  ['ship-review', /^Independent review of /],
  ['ship-address', /^Address review on /],
];

// measure-session.py TICKET_RE and NON_TICKET_PREFIXES. Python's `\b` and `\d` are
// Unicode-aware on str, so its word boundaries are lookarounds over its word
// characters (letters, numbers, underscore) and its digits are any decimal digit.
const TICKET_RE = /(?<![\p{L}\p{N}_])[A-Z][A-Z0-9]*-\p{Nd}+(?![\p{L}\p{N}_])/gu;
const NON_TICKET_PREFIXES = new Set(
  'UTF SHA RFC ISO CVE CWE MD AES RSA HMAC CRC BASE ASCII PEP ECMA IEEE ANSI HTTP HTTPS TLS SSL IPV EC CJK GB BIG WIN CP KOI'.split(' '),
);

// measure-session.py SLASH_BUILD_RE and COMMAND_ARGS_RE.
const SLASH_BUILD = /<command-name>\s*\/?feature:build\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** The slash-build rule matched a record whose arguments hold no ticket. */
export const UNATTRIBUTED_MARK = Symbol('unattributed slash build');

// measure-session.py DEFAULT_CHECK_PATTERN, READ_ONLY_COMMANDS, HEREDOC_BODY_RE.
const CHECK_PATTERN = /check-[a-z-]+\.(?:sh|mjs)|bash scripts\/|vitest|pytest|npm (?:run|test|ci)\b|node |tsc\b|pyright/;
const READ_ONLY_COMMANDS = new Set(
  'cat head tail sed less more grep rg wc ls find awk diff stat file xxd od cut sort uniq tr column printf echo test [ true false'.split(' '),
);
const HEREDOC_BODY = /(<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?[^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?:\n|$)/g;
const SEGMENT_SEPARATOR = /&&|\|\||[;\n|]/;
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

// measure-session.py DEFAULT_WEIGHTS.
export const WEIGHTS = { i: 1.0, cw: 1.25, cr: 0.1, o: 5.0 };

// measure-session.py IMPLEMENT_STAGE_ROLE and STAGE_CHILD_ROLES; plan-stage is this extractor's own.
export const STAGE_OF_ROLE = { 'plan-stage': 'plan', 'build-stage': 'implement', 'review-stage': 'review', 'close-stage': 'close' };
const STAGES = new Set(Object.values(STAGE_OF_ROLE));
const ROOT_STAGE_COMMANDS = { 'feature:plan': 'plan', 'feature:review-stage': 'review', 'feature:close-stage': 'close' };
const ROOT_TICKET_COMMANDS = new Set([...Object.keys(ROOT_STAGE_COMMANDS), 'feature:flow']);

const CLOSE_LINE = /^close: (done|review|backlog|caller|continue-with-hint|merged|pr-open|already-complete|error)(?: (?:—|-) verdict (pass|partial|stuck))?\s*$/;
const CLOSE_ENDINGS = new Set(['done', 'review', 'backlog', 'caller', 'continue-with-hint', 'merged', 'pr-open', 'already-complete', 'error']);
const VERDICT_LESS_ENDINGS = new Set(['merged', 'pr-open', 'error']);
const OPTIONAL_VERDICT_ENDINGS = new Set(['already-complete']);
const VERDICTS = new Set(['pass', 'partial', 'stuck']);

const TICKET = /^[A-Z][A-Z0-9]*-\d+$/;
const MAX_TICKET_CHARS = 40;
const KNOWN_ROLES = new Set([...ROLE_MAP.map(([role]) => role), ROOT_ROLE, GENERIC_FALLBACK_ROLE]);

/** The role of a subagent: its `agentType` verbatim, refined by description only for `general-purpose`. */
export function roleOf(agentType, description) {
  if (agentType !== GENERIC_ROLE) {
    return agentType ?? null;
  }
  const text = typeof description === 'string' ? description : '';
  const hit = ROLE_MAP.find(([, pattern]) => pattern.test(text));
  return hit === undefined ? GENERIC_FALLBACK_ROLE : hit[0];
}

/** The first `<LETTERS>-<digits>` token of `text` whose prefix is not a standard's name, or null. */
export function findTicket(text) {
  if (typeof text !== 'string') {
    return null;
  }
  for (const [match] of text.matchAll(TICKET_RE)) {
    if (!NON_TICKET_PREFIXES.has(match.split('-', 1)[0])) {
      return match;
    }
  }
  return null;
}

/** For string user content invoking `/feature:build`: its ticket, or UNATTRIBUTED_MARK; otherwise null. */
export function slashBuildTicket(content) {
  if (typeof content !== 'string' || !SLASH_BUILD.test(content)) {
    return null;
  }
  return findTicket(COMMAND_ARGS.exec(content)?.[1]) ?? UNATTRIBUTED_MARK;
}

/** The root session's own stage: implement under a ticketed slash build, else its first stage command's. */
export function rootStageOf(slashBuild, commands) {
  if (typeof slashBuild === 'string') {
    return 'implement';
  }
  for (const { name } of commands) {
    const stage = ROOT_STAGE_COMMANDS[name.replace(/^\//, '')];
    if (stage !== undefined) {
      return stage;
    }
  }
  return null;
}

/** The first ID, not a standard's name, of the first plan, review-stage, close-stage or flow command carrying one, or null. */
export function commandTicketOf(commands) {
  for (const { name, ids } of commands) {
    if (ROOT_TICKET_COMMANDS.has(name.replace(/^\//, ''))) {
      const ticket = ids.find((id) => !NON_TICKET_PREFIXES.has(id.split('-', 1)[0]));
      if (ticket !== undefined) {
        return ticket;
      }
    }
  }
  return null;
}

/** The last close result line in `text`, as `{ending, verdict}`, or null. */
export function closeResultOf(text) {
  if (typeof text !== 'string') {
    return null;
  }
  let found = null;
  for (const line of text.split('\n')) {
    const match = CLOSE_LINE.exec(line);
    if (match !== null) {
      found = { ending: match[1], verdict: VERDICT_LESS_ENDINGS.has(match[1]) ? null : (match[2] ?? null) };
    }
  }
  return found;
}

function* commandSegments(command) {
  for (const segment of command.split(SEGMENT_SEPARATOR)) {
    const words = segment.trim().split(/\s+/).filter((word) => word !== '');
    while (words.length > 0 && ASSIGNMENT_WORD.test(words[0])) {
      words.shift();
    }
    if (words.length > 0) {
      yield [words.join(' '), words[0]];
    }
  }
}

/** Whether a Bash command runs a validation check; heredoc bodies are never scanned. */
export function isCheckRun(command) {
  if (typeof command !== 'string') {
    return false;
  }
  const stripped = command.replace(HEREDOC_BODY, '$1\n');
  for (const [segment, firstWord] of commandSegments(stripped)) {
    if (!READ_ONLY_COMMANDS.has(firstWord) && CHECK_PATTERN.test(segment)) {
      return true;
    }
  }
  return false;
}

/** Weighted input-token equivalents of a digest `tokens` object, summed in measure-session.py's term order. */
export function weightedUnits(tokens) {
  return WEIGHTS.i * tokens.input + WEIGHTS.cw * tokens.cache_write + WEIGHTS.cr * tokens.cache_read + WEIGHTS.o * tokens.output;
}

export function validRole(role, agentType) {
  return typeof role === 'string' && (KNOWN_ROLES.has(role) || role === agentType) ? role : null;
}

export function validTicket(ticket) {
  return typeof ticket === 'string' && ticket.length <= MAX_TICKET_CHARS && TICKET.test(ticket) ? ticket : null;
}

export function validStage(stage) {
  return STAGES.has(stage) ? stage : null;
}

export function validCloseResult(result) {
  if (result === null || typeof result !== 'object' || !CLOSE_ENDINGS.has(result.ending)) {
    return null;
  }
  const verdictOk = VERDICT_LESS_ENDINGS.has(result.ending)
    ? result.verdict === null
    : VERDICTS.has(result.verdict) || (OPTIONAL_VERDICT_ENDINGS.has(result.ending) && result.verdict === null);
  return verdictOk ? { ending: result.ending, verdict: result.verdict } : null;
}

function addAnomaly(entry, name) {
  const counts = new Map(Object.entries(entry.anomalies));
  counts.set(name, (counts.get(name) ?? 0) + 1);
  entry.anomalies = Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function stored(entry, value, validated) {
  if (value !== null && value !== undefined && validated === null) {
    addAnomaly(entry, 'bad_recognition');
  }
  return validated;
}

/** Indices of entry `start`'s ancestors, nearest first; measure-session.py attribute_tickets's walk. */
function* ancestorsOf(entries, signals, indexOf, start) {
  const seen = new Set([entries[start].agent_id]);
  let cursor = start;
  while (signals[cursor].walks) {
    const parentId = entries[cursor].agent_id === ROOT_AGENT_ID ? null : (entries[cursor].parent_agent_id ?? ROOT_AGENT_ID);
    if (parentId === null || seen.has(parentId) || !indexOf.has(parentId)) {
      return;
    }
    seen.add(parentId);
    cursor = indexOf.get(parentId);
    yield cursor;
  }
}

/**
 * Give every digest entry of one session its `role`, `ticket`, `run_ticket`,
 * `stage` and `close_result`. `signals[i]` holds entry i's transient inputs:
 * `role`, `ownTicket` (from its description), `walks` (false when its meta is
 * absent or unreadable), `slashBuild`, `commandTicket`, `rootStage` and
 * `closeResult`. `ticket` is measure-session.py's attribution; `run_ticket`
 * adds the root's command ticket, which measure-session.py has no rule for.
 */
export function recognizeSession(entries, signals) {
  const indexOf = new Map(entries.map((entry, index) => [entry.agent_id, index]));
  const own = signals.map((signal) => signal.ownTicket ?? (typeof signal.slashBuild === 'string' ? signal.slashBuild : null));
  const ownRun = own.map((ticket, index) => ticket ?? (entries[index].agent_id === ROOT_AGENT_ID ? (signals[index].commandTicket ?? null) : null));
  const headStage = entries.map((entry, index) => (entry.agent_id === ROOT_AGENT_ID ? signals[index].rootStage : (STAGE_OF_ROLE[signals[index].role] ?? null)));
  entries.forEach((entry, index) => {
    const chain = [index, ...ancestorsOf(entries, signals, indexOf, index)];
    const ticket = chain.map((at) => own[at]).find((value) => value !== null) ?? null;
    const runTicket = chain.map((at) => ownRun[at]).find((value) => value !== null) ?? null;
    const stage = chain.map((at) => headStage[at]).find((value) => value !== null) ?? null;
    const closeResult = headStage[index] === 'close' ? signals[index].closeResult : null;
    entry.role = stored(entry, signals[index].role, validRole(signals[index].role, entry.agent_type));
    entry.ticket = stored(entry, ticket, validTicket(ticket));
    entry.run_ticket = runTicket === ticket ? entry.ticket : stored(entry, runTicket, validTicket(runTicket));
    entry.stage = stored(entry, stage, validStage(stage));
    entry.close_result = stored(entry, closeResult, validCloseResult(closeResult));
  });
  return entries;
}
