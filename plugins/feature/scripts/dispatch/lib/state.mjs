// Persistent state for the dispatcher (CONTRACT.md §12).
//
// `$HOME/.feature-pipeline/dispatch/<project-name>/` holds `runs.json` and
// `reports/`. The project name passes a character-class and containment check
// before any path is built from it; every file is written to a temporary file
// beside it and renamed into place. Nothing here writes into a working tree.
//
// Private to the implementation: only dispatch.mjs is a command.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ComputeError, render } from './output.mjs';

const NAME_RE = /^[A-Za-z0-9._-]+$/;
export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{6}$/;

/** A fresh run id: the UTC date and 3 random bytes. */
export function newRunId(now) {
  return `${now.toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Write `text` to `file` through a temporary file beside it, with `mode`. */
export function writeAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, text, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** The project name: the name of the directory holding the git common dir. */
export function projectNameFor(commonDir) {
  const name = path.basename(path.dirname(commonDir));
  if (!NAME_RE.test(name) || name === '.' || name === '..') {
    throw new ComputeError(`project directory name is not usable for the state directory: ${JSON.stringify(name.slice(0, 60))}`);
  }
  return name;
}

/** `$HOME/.feature-pipeline/dispatch/<name>`, contained under the dispatch root. */
export function stateDirFor(home, name) {
  if (typeof home !== 'string' || home === '') {
    throw new ComputeError('HOME is not set');
  }
  const root = path.join(home, '.feature-pipeline', 'dispatch');
  const dir = path.join(root, name);
  if (path.dirname(dir) !== root) {
    throw new ComputeError(`project name escapes the state root: ${JSON.stringify(name.slice(0, 60))}`);
  }
  return dir;
}

/** Create the state directory and its `reports/` (mode 0700) when absent. */
export function ensureStateDir(dir) {
  const reports = path.join(dir, 'reports');
  try {
    fs.mkdirSync(reports, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(reports, 0o700);
  } catch (err) {
    throw new ComputeError(`cannot create the state directory ${dir} (${err.code ?? 'error'})`);
  }
}

/**
 * Whether `dir` could be written: `W_OK` on it, or on its nearest existing
 * ancestor when it does not exist yet. Creates nothing. `{ ok, detail }`.
 */
export function stateDirWritable(dir) {
  let probe = dir;
  for (;;) {
    let stat;
    try {
      stat = fs.statSync(probe);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return { ok: false, detail: `no existing ancestor of ${dir}` };
      }
      probe = parent;
      continue;
    }
    if (!stat.isDirectory()) {
      return { ok: false, detail: `${probe} is not a directory` };
    }
    try {
      fs.accessSync(probe, fs.constants.W_OK);
      return { ok: true, detail: probe === dir ? dir : `${dir} (would be created under ${probe})` };
    } catch {
      return { ok: false, detail: `${probe} is not writable` };
    }
  }
}

/** The run records in `<dir>/runs.json`; a missing file reads as []. */
export function readRuns(dir) {
  const file = path.join(dir, 'runs.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw new ComputeError(`cannot read ${file} (${err.code ?? 'error'})`);
  }
  let runs;
  try {
    runs = JSON.parse(text);
  } catch {
    runs = null;
  }
  if (!Array.isArray(runs)) {
    throw new ComputeError(`${file} is not a JSON array — fix or move it; it is never overwritten`);
  }
  return runs;
}

/** Append one record to `<dir>/runs.json` (atomic, mode 0600). */
export function appendRun(dir, record) {
  const runs = readRuns(dir);
  runs.push(record);
  writeAtomic(path.join(dir, 'runs.json'), render(runs));
}

/** Write `reports/<runId>.md` (atomic, mode 0600) and return its path. */
export function writeReport(dir, runId, markdown) {
  if (!RUN_ID_RE.test(runId)) {
    throw new ComputeError(`not a run id: ${JSON.stringify(String(runId).slice(0, 40))}`);
  }
  const file = path.join(dir, 'reports', `${runId}.md`);
  writeAtomic(file, markdown);
  return file;
}
