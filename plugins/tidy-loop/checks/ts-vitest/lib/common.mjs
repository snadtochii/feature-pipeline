// Shared runtime for the ts-vitest checks commands.
//
// What: flag parsing, target-repo toolchain resolution, the per-invocation temp
// directory, the prelude-aware subprocess wrapper, repo-relative path
// normalization, and the sorted-key JSON emitter that every command's output
// rule depends on.
//
// Output contract: a command prints exactly one JSON document on stdout. This
// module owns both ends of that — `emit` for the success document, `fail` for
// the `{"error"}` document on exit 1 (could not compute) and exit 2 (bad
// invocation). See ../../CONTRACT.md §2 and §3.
//
// Portability: no dependency of any kind, plugin-side or otherwise. Everything
// the commands need beyond Node's standard library is resolved from the target
// repository's own `node_modules`. The only shell involved anywhere is the
// prelude wrapper in `run`, which receives the command as an argument vector
// and never as a shell string (CONTRACT.md §4).
//
// This file lives in `lib/` and is therefore private to the implementation:
// only top-level `<command>.mjs` files are commands.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Exit code for "the answer could not be computed". */
export const EXIT_CANNOT_COMPUTE = 1;
/** Exit code for "the invocation was wrong". */
export const EXIT_BAD_USAGE = 2;

/**
 * Write to stdout synchronously, tolerating partial writes and a non-blocking
 * pipe. `process.stdout.write` is asynchronous when stdout is a pipe, so a
 * document followed by `process.exit` can be truncated; this is not.
 *
 * @param {string} text
 */
function writeStdoutSync(text) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(1, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (error.code === 'EAGAIN') {
        continue;
      }
      if (error.code === 'EPIPE') {
        return;
      }
      throw error;
    }
  }
}

/**
 * Print the `{"error"}` document and exit.
 *
 * @param {string} reason single line of human-readable text
 * @param {number} code EXIT_CANNOT_COMPUTE or EXIT_BAD_USAGE
 * @returns {never}
 */
export function fail(reason, code = EXIT_CANNOT_COMPUTE) {
  writeStdoutSync(`${JSON.stringify({ error: String(reason) }, null, 2)}\n`);
  process.exit(code);
}

/**
 * Parse long flags only, in either `--flag value` or `--flag=value` form.
 *
 * @param {string[]} argv raw arguments (already sliced past the script path)
 * @param {Record<string, {required?: boolean, boolean?: boolean}>} spec
 *   flag name (without dashes) to its shape
 * @returns {Record<string, string | boolean>}
 */
export function parseArgs(argv, spec) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      fail(`unexpected argument "${token}" — long flags only`, EXIT_BAD_USAGE);
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (!Object.hasOwn(spec, name)) {
      fail(`unknown flag "--${name}"`, EXIT_BAD_USAGE);
    }
    if (spec[name].boolean) {
      if (eq !== -1) {
        fail(`flag "--${name}" takes no value`, EXIT_BAD_USAGE);
      }
      values[name] = true;
      continue;
    }
    let value;
    if (eq === -1) {
      i += 1;
      if (i >= argv.length) {
        fail(`flag "--${name}" needs a value`, EXIT_BAD_USAGE);
      }
      value = argv[i];
    } else {
      value = token.slice(eq + 1);
    }
    values[name] = value;
  }
  for (const [name, shape] of Object.entries(spec)) {
    if (shape.required && values[name] === undefined) {
      fail(`missing required flag "--${name}"`, EXIT_BAD_USAGE);
    }
  }
  return values;
}

/**
 * Validate `--repo` and resolve it to a real absolute path.
 *
 * @param {string} value
 * @returns {string}
 */
export function resolveRepo(value) {
  if (!path.isAbsolute(value)) {
    fail(`--repo must be an absolute path, got "${value}"`, EXIT_BAD_USAGE);
  }
  let real;
  try {
    real = fs.realpathSync(value);
  } catch {
    fail(`--repo does not exist: ${value}`, EXIT_BAD_USAGE);
  }
  if (!fs.statSync(real).isDirectory()) {
    fail(`--repo is not a directory: ${value}`, EXIT_BAD_USAGE);
  }
  return real;
}

