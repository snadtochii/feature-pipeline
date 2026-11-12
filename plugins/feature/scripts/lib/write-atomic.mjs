// The atomic file write the plugin's scripts share: a temporary file beside
// the target, its mode set, then renamed into place.
//
// Private to the implementation: no file under this directory is a command.

import crypto from 'node:crypto';
import fs from 'node:fs';

/** Write `text` to `file` through a temporary file beside it, with `mode`. */
export function writeAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}
