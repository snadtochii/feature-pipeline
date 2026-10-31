// Session rules for the margin command: where a scope path may point, how a notes file is
// resumed, how a run's session is built and saved, what a Send does to it (the round model),
// and what the end of a run does with the notes file. A run spans rounds: each Send stamps
// every unsent note with the new round number and records the round, and the run ends once,
// on Finish, Cancel or a signal. Between rounds the agent's replies to sent notes are appended
// (the reply rule). Every save — a viewer write, a Send, a reply post, the end — writes a
// temporary file beside the notes file and renames it over the notes file, so a reader between
// rounds never sees a partial file.
// Each rule throws a `RunError` carrying the exit code instead of exiting, so `cli.mjs` stays
// the only place that writes the error document and exits, and the self-test can call every
// rule in-process.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cleanAnnotation, cleanReply } from './annotations.mjs';

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
  const overallReplies = restoreOverallReplies(stored, out, rounds.length);
  const annotations = stored.annotations.map((raw) => cleanAnnotation(raw, null, rounds.length));
  const rejected = annotations.flatMap((a, i) => (a === null ? [i] : []));
  if (rejected.length > 0) {
    throw new RunError(`${out}: ${rejected.length} of ${annotations.length} notes are malformed (indices ${rejected.join(', ')}); fix them or pass another --out`, 1);
  }
  return {
    version: 1,
    createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : new Date().toISOString(),
    overall: typeof stored.overall === 'string' ? stored.overall : '',
    overallReplies,
    round: rounds.length,
    rounds,
    annotations,
  };
}

// The agent's overall replies of a resumed file, oldest first, each in the shape of a note's
// reply (`annotations.mjs`). Anything else stops the run before the notes are read.
function restoreOverallReplies(stored, out, maxRound) {
  if (stored.overallReplies === undefined) {
    return [];
  }
  if (!Array.isArray(stored.overallReplies)) {
    throw new RunError(`${out}: overallReplies is not a list; fix it or pass another --out`, 1);
  }
  return stored.overallReplies.map((entry, i) => {
    const reply = cleanReply(entry, 1, maxRound);
    if (reply === null) {
      throw new RunError(`${out}: overallReplies entry ${i} is malformed; fix it or pass another --out`, 1);
    }
    return reply;
  });
}

const isChange = (op) => op !== null && typeof op === 'object' && typeof op.op === 'string' && typeof op.id === 'string';
const changesValid = (changes) => changes === undefined || (Array.isArray(changes) && changes.every(isChange));

// The sent rounds of a resumed file, in order: entry `i` is round `i + 1`, with the time it was
// sent, the overall comment it carried and, for a run with a diagram, its structural changes.
// Anything else stops the run before the notes are read.
function restoreRounds(stored, out) {
  if (stored.rounds === undefined) {
    return [];
  }
  if (!Array.isArray(stored.rounds)) {
    throw new RunError(`${out}: rounds is not a list; fix it or pass another --out`, 1);
  }
  return stored.rounds.map((entry, i) => {
    if (!entry || entry.round !== i + 1 || typeof entry.sentAt !== 'string' || typeof entry.overall !== 'string' || !changesValid(entry.changes)) {
      throw new RunError(`${out}: rounds entry ${i} is malformed; fix it or pass another --out`, 1);
    }
    const kept = { round: entry.round, sentAt: entry.sentAt, overall: entry.overall };
    return entry.changes === undefined ? kept : { ...kept, changes: entry.changes };
  });
}

// The session a run serves: the resumed notes, or a fresh record at round 0, as a `draft` over
// `root` and `scope` that saves to `out`. `diagram` is the absolute path of the run's diagram
// file, or null; a resume reads it back from the stored file (CONTRACT §5). `baseline` is the
// current round's starting file as a diagram document, or null without a diagram; a Send and the
// reply that closes a round move it (CONTRACT §6).
export function createSession({ stored, out, root, scope, revision, diagram = null, baseline = null }) {
  const now = new Date().toISOString();
  const session = stored ? restoreSession(stored, out) : { version: 1, createdAt: now, overall: '', overallReplies: [], round: 0, rounds: [], annotations: [] };
  return Object.assign(session, { status: 'draft', root, scope, diagram, baseline, out, revision, updatedAt: now });
}

// Writes `text` to a temporary file in the same directory as `file`, then renames it over
// `file`, keeping an existing file's permission bits; a failed write, chmod or rename removes
// the temporary file and rethrows.
export function writeAtomic(file, text) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, text);
    if (existsSync(file)) {
      chmodSync(tmp, statSync(file).mode & 0o7777);
    }
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// Writes the session to its notes file, stamping `updatedAt` first.
export function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  writeAtomic(session.out, `${JSON.stringify(session, null, 2)}\n`);
}

// Whether the last round sent is out: sent, and answered by no note reply and no overall reply
// for it yet. While a round is out an `annotate` run's diagram takes no save (CONTRACT §8); the
// viewer's `roundOut()` in `ui/rounds.js` is the same rule.
export function roundOut(session) {
  const round = session.round;
  if (round === 0) {
    return false;
  }
  const answered = (replies) => (replies ?? []).some((reply) => reply.round === round);
  return !answered(session.overallReplies) && !session.annotations.some((a) => answered(a.replies));
}

