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
 */
export function writeCapture(sessionDirPath, evidenceDir, name, data, viewport) {
  const file = path.join(evidenceDir, name);
  fs.writeFileSync(file, data);
  appendLedger(sessionDirPath, { name, path: file, viewport: { ...viewport } });
  return file;
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
    let data = null;
    try {
      data = fs.readFileSync(file);
    } catch {
      data = null;
    }
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
