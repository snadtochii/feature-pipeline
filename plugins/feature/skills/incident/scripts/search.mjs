// The incident log reader's `search` verb (../references/log-query.md §6):
// fixed strings from the run's search file, matched case-insensitively
// against the relative paths and the lines of the files under one of three
// roots inside the project. The walk never follows a symbolic link, never
// opens a secret-named file and never reads the file `incident.token_file`
// names: the session's file rules do not reach this process, so its
// exclusions are here.
//
// Private to the implementation: only incident.mjs is a command.

import fs from 'node:fs';
import path from 'node:path';

import { parseMiniYaml } from '../../../scripts/lib/mini-yaml.mjs';
import { ComputeError, largestFit, oneLine, render } from '../../../scripts/lib/output.mjs';
import { INCIDENTS_DIR, MAX_DOCUMENT_BYTES, TICKETS_DIR, configFile, searchFile, takeInputFile, tokenFilePath } from './lib.mjs';

const MAX_SEARCH_BYTES = 4 * 1024;
const MAX_PATTERNS = 20;
const MIN_PATTERN_CHARS = 3;
const MAX_PATTERN_CHARS = 200;
const MAX_DEPTH = 32;
const MAX_FILES = 20_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;
const MATCHES_PER_PATTERN = 3;
const WINDOW_LEAD_CHARS = 100;
const WINDOW_CHARS = 400;

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.next', '.turbo', '.ssh', '.aws', '.docker', '.kube']);
const SECRET_FILE = /^(?:\.env.*|.*\.pem|.*\.key|id_.*|secrets.*|.*credentials.*|\.netrc|\.npmrc|\.pypirc)$/i;
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

const SCOPES = {
  repo: {
    root: ({ projectRoot, repo }) => (repo === '.' ? projectRoot : path.join(projectRoot, repo)),
    recursive: true,
    reads: () => true,
  },
  incidents: {
    root: ({ projectRoot }) => path.join(projectRoot, ...INCIDENTS_DIR),
    recursive: false,
    reads: (name) => name.endsWith('.md'),
  },
  tickets: {
    root: ({ projectRoot }) => path.join(projectRoot, ...TICKETS_DIR),
    recursive: true,
    reads: (name) => name === '01-spec.md' || name === 'prd.md',
  },
};

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Read the run's patterns from its search file and remove the file: one fixed
 * string per line, trimmed, blank and repeated lines dropped, 1 to 20 of
 * them, each 3 to 200 characters. A refusal never echoes a pattern.
 */
export function takePatterns(projectRoot, run) {
  const file = searchFile(projectRoot, run);
  const text = takeInputFile(file, MAX_SEARCH_BYTES, 'write the search patterns there, one per line, before each search run');
  const patterns = [...new Set(text.split('\n').map((line) => line.trim()).filter((line) => line !== ''))];
  if (patterns.length > MAX_PATTERNS) {
    throw new ComputeError(`${file} holds more than ${MAX_PATTERNS} patterns`);
  }
  const misfit = patterns.findIndex((pattern) => pattern.length < MIN_PATTERN_CHARS || pattern.length > MAX_PATTERN_CHARS);
  if (misfit !== -1) {
    throw new ComputeError(`${file}: pattern ${misfit + 1} must be ${MIN_PATTERN_CHARS} to ${MAX_PATTERN_CHARS} characters`);
  }
  return patterns;
}

/** The device and inode of the file `incident.token_file` names, or undefined when config names none that exists. */
function credentialOf(projectRoot, home) {
  try {
    const block = parseMiniYaml(fs.readFileSync(configFile(projectRoot), 'utf8')).incident;
    const named = tokenFilePath(block?.token_file, home);
    if (named === undefined) {
      return undefined;
    }
    const { dev, ino } = fs.statSync(named);
    return { dev, ino };
  } catch {
    return undefined;
  }
}

/** Whether a directory named `name` under the relative directory `parent` is one the walk never enters. */
function neverEntered(name, parent) {
  return SKIP_DIRS.has(name) || (name === 'gh' && path.posix.basename(parent) === '.config');
}

/**
 * The scope's root as a real path inside the project root, and its path
 * relative to the project root, or null when it does not exist. A root at or
 * under a directory the walk never enters is refused.
 */
function resolveRoot(scope, { projectRoot, repo }) {
  const root = SCOPES[scope].root({ projectRoot, repo });
  let real;
  try {
    real = fs.realpathSync(root);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      return null;
    }
    throw new ComputeError(`${root} cannot be resolved (${err.code ?? 'error'})`);
  }
  const project = fs.realpathSync(projectRoot);
  if (real !== project && !real.startsWith(`${project}${path.sep}`)) {
    throw new ComputeError(`${root} resolves outside the project root`);
  }
  const parts = path.relative(project, real).split(path.sep).filter((part) => part !== '');
  if (parts.some((part, index) => neverEntered(part, parts.slice(0, index).join('/')))) {
    throw new ComputeError(`${root} is inside a directory a search never reads`);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new ComputeError(`${root} is not a directory`);
  }
  return { real, rel: parts.join('/') };
}

function skipsDirectory(name, parent, walk) {
  const above = parent === '' ? walk.rootRel : `${walk.rootRel}/${parent}`;
  return neverEntered(name, above) || (parent === '' && name === walk.skipTop);
}

