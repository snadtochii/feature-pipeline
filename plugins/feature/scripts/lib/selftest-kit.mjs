// The helpers the plugin's script self-tests share: assertions, a temporary
// directory, a command run as a child process, a loopback stand-in server and
// a temporary git repository.
//
// Private to the implementation: no file under this directory is a command.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export class CaseFailure extends Error {}

export function assert(condition, detail) {
  if (!condition) {
    throw new CaseFailure(detail);
  }
}

export function equal(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${label}: expected ${e}, got ${a}`);
}

function checkThrown(err, Kind, fragment) {
  assert(err instanceof Kind, `expected a ${Kind.name}, got ${err.constructor.name}: ${err.message}`);
  if (fragment !== undefined) {
    assert(err.message.includes(fragment), `expected the error to mention "${fragment}", got: ${err.message}`);
  }
  return err;
}

/** `fn` must throw a `Kind` whose message holds `fragment`; returns the error. */
export function throwsKind(fn, Kind, fragment) {
  try {
    fn();
  } catch (err) {
    return checkThrown(err, Kind, fragment);
  }
  throw new CaseFailure(`expected a ${Kind.name}, nothing was thrown`);
}

/** `fn` must reject with a `Kind` whose message holds `fragment`; returns the error. */
export async function rejectsKind(fn, Kind, fragment) {
  try {
    await fn();
  } catch (err) {
    return checkThrown(err, Kind, fragment);
  }
  throw new CaseFailure(`expected a ${Kind.name}, nothing was thrown`);
}

/** Run `fn(dir)` in a fresh temporary directory named `<prefix>-…`, removed afterwards. */
export async function withTemp(prefix, fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the script `entry` as a Node child with `args` and exactly `env`, killed
 * after 30 seconds: `{ status, stdout, stderr, doc }`, `doc` the parsed stdout
 * or null when it is not JSON.
 */
export function runNode(entry, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      let doc = null;
      try {
        doc = JSON.parse(stdout);
      } catch {
        doc = null;
      }
      resolve({ status, stdout, stderr, doc });
    });
  });
}

/** A loopback stand-in server; `handler(req, res)` answers, `fn(url)` runs against it. */
export async function withStub(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Run git in `repo` under a fixture identity; a failure fails the case. */
export function git(repo, ...args) {
  const res = spawnSync(
    'git',
    ['-C', repo, '-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8' },
  );
  assert(res.status === 0, `git ${args[0]} failed: ${res.stderr}`);
}

/** Create `dir` as a git repository on `branch`; returns `dir`. */
export function initRepo(dir, branch = 'main') {
  fs.mkdirSync(dir, { recursive: true });
  const res = spawnSync('git', ['-c', `init.defaultBranch=${branch}`, 'init', '-q', dir], { encoding: 'utf8' });
  assert(res.status === 0, `git init failed: ${res.stderr}`);
  return dir;
}

/** Commit everything in `repo`. */
export function commitAll(repo) {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'fixture');
}
