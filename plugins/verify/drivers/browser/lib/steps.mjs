// Step-file schema and the screenshot-name grammar (CONTRACT.md §7, §11).
//
// Pure: no I/O beyond reading the file, no browser. The whole file is validated
// before any step runs, so a bad step 7 exits 2 without executing steps 0-6.
//
// Private to the implementation: only cli.mjs is a command.

import fs from 'node:fs';

import { UsageError } from './output.mjs';

export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 60000;
const MAX_VIEWPORT = 10000;

/** The feature pipeline's capture grammar, a subset of ^[A-Za-z0-9-]+\.png$. */
export const NAME_RE = /^(?:[A-Z][A-Z0-9]*-[0-9]+-)?(?:AC-[0-9]+|[a-z0-9]+(?:-[a-z0-9]+)*-(?:empty|error|disabled))-(?:desktop|mobile)\.png$/;

/** The upload rule every evidence name must also satisfy. */
export const UPLOAD_NAME_RE = /^[A-Za-z0-9-]+\.png$/;

/** Viewport width a name's suffix requires at capture time. */
export const SUFFIX_WIDTH = { desktop: 1280, mobile: 390 };

export const NAMED_KEYS = new Set([
  'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

// Per-step field rules. `required`: every field must be present. `oneOf`:
// exactly one of the fields. `optional`: may be present. `step` and
// `timeout_ms` are accepted on every step.
const SPEC = {
  goto: { required: ['url'], optional: [], oneOf: [] },
  click: { required: [], optional: [], oneOf: ['testid', 'text'] },
  fill: { required: ['testid', 'value'], optional: [], oneOf: [] },
  press: { required: ['key'], optional: ['testid'], oneOf: [] },
  wait: { required: [], optional: [], oneOf: ['text', 'url', 'ms'] },
  expect: { required: [], optional: [], oneOf: ['text', 'testid', 'url'] },
  viewport: { required: ['width', 'height'], optional: [], oneOf: [] },
  screenshot: { required: ['name'], optional: [], oneOf: [] },
};

export const STEP_VERBS = Object.keys(SPEC);

/** True when `name` is a valid evidence file name. */
export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && UPLOAD_NAME_RE.test(name);
}

/** The viewport suffix (`desktop` | `mobile`) of a valid name. */
export function nameSuffix(name) {
  return name.endsWith('-mobile.png') ? 'mobile' : 'desktop';
}

/** True when `value` is a path beginning `/` (not `//`) or an http(s) URL. */
export function isNavigableUrl(value) {
  if (typeof value !== 'string' || value === '') {
    return false;
  }
  if (value.startsWith('/')) {
    return !value.startsWith('//');
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isIntIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isPrintableChar(value) {
  const chars = Array.from(value);
  return chars.length === 1 && !/[\u0000-\u001f\u007f]/.test(value);
}

function checkField(index, field, value) {
  const where = `step ${index}: ${field}`;
  switch (field) {
    case 'url':
      if (!isNavigableUrl(value)) {
        throw new UsageError(`${where} must be a path beginning / or an http(s) URL`);
      }
      return;
    case 'testid':
    case 'text':
      if (typeof value !== 'string' || value.trim() === '') {
        throw new UsageError(`${where} must be a non-empty string`);
      }
      return;
    case 'value':
      if (typeof value !== 'string') {
        throw new UsageError(`${where} must be a string`);
      }
      return;
    case 'key':
      if (typeof value !== 'string' || !(NAMED_KEYS.has(value) || isPrintableChar(value))) {
        throw new UsageError(`${where} must be a named key (${[...NAMED_KEYS].join(', ')}) or one printable character`);
      }
      return;
    case 'ms':
      if (!isIntIn(value, 1, MAX_TIMEOUT_MS)) {
        throw new UsageError(`${where} must be an integer 1..${MAX_TIMEOUT_MS}`);
      }
      return;
    case 'width':
    case 'height':
      if (!isIntIn(value, 1, MAX_VIEWPORT)) {
        throw new UsageError(`${where} must be an integer 1..${MAX_VIEWPORT}`);
      }
      return;
    case 'name':
      if (!isValidName(value)) {
        throw new UsageError(`${where} is outside the evidence-name grammar (CONTRACT.md §11): ${String(value).slice(0, 80)}`);
      }
      return;
    case 'timeout_ms':
      if (!isIntIn(value, 1, MAX_TIMEOUT_MS)) {
        throw new UsageError(`${where} must be an integer 1..${MAX_TIMEOUT_MS}`);
      }
      return;
    default:
      throw new UsageError(`${where} is not a known field`);
  }
}

/**
 * Validate a parsed step file. Returns normalised steps (with `timeout_ms`
 * defaulted) or throws a UsageError naming the 0-based step index.
 */
export function validateSteps(json) {
  if (!Array.isArray(json)) {
    throw new UsageError('steps: the file must hold a JSON array of step objects');
  }
  if (json.length === 0) {
    throw new UsageError('steps: the array is empty');
  }
  return json.map((raw, index) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new UsageError(`step ${index}: must be an object`);
    }
    const verb = raw.step;
    if (typeof verb !== 'string' || !Object.hasOwn(SPEC, verb)) {
      throw new UsageError(`step ${index}: unknown step ${JSON.stringify(verb)} (expected one of: ${STEP_VERBS.join(', ')})`);
    }
    const spec = SPEC[verb];
    const allowed = new Set(['step', 'timeout_ms', ...spec.required, ...spec.optional, ...spec.oneOf]);
    for (const field of Object.keys(raw)) {
      if (!allowed.has(field)) {
        throw new UsageError(`step ${index}: ${verb} does not take field ${JSON.stringify(field)}`);
      }
    }
    for (const field of spec.required) {
      if (!Object.hasOwn(raw, field)) {
        throw new UsageError(`step ${index}: ${verb} needs ${field}`);
      }
    }
    if (spec.oneOf.length > 0) {
      const given = spec.oneOf.filter((field) => Object.hasOwn(raw, field));
      if (given.length !== 1) {
        throw new UsageError(`step ${index}: ${verb} needs exactly one of ${spec.oneOf.join(', ')}`);
      }
    }
    const step = { step: verb, timeout_ms: DEFAULT_TIMEOUT_MS };
    for (const field of Object.keys(raw)) {
      if (field === 'step') {
        continue;
      }
      checkField(index, field, raw[field]);
      step[field] = raw[field];
    }
    return step;
  });
}

/**
 * Read and parse a JSON input file named by a path flag. An unreadable or
 * malformed file is an invocation error.
 */
export function readJsonFile(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new UsageError(`${label}: cannot read ${file} (${err.code || err.message})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`${label}: ${file} is not valid JSON`);
  }
}
