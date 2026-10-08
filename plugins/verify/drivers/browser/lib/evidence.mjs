// `evidence` (CONTRACT.md §8) and the capture write behind `screenshot`
// (CONTRACT.md §11).
//
// A capture is written into the --evidence directory and recorded in the
// session's ledger; `evidence` re-reads every recorded file from disk and
// reports its size, hash and whether it may be uploaded. Nothing here speaks
// to the browser.
//
// Private to the implementation: only cli.mjs is a command.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { appendLedger, readLedger, readState } from './session.mjs';
import { UPLOAD_NAME_RE } from './steps.mjs';

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Write one capture to `<evidenceDir>/<name>` and record it in the session's
 * ledger. Returns the absolute path written; a write error propagates.
 *
 * The bytes go to a fresh temporary file created exclusively (it never opens
 * an existing path, so never follows a symlink planted there) and are renamed
 * over the name, which replaces whatever entry held it instead of writing
 * through it.
 */
export function writeCapture(sessionDirPath, evidenceDir, name, data, viewport) {
  const file = path.join(evidenceDir, name);
  const tmp = path.join(evidenceDir, `.${name}.tmp-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx', mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  appendLedger(sessionDirPath, { name, path: file, viewport: { ...viewport } });
  return file;
}

// The bytes of a recorded capture, or null when it is missing or is not a
// regular file — a symlink in its place is never followed.
function readCapture(file) {
  try {
    if (!fs.lstatSync(file).isFile()) {
      return null;
    }
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

export async function evidence({ session }) {
  const { dir } = readState(session);
  const latest = new Map();
  for (const entry of readLedger(dir)) {
    if (entry && typeof entry.path === 'string') {
      latest.set(entry.path, entry);
    }
  }
  const entries = [...latest.keys()].sort().map((file) => {
    const entry = latest.get(file);
    const data = readCapture(file);
    const bytes = data === null ? null : data.length;
    return {
      bytes,
      missing: data === null,
      name: entry.name,
      path: file,
      sha256: data === null ? null : crypto.createHash('sha256').update(data).digest('hex'),
      uploadable: data !== null && bytes >= 1 && bytes <= MAX_UPLOAD_BYTES && UPLOAD_NAME_RE.test(entry.name),
      viewport: entry.viewport,
    };
  });
  return { evidence: entries, session };
}
