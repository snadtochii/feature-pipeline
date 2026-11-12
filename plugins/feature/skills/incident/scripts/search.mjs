// The incident log reader's `search` verb and its argument rules
// (../references/log-query.md §1, §6):
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
import { ComputeError, UsageError, largestFit, oneLine, render } from '../../../scripts/lib/output.mjs';
import { INCIDENTS_DIR, MAX_DOCUMENT_BYTES, REPO_RULE, RUN_ID, TICKETS_DIR, configFile, inputFile, isRepoName, takeInputFile, tokenFilePath } from './project.mjs';

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

const OUTPUTS = ['lines', 'files'];

/** The `search` verb's flags, each mapped to the field it sets. */
export const SEARCH_FLAGS = { '--project-root': 'projectRoot', '--run': 'run', '--scope': 'scope', '--repo': 'repo', '--output': 'output' };

/**
 * Each scope's root, whether the walk descends, which file names it reads,
 * and which project-relative directories it leaves out beyond those no
 * search enters: the repo scope never reaches into `claudedocs/`.
 */
const SCOPES = {
  repo: {
    root: ({ projectRoot, repo }) => (repo === '.' ? projectRoot : path.join(projectRoot, repo)),
    recursive: true,
    reads: () => true,
    leavesOut: (parts) => parts[0] === 'claudedocs',
  },
  incidents: {
    root: ({ projectRoot }) => path.join(projectRoot, ...INCIDENTS_DIR),
    recursive: false,
    reads: (name) => name.endsWith('.md'),
    leavesOut: () => false,
  },
  tickets: {
    root: ({ projectRoot }) => path.join(projectRoot, ...TICKETS_DIR),
    recursive: true,
    reads: (name) => name === '01-spec.md' || name === 'prd.md',
    leavesOut: () => false,
  },
};

const SCOPE_NAMES = Object.keys(SCOPES);

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Check the parsed `search` flags and default `--output`. Throws a UsageError naming the flag at fault. */
export function finishSearch(parsed) {
  if (parsed.run === undefined) {
    throw new UsageError('search: --run is required');
  }
  if (!RUN_ID.test(parsed.run)) {
    throw new UsageError('search: --run must be the run value preflight printed');
  }
  if (!SCOPE_NAMES.includes(parsed.scope)) {
    throw new UsageError(`search: --scope must be ${SCOPE_NAMES.slice(0, -1).join(', ')} or ${SCOPE_NAMES.at(-1)}`);
  }
  if (parsed.scope === 'repo' && parsed.repo === undefined) {
    throw new UsageError('search: --scope repo needs --repo');
  }
  if (parsed.scope !== 'repo' && parsed.repo !== undefined) {
    throw new UsageError('search: --repo applies to --scope repo only');
  }
  if (parsed.repo !== undefined && !isRepoName(parsed.repo)) {
    throw new UsageError(`search: --repo ${REPO_RULE}`);
  }
  const output = parsed.output ?? 'lines';
  if (!OUTPUTS.includes(output)) {
    throw new UsageError('search: --output must be lines or files');
  }
  return { ...parsed, output };
}

/**
 * Read the run's patterns from its search file and remove the file: one fixed
 * string per line, trimmed, blank and repeated lines dropped, 1 to 20 of
 * them, each 3 to 200 characters. A refusal never echoes a pattern.
 */
export function takePatterns(projectRoot, run) {
  const file = inputFile(projectRoot, 'search', run);
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

/**
 * Whether a search of `spec`'s scope never enters the directory at the
 * project-relative path `projectRel`: one under a skipped directory, `gh`
 * inside `.config`, or one the scope leaves out.
 */
function leftOut(spec, projectRel) {
  const parts = projectRel === '' ? [] : projectRel.split('/');
  return parts.some((part, index) => SKIP_DIRS.has(part) || (part === 'gh' && parts[index - 1] === '.config')) || spec.leavesOut(parts);
}

/**
 * The scope's root as a real path inside the project root, and its path
 * relative to the project root, or null when it does not exist. A root at or
 * under a directory the scope never enters is refused.
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
  const rel = path.relative(project, real).split(path.sep).join('/');
  if (leftOut(SCOPES[scope], rel)) {
    throw new ComputeError(`${root} is inside a directory a ${scope} search never reads`);
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new ComputeError(`${root} is not a directory`);
  }
  return { real, rel };
}

/** Read from `from` on until `buffer` is full or the file ends; the bytes it then holds. */
function fill(fd, buffer, from) {
  let length = from;
  while (length < buffer.length) {
    const read = fs.readSync(fd, buffer, length, buffer.length - length, length);
    if (read === 0) {
      break;
    }
    length += read;
  }
  return length;
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
    const probed = fs.readSync(fd, walk.buffer, 0, BINARY_PROBE_BYTES, 0);
    if (walk.buffer.subarray(0, probed).includes(0)) {
      walk.skipped += 1;
      return;
    }
    if (walk.bytes + stat.size > MAX_TOTAL_BYTES) {
      walk.partial = 'bytes';
      return;
    }
    const length = fill(fd, walk.buffer, probed);
    walk.bytes += length;
    if (length > MAX_FILE_BYTES) {
      walk.skipped += 1;
      return;
    }
    walk.files += 1;
    matchLines(rel, walk.buffer.toString('utf8', 0, length), walk);
  } catch {
    walk.skipped += 1;
  } finally {
    fs.closeSync(fd);
  }
}

