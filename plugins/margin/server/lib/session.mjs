// Session rules for the margin command: where a scope path may point, how a notes file is
// resumed, how a run's session is built and saved, what a Send does to it (the round model),
// and what the end of a run does with the notes file. A run spans rounds: each Send stamps
// every unsent note with the new round number and records the round, and the run ends once,
// on Finish, Cancel or a signal. Every save writes a temporary file beside the notes file and
// renames it over the notes file, so a reader between rounds never sees a partial file.
// Each rule throws a `RunError` carrying the exit code instead of exiting, so `cli.mjs` stays
// the only place that writes the error document and exits, and the self-test can call every
// rule in-process.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cleanAnnotation } from './annotations.mjs';

export class RunError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.name = 'RunError';
    this.exitCode = exitCode;
  }
}

export function scopePath(root, raw) {
  const abs = resolve(root, raw);
  const rel = relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RunError(`scope ${raw} is outside ${root}`, 2);
  }
  return rel === '' ? '.' : rel;
}

// The notes file being resumed, parsed but not yet trusted. Null only when there is no file:
// a file that exists and is not a notes file stops the run, because the first save would
// otherwise overwrite whatever the human had there.
export function readStored(out) {
  if (!existsSync(out)) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(out, 'utf8'));
  } catch (err) {
    throw new RunError(`${out} exists but is not valid JSON (${err.message}); fix it or pass another --out`, 1);
  }
  if (!parsed || !Array.isArray(parsed.annotations)) {
    throw new RunError(`${out} exists but is not a margin notes file (no annotations array); move it aside or pass another --out`, 1);
  }
  return parsed;
}

// A resumed file may have been edited by hand; it comes back in the shape the rest of the
// server assumes. Anchors are checked for shape only here: where a note may point is decided
// once, at creation (see `annotations.mjs`), and a stored note keeps its anchor.
// A note the cleaner rejects stops the run rather than vanishing on the first save.
// A file with no `rounds` resumes as round 0 with every note unsent. The round counter is
// always the length of `rounds`; a stored `round` value is ignored, like `status`.
export function restoreSession(stored, out) {
  const rounds = restoreRounds(stored, out);
  const annotations = stored.annotations.map((raw) => cleanAnnotation(raw, null, rounds.length));
  const rejected = annotations.flatMap((a, i) => (a === null ? [i] : []));
  if (rejected.length > 0) {
    throw new RunError(`${out}: ${rejected.length} of ${annotations.length} notes are malformed (indices ${rejected.join(', ')}); fix them or pass another --out`, 1);
  }
  return {
    version: 1,
    createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : new Date().toISOString(),
    overall: typeof stored.overall === 'string' ? stored.overall : '',
    round: rounds.length,
    rounds,
    annotations,
  };
}

// The sent rounds of a resumed file, in order: entry `i` is round `i + 1`, with the time it was
// sent and the overall comment it carried. Anything else stops the run before the notes are read.
function restoreRounds(stored, out) {
  if (stored.rounds === undefined) {
    return [];
  }
  if (!Array.isArray(stored.rounds)) {
    throw new RunError(`${out}: rounds is not a list; fix it or pass another --out`, 1);
  }
  return stored.rounds.map((entry, i) => {
    if (!entry || entry.round !== i + 1 || typeof entry.sentAt !== 'string' || typeof entry.overall !== 'string') {
      throw new RunError(`${out}: rounds entry ${i} is malformed; fix it or pass another --out`, 1);
    }
    return { round: entry.round, sentAt: entry.sentAt, overall: entry.overall };
  });
}

// The session a run serves: the resumed notes, or a fresh record at round 0, as a `draft` over
// `root` and `scope` that saves to `out`.
export function createSession({ stored, out, root, scope, revision }) {
  const now = new Date().toISOString();
  const session = stored ? restoreSession(stored, out) : { version: 1, createdAt: now, overall: '', round: 0, rounds: [], annotations: [] };
  return Object.assign(session, { status: 'draft', root, scope, out, revision, updatedAt: now });
}

// Writes the session to its notes file, stamping `updatedAt` first. The content goes to a
// temporary file in the same directory, which is then renamed over the notes file; a failed
// write or rename removes the temporary file and rethrows.
export function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  const dir = dirname(session.out);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(session.out)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`);
    renameSync(tmp, session.out);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// A Send: stamps every unsent note with the next round number, records the round with the
// overall comment it carries, and saves. Returns the new round number, or null when there is
// nothing to send — no unsent note and the same overall comment the last round sent. A failed
// save undoes the stamps and the round entry and rethrows, so a retried Send sends the round.
export function sendRound(session) {
  const unsent = session.annotations.filter((a) => a.round === undefined);
  const last = session.rounds.at(-1)?.overall ?? '';
  if (unsent.length === 0 && session.overall.trim() === last.trim()) {
    return null;
  }
  const round = session.round + 1;
  for (const note of unsent) {
    note.round = round;
  }
  session.rounds.push({ round, sentAt: new Date().toISOString(), overall: session.overall });
  session.round = round;
  try {
    saveSession(session);
  } catch (err) {
    for (const note of unsent) {
      delete note.round;
    }
    session.rounds.pop();
    session.round = round - 1;
    throw err;
  }
  return round;
}

// The end of a run. A cancel before any round was sent, with no notes and a blank overall
// comment, deletes the notes file; every other ending saves it with its final status.
// Returns the result document.
export function finishRun(session, status) {
  const { out, root, scope } = session;
  session.status = status;
  const discard = status === 'cancelled' && session.round === 0 && session.annotations.length === 0 && session.overall.trim() === '';
  if (discard) {
    if (existsSync(out)) {
      unlinkSync(out);
    }
  } else {
    saveSession(session);
  }
  return { status, out: discard ? null : out, annotations: session.annotations.length, rounds: session.round, root, scope };
}
