// File listing and reading for the margin viewer. Git-aware when the root is a
// repository: tracked plus untracked-but-not-ignored files, so generated trees
// stay out of the viewer without any configuration. Falls back to a walk that
// skips the usual generated directories.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', 'target']);
const MAX_BYTES = 2 * 1024 * 1024;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
}

export function listFiles(root, scope) {
  const targets = scope.length > 0 ? scope : ['.'];
  let paths;
  try {
    paths = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...targets]).split('\0');
  } catch {
    paths = walk(root, targets);
  }
  return [...new Set(paths)].filter((p) => p !== '' && isRegularFile(join(root, p))).sort();
}

// A symlink is never listed or read: a link pointing outside the root would otherwise
// serve files the scope never named.
function isRegularFile(abs) {
  try {
    return lstatSync(abs).isFile();
  } catch {
    return false;
  }
}

function walk(root, targets) {
  const found = [];
  const visit = (abs) => {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      return;
    }
    if (stat.isFile()) {
      found.push(relative(root, abs).split(sep).join('/'));
      return;
    }
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
        continue;
      }
      visit(join(abs, entry.name));
    }
  };
  for (const target of targets) {
    const abs = resolve(root, target);
    if (existsSync(abs)) {
      visit(abs);
    }
  }
  return found;
}

export function readSource(root, path) {
  const abs = join(root, path);
  const real = realpathSync(abs);
  if (!isRegularFile(abs) || !real.startsWith(`${realpathSync(root)}${sep}`)) {
    return { path, binary: true, reason: 'not a regular file inside the root' };
  }
  const size = statSync(real).size;
  if (size > MAX_BYTES) {
    return { path, binary: true, reason: `${(size / 1024 / 1024).toFixed(1)} MB is above the ${MAX_BYTES / 1024 / 1024} MB viewer limit` };
  }
  const buffer = readFileSync(real);
  if (buffer.subarray(0, 8000).includes(0)) {
    return { path, binary: true, reason: 'binary file' };
  }
  return { path, text: buffer.toString('utf8') };
}

export function revision(root) {
  try {
    const head = git(root, ['rev-parse', 'HEAD']).trim();
    const dirty = git(root, ['status', '--porcelain']).trim() !== '';
    return { head, dirty };
  } catch {
    return null;
  }
}
