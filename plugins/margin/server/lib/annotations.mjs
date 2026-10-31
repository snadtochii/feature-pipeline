// The annotation model: the fields a note may carry, where it may point, and how a write from
// the viewer revises the stored notes. A note carries `round` once it has been sent; a sent
// note is locked, so no write revises or deletes it, and `round` is set only by the server.
// A sent note may carry the agent's `replies`, which are server-owned like `round`: a viewer
// write never sets or changes them.
// A new candidate, box or arrow note whose name or id the run does not know refuses the whole
// write (`refuseAnchors`); any other new note that fails its checks is left out of it.
// Shared by the HTTP surface (`server.mjs`) and the session rules (`session.mjs`); it depends
// on neither.

import { randomUUID } from 'node:crypto';

// The overview's candidate name rule (CONTRACT §13), which a candidate anchor's `name` follows.
export const CANDIDATE_NAME = /^[a-z0-9][a-z0-9-]*$/;

// The diagram's id rule (CONTRACT §15), which a box or arrow anchor's `id` follows.
const DIAGRAM_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

const ANCHOR_KINDS = new Set(['range', 'file', 'folder', 'scope', 'candidate', 'box', 'arrow']);
const DIAGRAM_KINDS = { box: 'boxes', arrow: 'arrows' };
const INTENTS = new Set(['change', 'question']);

// The one rule for where a note may point: an anchor is checked against the listed paths,
// the run's overview candidates and the run's diagram when the note is created, and never
// changes afterwards. A later write from the viewer may revise what the human typed (`intent`,
// `body`), not where the note sits, so a note resumed from an earlier run keeps its anchor even
// when that file has since moved or fallen outside this run's scope, or its candidate, box or
// arrow is not in this run's overview or diagram. `allowed` is `{ paths, candidates, boxes,
// arrows }`: the set of listed paths, the set of the overview's candidate names, and the
// diagram's box and arrow ids, each a map to the element's label; one rule per kind, no
// fallthrough; null skips the check for notes read back from the file.
const IN_SCOPE = {
  scope: () => true,
  folder: (anchor, allowed) => [...allowed.paths].some((path) => path.startsWith(`${anchor.path}/`)),
  file: (anchor, allowed) => allowed.paths.has(anchor.path),
  range: (anchor, allowed) => allowed.paths.has(anchor.path),
  candidate: (anchor, allowed) => allowed.candidates.has(anchor.name),
  box: (anchor, allowed) => allowed.boxes.has(anchor.id),
  arrow: (anchor, allowed) => allowed.arrows.has(anchor.id),
};

function inScope(anchor, allowed) {
  return IN_SCOPE[anchor.kind](anchor, allowed);
}

function labelSnapshot(anchor, allowed) {
  if (allowed) {
    return allowed[DIAGRAM_KINDS[anchor.kind]].get(anchor.id);
  }
  return typeof anchor.label === 'string' ? anchor.label : '';
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
  if (anchor.kind === 'candidate') {
    if (typeof anchor.name !== 'string' || !CANDIDATE_NAME.test(anchor.name)) {
      return null;
    }
    clean.anchor.name = anchor.name;
  } else if (DIAGRAM_KINDS[anchor.kind]) {
    if (typeof anchor.id !== 'string' || !DIAGRAM_ID.test(anchor.id)) {
      return null;
    }
    clean.anchor.id = anchor.id;
  } else if (anchor.kind !== 'scope') {
    if (typeof anchor.path !== 'string') {
      return null;
    }
    clean.anchor.path = anchor.path;
  }
  if (allowed && !inScope(anchor, allowed)) {
    return null;
  }
  if (DIAGRAM_KINDS[anchor.kind]) {
    clean.anchor.label = labelSnapshot(anchor, allowed);
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

function newEntries(session, entries) {
  const stored = new Set(session.annotations.map((a) => a.id));
  return entries.map((raw, index) => ({ raw, index })).filter(({ raw }) => !(typeof raw?.id === 'string' && stored.has(raw.id)));
}

// Applies a viewer write to the session. Sent notes (those with `round`) are locked: a write
// entry carrying a sent note's id is ignored, and a sent note absent from the write is kept.
// Among unsent notes, one whose `id` is stored is revised, any other note is cleaned and
// checked against `allowed`, and a stored note absent from the write is dropped. A Send
// stamps every unsent note it does not withhold and moves the withheld ones after it, so sent notes
// all predate unsent ones and lead the list.
export function applyEdits(session, body, allowed) {
  if (typeof body.overall === 'string') {
    session.overall = body.overall;
  }
  if (Array.isArray(body.annotations)) {
    const sent = session.annotations.filter((a) => a.round !== undefined);
    const unsent = new Map(session.annotations.filter((a) => a.round === undefined).map((a) => [a.id, a]));
    const created = new Set(newEntries(session, body.annotations).map(({ index }) => index));
    const rest = body.annotations
      .map((raw, index) => {
        if (created.has(index)) {
          return cleanAnnotation(raw, allowed);
        }
        const known = unsent.get(raw.id);
        return known ? reviseAnnotation(known, raw) : null;
      })
      .filter(Boolean);
    session.annotations = [...sent, ...rest];
  }
}

const REFUSED = {
  candidate: (anchor) => `${JSON.stringify(anchor.name ?? null)} is not a candidate of this run's overview`,
  box: (anchor) => `${JSON.stringify(anchor.id ?? null)} is not a box of this run's diagram`,
  arrow: (anchor) => `${JSON.stringify(anchor.id ?? null)} is not an arrow of this run's diagram`,
};

// Checks a write before `applyEdits` runs, deciding which entries are new the same way: every
// new entry with a candidate, box or arrow anchor whose name or id `allowed` does not hold
// fails — one that is missing, not a string or breaks its rule included, since no candidate,
// box or arrow carries one — and the result is one message naming each failing entry in entry
// order, or null when none fails.
export function refuseAnchors(session, body, allowed) {
  if (!Array.isArray(body.annotations)) {
    return null;
  }
  const problems = newEntries(session, body.annotations)
    .filter(({ raw }) => Object.hasOwn(REFUSED, raw?.anchor?.kind ?? '') && !inScope(raw.anchor, allowed))
    .map(({ raw, index }) => `entry ${index}: ${REFUSED[raw.anchor.kind](raw.anchor)}`);
  return problems.length > 0 ? problems.join('; ') : null;
}