/** Visit the directory at the project-relative path `projectRel`; a match is reported relative to the scope's root. */
function visit(dir, projectRel, depth, walk) {
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
    const itemRel = projectRel === '' ? item.name : `${projectRel}/${item.name}`;
    if (item.isDirectory()) {
      if (walk.spec.recursive && depth < MAX_DEPTH && !leftOut(walk.spec, itemRel)) {
        visit(path.join(dir, item.name), itemRel, depth + 1, walk);
      }
    } else if (item.isFile() && walk.spec.reads(item.name) && !SECRET_FILE.test(item.name)) {
      scanFile(path.join(dir, item.name), itemRel.slice(walk.prefix.length), walk);
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

/**
 * `listed` in the order the size bound keeps it: each pattern's first entry,
 * then each pattern's second, and so on, ties in `listed`'s order. Every
 * pattern with a match keeps one listed entry before any pattern gets a
 * second. Each entry carries its index in `listed`, which restores that order.
 */
function boundOrder(listed, patternsOf) {
  const seen = new Map();
  const ranked = listed.map((entry, index) => {
    let rank = Infinity;
    for (const pattern of patternsOf(entry)) {
      const count = seen.get(pattern) ?? 0;
      seen.set(pattern, count + 1);
      rank = Math.min(rank, count);
    }
    return { entry, index, rank };
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
}

/** The `search` verb: the run's patterns over one scope, as matched lines or matched files. */
export function search({ projectRoot, run, scope, repo, output }, env = process.env) {
  const patterns = takePatterns(projectRoot, run);
  const resolved = resolveRoot(scope, { projectRoot, repo });
  const root = resolved?.real ?? null;
  const walk = {
    spec: SCOPES[scope],
    prefix: resolved === null || resolved.rel === '' ? '' : `${resolved.rel}/`,
    matchers: patterns.map((pattern) => new RegExp(escapeRegExp(pattern), 'iu')),
    credential: credentialOf(projectRoot, env.HOME),
    buffer: Buffer.allocUnsafe(MAX_FILE_BYTES + 1),
    files: 0,
    skipped: 0,
    bytes: 0,
    overflow: 0,
    partial: null,
    found: [],
  };
  if (root !== null) {
    visit(root, resolved.rel, 0, walk);
  }
  walk.found.sort((a, b) => byCodeUnit(a.path, b.path) || a.line - b.line || a.pattern - b.pattern);
  const listed = output === 'files' ? filesOf(walk.found) : walk.found;
  const overflow = output === 'files' ? 0 : walk.overflow;
  const patternsOf = output === 'files' ? (entry) => entry.patterns : (entry) => [entry.pattern];
  const ordered = boundOrder(listed, patternsOf);
  const matched = new Set(listed.flatMap(patternsOf));
  const documentKeeping = (keep) => {
    const entries = ordered
      .slice(0, keep)
      .sort((a, b) => a.index - b.index)
      .map(({ entry }) => entry);
    const shown = new Set(entries.flatMap(patternsOf));
    return {
      ok: true,
      verb: 'search',
      scope,
      root: root ?? SCOPES[scope].root({ projectRoot, repo }),
      exists: root !== null,
      output,
      patterns,
      [output === 'files' ? 'files' : 'matches']: entries,
      count: keep,
      omitted: listed.length - keep + overflow,
      unlisted: [...matched].filter((pattern) => !shown.has(pattern)).sort((a, b) => a - b),
      truncated: listed.length > keep || overflow > 0 || walk.partial !== null,
      scanned: { files: walk.files, skipped: walk.skipped },
      partial: walk.partial,
    };
  };
  const fits = (keep) => Buffer.byteLength(render(documentKeeping(keep))) <= MAX_DOCUMENT_BYTES;
  return documentKeeping(largestFit(listed.length, fits, 0));
}
