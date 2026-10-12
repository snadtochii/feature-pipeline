// Session rules for the margin command: where a scope path may point, how a notes file is
// resumed, how a run's session is built and saved, and what the end of a run does with the
// notes file. Each rule throws a `RunError` carrying the exit code instead of exiting, so
// `cli.mjs` stays the only place that writes the error document and exits, and the self-test
// can call every rule in-process.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
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
export function restoreSession(stored, out) {
  const annotations = stored.annotations.map((raw) => cleanAnnotation(raw, null));
  const rejected = annotations.flatMap((a, i) => (a === null ? [i] : []));
  if (rejected.length > 0) {
    throw new RunError(`${out}: ${rejected.length} of ${annotations.length} notes are malformed (indices ${rejected.join(', ')}); fix them or pass another --out`, 1);
  }
  return {
    version: 1,
    createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : new Date().toISOString(),
    overall: typeof stored.overall === 'string' ? stored.overall : '',
    annotations,
  };
}

// The session a run serves: the resumed notes, or a fresh record, as a `draft` over `root` and
// `scope` that saves to `out`.
export function createSession({ stored, out, root, scope, revision }) {
  const now = new Date().toISOString();
  const session = stored ? restoreSession(stored, out) : { version: 1, createdAt: now, overall: '', annotations: [] };
  return Object.assign(session, { status: 'draft', root, scope, out, revision, updatedAt: now });
}

// Writes the session to its notes file, stamping `updatedAt` first.
export function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  mkdirSync(dirname(session.out), { recursive: true });
  writeFileSync(session.out, `${JSON.stringify(session, null, 2)}\n`);
}

// The end of a run. A cancel with no notes and a blank overall comment deletes the notes
// file; every other ending saves it with its final status. Returns the result document.
export function finishRun({ session, status, out, root, scope, save }) {
  session.status = status;
  const discard = status === 'cancelled' && session.annotations.length === 0 && session.overall.trim() === '';
  if (discard) {
    if (existsSync(out)) {
      unlinkSync(out);
    }
  } else {
    save();
  }
  return { status, out: discard ? null : out, annotations: session.annotations.length, root, scope };
}