// A Send: stamps every unsent note with the next round number, records the round with the
// overall comment it carries and, when `changes` is a list, the diagram's structural changes
// (CONTRACT §6), and saves. `allowed` is what the run's anchors may name now: `candidates`, the
// overview's candidate names, and `boxes` and `arrows`, maps keyed by the current diagram's ids.
// A withheld note — an unsent candidate note whose name is not a candidate, or an unsent box or
// arrow note whose id the diagram no longer holds — is not stamped, and the stamped notes move
// ahead of it, so sent notes still lead the list. Returns the new round number, or null when
// there is nothing to send — no unsent note other than withheld ones, the same overall comment
// the last round sent and no change. When `changes` is a list, `sent` — the diagram document the
// Send diffed — becomes `baseline`, the next round's starting file the notes file records.
// A failed save undoes the stamps, the reordering, the round entry and the baseline and
// rethrows, so a retried Send sends the round.
export function sendRound(session, allowed, changes = null, sent = null) {
  const absent = {
    candidate: (anchor) => !allowed.candidates.has(anchor.name),
    box: (anchor) => !allowed.boxes.has(anchor.id),
    arrow: (anchor) => !allowed.arrows.has(anchor.id),
  };
  const withheld = (a) => absent[a.anchor.kind]?.(a.anchor) ?? false;
  const unsent = session.annotations.filter((a) => a.round === undefined && !withheld(a));
  const last = session.rounds.at(-1)?.overall ?? '';
  if (unsent.length === 0 && session.overall.trim() === last.trim() && (changes === null || changes.length === 0)) {
    return null;
  }
  const round = session.round + 1;
  const before = session.annotations;
  for (const note of unsent) {
    note.round = round;
  }
  session.annotations = [...before.filter((a) => a.round !== undefined), ...before.filter((a) => a.round === undefined)];
  const entry = { round, sentAt: new Date().toISOString(), overall: session.overall };
  session.rounds.push(changes === null ? entry : { ...entry, changes });
  session.round = round;
  const baseline = session.baseline;
  if (changes !== null) {
    session.baseline = sent;
  }
  try {
    saveSession(session);
  } catch (err) {
    for (const note of unsent) {
      delete note.round;
    }
    session.annotations = before;
    session.rounds.pop();
    session.round = round - 1;
    session.baseline = baseline;
    throw err;
  }
  return round;
}

// A reply post of the agent for sent round `body.round`: each entry `{ id, body }` appends a
// reply to every stored note carrying that id that was sent in that round or earlier, and an
// optional `overall` appends an overall reply. The whole request is checked before anything
// changes: a problem returns `{ error }` and nothing is applied. A request-level problem is
// the whole error; otherwise the error joins each entry's first problem.
// Once those checks pass, `gate()` runs — the server's re-read of a redrawn diagram (CONTRACT
// §8): `{ error }` refuses the post with nothing applied, and `{ baseline }` names the re-read
// document, which becomes the next round's starting file the notes file records.
// Otherwise the replies are appended with one server time and saved, and `{ replied }` is the
// number of note replies appended. A failed save undoes every append and the baseline and
// rethrows, so a retried post does not duplicate.
export function postReplies(session, body, gate = () => ({})) {
  const round = body?.round;
  if (!Number.isInteger(round) || round < 1 || round > session.round) {
    return { error: `bad round: ${JSON.stringify(round) ?? 'none'}` };
  }
  const entries = body.replies === undefined ? [] : body.replies;
  if (!Array.isArray(entries)) {
    return { error: 'replies is not a list' };
  }
  const overall = body.overall;
  if (overall !== undefined && (typeof overall !== 'string' || overall.trim() === '')) {
    return { error: 'overall reply is blank or not a string' };
  }
  if (entries.length === 0 && overall === undefined) {
    return { error: 'nothing to reply' };
  }
  const problems = [];
  const accepted = [];
  entries.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
      problems.push(`entry ${i}: id is not a string`);
      return;
    }
    if (typeof entry.body !== 'string' || entry.body.trim() === '') {
      problems.push(`entry ${i}: body is blank or not a string`);
      return;
    }
    const carriers = session.annotations.filter((a) => a.id === entry.id);
    const sent = carriers.filter((a) => a.round !== undefined);
    const targets = sent.filter((a) => a.round <= round);
    if (carriers.length === 0) {
      problems.push(`entry ${i}: no note ${entry.id}`);
    } else if (sent.length === 0) {
      problems.push(`entry ${i}: note ${entry.id} is not sent`);
    } else if (targets.length === 0) {
      problems.push(`entry ${i}: note ${entry.id} was sent after round ${round}`);
    } else {
      accepted.push({ targets, text: entry.body });
    }
  });
  if (problems.length > 0) {
    return { error: problems.join('; ') };
  }
  const gated = gate();
  if (gated.error !== undefined) {
    return { error: gated.error };
  }
  const baseline = session.baseline;
  if (gated.baseline !== undefined) {
    session.baseline = gated.baseline;
  }
  const createdAt = new Date().toISOString();
  const appended = [];
  const created = [];
  for (const { targets, text } of accepted) {
    for (const note of targets) {
      if (note.replies === undefined) {
        note.replies = [];
        created.push(note);
      }
      note.replies.push({ body: text, round, createdAt });
      appended.push(note.replies);
    }
  }
  if (overall !== undefined) {
    session.overallReplies.push({ body: overall, round, createdAt });
  }
  try {
    saveSession(session);
  } catch (err) {
    for (const list of appended) {
      list.pop();
    }
    for (const note of created) {
      delete note.replies;
    }
    if (overall !== undefined) {
      session.overallReplies.pop();
    }
    session.baseline = baseline;
    throw err;
  }
  return { replied: appended.length };
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
