// The annotation model: the fields a note may carry, where it may point, and how a write from
// the viewer revises the stored notes. A note carries `round` once it has been sent; a sent
// note is locked, so no write revises or deletes it, and `round` is set only by the server.
// A sent note may carry the agent's `replies`, which are server-owned like `round`: a viewer
// write never sets or changes them.
// Shared by the HTTP surface (`server.mjs`) and the session rules (`session.mjs`); it depends
// on neither.

import { randomUUID } from 'node:crypto';

const ANCHOR_KINDS = new Set(['range', 'file', 'folder', 'scope']);
const INTENTS = new Set(['change', 'question']);

// The one rule for where a note may point: an anchor is checked against the listed paths
// when the note is created, and never changes afterwards. A later write from the viewer
// may revise what the human typed (`intent`, `body`), not where the note sits, so a note
// resumed from an earlier run keeps its anchor even when that file has since moved or
// fallen outside this run's scope. `allowed` is the set of listed paths; one rule per
// kind, no fallthrough; null skips the check for notes read back from the file.
const IN_SCOPE = {
  scope: () => true,
  folder: (anchor, allowed) => [...allowed].some((path) => path.startsWith(`${anchor.path}/`)),
  file: (anchor, allowed) => allowed.has(anchor.path),
  range: (anchor, allowed) => allowed.has(anchor.path),
};

function inScope(anchor, allowed) {
  return IN_SCOPE[anchor.kind](anchor, allowed);
}

// Keeps only the fields the notes file defines, so neither a stray client nor a
// hand-edited notes file can give the reading skill a shape it does not expect.
// `maxRound` is given only on resume: a stored `round` from 1 to `maxRound` is kept and any
// other value rejects the note, and so are stored `replies` — a list, on a sent note only, each
// reply answering a round from the note's `round` to `maxRound`; an empty list is dropped.
// Without `maxRound` (a viewer write), `round` and `replies` are dropped like any unknown field.
export function cleanAnnotation(raw, allowed, maxRound) {
  const anchor = raw?.anchor ?? {};
  if (!ANCHOR_KINDS.has(anchor.kind) || typeof raw.body !== 'string') {
    return null;
  }
  const clean = {
    id: typeof raw.id === 'string' ? raw.id : randomUUID(),
    anchor: { kind: anchor.kind },
    intent: INTENTS.has(raw.intent) ? raw.intent : 'change',
    body: raw.body,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
  if (anchor.kind !== 'scope') {
    if (typeof anchor.path !== 'string') {
      return null;
    }
    clean.anchor.path = anchor.path;
  }
  if (allowed && !inScope(anchor, allowed)) {
    return null;
  }
  if (anchor.kind === 'range') {
    const start = Number(anchor.start);
    const end = Number(anchor.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return null;
    }
    clean.anchor.start = start;
    clean.anchor.end = end;
    clean.anchor.excerpt = typeof anchor.excerpt === 'string' ? anchor.excerpt.slice(0, 4000) : '';
  }
  if (typeof maxRound === 'number' && raw.round !== undefined) {
    if (!Number.isInteger(raw.round) || raw.round < 1 || raw.round > maxRound) {
      return null;
    }
    clean.round = raw.round;
  }
  if (typeof maxRound === 'number' && raw.replies !== undefined) {
    if (clean.round === undefined || !Array.isArray(raw.replies)) {
      return null;
    }
    const replies = raw.replies.map((reply) => cleanReply(reply, clean.round, maxRound));
    if (replies.includes(null)) {
      return null;
    }
    if (replies.length > 0) {
      clean.replies = replies;
    }
  }
  return clean;
}

// One reply of the agent, as stored: `{ body, round, createdAt }`, where `round` is the round
// the agent answered and lies from `minRound` to `maxRound`. Other keys are dropped; anything
// else returns null.
export function cleanReply(raw, minRound, maxRound) {
  if (!raw || typeof raw !== 'object' || typeof raw.body !== 'string' || typeof raw.createdAt !== 'string') {
    return null;
  }
  if (!Number.isInteger(raw.round) || raw.round < minRound || raw.round > maxRound) {
    return null;
  }
  return { body: raw.body, round: raw.round, createdAt: raw.createdAt };
}

// A write may change a stored note's text, never its anchor.
function reviseAnnotation(stored, raw) {
  return {
    ...stored,
    intent: INTENTS.has(raw.intent) ? raw.intent : stored.intent,
    body: typeof raw.body === 'string' ? raw.body : stored.body,
  };
}

// Applies a viewer write to the session. Sent notes (those with `round`) are locked: a write
// entry carrying a sent note's id is ignored, and a sent note absent from the write is kept.
// Among unsent notes, one whose `id` is stored is revised, any other note is cleaned and
// checked against `allowed`, and a stored note absent from the write is dropped. Every note
// present at a Send is stamped, so sent notes all predate unsent ones and lead the list.
export function applyEdits(session, body, allowed) {
  if (typeof body.overall === 'string') {
    session.overall = body.overall;
  }
  if (Array.isArray(body.annotations)) {
    const sent = session.annotations.filter((a) => a.round !== undefined);
    const sentIds = new Set(sent.map((a) => a.id));
    const unsent = new Map(session.annotations.filter((a) => a.round === undefined).map((a) => [a.id, a]));
    const rest = body.annotations
      .filter((raw) => !(typeof raw?.id === 'string' && sentIds.has(raw.id)))
      .map((raw) => {
        const known = typeof raw?.id === 'string' ? unsent.get(raw.id) : undefined;
        return known ? reviseAnnotation(known, raw) : cleanAnnotation(raw, allowed);
      })
      .filter(Boolean);
    session.annotations = [...sent, ...rest];
  }
}
