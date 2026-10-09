// Session ids, paths and on-disk state for the browser driver.
//
// A session lives in a fixed /tmp/fp-verify-<id>/ directory (CONTRACT.md §12):
// a fixed root because the processes that launch, drive and clean up a session
// may each see a different TMPDIR. An id is 12 lowercase hex characters and is
// validated before any path is built from it. The directory is mode 0700 and
// state.json mode 0600, both rewritten by temp-file-and-rename.
//
// Private to the implementation: only cli.mjs is a command.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ComputeError, UsageError } from './output.mjs';

export const SESSION_ROOT = '/tmp';
export const SESSION_PREFIX = 'fp-verify-';
const ID_RE = /^[a-f0-9]{12}$/;

/** A fresh random session id. */
export function newId() {
  return crypto.randomBytes(6).toString('hex');
}

/** True when `id` is a well-formed session id. */
export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/** Throw a UsageError unless `id` is a well-formed session id. */
export function validateId(id) {
  if (!isValidId(id)) {
    throw new UsageError(`--session: not a session id (expected 12 lowercase hex characters): ${String(id).slice(0, 40)}`);
  }
  return id;
}

/** The session directory for a validated id. */
export function sessionDir(id) {
  return path.join(SESSION_ROOT, `${SESSION_PREFIX}${validateId(id)}`);
}

/** Create a new session directory (mode 0700). Returns `{ id, dir }`. */
export function createSession() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = newId();
    const dir = sessionDir(id);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if (err.code === 'EEXIST') {
        continue;
      }
      throw new ComputeError(`cannot create session directory ${dir}: ${err.code || err.message}`);
    }
    fs.chmodSync(dir, 0o700);
    return { id, dir };
  }
  throw new ComputeError('cannot allocate a free session id');
}

/**
 * True when `dir` is a session directory this user created: a real directory
 * (not a symlink) owned by the current user and closed to group and others.
 * /tmp is shared, so anything else may be another user's session or a forgery.
 */
export function isOwnSessionDir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return false;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : st.uid;
  return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o077) === 0;
}

/** Ids of every session directory this user owns, sorted. */
export function listSessions() {
  let names;
  try {
    names = fs.readdirSync(SESSION_ROOT);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(SESSION_PREFIX))
    .map((name) => name.slice(SESSION_PREFIX.length))
    .filter(isValidId)
    .filter((id) => isOwnSessionDir(sessionDir(id)))
    .sort();
}

/** Write a JSON file by temp-file-and-rename with the given mode. */
export function writeJsonAtomic(file, value, mode = 0o600) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** Write a session's state.json. */
export function writeState(dir, state) {
  writeJsonAtomic(path.join(dir, 'state.json'), state);
}

/**
 * Read a session's state.json, or null when the file is absent or unreadable,
 * or the directory is not one this user owns.
 */
export function tryReadState(dir) {
  if (!isOwnSessionDir(dir)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Read a session's state, throwing a ComputeError when there is no such session. */
export function readState(id) {
  const dir = sessionDir(id);
  const state = tryReadState(dir);
  if (state === null) {
    throw new ComputeError(`no such session: ${id}`);
  }
  return { dir, state };
}

/** Remove a session directory and everything in it. */
export function removeSession(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** The capture ledger: `{ name, path, viewport }` per capture, in capture order. */
export function readLedger(dir) {
  try {
    const entries = JSON.parse(fs.readFileSync(path.join(dir, 'evidence.json'), 'utf8'));
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

/** Append one capture to the ledger. */
export function appendLedger(dir, entry) {
  const entries = readLedger(dir);
  entries.push(entry);
  writeJsonAtomic(path.join(dir, 'evidence.json'), entries);
}
