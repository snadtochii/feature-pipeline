// The annotation model: the fields a note may carry, where it may point, and how a write from
// the viewer revises the stored notes. Shared by the HTTP surface (`server.mjs`) and the session
// rules (`session.mjs`); it depends on neither.

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
export function cleanAnnotation(raw, allowed) {
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
  return clean;
}

// A write may change a stored note's text, never its anchor.
function reviseAnnotation(stored, raw) {
  return {
    ...stored,
    intent: INTENTS.has(raw.intent) ? raw.intent : stored.intent,
    body: typeof raw.body === 'string' ? raw.body : stored.body,
  };
}

// Applies a viewer write to the session: a note whose `id` is stored is revised, any other
// note is cleaned and checked against `allowed`, and a stored note absent from the write is dropped.
export function applyEdits(session, body, allowed) {
  if (typeof body.overall === 'string') {
    session.overall = body.overall;
  }
  if (Array.isArray(body.annotations)) {
    const stored = new Map(session.annotations.map((a) => [a.id, a]));
    session.annotations = body.annotations
      .map((raw) => {
        const known = typeof raw?.id === 'string' ? stored.get(raw.id) : undefined;
        return known ? reviseAnnotation(known, raw) : cleanAnnotation(raw, allowed);
      })
      .filter(Boolean);
  }
}
