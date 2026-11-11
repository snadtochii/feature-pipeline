// Configuration for the dispatcher (CONTRACT.md §5).
//
// `config.yaml` is read with the plugin's shared reader, which skips what it
// does not interpret, so a block the dispatcher does not read can never fail a
// run. `validateConfig` turns the parsed document into the effective dispatch
// settings, defaulting what is missing and refusing what is wrong.
//
// Private to the implementation: only dispatch.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';

import { parseMiniYaml } from '../../lib/mini-yaml.mjs';
import { ComputeError } from './output.mjs';

export const DISPATCH_DEFAULTS = Object.freeze({
  tag: 'agent-ready',
  max_age_days: 14,
  max_tickets_per_run: 2,
  max_open_prs: 3,
  max_session_minutes: 180,
  max_rate_limit_retries: 10,
});

const NUMERIC_KEYS = ['max_age_days', 'max_tickets_per_run', 'max_open_prs', 'max_session_minutes', 'max_rate_limit_retries'];
const DISPATCH_KEYS = ['tag', ...NUMERIC_KEYS];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const FS_NATIVE_REFUSAL = 'fs-native projects are not dispatched';

/** The config file's path under a project root. */
export function configPath(projectRoot) {
  return path.join(projectRoot, 'claudedocs', 'tickets', 'config.yaml');
}

/**
 * The effective configuration from a parsed document:
 * `{ project, dispatch: {tag, max_age_days, max_tickets_per_run, max_open_prs,
 * max_session_minutes, max_rate_limit_retries}, notes }`.
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