function excerpt(line, at) {
  const start = Math.max(0, at - WINDOW_LEAD_CHARS);
  const end = start + WINDOW_CHARS;
  const text = oneLine(line.slice(start, end));
  return start > 0 || end < line.length ? { text, cut: true } : { text };
}

function matchPath(rel, walk) {
  walk.matchers.forEach((matcher, pattern) => {
    if (matcher.test(rel)) {
      walk.found.push({ path: rel, pattern, line: 0 });
    }
  });
}

function matchLines(rel, text, walk) {
  const lines = text.split(/\r?\n/);
  walk.matchers.forEach((matcher, pattern) => {
    if (!matcher.test(text)) {
      return;
    }
    let kept = 0;
    lines.forEach((line, index) => {
      const hit = matcher.exec(line);
      if (hit === null) {
        return;
      }
      if (kept === MATCHES_PER_PATTERN) {
        walk.overflow += 1;
        return;
      }
      kept += 1;
      walk.found.push({ path: rel, pattern, line: index + 1, ...excerpt(line, hit.index) });
    });
  });
}

function scanFile(file, rel, walk) {
  if (walk.files + walk.skipped >= MAX_FILES) {
    walk.partial = 'files';
    return;
  }
  let fd;
  try {
    fd = fs.openSync(file, OPEN_FLAGS);
  } catch {
    walk.skipped += 1;
    return;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      walk.skipped += 1;
      return;
    }
    if (walk.credential !== undefined && stat.dev === walk.credential.dev && stat.ino === walk.credential.ino) {
      return;
    }
    matchPath(rel, walk);
    if (stat.size > MAX_FILE_BYTES) {
      walk.skipped += 1;
      return;
    }
    const probe = Buffer.alloc(BINARY_PROBE_BYTES);
    if (probe.subarray(0, fs.readSync(fd, probe, 0, BINARY_PROBE_BYTES, 0)).includes(0)) {
      walk.skipped += 1;
      return;
    }
    if (walk.bytes + stat.size > MAX_TOTAL_BYTES) {
      walk.partial = 'bytes';
      return;
    }
    const content = fs.readFileSync(fd);
    walk.bytes += content.length;
    if (content.length > MAX_FILE_BYTES || content.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
      walk.skipped += 1;
      return;
    }
    walk.files += 1;
    matchLines(rel, content.toString('utf8'), walk);
  } catch {
    walk.skipped += 1;
  } finally {
    fs.closeSync(fd);
  }
}

function visit(dir, rel, depth, walk) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    walk.skipped += 1;
    return;
  }
  items.sort((a, b) => byCodeUnit(a.name, b.name));
  for (const item of items) {
    if (walk.partial !== null) {
      return;
    }
    const itemRel = rel === '' ? item.name : `${rel}/${item.name}`;
    if (item.isDirectory()) {
      if (walk.spec.recursive && depth < MAX_DEPTH && !skipsDirectory(item.name, rel, walk)) {
        visit(path.join(dir, item.name), itemRel, depth + 1, walk);
      }
    } else if (item.isFile() && walk.spec.reads(item.name) && !SECRET_FILE.test(item.name)) {
      scanFile(path.join(dir, item.name), itemRel, walk);
    }
  }
}

function filesOf(found) {
  const byPath = new Map();
  for (const { path: rel, pattern } of found) {
    byPath.set(rel, (byPath.get(rel) ?? new Set()).add(pattern));
  }
  return [...byPath].map(([rel, patterns]) => ({ path: rel, patterns: [...patterns].sort((a, b) => a - b) }));
}

/** The `search` verb: the run's patterns over one scope, as matched lines or matched files. */
export function search({ projectRoot, run, scope, repo, output }, env = process.env) {
  const patterns = takePatterns(projectRoot, run);
  const resolved = resolveRoot(scope, { projectRoot, repo });
  const root = resolved?.real ?? null;
  const walk = {
    spec: SCOPES[scope],
    rootRel: resolved?.rel ?? '',
    matchers: patterns.map((pattern) => new RegExp(escapeRegExp(pattern), 'iu')),
    credential: credentialOf(projectRoot, env.HOME),
    skipTop: scope === 'repo' && repo === '.' ? 'claudedocs' : undefined,
    files: 0,
    skipped: 0,
    bytes: 0,
    overflow: 0,
    partial: null,
    found: [],
  };
  if (root !== null) {
    visit(root, '', 0, walk);
  }
  walk.found.sort((a, b) => byCodeUnit(a.path, b.path) || a.line - b.line || a.pattern - b.pattern);
  const listed = output === 'files' ? filesOf(walk.found) : walk.found;
  const overflow = output === 'files' ? 0 : walk.overflow;
  const documentKeeping = (keep) => ({
    ok: true,
    verb: 'search',
    scope,
    root: root ?? SCOPES[scope].root({ projectRoot, repo }),
    exists: root !== null,
    output,
    patterns,
    [output === 'files' ? 'files' : 'matches']: listed.slice(0, keep),
    count: keep,
    omitted: listed.length - keep + overflow,
    truncated: listed.length > keep || overflow > 0 || walk.partial !== null,
    scanned: { files: walk.files, skipped: walk.skipped },
    partial: walk.partial,
  });
  const fits = (keep) => Buffer.byteLength(render(documentKeeping(keep))) <= MAX_DOCUMENT_BYTES;
  return documentKeeping(largestFit(listed.length, fits, 0));
}