/**
 * Resolve a package from the target repository, never from this plugin.
 *
 * @param {string} repo absolute repo path
 * @param {string} specifier e.g. "typescript" or "vitest/package.json"
 * @returns {string} resolved absolute path
 */
export function resolveFromRepo(repo, specifier) {
  const require = createRequire(path.join(repo, 'package.json'));
  try {
    return require.resolve(specifier);
  } catch {
    return fail(`cannot resolve ${specifier} from ${repo}`, EXIT_CANNOT_COMPUTE);
  }
}

/**
 * Probe for an optional package in the target repository. Unlike
 * `resolveFromRepo`, absence is an answer here, not a failure.
 *
 * @param {string} repo absolute repo path
 * @param {string} specifier
 * @returns {string | null} resolved absolute path, or null
 */
export function tryResolveFromRepo(repo, specifier) {
  const require = createRequire(path.join(repo, 'package.json'));
  try {
    return require.resolve(specifier);
  } catch {
    return null;
  }
}

/**
 * Load a package from the target repository.
 *
 * @param {string} repo absolute repo path
 * @param {string} specifier
 * @returns {unknown}
 */
export function requireFromRepo(repo, specifier) {
  const require = createRequire(path.join(repo, 'package.json'));
  try {
    return require(specifier);
  } catch {
    return fail(`cannot resolve ${specifier} from ${repo}`, EXIT_CANNOT_COMPUTE);
  }
}

/**
 * Resolve the target repository's own vitest executable.
 *
 * @param {string} repo absolute repo path
 * @returns {string} absolute path to the vitest entry script
 */
export function resolveVitestBin(repo) {
  const manifestPath = resolveFromRepo(repo, 'vitest/package.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${manifestPath}: ${error.message}`, EXIT_CANNOT_COMPUTE);
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.vitest;
  if (!bin) {
    return fail(`vitest resolved from ${repo} declares no executable`, EXIT_CANNOT_COMPUTE);
  }
  return path.resolve(path.dirname(manifestPath), bin);
}

let tempDir = null;

/**
 * The invocation's private temp directory, created on first use and removed
 * when the process exits. Commands write nothing anywhere else.
 *
 * @returns {string}
 */
export function makeTempDir() {
  if (tempDir === null) {
    tempDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tidy-checks-'));
    process.on('exit', () => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best effort — the OS reclaims the temp directory either way.
      }
    });
  }
  return tempDir;
}

let preludeScript = null;
let runCount = 0;

/**
 * Run a Node subprocess, optionally behind the caller's declared prelude.
 *
 * The prelude is written verbatim into a script file, under `set -e`, so a
 * prelude line that fails ends the run with that line's status and the command
 * never starts; the EXIT trap names the prelude on stderr for the caller's
 * error tail, since a failing command is free to print nothing. The command
 * rides as an argument vector that `exec "$@"` re-executes. Nothing is ever
 * substituted into a shell string — see CONTRACT.md §4.
 *
 * Behind a prelude the interpreter is `node` as resolved on the PATH the
 * prelude leaves behind — that is what lets a prelude select a toolchain, not
 * only an environment — with this process's own interpreter directory
 * appended last so a prelude that sets no PATH still resolves one. Without a
 * prelude the subprocess is this process's own interpreter.
 *
 * @param {string[]} argv arguments to the Node interpreter
 * @param {{cwd: string, prelude?: string | undefined}} options
 * @returns {{code: number, stdout: string, stderr: string}}
 */
