// The committed synthetic transcript fixtures (../CONTRACT.md §9), shared by
// the self-test and scripts/check-insights-parity.mjs: where they live, the
// sentinel every free-text field carries, and the copy that substitutes the
// `<ROOT>` token with a JSON-escaped workspace path.
//
// Private to the implementation: only insights.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'transcripts');
export const SENTINEL = 'FIXTURE-TEXT-9c41';
const ROOT_TOKEN = '<ROOT>';

/** Copy the fixture tree `source` to `target`, writing `root` (already JSON-escaped) for every `<ROOT>`. */
export function copyFixtures(source, target, root) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyFixtures(from, to, root);
    } else {
      fs.writeFileSync(to, fs.readFileSync(from, 'utf8').replaceAll(ROOT_TOKEN, root));
    }
  }
}
