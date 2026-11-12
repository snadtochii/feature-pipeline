// The committed synthetic fixtures (../CONTRACT.md §11): the transcript
// fixtures, shared by the self-test and scripts/check-insights-parity.mjs, and
// the ticket-tree fixtures the self-test alone uses. Where they live, the
// sentinel every free-text field carries, the transcript copy that substitutes
// the `<ROOT>` token with a JSON-escaped workspace path, and the byte-exact
// ticket-tree copy.
//
// Private to the implementation: only insights.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const FIXTURES_DIR = path.join(FIXTURES_ROOT, 'transcripts');
export const TICKET_FIXTURES_DIR = path.join(FIXTURES_ROOT, 'tickets');
export const SENTINEL = 'FIXTURE-TEXT-9c41';

/** Copy the ticket fixture tree `name` byte for byte into `target`, a project's `claudedocs/tickets/`. */
export function copyTicketFixtures(name, target) {
  fs.cpSync(path.join(TICKET_FIXTURES_DIR, name), target, { recursive: true });
}
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
