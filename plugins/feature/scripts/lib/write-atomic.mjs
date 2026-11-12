// The atomic file writes the plugin's scripts share: a temporary file beside
// the target, its mode set, then moved into place — renamed over the target,
// or linked to a name that must not exist yet.
//
// Private to the implementation: no file under this directory is a command.

import crypto from 'node:crypto';
import fs from 'node:fs';

function viaTemporary(file, text, mode, publish) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    publish(tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Write `text` to `file` through a temporary file beside it, with `mode`, replacing any file there. */
export function writeAtomic(file, text, mode = 0o600) {
  viaTemporary(file, text, mode, (tmp) => fs.renameSync(tmp, file));
}

/**
 * Write `text` to `file` through a temporary file beside it, with `mode`,
 * only when `file` does not exist: the link fails with `EEXIST` otherwise,
 * so of two writers racing for one name exactly one gets it.
 */
export function writeExclusive(file, text, mode = 0o600) {
  viaTemporary(file, text, mode, (tmp) => fs.linkSync(tmp, file));
}
