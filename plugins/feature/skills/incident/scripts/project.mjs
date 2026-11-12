// The incident log reader's project layout and the rules every verb shares
// (../references/log-query.md §1, §2, §4): the run identifier and the
// repository name, the `claudedocs/` directories, where `config.yaml` lives and
// where `incident.token_file` points, how a run takes its query or search file
// and how preflight sweeps one left behind, and the output document's bound.
//
// Private to the implementation: only incident.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';

import { ComputeError } from '../../../scripts/lib/output.mjs';

export const INCIDENTS_DIR = ['claudedocs', 'incidents'];
export const TICKETS_DIR = ['claudedocs', 'tickets'];
export const MAX_DOCUMENT_BYTES = 16 * 1024;
export const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
export const REPO_RULE = 'must be one directory name, or "." for the project root';

const REPO_NAME = /^[A-Za-z0-9._-]+$/;
const INPUT_EXTENSIONS = { query: 'logql', search: 'txt' };
const INPUT_FILE_NAME = new RegExp(
  `^\\.(?:${Object.entries(INPUT_EXTENSIONS)
    .map(([kind, extension]) => `${kind}-${RUN_ID.source.slice(1, -1)}\\.${extension}`)
    .join('|')})$`,
);
const STALE_INPUT_MS = 60 * 60 * 1000;

export const isSet = (value) => typeof value === 'string' && value !== '';
export const isRepoName = (value) => REPO_NAME.test(value) && value !== '..';

/** The run's input file of `kind` (`query` or `search`) under `<projectRoot>/claudedocs/incidents/`. */
export function inputFile(projectRoot, kind, run) {
  return path.join(projectRoot, ...INCIDENTS_DIR, `.${kind}-${run}.${INPUT_EXTENSIONS[kind]}`);
}

export function configFile(projectRoot) {
  return path.join(projectRoot, ...TICKETS_DIR, 'config.yaml');
}

/** The file `incident.token_file` names, or undefined when it names none. Throws a ComputeError for a value its rule refuses. */
export function tokenFilePath(value, home) {
  if (!isSet(value)) {
    return undefined;
  }
  let file;
  if (value.startsWith('~/')) {
    if (!isSet(home)) {
      throw new ComputeError('config.yaml: incident.token_file starts with ~/ but HOME is not set');
    }
    file = path.join(home, value.slice(2));
  } else if (path.isAbsolute(value)) {
    file = path.normalize(value);
  } else {
    throw new ComputeError('config.yaml: incident.token_file must be an absolute path or start with ~/');
  }
  const name = path.basename(file);
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) {
    throw new ComputeError('config.yaml: incident.token_file must not be a dotenv-family file (.env, .env.*, *.env)');
  }
  return file;
}

/**
 * Read an input file's trimmed text and remove the file. A symbolic link is
 * refused and left alone; a regular file is removed whether or not its
 * content is usable, so no run leaves its input behind. `remedy` says what to
 * write when the file is missing.
 */
export function takeInputFile(file, maxBytes, remedy) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      throw new ComputeError(`${file} does not exist — ${remedy}`);
    }
    if (err.code === 'ELOOP' || err.code === 'EMLINK') {
      throw new ComputeError(`${file} is a symbolic link, not a regular file`);
    }
    throw new ComputeError(`${file} cannot be read (${err.code ?? 'error'})`);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new ComputeError(`${file} is not a regular file`);
    }
    fs.rmSync(file, { force: true });
    if (stat.size > maxBytes) {
      throw new ComputeError(`${file} is larger than ${maxBytes / 1024} KiB`);
    }
    const text = fs.readFileSync(fd, 'utf8').trim();
    if (text === '') {
      throw new ComputeError(`${file} is empty`);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Remove the query and search files an interrupted run left under
 * `<projectRoot>/claudedocs/incidents/`: regular files with an input file's
 * name, last written more than an hour before `now`.
 */
export function sweepInputFiles(projectRoot, now) {
  const dir = path.join(projectRoot, ...INCIDENTS_DIR);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names.filter((entry) => INPUT_FILE_NAME.test(entry))) {
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && now.getTime() - stat.mtimeMs > STALE_INPUT_MS) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      continue;
    }
  }
}