export function run(argv, { cwd, prelude }) {
  let file = process.execPath;
  let args = argv;
  if (prelude) {
    if (preludeScript === null) {
      preludeScript = path.join(makeTempDir(), 'prelude.sh');
      fs.writeFileSync(
        preludeScript,
        [
          'trap \'echo "prelude failed with status $?" >&2\' EXIT',
          'set -e',
          prelude,
          'trap - EXIT',
          'PATH="$PATH:$1"',
          'shift',
          'exec "$@"',
          '',
        ].join('\n'),
        { mode: 0o700 },
      );
    }
    file = 'sh';
    args = [preludeScript, path.dirname(process.execPath), 'node', ...argv];
  }
  // Both callers read their real answer from a file the subprocess writes, and
  // want its output only as an error tail. Buffering it in the parent's heap
  // would therefore cost memory for nothing and — worse — a suite chatty enough
  // to pass a buffer cap would be killed and reported as "could not compute",
  // turning an answerable question into a broken check. Spill to disk instead;
  // the temp directory is removed at exit either way.
  const captureDir = path.join(makeTempDir(), 'capture');
  fs.mkdirSync(captureDir, { recursive: true });
  const stdoutPath = path.join(captureDir, `stdout-${runCount}`);
  const stderrPath = path.join(captureDir, `stderr-${runCount}`);
  runCount += 1;
  const stdoutFd = fs.openSync(stdoutPath, 'w');
  const stderrFd = fs.openSync(stderrPath, 'w');
  let code;
  try {
    const result = spawnSync(file, args, {
      cwd,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    if (result.error) {
      return fail(`could not run ${file}: ${result.error.message}`, EXIT_CANNOT_COMPUTE);
    }
    if (typeof result.status !== 'number') {
      // Killed by a signal — not an exit status the caller can reason about.
      return fail(`${file} was terminated by ${result.signal}`, EXIT_CANNOT_COMPUTE);
    }
    code = result.status;
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  return {
    code,
    get stdout() {
      return readTail(stdoutPath);
    },
    get stderr() {
      return readTail(stderrPath);
    },
  };
}

/**
 * Read the last bytes of a captured stream without loading the whole file.
 *
 * @param {string} filePath
 * @param {number} bytes
 * @returns {string}
 */
function readTail(filePath, bytes = 8192) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/**
 * Bounded tail of subprocess output, for quoting inside an `error` string.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function tail(text, limit = 500) {
  // Slice before normalizing: the input can be a multi-megabyte capture and
  // only the last few hundred characters ever reach the caller.
  const raw = String(text ?? '');
  const window = raw.length > limit * 4 ? raw.slice(-limit * 4) : raw;
  const trimmed = window.trim().replace(/\s+/g, ' ');
  return trimmed.length > limit ? `…${trimmed.slice(-limit)}` : trimmed;
}

/**
 * Express an absolute path relative to the repository, with posix separators.
 * A path outside the repository is a contract violation, not a value.
 *
 * @param {string} repo absolute repo path (already realpath'd)
 * @param {string} absolute
 * @returns {string}
 */
export function toRepoRelative(repo, absolute) {
  const normalized = path.resolve(absolute);
  const relative = path.relative(repo, normalized);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return fail(`path outside --repo: ${normalized}`, EXIT_CANNOT_COMPUTE);
  }
  return relative.split(path.sep).join('/');
}

/**
 * Hex sha256 of a string, after normalizing line endings so a digest does not
 * depend on the platform that emitted it.
 *
 * @param {string} text
 * @returns {string}
 */
export function sha256(text) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * Recursively sort object keys so two runs serialize identically.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeys(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Print the one JSON document this invocation produces, and exit 0.
 *
 * @param {Record<string, unknown>} document
 * @returns {never}
 */
export function emit(document) {
  writeStdoutSync(`${JSON.stringify(sortKeys(document), null, 2)}\n`);
  process.exit(0);
}

/**
 * Run a command body, turning an unexpected throw into the exit-1 document
 * rather than a Node stack trace on stdout.
 *
 * @param {() => void} body
 */
export function main(body) {
  try {
    body();
  } catch (error) {
    fail(`unexpected failure: ${error?.message ?? error}`, EXIT_CANNOT_COMPUTE);
  }
}
