// `--entry` file validation (CONTRACT.md §5).
//
// The caller has already resolved the project's configuration; the driver only
// checks shape. `start` arrives as file content and is never interpolated into
// a command line. `start_timeout` follows the feature pipeline's rule: an
// integer 1..540 is used as-is, absent means 60, anything else falls back to 60
// with a note.
//
// Private to the implementation: only cli.mjs is a command.

import path from 'node:path';

import { UsageError } from './output.mjs';

export const DEFAULT_START_TIMEOUT = 60;
export const MAX_START_TIMEOUT = 540;

const ENTRY_KEYS = new Set(['url', 'start', 'cwd', 'start_timeout', 'auth']);
const AUTH_KEYS = new Set(['storage_state']);

/** Normalise start_timeout to `{ value, note }` (note is null when none). */
export function normaliseStartTimeout(raw) {
  if (raw === undefined) {
    return { value: DEFAULT_START_TIMEOUT, note: null };
  }
  if (Number.isInteger(raw) && raw >= 1 && raw <= MAX_START_TIMEOUT) {
    return { value: raw, note: null };
  }
  return {
    value: DEFAULT_START_TIMEOUT,
    note: `start_timeout ${JSON.stringify(raw)} is not an integer 1..${MAX_START_TIMEOUT}; using ${DEFAULT_START_TIMEOUT}`,
  };
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate a parsed entry object. Returns
 * `{ url, start, cwd, start_timeout, storage_state, notes }` with absent
 * optionals as null, or throws a UsageError.
 */
export function validateEntry(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new UsageError('entry: the file must hold a JSON object');
  }
  for (const key of Object.keys(json)) {
    if (!ENTRY_KEYS.has(key)) {
      throw new UsageError(`entry: unknown key ${JSON.stringify(key)}`);
    }
  }
  if (typeof json.url !== 'string' || !isHttpUrl(json.url)) {
    throw new UsageError('entry: url must be an absolute http(s) URL');
  }
  let start = null;
  if (Object.hasOwn(json, 'start')) {
    if (typeof json.start !== 'string' || json.start.trim() === '') {
      throw new UsageError('entry: start must be a non-empty string');
    }
    start = json.start;
  }
  let cwd = null;
  if (Object.hasOwn(json, 'cwd')) {
    if (typeof json.cwd !== 'string' || !path.isAbsolute(json.cwd)) {
      throw new UsageError('entry: cwd must be an absolute path');
    }
    cwd = json.cwd;
  }
  if (start !== null && cwd === null) {
    throw new UsageError('entry: start needs cwd, the absolute directory it runs from');
  }
  let storageState = null;
  if (Object.hasOwn(json, 'auth')) {
    const auth = json.auth;
    if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) {
      throw new UsageError('entry: auth must be an object');
    }
    for (const key of Object.keys(auth)) {
      if (!AUTH_KEYS.has(key)) {
        throw new UsageError(`entry: unknown auth key ${JSON.stringify(key)}`);
      }
    }
    if (typeof auth.storage_state !== 'string' || !path.isAbsolute(auth.storage_state)) {
      throw new UsageError('entry: auth.storage_state must be an absolute path');
    }
    storageState = auth.storage_state;
  }
  const timeout = normaliseStartTimeout(json.start_timeout);
  return {
    url: json.url,
    start,
    cwd,
    start_timeout: timeout.value,
    storage_state: storageState,
    notes: timeout.note === null ? [] : [timeout.note],
  };
}
