// The reader the plugin's scripts share for `claudedocs/tickets/config.yaml`.
//
// Deliberately small: top-level scalars and one level of nested mapping,
// nothing else. Deeper nesting, sequences and flow collections are skipped
// without being interpreted, so a block a script does not read can never fail
// its run.
//
// Private to the implementation: no file under this directory is a command.

const KEY_LINE = /^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*))?$/;

/**
 * Parse the subset of YAML the scripts read. Returns an object whose
 * top-level values are strings (scalars) or objects of strings (one nested
 * mapping level). Pure.
 */
export function parseMiniYaml(text) {
  const out = {};
  let block = null;
  let blockIndent = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const body = line.trimStart();
    if (body === '' || body.startsWith('#')) {
      continue;
    }
    const indent = line.length - body.length;
    if (indent === 0) {
      block = null;
      blockIndent = null;
      const entry = splitKey(body);
      if (entry === null) {
        continue;
      }
      if (entry.value === '') {
        out[entry.key] = {};
        block = entry.key;
      } else {
        out[entry.key] = entry.value;
      }
      continue;
    }
    if (block === null || body.startsWith('-')) {
      continue;
    }
    if (blockIndent === null) {
      blockIndent = indent;
    }
    if (indent !== blockIndent) {
      continue;
    }
    const entry = splitKey(body);
    if (entry !== null) {
      out[block][entry.key] = entry.value;
    }
  }
  return out;
}

/** `key: value` → `{key, value}` with the value unquoted and comment-free; else null. */
function splitKey(body) {
  const match = KEY_LINE.exec(body);
  if (match === null) {
    return null;
  }
  return { key: match[1], value: parseValue(match[2] ?? '') };
}

/** One matched pair of quotes stripped; a ` #` comment outside quotes dropped. */
function parseValue(raw) {
  const value = raw.trim();
  if (value === '' || value.startsWith('#')) {
    return '';
  }
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end !== -1) {
      const rest = value.slice(end + 1).trim();
      if (rest === '' || rest.startsWith('#')) {
        return value.slice(1, end);
      }
    }
  }
  const hash = value.search(/\s#/);
  return (hash === -1 ? value : value.slice(0, hash)).trim();
}
