// Configuration for the dispatcher (CONTRACT.md §5).
//
// `parseMiniYaml` is a deliberately small reader for `config.yaml`: top-level
// scalars and one level of nested mapping, nothing else. Deeper nesting,
// sequences and flow collections are skipped without being interpreted, so a
// block the dispatcher does not read can never fail a run. `validateConfig`
// turns the parsed document into the effective dispatch settings, defaulting
// what is missing and refusing what is wrong.
//
// Private to the implementation: only dispatch.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';

import { ComputeError } from './output.mjs';

export const DISPATCH_DEFAULTS = Object.freeze({
  tag: 'agent-ready',
  max_age_days: 14,
  max_tickets_per_run: 2,
  max_open_prs: 3,
});

const NUMERIC_KEYS = ['max_age_days', 'max_tickets_per_run', 'max_open_prs'];
const DISPATCH_KEYS = ['tag', ...NUMERIC_KEYS];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_LINE = /^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*))?$/;

export const FS_NATIVE_REFUSAL = 'fs-native projects are not dispatched';

/** The config file's path under a project root. */
export function configPath(projectRoot) {
  return path.join(projectRoot, 'claudedocs', 'tickets', 'config.yaml');
}

/**
 * Parse the subset of YAML the dispatcher reads. Returns an object whose
 * top-level values are strings (scalars) or objects of strings (one nested
 * mapping level). Pure.
 */
export function parseMiniYaml(text) {
  const out = {};
  let block = null;
  let blockIndent = null;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
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

/**
 * The effective configuration from a parsed document:
 * `{ project, dispatch: {tag, max_age_days, max_tickets_per_run, max_open_prs}, notes }`.
 * Throws ComputeError for a non-server-native mode or an invalid value. Pure.
 */
export function validateConfig(doc) {
  if (doc.mode !== 'server-native') {
    throw new ComputeError(FS_NATIVE_REFUSAL);
  }
  const project = doc.project;
  if (typeof project !== 'string' || !UUID.test(project)) {
    throw new ComputeError('config.yaml: project must be the server project UUID');
  }
  const notes = [];
  const dispatch = { ...DISPATCH_DEFAULTS };
  if (!Object.hasOwn(doc, 'dispatch')) {
    notes.push('config.yaml has no dispatch: block — using every default');
    return { project,dispatch, notes };
  }
  const block = doc.dispatch;
  if (block === null || typeof block !== 'object') {
    throw new ComputeError('config.yaml: dispatch must be a mapping');
  }
  for (const key of Object.keys(block).sort()) {
    if (!DISPATCH_KEYS.includes(key)) {
      notes.push(`config.yaml: unknown key dispatch.${key} ignored`);
    }
  }
  for (const key of DISPATCH_KEYS) {
    if (!Object.hasOwn(block, key)) {
      notes.push(`config.yaml: dispatch.${key} not set — using ${DISPATCH_DEFAULTS[key]}`);
      continue;
    }
    const value = block[key];
    if (key === 'tag') {
      if (typeof value !== 'string' || value === '') {
        throw new ComputeError('config.yaml: dispatch.tag must not be empty');
      }
      dispatch.tag = value;
      continue;
    }
    if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new ComputeError(`config.yaml: dispatch.${key} must be a positive integer`);
    }
    dispatch[key] = Number(value);
  }
  return { project,dispatch, notes };
}

/** Read and validate `<projectRoot>/claudedocs/tickets/config.yaml`. */
export function loadDispatchConfig(projectRoot) {
  const file = configPath(projectRoot);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new ComputeError(FS_NATIVE_REFUSAL);
    }
    throw new ComputeError(`cannot read ${file} (${err.code ?? 'error'})`);
  }
  return validateConfig(parseMiniYaml(text));
}
