// Output and error classes for the dispatcher.
//
// The dispatcher prints exactly one JSON document on stdout per run: keys sorted
// recursively by code unit, two-space indent, one trailing newline
// (CONTRACT.md §2). A thrown UsageError maps to exit 2, anything else to exit 1,
// and both print {"error": "<reason>"} (CONTRACT.md §3). The classes and the
// rendering are the plugin's shared output contract; the one-document rule is
// the dispatcher's own.
//
// Private to the implementation: only dispatch.mjs is a command.

import { render, writeOut } from '../../lib/output.mjs';

export * from '../../lib/output.mjs';

let emitted = false;

/**
 * Print the run's one document. A second call — a signal arriving after the
 * answer was printed — prints nothing, so stdout never holds two documents.
 * Returns whether this call printed.
 */
export function emit(doc) {
  if (emitted) {
    return false;
  }
  emitted = true;
  writeOut(render(doc));
  return true;
}
