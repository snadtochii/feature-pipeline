// The assembly rules of the overview data (CONTRACT §14): a measurement document, a roles JSON
// and a deepen explorer's text output become one overview document (§13). The roles and the
// explorer output are model-written, so nothing in them fails the run: a bad field becomes
// null, a bad block is dropped with a warning, a missing input becomes a notice. Only the
// measurement file, the overview shape check and the size cap can refuse.

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { MAX_OVERVIEW_BYTES, checkOverview } from './overview.mjs';
import { RunError } from './session.mjs';

const LIMIT_MB = MAX_OVERVIEW_BYTES / 1024 / 1024;
const BLOCK_FIELDS = ['name', 'tier', 'category', 'files', 'next_change', 'est_diff_lines', 'deletion_test', 'friction'];
const BLOCK_KEYS = [...BLOCK_FIELDS, 'next_sites', 'structural_key', 'adr_conflict'];
const FIELD_LINE = /^([a-z_]+):\s?(.*)$/;
const LOOSE_FIELD_LINE = /^(?:[-*+]\s+)?[*_]*([A-Za-z_]+)[*_]*\s*:/;
const SITE_LINE = /^(\S+?):(\d+)\s+[—–-]\s+(.+)$/;
const FENCE_LINE = /^\s*```/;
const ROLE_FIELDS = ['kind', 'role', 'exports', 'mixes'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

function megabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function readBounded(file) {
  let stat;
  try {
    stat = statSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
      return { reason: 'not found' };
    }
    return { reason: `could not be read (${err?.code ?? err?.message})` };
  }
  if (!stat.isFile()) {
    return { reason: 'not a regular file' };
  }
  if (stat.size > MAX_OVERVIEW_BYTES) {
    return { reason: `${megabytes(stat.size)} MB is above the ${LIMIT_MB} MB limit` };
  }
  try {
    return { text: readFileSync(file, 'utf8') };
  } catch (err) {
    return { reason: `could not be read (${err?.code ?? err?.message})` };
  }
}

export function readOptional(file, what) {
  if (file === undefined) {
    return { reason: `no ${what} file was given` };
  }
  const read = readBounded(file);
  return read.reason === undefined ? read : { reason: `${what} file ${file}: ${read.reason}` };
}

function measurementProblem(value) {
  if (!isObject(value)) {
    return 'not a JSON object';
  }
  if (value.version !== 1) {
    return 'version is not 1';
  }
  if (typeof value.root !== 'string' || !isAbsolute(value.root)) {
    return 'root is not an absolute path';
  }
  if (!Array.isArray(value.scope)) {
    return 'scope is not an array';
  }
  if (!Array.isArray(value.files)) {
    return 'files is not an array';
  }
  const bad = value.files.findIndex((file) => !isObject(file) || typeof file.path !== 'string');
  return bad === -1 ? null : `files[${bad}] is not an object with a string path`;
}

export function readMeasurement(file) {
  const label = `measurements ${file}`;
  const read = readBounded(file);
  if (read.reason !== undefined) {
    throw new RunError(`${label}: ${read.reason}`, 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(read.text);
  } catch (err) {
    throw new RunError(`${label}: not valid JSON (${err.message})`, 1);
  }
  const problem = measurementProblem(parsed);
  if (problem !== null) {
    throw new RunError(`${label}: ${problem}`, 1);
  }
  return parsed;
}

function normalisePath(raw, prefix, known) {
  let path = raw.trim();
  while (path.startsWith('./')) {
    path = path.slice(2);
  }
  if (!known.has(path) && prefix !== '' && path.startsWith(prefix)) {
    path = path.slice(prefix.length);
  }
  return path;
}

function unique(list) {
  return [...new Set(list)];
}

function stripFence(text) {
  const trimmed = text.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced === null ? trimmed : fenced[1];
}

function roleValue(entry, field, path, warnings) {
  if (!Object.hasOwn(entry, field)) {
    return null;
  }
  const value = entry[field];
  if (field === 'kind' || field === 'role') {
    if (isNonEmptyString(value)) {
      return value;
    }
  } else if (Array.isArray(value) && value.every(isNonEmptyString)) {
    return unique(value);
  }
  warnings.push(`roles: ${path}.${field} is not ${field === 'kind' || field === 'role' ? 'a non-empty string' : 'an array of non-empty strings'}, set to null`);
  return null;
}

function parseRoles(text, prefix, known) {
  let parsed;
  try {
    parsed = JSON.parse(stripFence(text));
  } catch (err) {
    return { roles: new Map(), warnings: [], reason: `the roles input is not valid JSON (${err.message})` };
  }
  if (!isObject(parsed)) {
    return { roles: new Map(), warnings: [], reason: 'the roles input is not a JSON object' };
  }
  const roles = new Map();
  const warnings = [];
  for (const key of Object.keys(parsed)) {
    const path = normalisePath(key, prefix, known);
    if (!known.has(path)) {
      warnings.push(`roles: ignored ${key}, which is not in the scope`);
      continue;
    }
    const entry = parsed[key];
    if (!isObject(entry)) {
      warnings.push(`roles: ${key} is not an object, its fields are null`);
      continue;
    }
    roles.set(path, Object.fromEntries(ROLE_FIELDS.map((field) => [field, roleValue(entry, field, path, warnings)])));
  }
  return { roles, warnings, reason: null };
}

function namesBlockField(line) {
  const match = LOOSE_FIELD_LINE.exec(line.trim());
  return match !== null && BLOCK_KEYS.includes(match[1].toLowerCase());
}

function explorerChunks(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((line) => !FENCE_LINE.test(line));
  return lines.join('\n').split(/\n\s*\n/).map((chunk) => {
    const chunkLines = chunk.split('\n');
    const fields = chunkLines.flatMap((line) => {
      const match = FIELD_LINE.exec(line.trim());
      return match === null ? [] : [[match[1], match[2].trim()]];
    });
    return { fields, isBlock: chunkLines.some(namesBlockField) };
  });
}

function parseBlock(fields, number, prefix, known) {
  const values = new Map();
  const sites = [];
  let repeated = null;
  for (const [key, value] of fields) {
    if (key === 'next_sites') {
      sites.push(value);
    } else if (BLOCK_FIELDS.includes(key)) {
      if (values.has(key) && repeated === null) {
        repeated = key;
      }
      values.set(key, value);
    }
  }
  const label = values.get('name') ? `"${values.get('name')}"` : `block ${number}`;
  const drop = (reason) => ({ label, reason });
  if (repeated !== null) {
    return drop(`repeats ${repeated}`);
  }
  const missing = BLOCK_FIELDS.find((field) => !values.has(field));
  if (missing !== undefined) {
    return drop(`missing ${missing}`);
  }
  const files = unique(values.get('files').split(',').map((path) => path.trim()).filter((path) => path !== '')
    .map((path) => normalisePath(path, prefix, known)));
  const stranger = files.find((path) => !known.has(path));
  if (stranger !== undefined) {
    return drop(`names ${stranger}, which is not in the scope`);
  }
  const nextSites = [];
  for (const [k, line] of sites.entries()) {
    const match = SITE_LINE.exec(line);
    if (match === null) {
      return drop(`next_sites line ${k + 1} is not <path>:<line> — <what>`);
    }
    nextSites.push({ path: normalisePath(match[1], prefix, known), line: Number(match[2]), what: match[3].trim() });
  }
  if (!/^\d+$/.test(values.get('est_diff_lines'))) {
    return drop(`est_diff_lines ${values.get('est_diff_lines')} is not a whole number`);
  }
  return {
    label,
    candidate: {
      name: values.get('name'),
      tier: values.get('tier'),
      category: values.get('category'),
      files,
      next_change: values.get('next_change'),
      next_sites: nextSites,
      est_diff_lines: Number(values.get('est_diff_lines')),
      deletion_test: values.get('deletion_test'),
      friction: values.get('friction'),
    },
  };
}

function parseExplorer(text, prefix, base) {
  const known = new Set(base.files.map((file) => file.path));
  const candidates = [];
  const dropped = [];
  let notes = null;
  let blocks = 0;
  for (const { fields, isBlock } of explorerChunks(text)) {
    for (const [key, value] of fields) {
      if (key === 'notes') {
        notes = value;
      }
    }
    if (!isBlock) {
      continue;
    }
    blocks += 1;
    const blockFields = fields.filter(([key]) => key !== 'notes' && key !== 'pin');
    const parsed = parseBlock(blockFields, blocks, prefix, known);
    if (parsed.candidate === undefined) {
      dropped.push(parsed);
      continue;
    }
    if (candidates.some((candidate) => candidate.name === parsed.candidate.name)) {
      dropped.push({ label: parsed.label, reason: 'repeats the name of an earlier block' });
      continue;
    }
    try {
      candidates.push(checkOverview({ ...base, candidates: [parsed.candidate] }, 'candidate').candidates[0]);
    } catch (err) {
      if (!(err instanceof RunError)) {
        throw err;
      }
      dropped.push({ label: parsed.label, reason: err.message.replace(/^candidate: (candidates\[0\]\.)?/, '') });
    }
  }
  return { candidates, dropped, notes, blocks };
}

function fileEntry(file, role) {
  return {
    path: file.path,
    lines: file.lines ?? null,
    churn: file.churn ?? null,
    indentation: file.indentation ?? null,
    kind: role?.kind ?? null,
    role: role?.role ?? null,
    exports: role?.exports ?? null,
    mixes: role?.mixes ?? null,
    imports: file.imports ?? [],
    outside: file.outside ?? [],
  };
}

export function assembleOverview({ measurement, rolesText, rolesReason, explorerText, explorerReason }) {
  const prefix = typeof measurement.prefix === 'string' ? measurement.prefix : '';
  const known = new Set(measurement.files.map((file) => file.path));
  const notices = [];
  const warnings = [];

  let roles = new Map();
  let rolesProblem = rolesReason ?? null;
  if (rolesProblem === null) {
    const parsed = parseRoles(rolesText, prefix, known);
    roles = parsed.roles;
    rolesProblem = parsed.reason;
    warnings.push(...parsed.warnings);
  }
  if (rolesProblem !== null) {
    notices.push(`File roles are unavailable: ${rolesProblem}.`);
  }

  const base = {
    version: 1,
    root: measurement.root,
    scope: measurement.scope,
    generatedAt: new Date().toISOString(),
    files: measurement.files.map((file) => fileEntry(file, roles.get(file.path))),
    candidates: [],
    notices: [],
  };
  checkOverview(base, 'assembled overview');

  let candidates = [];
  let dropped = [];
  if (explorerReason !== undefined && explorerReason !== null) {
    notices.push(`No deepening candidates: ${explorerReason}.`);
  } else {
    const parsed = parseExplorer(explorerText, prefix, base);
    candidates = parsed.candidates;
    dropped = parsed.dropped;
    if (parsed.blocks === 0 && parsed.notes === null) {
      notices.push('No deepening candidates: the explorer output holds no candidate block and no notes: line.');
    }
    if (parsed.blocks === 0 && parsed.notes !== null && parsed.notes !== '' && parsed.notes.toLowerCase() !== 'none') {
      notices.push(`Explorer: ${parsed.notes}`);
    }
    if (parsed.blocks > 0 && candidates.length === 0) {
      notices.push(`${parsed.blocks} explorer candidate${parsed.blocks === 1 ? '' : 's'} dropped as malformed.`);
    }
  }
  warnings.push(...dropped.map(({ label, reason }) => `dropped explorer block ${label}: ${reason}`));

  const document = checkOverview({ ...base, candidates, notices }, 'assembled overview');
  return { document, warnings, dropped: dropped.length };
}

export function serialiseOverview(document, out) {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_OVERVIEW_BYTES) {
    throw new RunError(`overview ${out}: ${megabytes(bytes)} MB is above the ${LIMIT_MB} MB overview limit`, 1);
  }
  return text;
}
