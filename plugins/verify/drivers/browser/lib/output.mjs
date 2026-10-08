// Output and error classes for the browser driver.
//
// The driver prints exactly one JSON document on stdout per run: keys sorted
// recursively by code unit, two-space indent, one trailing newline
// (CONTRACT.md §2). A thrown UsageError maps to exit 2, anything else to exit 1,
// and both print {"error": "<reason>"} (CONTRACT.md §3).
//
// Private to the implementation: only cli.mjs is a command.

import fs from 'node:fs';

/** The invocation was wrong — exit 2. */
export class UsageError extends Error {}

/** The answer could not be computed — exit 1. */
export class ComputeError extends Error {}

export const EXIT_OK = 0;
export const EXIT_CANNOT_COMPUTE = 1;
export const EXIT_BAD_USAGE = 2;

/**
 * Return a copy of `value` whose object keys are sorted recursively by code
 * unit. Arrays keep their order; `undefined` object members are dropped.
 */
export function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) {
        out[key] = sortKeys(value[key]);
      }
    }
    return out;
  }
  return value;
}

/** Serialise one output document: sorted keys, two-space indent, one newline. */
export function render(doc) {
  return `${JSON.stringify(sortKeys(doc), null, 2)}\n`;
}

/** The exit code a thrown error maps to. */
export function exitCodeFor(err) {
  if (err instanceof UsageError) {
    return EXIT_BAD_USAGE;
  }
  return EXIT_CANNOT_COMPUTE;
}

/** Collapse a message to one line. */
export function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/** The {"error"} document for a thrown error. */
export function errorDoc(err) {
  const message = err instanceof Error ? err.message : String(err);
  return { error: oneLine(message) || 'unknown error' };
}

/**
 * Write to stdout synchronously, so a document followed by process.exit is
 * never truncated on a pipe.
 */
export function writeOut(text) {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(1, buf, offset, buf.length - offset);
    } catch (err) {
      if (err.code !== 'EAGAIN') {
        throw err;
      }
    }
  }
}

/** The last `lines` lines of a log file, one-lined, or '' when unreadable. */
export function logTail(file, lines = 20) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const kept = text.split('\n').filter((line) => line.trim() !== '');
    return oneLine(kept.slice(-lines).join(' | '));
  } catch {
    return '';
  }
}
