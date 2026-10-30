// The overview document for the margin command (CONTRACT §13): one JSON object describing a
// run's files and its refactoring candidates, read once when a run starts and served to the
// viewer. `checkOverview` is the single definition of a valid document and returns a copy that
// holds only the checked fields; `readOverview` bounds, reads and parses a file, then checks it.
// Both throw a `RunError` with exit 1, so `cli.mjs` stays the only place that exits, and both
// run without a server, so whatever assembles an overview can check it before writing it.

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { CANDIDATE_NAME } from './annotations.mjs';
import { RunError } from './session.mjs';

export const MAX_OVERVIEW_BYTES = 2 * 1024 * 1024;

const TIERS = ['strong', 'worth-exploring', 'speculative'];
const CATEGORIES = ['in-process', 'local-substitutable', 'remote-owned', 'true-external'];
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

class ShapeViolation extends Error {}

function violation(text) {
  throw new ShapeViolation(text);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function isNonNegativeInt(value) {
  return Number.isInteger(value) && value >= 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function orNull(test) {
  return (value) => value === null || test(value);
}

function isOverviewPath(value) {
  return isNonEmptyString(value)
    && !value.includes('\\')
    && !value.startsWith('/')
    && value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function at(loc, key) {
  return loc === '' ? key : `${loc}.${key}`;
}

function field(entry, key, loc, test, expected) {
  if (!Object.hasOwn(entry, key)) {
    violation(`missing key ${at(loc, key)}`);
  }
  const value = entry[key];
  if (!test(value)) {
    violation(`${at(loc, key)} is not ${expected}`);
  }
  return value;
}

function requireObject(entry, loc) {
  if (!isObject(entry)) {
    violation(loc === '' ? 'the document is not an object' : `${loc} is not an object`);
  }
}

function copyOrNull(list) {
  return list === null ? null : [...list];
}

function checkFile(entry, loc) {
  requireObject(entry, loc);
  return {
    path: field(entry, 'path', loc, isOverviewPath, 'a root-relative path'),
    lines: field(entry, 'lines', loc, orNull(isNonNegativeInt), 'a non-negative integer or null'),
    churn: field(entry, 'churn', loc, orNull(isNonNegativeInt), 'a non-negative integer or null'),
    indentation: field(entry, 'indentation', loc, orNull(isNonNegativeInt), 'a non-negative integer or null'),
    kind: field(entry, 'kind', loc, orNull(isNonEmptyString), 'a non-empty string or null'),
    role: field(entry, 'role', loc, orNull(isNonEmptyString), 'a non-empty string or null'),
    exports: copyOrNull(field(entry, 'exports', loc, orNull(isStringArray), 'an array of non-empty strings or null')),
    mixes: copyOrNull(field(entry, 'mixes', loc, orNull(isStringArray), 'an array of non-empty strings or null')),
    imports: [...field(entry, 'imports', loc, Array.isArray, 'an array')],
    outside: [...field(entry, 'outside', loc, isStringArray, 'an array of non-empty strings')],
  };
}

function isUtcTimestamp(value) {
  return typeof value === 'string' && UTC_TIMESTAMP.test(value) && !Number.isNaN(Date.parse(value));
}

function checkOverviewFiles(list, loc, paths) {
  const seen = new Map();
  list.forEach((path, j) => {
    if (!paths.has(path)) {
      violation(`${loc}[${j}] is not an overview file`);
    }
    if (seen.has(path)) {
      violation(`${loc}[${j}] duplicates ${loc}[${seen.get(path)}]`);
    }
    seen.set(path, j);
  });
}

function checkFiles(list) {
  const index = new Map();
  const files = list.map((entry, i) => {
    const file = checkFile(entry, `files[${i}]`);
    if (index.has(file.path)) {
      violation(`files[${i}].path duplicates files[${index.get(file.path)}].path`);
    }
    index.set(file.path, i);
    return file;
  });
  files.forEach((file, i) => {
    checkOverviewFiles(file.imports, `files[${i}].imports`, index);
  });
  return { files, paths: index };
}

function checkSite(entry, loc, candidateFiles) {
  requireObject(entry, loc);
  const path = field(entry, 'path', loc, isNonEmptyString, 'a non-empty string');
  if (!candidateFiles.includes(path)) {
    violation(`${loc}.path is not one of the candidate's files`);
  }
  return {
    path,
    line: field(entry, 'line', loc, (value) => Number.isInteger(value) && value >= 1, 'an integer of at least 1'),
    what: field(entry, 'what', loc, isNonEmptyString, 'a non-empty string'),
  };
}

function checkCandidate(entry, loc, paths) {
  requireObject(entry, loc);
  const name = field(entry, 'name', loc, (value) => typeof value === 'string' && CANDIDATE_NAME.test(value), 'a name of lowercase letters, digits and hyphens');
  const tier = field(entry, 'tier', loc, (value) => TIERS.includes(value), `one of ${TIERS.join(', ')}`);
  const category = field(entry, 'category', loc, (value) => CATEGORIES.includes(value), `one of ${CATEGORIES.join(', ')}`);
  const files = [...field(entry, 'files', loc, (value) => Array.isArray(value) && value.length > 0, 'a non-empty array')];
  checkOverviewFiles(files, `${loc}.files`, paths);
  const nextChange = field(entry, 'next_change', loc, isNonEmptyString, 'a non-empty string');
  const sites = field(entry, 'next_sites', loc, Array.isArray, 'an array');
  return {
    name,
    tier,
    category,
    files,
    next_change: nextChange,
    next_sites: sites.map((site, k) => checkSite(site, `${loc}.next_sites[${k}]`, files)),
    est_diff_lines: field(entry, 'est_diff_lines', loc, isNonNegativeInt, 'a non-negative integer'),
    deletion_test: field(entry, 'deletion_test', loc, isNonEmptyString, 'a non-empty string'),
    friction: field(entry, 'friction', loc, isNonEmptyString, 'a non-empty string'),
  };
}

function checkCandidates(list, paths) {
  const index = new Map();
  return list.map((entry, i) => {
    const candidate = checkCandidate(entry, `candidates[${i}]`, paths);
    if (index.has(candidate.name)) {
      violation(`candidates[${i}].name duplicates candidates[${index.get(candidate.name)}].name`);
    }
    index.set(candidate.name, i);
    return candidate;
  });
}

function checkDocument(value) {
  requireObject(value, '');
  const version = field(value, 'version', '', (v) => v === 1, 'the number 1');
  const root = field(value, 'root', '', (v) => typeof v === 'string' && isAbsolute(v), 'an absolute path');
  const scope = [...field(value, 'scope', '', Array.isArray, 'an array')];
  scope.forEach((entry, i) => {
    if (entry !== '.' && !isOverviewPath(entry)) {
      violation(`scope[${i}] is not . or a root-relative path`);
    }
  });
  const generatedAt = field(value, 'generatedAt', '', isUtcTimestamp, 'an ISO 8601 UTC timestamp');
  const fileList = field(value, 'files', '', Array.isArray, 'an array');
  const candidateList = field(value, 'candidates', '', Array.isArray, 'an array');
  const notices = [...field(value, 'notices', '', isStringArray, 'an array of non-empty strings')];
  const { files, paths } = checkFiles(fileList);
  const candidates = checkCandidates(candidateList, paths);
  return { version, root, scope, generatedAt, files, candidates, notices };
}

export function checkOverview(value, label = 'overview') {
  try {
    return checkDocument(value);
  } catch (err) {
    if (err instanceof ShapeViolation) {
      throw new RunError(`${label}: ${err.message}`, 1);
    }
    throw err;
  }
}

export function readOverview(file) {
  const label = `overview ${file}`;
  let stat;
  try {
    stat = statSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      throw new RunError(`${label}: not found`, 1);
    }
    throw new RunError(`${label}: could not be read (${err?.code ?? err?.message})`, 1);
  }
  if (!stat.isFile()) {
    throw new RunError(`${label}: not a regular file`, 1);
  }
  if (stat.size > MAX_OVERVIEW_BYTES) {
    throw new RunError(`${label}: ${(stat.size / 1024 / 1024).toFixed(1)} MB is above the ${MAX_OVERVIEW_BYTES / 1024 / 1024} MB overview limit`, 1);
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new RunError(`${label}: could not be read (${err?.code ?? err?.message})`, 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new RunError(`${label}: not valid JSON (${err.message})`, 1);
  }
  return checkOverview(parsed, label);
}

// The names of a checked overview's candidates, the set a candidate anchor is checked against;
// empty for a run without an overview.
export function candidateNames(overview) {
  return new Set(overview ? overview.candidates.map((candidate) => candidate.name) : []);
}
