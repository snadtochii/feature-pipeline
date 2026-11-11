// The helpers the plugin's script self-tests share: assertions, a loopback
// stand-in server and a temporary git repository.
//
// Private to the implementation: no file under this directory is a command.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

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
