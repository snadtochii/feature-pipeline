// The dispatcher's self-test (CONTRACT.md §13).
//
// Every case is `[name, fn]`. Pure rules are exercised in-process over inline
// fixtures and an injected clock; the verbs are exercised end to end as child
// processes against a loopback stand-in server, a stand-in `gh` and `claude` on
// a temporary PATH, a temporary git repository and a redirected HOME. Nothing
// reaches beyond the loopback interface, and every temporary directory and
// server is removed in a `finally`.
//
// Private to the implementation: only dispatch.mjs is a command.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgv } from './args.mjs';
import { DISPATCH_DEFAULTS, FS_NATIVE_REFUSAL, loadDispatchConfig, parseMiniYaml, validateConfig } from './config.mjs';
import { LOCK_NAME, STALE_MS, UNREADABLE_GRACE_MS, acquireLock, gitCommonDir, holdsLock, readOwner, releaseLock } from './lock.mjs';
import { ComputeError, UsageError, exitCodeFor, render } from './output.mjs';
import { onPath } from './preconditions.mjs';
import { countOpenPrs, prSlots } from './prs.mjs';
import { renderReport } from './report.mjs';
import { admit, compareIds, selectCandidates } from './select.mjs';
import { listTickets, parseCredentialFile, resolveServerAccess } from './server.mjs';
import { RUN_ID_RE, newRunId, projectNameFor, stateDirFor } from './state.mjs';
import { shipArgv, syncArgv } from './dispatch.mjs';
import { sessionCases } from './selftest-sessions.mjs';
import { addTeardown, runTeardown } from './teardown.mjs';

const ENTRY = fileURLToPath(new URL('../dispatch.mjs', import.meta.url));
const PROJECT_ID = '5b0c8a52-3f0e-4c41-9a43-2f1d7f3c9e10';
const TOKEN = 'selftest-token-7f3c9e10';
const TAG = 'agent-ready';
const NOW = new Date('2026-10-14T02:00:00.000Z');

class CaseFailure extends Error {}

function assert(condition, detail) {
  if (!condition) {
    throw new CaseFailure(detail);
  }
}

function equal(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${label}: expected ${e}, got ${a}`);
}

function throwsKind(fn, Kind, fragment) {
  try {
    fn();
  } catch (err) {
    assert(err instanceof Kind, `expected a ${Kind.name}, got ${err.constructor.name}: ${err.message}`);
    if (fragment !== undefined) {
      assert(err.message.includes(fragment), `expected the error to mention "${fragment}", got: ${err.message}`);
    }
    return err;
  }
  throw new CaseFailure(`expected a ${Kind.name}, nothing was thrown`);
}

async function rejectsKind(fn, Kind, fragment) {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof Kind, `expected a ${Kind.name}, got ${err.constructor.name}: ${err.message}`);
    if (fragment !== undefined) {
      assert(err.message.includes(fragment), `expected the error to mention "${fragment}", got: ${err.message}`);
    }
    return err;
  }
  throw new CaseFailure(`expected a ${Kind.name}, nothing was thrown`);
}

function tempDir(label) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `fp-dispatch-${label}-`)));
}

function initRepo(parent, name = 'my-app') {
  const repo = path.join(parent, name);
  fs.mkdirSync(repo, { recursive: true });
  const res = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', repo], { encoding: 'utf8' });
  assert(res.status === 0, `git init failed: ${res.stderr}`);
  return repo;
}

function writeConfig(repo, text) {
  const dir = path.join(repo, 'claudedocs', 'tickets');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yaml'), text);
}

/**
 * Commit everything in `repo` and point `origin/HEAD` at the checked-out
 * branch, so the tree is clean and on its base branch.
 */
function commitAll(repo) {
  const git = (...args) => {
    const res = spawnSync('git', ['-C', repo, '-c', 'user.name=selftest', '-c', 'user.email=selftest@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert(res.status === 0, `git ${args[0]} failed: ${res.stderr}`);
  };
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

/** The stand-in `gh`: `auth status`, `pr view` and `pr list`, each from its own variable. */
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "auth status") exit "\${FAKE_GH_AUTH_STATUS:-\${FAKE_GH_STATUS:-0}}" ;;
  "pr view") cat "\${FAKE_GH_VIEW_OUT:-/dev/null}"; exit "\${FAKE_GH_STATUS:-0}" ;;
esac
cat "$FAKE_GH_OUT"
exit "\${FAKE_GH_STATUS:-0}"
`;

/**
 * The stand-in `claude`: logs its working directory and arguments, then
 * prints a scripted `sync` document or `ship` stream. Hang mode waits
 * until interrupted, its trap set before it prints, so a cap that fires
 * mid-print still ends it; stubborn mode ignores SIGINT and SIGTERM; orphan
 * mode closes its stdout, starts a grandchild that outlives it, and waits
 * until interrupted.
 */
const FAKE_CLAUDE = `#!/bin/sh
if [ -n "$FAKE_CLAUDE_ARGS" ]; then
  { pwd; for arg in "$@"; do printf '%s\\n' "$arg"; done; echo '--'; } >> "$FAKE_CLAUDE_ARGS"
fi
if [ "$2" = "/feature:sync" ]; then
  if [ -n "$FAKE_CLAUDE_SYNC_OUT" ]; then cat "$FAKE_CLAUDE_SYNC_OUT"; fi
  exit "\${FAKE_CLAUDE_SYNC_STATUS:-0}"
fi
if [ "$FAKE_CLAUDE_HANG" = "1" ] || [ "$FAKE_CLAUDE_HANG" = "orphan" ]; then trap 'exit 130' INT; fi
if [ -n "$FAKE_CLAUDE_PID" ]; then echo "$$" > "$FAKE_CLAUDE_PID"; fi
if [ -n "$FAKE_CLAUDE_SHIP_OUT" ]; then cat "$FAKE_CLAUDE_SHIP_OUT"; fi
if [ "$FAKE_CLAUDE_HANG" = "1" ]; then sleep 30 & wait; fi
if [ "$FAKE_CLAUDE_HANG" = "orphan" ]; then
  exec >/dev/null
  sleep 30 &
  echo "$!" > "$FAKE_CLAUDE_PID.child"
  sleep 30 & wait
fi
if [ "$FAKE_CLAUDE_HANG" = "stubborn" ]; then trap '' INT TERM; sleep 30; fi
exit "\${FAKE_CLAUDE_SHIP_STATUS:-0}"
`;

/** A temporary bin directory holding stand-in `gh` and `claude` scripts. */
function fakeBin(dir) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const [name, script] of [['gh', FAKE_GH], ['claude', FAKE_CLAUDE]]) {
    fs.writeFileSync(path.join(bin, name), script);
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  return bin;
}

/** Stream-json lines as the stand-in prints them. */
const jsonl = (...events) => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
const initEvent = (sessionId) => ({ type: 'system', subtype: 'init', session_id: sessionId, tools: ['Bash'] });
const resultEvent = (sessionId, fields = {}) => ({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, total_cost_usd: 1.25, permission_denials: [], ...fields });
const rateLimitEvent = (sessionId) => ({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit', session_id: sessionId });

function childEnv({ bin, home, url, token, extra = {} }) {
  const git = onPath('git', process.env);
  const dirs = [bin, git === null ? null : path.dirname(git), '/usr/bin', '/bin'].filter(Boolean);
  const env = { PATH: dirs.join(path.delimiter), HOME: home, ...extra };
  if (url !== undefined) {
    env.PERSONAL_SERVER_URL = url;
  }
  if (token !== undefined) {
    env.PERSONAL_SERVER_CLIENT_TOKEN = token;
  }
  return env;
}

/** Run the entry as a child, asynchronously so an in-process stub server can answer it. */
function runEntry(args, { env = {}, onSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    if (onSpawn) {
      onSpawn(child);
    }
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      let doc = null;
      try {
        doc = JSON.parse(stdout);
      } catch {
        doc = null;
      }
      resolve({ status, signal, stdout, doc });
    });
  });
}

/** A loopback stand-in for the server; `handler(req, res)` answers. */
async function withStub(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function row(id, fields = {}) {
  return {
    id,
    status: 'backlog',
    kind: 'solo',
    parent_id: null,
    tags: [TAG],
    blocked_by: [],
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-10T00:00:00.000Z',
    ...fields,
  };
}

/** The fixture ticket list for selection, and its expected outcome. */
const FIXTURE_ROWS = [
  row('ABC-10', { created_at: '2026-10-02T00:00:00.000Z' }),
  row('ABC-2', { created_at: '2026-10-02T00:00:00.000Z' }),
  row('ABC-3', { blocked_by: ['ABC-99'] }),
  row('ABC-4', { updated_at: '2026-08-01T00:00:00.000Z' }),
  row('ABC-5', { status: 'in-progress' }),
  row('ABC-6', { status: 'done' }),
  row('ABC-7', { updated_at: 'not a date' }),
  row('ABC-8', { blocked_by: ['ABC-6', 'ABC-5'] }),
  row('ABC-20', { kind: 'epic', status: 'in-review', created_at: '2026-10-03T00:00:00.000Z' }),
  row('ABC-21', { kind: 'child', parent_id: 'ABC-20', tags: [], created_at: '2026-10-03T00:00:00.000Z' }),
  row('ABC-22', { kind: 'child', parent_id: 'ABC-20', blocked_by: ['ABC-21'], created_at: '2026-10-03T00:00:00.000Z' }),
  row('ABC-23', { kind: 'child', parent_id: 'ABC-20', status: 'in-review', tags: [] }),
  row('ABC-30', { kind: 'epic', created_at: '2026-10-04T00:00:00.000Z' }),
  row('ABC-31', { kind: 'child', parent_id: 'ABC-30', status: 'done', tags: [] }),
  row('ABC-40', { kind: 'epic', created_at: '2026-10-05T00:00:00.000Z' }),
  row('ABC-41', { kind: 'child', parent_id: 'ABC-40', blocked_by: ['ABC-5'], tags: [] }),
  row('ABC-50', { kind: 'epic', tags: [], created_at: '2026-10-06T00:00:00.000Z' }),
  row('ABC-51', { kind: 'child', parent_id: 'ABC-50', created_at: '2026-10-06T00:00:00.000Z' }),
  row('ABC-60', { tags: ['other'] }),
];

function e2eRows() {
  const fresh = new Date().toISOString();
  return [
    row('ABC-1', { updated_at: fresh }),
    row('ABC-2', { updated_at: fresh, created_at: '2026-10-02T00:00:00.000Z' }),
    row('ABC-9', { updated_at: fresh, status: 'in-review' }),
  ];
}

/**
 * A routing stand-in for the server, answering a request that carries the
 * bearer token (403 otherwise): the ticket list, one ticket from `tickets`
 * (404 when absent), the project list, and the inbox capture, whose bodies
 * are pushed to `inbox`.
 */
function stubHandler({ rows = [], tickets = {}, projects = [{ id: PROJECT_ID, name: 'my-app' }], inbox = [], inboxStatus = 201, seen = [] } = {}) {
  return (req, res) => {
    seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    const send = (status, body) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      send(403, {});
      return;
    }
    const { pathname } = new URL(req.url, 'http://stub.invalid');
    const one = /^\/api\/pipeline\/tickets\/([^/]+)$/.exec(pathname);
    if (req.method === 'GET' && pathname === '/api/pipeline/tickets') {
      send(200, rows);
    } else if (req.method === 'GET' && one !== null) {
      const ticket = tickets[decodeURIComponent(one[1])];
      send(ticket === undefined ? 404 : 200, ticket ?? {});
    } else if (req.method === 'GET' && pathname === '/api/projects') {
      send(200, projects);
    } else if (req.method === 'POST' && pathname === '/api/inbox') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        inbox.push({ contentType: req.headers['content-type'], body: JSON.parse(body) });
        send(inboxStatus, { id: 'inbox-1' });
      });
    } else {
      send(404, {});
    }
  };
}

/** Serve `rows` to a request carrying the bearer token; 403 otherwise. */
function ticketHandler(rows, seen = []) {
  return stubHandler({ rows, seen });
}

/** A temp world for an end-to-end run: repo, bin, home, and the stand-ins' scripted output. */
function world(label, { config, ghOut = '[]' } = {}) {
  const dir = tempDir(label);
  const repo = initRepo(dir);
  writeConfig(repo, config ?? `mode: server-native\nproject: ${PROJECT_ID}\ndispatch:\n  max_tickets_per_run: 1\n`);
  commitAll(repo);
  const bin = fakeBin(dir);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const file = (name, text) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, text);
    return target;
  };
  const ghFile = file('gh-out.json', ghOut);
  const files = {
    FAKE_GH_OUT: ghFile,
    FAKE_GH_VIEW_OUT: file('gh-view.txt', 'OPEN\n'),
    FAKE_CLAUDE_SYNC_OUT: file('sync-out.json', `${JSON.stringify(resultEvent('sess-sync'))}\n`),
    FAKE_CLAUDE_SHIP_OUT: file('ship-out.jsonl', jsonl(initEvent('sess-ship'), resultEvent('sess-ship'))),
    FAKE_CLAUDE_ARGS: path.join(dir, 'claude-args.log'),
    FAKE_CLAUDE_PID: path.join(dir, 'claude.pid'),
  };
  const stateDir = path.join(home, '.feature-pipeline', 'dispatch', 'my-app');
  return { dir, repo, bin, home, ghFile, files, file, stateDir };
}

/** The child environment for a world: stand-ins on PATH, HOME redirected, the server URL and token. */
function worldEnv(w, url, extra = {}) {
  return childEnv({ bin: w.bin, home: w.home, url, token: TOKEN, extra: { ...w.files, ...extra } });
}

/** The row the server answers for an item after a shipped session. */
const shippedRow = (id, fields = {}) => ({ id, status: 'in-review', kind: 'solo', pr_url: `https://github.com/acme/my-app/pull/${id.replace(/\D/g, '')}`, ...fields });

const CASES = [
  ['argv: rejections exit 2 before anything runs', async () => {
    const dir = tempDir('argv');
    try {
      const cases = [
        [[], 'no verb given'],
        [['--self-test', 'plan'], '--self-test takes no verb'],
        [['deploy'], 'unknown verb'],
        [['plan'], 'plan needs --project-root'],
        [['plan', '--project-root='], 'needs a value'],
        [['plan', '--project-root', 'relative/dir'], 'must be an absolute path'],
        [['plan', '--project-root', path.join(dir, 'missing')], 'does not exist'],
        [['run', '--project-root', dir, '--project-root', dir], 'flag given twice'],
        [['run', '--project-root', dir, '--force'], 'unknown flag'],
        [['plan', '--project-root', dir, 'extra'], 'unexpected argument'],
      ];
      for (const [args, fragment] of cases) {
        const res = await runEntry(args, { env: { PATH: '/usr/bin:/bin', HOME: dir } });
        assert(res.status === 2, `${JSON.stringify(args)}: exit ${res.status}, stdout ${JSON.stringify(res.stdout)}`);
        assert(res.doc !== null && Object.keys(res.doc).length === 1 && typeof res.doc.error === 'string', `${JSON.stringify(args)}: not an error document`);
        assert(res.doc.error.includes(fragment), `${JSON.stringify(args)}: error does not mention "${fragment}": ${res.doc.error}`);
      }
      assert(!fs.existsSync(path.join(dir, '.feature-pipeline')), 'an exit 2 created state');
      equal(parseArgv(['plan', `--project-root=${dir}/`]), { verb: 'plan', projectRoot: dir }, 'parseArgv normalises the root');
      equal(parseArgv(['--self-test']), { selfTest: true }, 'parseArgv --self-test');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }],

  ['output: sorted keys, two-space indent, exit-code mapping', () => {
    equal(render({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } }), '{\n  "a": {\n    "c": null,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n', 'render');
    assert(exitCodeFor(new UsageError('x')) === 2, 'UsageError → 2');
    assert(exitCodeFor(new ComputeError('x')) === 1, 'ComputeError → 1');
    assert(exitCodeFor(new Error('x')) === 1, 'Error → 1');
  }],

  ['teardown: hooks run once each, newest first, past a throwing hook', () => {
    runTeardown('drain');
    const order = [];
    addTeardown((reason) => order.push(`first:${reason}`));
    addTeardown(() => {
      throw new Error('boom');
    });
    const dispose = addTeardown(() => order.push('disposed'));
    addTeardown((reason) => order.push(`last:${reason}`));
    dispose();
    runTeardown('interrupted by SIGTERM');
    runTeardown('again');
    equal(order, ['last:interrupted by SIGTERM', 'first:interrupted by SIGTERM'], 'hook order');
  }],

  ['config: the mini YAML reader', () => {
    const doc = parseMiniYaml(
      '﻿prefix: ABC\r\nmode: "server-native" # inline\r\n# comment\r\n\r\nproject: \'' + PROJECT_ID + '\'\r\n' +
        'test:\r\n  repos:\r\n    app:\r\n      start: "npm run dev"\r\nchildren:\r\n  - ABC-1\r\n' +
        'dispatch:\r\n  tag: "night #1"\r\n  max_open_prs: 4 # four\r\n    deeper: ignored\r\nworktree:\r\n  setup: "true"\r\n',
    );
    equal(doc.prefix, 'ABC', 'BOM stripped from the first key');
    equal(doc.mode, 'server-native', 'quoted scalar with inline comment');
    equal(doc.project, PROJECT_ID, 'single-quoted scalar');
    equal(doc.dispatch, { tag: 'night #1', max_open_prs: '4' }, 'nested block, # inside quotes kept, deeper line skipped');
    equal(doc.test, { repos: '' }, 'deeper nesting under test: skipped');
    equal(doc.children, {}, 'sequence items skipped');
    equal(doc.worktree, { setup: 'true' }, 'later block');
  }],

  ['config: validation, defaults and refusals', () => {
    const base = { mode: 'server-native', project: PROJECT_ID };
    const all = validateConfig(base);
    equal(all.dispatch, { ...DISPATCH_DEFAULTS }, 'missing block → defaults');
    equal(all.notes.length, 1, 'missing block → one note');
    const partial = validateConfig({ ...base, dispatch: { tag: 'night', max_open_prs: '5', colour: 'red' } });
    equal(partial.dispatch, { tag: 'night', max_age_days: 14, max_tickets_per_run: 2, max_open_prs: 5, max_session_minutes: 180, max_rate_limit_retries: 10 }, 'partial block');
    equal(partial.notes, [
      'config.yaml: unknown key dispatch.colour ignored',
      'config.yaml: dispatch.max_age_days not set — using 14',
      'config.yaml: dispatch.max_tickets_per_run not set — using 2',
      'config.yaml: dispatch.max_session_minutes not set — using 180',
      'config.yaml: dispatch.max_rate_limit_retries not set — using 10',
    ], 'partial block notes');
    equal(validateConfig({ ...base, dispatch: { max_session_minutes: '30', max_rate_limit_retries: '4' } }).dispatch.max_session_minutes, 30, 'session cap read');
    throwsKind(() => validateConfig({ ...base, dispatch: { max_rate_limit_retries: '0' } }), ComputeError, 'dispatch.max_rate_limit_retries must be a positive integer');
    throwsKind(() => validateConfig({ mode: 'fs-native', project: PROJECT_ID }), ComputeError, FS_NATIVE_REFUSAL);
    throwsKind(() => validateConfig({ project: PROJECT_ID }), ComputeError, FS_NATIVE_REFUSAL);
    throwsKind(() => validateConfig({ ...base, project: 'my-project' }), ComputeError, 'project must be the server project UUID');
    for (const bad of ['0', '-1', '1.5', 'two', '']) {
      throwsKind(() => validateConfig({ ...base, dispatch: { max_age_days: bad } }), ComputeError, 'dispatch.max_age_days must be a positive integer');
    }
    throwsKind(() => validateConfig({ ...base, dispatch: { tag: '' } }), ComputeError, 'dispatch.tag must not be empty');
    const dir = tempDir('config');
    try {
      throwsKind(() => loadDispatchConfig(dir), ComputeError, FS_NATIVE_REFUSAL);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }],

  ['server: credential file, precedence and token binding', () => {
    const dir = tempDir('cred');
    try {
      equal(parseCredentialFile('# c\nexport PERSONAL_SERVER_URL="http://h:1"\nOTHER="two words"\nPERSONAL_SERVER_CLIENT_TOKEN=abc\n', 'f'), { PERSONAL_SERVER_URL: 'http://h:1', PERSONAL_SERVER_CLIENT_TOKEN: 'abc' }, 'parse');
      const malformed = throwsKind(() => parseCredentialFile('PERSONAL_SERVER_CLIENT_TOKEN="sec ret"\n', 'f'), ComputeError, 'f:1: malformed line');
      assert(!malformed.message.includes('sec'), 'malformed-line message leaks content');
      throwsKind(() => parseCredentialFile('not a line\n', 'f'), ComputeError, 'f:1');

      const file = path.join(dir, 'cli.env');
      fs.writeFileSync(file, `PERSONAL_SERVER_URL=http://127.0.0.1:7801\nPERSONAL_SERVER_CLIENT_TOKEN=${TOKEN}\n`);
      fs.chmodSync(file, 0o644);
      const env = { PERSONAL_SERVER_CLI_CONFIG: file };
      const open = throwsKind(() => resolveServerAccess(env, dir), ComputeError, 'mode 0600 required');
      assert(!open.message.includes(TOKEN), 'mode refusal leaks the token');
      equal(resolveServerAccess({ ...env, PERSONAL_SERVER_URL: 'http://x:1/', PERSONAL_SERVER_CLIENT_TOKEN: 'e' }, dir), { apiBase: 'http://x:1/api', origin: 'http://x:1', token: 'e', tokenSource: 'env' }, 'a full environment never reads the file');
      fs.chmodSync(file, 0o600);
      equal(resolveServerAccess(env, dir), { apiBase: 'http://127.0.0.1:7801/api', origin: 'http://127.0.0.1:7801', token: TOKEN, tokenSource: 'file' }, 'file values');
      const bound = throwsKind(() => resolveServerAccess({ ...env, PERSONAL_SERVER_URL: 'http://localhost:7801' }, dir), ComputeError, 'is bound to http://127.0.0.1:7801');
      assert(!bound.message.includes(TOKEN), 'binding refusal leaks the token');
      equal(resolveServerAccess({ ...env, PERSONAL_SERVER_URL: 'http://127.0.0.1:7801/', PERSONAL_SERVER_CLIENT_TOKEN: '' }, dir).tokenSource, 'file', 'empty env token counts as unset; same origin keeps the file token');
      throwsKind(() => resolveServerAccess({ PERSONAL_SERVER_URL: 'http://user:pw@h:1' }, undefined), ComputeError, 'without credentials');
      throwsKind(() => resolveServerAccess({ PERSONAL_SERVER_CLI_CONFIG: 'relative.env' }, dir), ComputeError, 'must be an absolute path');
      equal(resolveServerAccess({}, path.join(dir, 'no-home')), { apiBase: 'http://localhost:7717/api', origin: 'http://localhost:7717', token: undefined, tokenSource: 'none' }, 'defaults with no file');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }],

  ['server: the ticket list request', async () => {
    const seen = [];
    await withStub(ticketHandler([row('ABC-1'), { id: 'ABC-2' }], seen), async (url) => {
      const access = resolveServerAccess({ PERSONAL_SERVER_URL: url, PERSONAL_SERVER_CLIENT_TOKEN: TOKEN }, undefined);
      const listed = await listTickets({ access, projectId: PROJECT_ID });
      equal(listed.rows.map((r) => r.id), ['ABC-1'], 'malformed row dropped');
      assert(listed.notes.length === 1 && listed.notes[0].includes('ABC-2'), `malformed-row note: ${JSON.stringify(listed.notes)}`);
      equal(seen[0].url, `/api/pipeline/tickets?project_id=${PROJECT_ID}`, 'route');
      const anonymous = { ...access, token: undefined, tokenSource: 'none' };
      const rejected = await rejectsKind(() => listTickets({ access: anonymous, projectId: PROJECT_ID }), ComputeError, 'HTTP 403 (token source: none)');
      assert(seen[1].authorization === undefined, 'an unset token sent an Authorization header');
      assert(!rejected.message.includes(TOKEN), 'rejection leaks the token');
    });
    await withStub((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('[]');
    }, async (url) => {
      const listed = await listTickets({ access: resolveServerAccess({ PERSONAL_SERVER_URL: url }, undefined), projectId: PROJECT_ID });
      equal(listed.notes, [`server returned no tickets for project ${PROJECT_ID}`], 'empty list note');
    });
    let closedUrl;
    await withStub(() => {}, async (url) => {
      closedUrl = url;
    });
    await rejectsKind(() => listTickets({ access: resolveServerAccess({ PERSONAL_SERVER_URL: closedUrl }, undefined), projectId: PROJECT_ID }), ComputeError, 'server unreachable at');
  }],

  ['selection: eligibility, epics, skips and order', () => {
    const { candidates, skips, notes } = selectCandidates(FIXTURE_ROWS, { tag: TAG, maxAgeDays: 14, now: NOW });
    equal(candidates.map((c) => [c.id, c.kind, c.tickets]), [
      ['ABC-2', 'solo', ['ABC-2']],
      ['ABC-10', 'solo', ['ABC-10']],
      ['ABC-20', 'epic', ['ABC-21', 'ABC-22']],
      ['ABC-51', 'child', ['ABC-51']],
    ], 'candidates');
    equal(skips.map((s) => [s.id, s.reason]), [
      ['ABC-3', 'blocked'],
      ['ABC-4', 'stale'],
      ['ABC-5', 'not backlog'],
      ['ABC-7', 'stale'],
      ['ABC-8', 'blocked'],
      ['ABC-22', 'covered by epic ABC-20'],
      ['ABC-30', 'no backlog children'],
      ['ABC-40', 'blocked'],
    ], 'skips');
    equal(skips.find((s) => s.id === 'ABC-3').detail, 'waiting on ABC-99 (not found)', 'missing blocker detail');
    equal(skips.find((s) => s.id === 'ABC-8').detail, 'waiting on ABC-5 (in-progress)', 'terminal blocker passes');
    equal(skips.find((s) => s.id === 'ABC-40').detail, 'waiting on ABC-5 (in-progress)', 'external child blocker blocks the epic');
    equal(skips.find((s) => s.id === 'ABC-4').detail, 'updated 74 days ago', 'stale detail');
    equal(notes, ['ABC-7: unparseable updated_at — treated as stale'], 'notes');
    equal(['ABC-10', 'ABC-2', 'B-1', 'ABC-1'].sort(compareIds), ['ABC-1', 'ABC-2', 'ABC-10', 'B-1'], 'id order');
  }],

  ['caps: open-PR count and admission', () => {
    const counted = countOpenPrs({
      openPrs: [
        { title: 'ABC-2: x', url: 'https://g/1' },
        { title: 'ABC-20: y', url: 'https://g/2' },
        { title: 'ABC-200: z', url: 'https://g/3' },
        { title: 'chore', url: 'https://g/4' },
      ],
      runs: [{ items: [{ pr_url: 'https://g/2' }, { pr_url: 'https://g/4' }, { pr_url: null }] }],
      slots: new Map([['ABC-2', 'ABC-2'], ['ABC-20', 'ABC-20']]),
    });
    equal(counted, { count: 3, slots: ['ABC-2', 'ABC-20', 'https://g/4'], urls: ['https://g/1', 'https://g/2', 'https://g/4'] }, 'union by URL');

    const row = (id, kind, tags, parentId = null) => ({ id, kind, tags, parent_id: parentId });
    const slots = prSlots([
      row('E-1', 'epic', ['agent-ready']),
      row('E-2', 'child', ['agent-ready'], 'E-1'),
      row('E-3', 'child', [], 'E-1'),
      row('U-1', 'epic', []),
      row('U-2', 'child', ['agent-ready'], 'U-1'),
      row('U-3', 'child', [], 'U-1'),
      row('S-1', 'solo', ['agent-ready']),
      row('S-2', 'solo', []),
    ], 'agent-ready');
    equal([...slots].sort(), [['E-1', 'E-1'], ['E-2', 'E-1'], ['E-3', 'E-1'], ['S-1', 'S-1'], ['U-2', 'U-2']], 'pr slots');
    const epicPrs = countOpenPrs({
      openPrs: [
        { title: 'E-2: first child', url: 'https://g/12' },
        { title: 'E-3: second child', url: 'https://g/13' },
        { title: 'E-1: integration', url: 'https://g/11' },
        { title: 'S-1: solo', url: 'https://g/21' },
        { title: 'U-2: child of an untagged epic', url: 'https://g/32' },
        { title: 'U-3: untagged', url: 'https://g/33' },
        { title: 'S-2: untagged', url: 'https://g/22' },
        { title: 'recorded epic PR', url: 'https://g/40' },
      ],
      runs: [{ items: [{ id: 'E-1', pr_url: 'https://g/40' }] }],
      slots,
    });
    equal(epicPrs.slots, ['E-1', 'S-1', 'U-2'], 'an epic\'s child and integration PRs hold one slot');
    equal(epicPrs.count, 3, 'epic slot count');

    const solo = (id) => ({ id, tickets: [id] });
    const epic = { id: 'E-1', tickets: ['E-2', 'E-3', 'E-4'] };
    const ids = (result) => [result.admitted.map((i) => i.id), result.notAdmitted.map((i) => `${i.id}:${i.reason}`), result.caps.reason];
    equal(ids(admit([solo('A'), solo('B'), solo('C')], { openPrs: 0, maxOpenPrs: 3, maxTicketsPerRun: 2 })), [['A', 'B'], ['C:ticket cap'], 'max_tickets_per_run reached (2/2)'], 'ticket cap');
    equal(ids(admit([solo('A'), solo('B')], { openPrs: 2, maxOpenPrs: 3, maxTicketsPerRun: 5 })), [['A'], ['B:pr cap'], 'max_open_prs reached (3/3)'], 'pr cap mid-walk');
    equal(ids(admit([], { openPrs: 3, maxOpenPrs: 3, maxTicketsPerRun: 2 })), [[], [], 'max_open_prs reached (3/3)'], 'cap already met, no candidates');
    equal(ids(admit([epic, solo('S')], { openPrs: 0, maxOpenPrs: 3, maxTicketsPerRun: 1 })), [['E-1'], ['S:ticket cap'], 'max_tickets_per_run reached (3/1)'], 'first epic exemption');
    equal(ids(admit([solo('S'), epic, solo('T')], { openPrs: 0, maxOpenPrs: 3, maxTicketsPerRun: 2 })), [['S'], ['E-1:ticket cap', 'T:ticket cap'], 'max_tickets_per_run has no room for E-1 (1/2, needs 3)'], 'no younger jump-ahead');
    equal(ids(admit([solo('S')], { openPrs: null, maxOpenPrs: 3, maxTicketsPerRun: 2 })), [[], ['S:open PRs unknown'], 'open PRs could not be counted'], 'gh unknown');
  }],

  ['lock: acquire, held, takeover, unreadable owner, release by owner only', () => {
    const dir = tempDir('lock');
    try {
      throwsKind(() => gitCommonDir(dir), ComputeError, 'project root is not a git repository');
      const repo = initRepo(dir);
      const commonDir = gitCommonDir(repo);
      equal(projectNameFor(commonDir), 'my-app', 'project name');
      const lockDir = path.join(commonDir, LOCK_NAME);
      const first = newRunId(NOW);
      assert(RUN_ID_RE.test(first) && first.startsWith('2026-10-14-'), `run id shape: ${first}`);
      const a = acquireLock({ commonDir, runId: first, now: NOW });
      equal(readOwner(lockDir)?.runId, first, 'owner written');
      throwsKind(() => acquireLock({ commonDir, runId: newRunId(NOW), now: new Date(NOW.getTime() + STALE_MS - 1) }), ComputeError, `lock held by run ${first}`);
      const second = newRunId(NOW);
      const b = acquireLock({ commonDir, runId: second, now: new Date(NOW.getTime() + STALE_MS) });
      assert(b.notes.length === 1 && b.notes[0].includes(first), `takeover note: ${JSON.stringify(b.notes)}`);
      assert(holdsLock(a.lock) === false && holdsLock(b.lock) === true, 'holdsLock after a takeover');
      assert(releaseLock(a.lock) === false && fs.existsSync(lockDir), 'a taken-over run removed the new owner\'s lock');
      assert(releaseLock(b.lock) === true && !fs.existsSync(lockDir), 'the owner did not release');
      assert(releaseLock(b.lock) === false, 'release is not idempotent');

      fs.mkdirSync(lockDir);
      const now = new Date();
      throwsKind(() => acquireLock({ commonDir, runId: newRunId(now), now }), ComputeError, 'lock held (owner unreadable)');
      const young = new Date(now.getTime() - UNREADABLE_GRACE_MS + 10_000);
      fs.utimesSync(lockDir, young, young);
      throwsKind(() => acquireLock({ commonDir, runId: newRunId(now), now }), ComputeError, 'lock held (owner unreadable)');
      const old = new Date(now.getTime() - UNREADABLE_GRACE_MS - 1_000);
      fs.utimesSync(lockDir, old, old);
      const c = acquireLock({ commonDir, runId: newRunId(now), now });
      assert(c.notes.length === 1 && c.notes[0].includes('unreadable owner'), `mtime takeover note: ${JSON.stringify(c.notes)}`);
      releaseLock(c.lock);
      assert(!fs.existsSync(lockDir), 'mtime-taken lock not released');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }],

  ['state: project name and containment', () => {
    throwsKind(() => projectNameFor('/x/a b/.git'), ComputeError, 'not usable');
    throwsKind(() => stateDirFor('/home/me', '..'), ComputeError, 'escapes the state root');
    throwsKind(() => stateDirFor(undefined, 'my-app'), ComputeError, 'HOME is not set');
    equal(stateDirFor('/home/me', 'my-app'), path.join('/home/me', '.feature-pipeline', 'dispatch', 'my-app'), 'state dir');
  }],

  ['report: sections in order, escaped cells', () => {
    const md = renderReport({
      run_id: '2026-10-14-a1b2c3',
      project: { name: 'my-app', id: PROJECT_ID },
      started: 's',
      finished: 'f',
      outcome: 'completed',
      error: null,
      items: [{ id: 'ABC|1', kind: 'solo', tickets: ['ABC|1'], outcome: 'not dispatched', pr_url: null, session_id: null }],
      not_admitted: [{ id: 'ABC-2', reason: 'ticket cap' }],
      skips: [{ id: 'ABC-3', reason: 'blocked', detail: 'waiting on ABC-9 (in-progress)' }],
      caps: { open_prs: null, max_open_prs: 3, tickets_admitted: 1, max_tickets_per_run: 2, reason: null },
      preconditions: [{ name: 'gh', ok: false, detail: 'not found on PATH' }],
      notes: [],
    });
    const headings = md.split('\n').filter((line) => line.startsWith('## '));
    equal(headings, ['## Outcome', '## Sync', '## Dispatched', '## Skips', '## Caps', '## Preconditions', '## Notes'], 'sections');
    assert(md.includes('- before: not run'), 'sync line');
    assert(md.includes('Night dispatch 2026-10-14-a1b2c3: 0 shipped, 0 stuck, 3 skipped'), 'summary line under Outcome');
    assert(md.includes('| ABC\\|1 | solo |'), 'cell not escaped');
    assert(md.includes('- ABC-3 — blocked (waiting on ABC-9 (in-progress))'), 'skip line');
    assert(md.includes('- open PRs: unknown / 3'), 'caps line');
    assert(md.includes('- FAILED gh — not found on PATH'), 'precondition line');
  }],

  ['end to end: plan answers and writes nothing; run ships, records, reports, posts and releases', async () => {
    const w = world('e2e', { ghOut: JSON.stringify([{ number: 1, title: 'ABC-9: open', url: 'https://g/9' }]) });
    const inbox = [];
    try {
      await withStub(stubHandler({ rows: e2eRows(), tickets: { 'ABC-1': shippedRow('ABC-1') }, inbox }), async (url) => {
        const env = worldEnv(w, url);
        const lockDir = path.join(gitCommonDir(w.repo), LOCK_NAME);

        const planned = await runEntry(['plan', '--project-root', w.repo], { env });
        assert(planned.status === 0, `plan exit ${planned.status}: ${planned.stdout}`);
        assert(planned.stdout === render(planned.doc), 'plan output is not the sorted-key rendering');
        const p = planned.doc;
        equal([p.verb, p.ok, p.admitted.map((i) => i.id), p.not_admitted, p.skips.map((s) => s.id)], ['plan', true, ['ABC-1'], [{ id: 'ABC-2', reason: 'ticket cap' }], ['ABC-9']], 'plan document');
        equal(p.caps.open_prs, 1, 'open PR counted by title');
        equal(p.preconditions.map((c) => c.name), ['claude', 'config', 'gh', 'git_base', 'git_clean', 'node', 'server', 'state_dir'], 'precondition names');
        assert(!fs.existsSync(path.join(w.home, '.feature-pipeline')) && !fs.existsSync(lockDir), 'plan wrote state or a lock');

        const ran = await runEntry(['run', '--project-root', w.repo], { env });
        assert(ran.status === 0, `run exit ${ran.status}: ${ran.stdout}`);
        const r = ran.doc;
        const prUrl = 'https://github.com/acme/my-app/pull/1';
        equal([r.verb, r.outcome, r.items.map((i) => [i.id, i.outcome, i.reason, i.pr_url, i.session_id, i.exit_code, i.cost_usd, i.rate_limit_retries])], ['run', 'completed', [['ABC-1', 'shipped', null, prUrl, 'sess-ship', 0, 1.25, 0]]], 'run document');
        equal([r.sync.before?.ok, r.sync.before?.session_id, r.sync.after?.ok], [true, 'sess-sync', true], 'sync before and after');
        assert(RUN_ID_RE.test(r.run_id), `run id: ${r.run_id}`);
        equal(r.report, path.join(w.stateDir, 'reports', `${r.run_id}.md`), 'report path');
        const report = fs.readFileSync(r.report, 'utf8');
        assert(report.includes('## Sync') && report.includes(`| ABC-1 | solo | ABC-1 | shipped | — | ${prUrl} | sess-ship | 0 | 1.25 | 0 |`), 'report content');
        const runs = JSON.parse(fs.readFileSync(path.join(w.stateDir, 'runs.json'), 'utf8'));
        equal(runs.map((x) => [x.run_id, x.outcome, x.error, x.items[0].pr_url, x.sync.before.ok]), [[r.run_id, 'completed', null, prUrl, true]], 'runs.json');
        equal((fs.statSync(w.stateDir).mode & 0o777).toString(8), '700', 'state dir mode');
        equal((fs.statSync(r.items[0].log).mode & 0o777).toString(8), '600', 'session log mode');
        equal(path.dirname(r.items[0].log), path.join(w.stateDir, 'logs', r.run_id), 'session log location');
        assert(!fs.existsSync(lockDir), 'lock not released');
        assert(!ran.stdout.includes(TOKEN) && !report.includes(TOKEN), 'token in output or report');
        equal(inbox.length, 1, 'one inbox item');
        const item = inbox[0].body;
        equal([item.source, item.project, item.metadata], ['feature:dispatch', 'my-app', { project_id: PROJECT_ID, run_id: r.run_id }], 'inbox item fields');
        equal(item.body.split('\n')[0], `Night dispatch ${r.run_id}: 1 shipped, 0 stuck, 2 skipped`, 'inbox first line');
        assert(!item.body.includes(TOKEN), 'token in the inbox body');
        const calls = fs.readFileSync(w.files.FAKE_CLAUDE_ARGS, 'utf8').split('--\n').filter(Boolean).map((call) => call.split('\n').filter(Boolean));
        equal(calls.map((call) => call[0]), [w.repo, w.repo, w.repo], 'every child ran in the project root');
        equal(calls, [[w.repo, ...syncArgv()], [w.repo, ...shipArgv('ABC-1', w.home)], [w.repo, ...syncArgv()]], 'sync, ship, sync: exact vectors in the project root');
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  }],

  ['end to end: a rejecting server, a failing gh, fs-native and a live lock', async () => {
    const w = world('e2e-fail');
    try {
      const commonDir = gitCommonDir(w.repo);
      const lockDir = path.join(commonDir, LOCK_NAME);
      await withStub((req, res) => {
        res.statusCode = 401;
        res.end('{}');
      }, async (url) => {
        const env = worldEnv(w, url);
        const res = await runEntry(['run', '--project-root', w.repo], { env });
        assert(res.status === 1 && res.doc?.error === 'preconditions failed: server (server rejected the request: HTTP 401 (token source: env))', `401: exit ${res.status} ${res.stdout}`);
        assert(!res.stdout.includes(TOKEN), '401 leaks the token');
        const runs = JSON.parse(fs.readFileSync(path.join(w.stateDir, 'runs.json'), 'utf8'));
        equal(runs.map((x) => x.outcome), ['stopped'], 'stopped record');
        equal(fs.readdirSync(path.join(w.stateDir, 'reports')).length, 1, 'stopped report');
        assert(!fs.existsSync(lockDir), 'lock not released after exit 1');
      });

      await withStub(ticketHandler(e2eRows()), async (url) => {
        const env = worldEnv(w, url, { FAKE_GH_STATUS: '1' });
        const planned = await runEntry(['plan', '--project-root', w.repo], { env });
        assert(planned.status === 0, `plan with failing gh: exit ${planned.status} ${planned.stdout}`);
        const p = planned.doc;
        equal([p.ok, p.caps.open_prs, p.admitted, p.preconditions.find((c) => c.name === 'gh').ok], [false, null, [], false], 'plan with failing gh');
        const ran = await runEntry(['run', '--project-root', w.repo], { env });
        assert(ran.status === 1 && ran.doc?.error === 'preconditions failed: gh (gh auth status failed)', `run with failing gh: exit ${ran.status} ${ran.stdout}`);
        const listing = await runEntry(['run', '--project-root', w.repo], { env: { ...env, FAKE_GH_AUTH_STATUS: '0' } });
        assert(listing.status === 1 && listing.doc?.error.startsWith('cannot count open pull requests'), `run with failing gh pr list: exit ${listing.status} ${listing.stdout}`);
        assert(!fs.existsSync(lockDir), 'lock not released after gh failure');

        const owner = 'run_id: 2026-10-14-abcdef\nstarted: ' + new Date().toISOString() + '\n';
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, 'owner'), owner);
        const before = fs.readdirSync(path.join(w.stateDir, 'reports')).length;
        const held = await runEntry(['run', '--project-root', w.repo], { env: { ...env, FAKE_GH_STATUS: '0' } });
        assert(held.status === 1 && held.doc?.error === 'lock held by run 2026-10-14-abcdef', `live lock: exit ${held.status} ${held.stdout}`);
        equal(fs.readdirSync(path.join(w.stateDir, 'reports')).length, before, 'a refused run wrote a report');
        equal(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8'), owner, 'the live lock was touched');
        fs.rmSync(lockDir, { recursive: true, force: true });

        writeConfig(w.repo, 'mode: fs-native\n');
        const fsNative = await runEntry(['plan', '--project-root', w.repo], { env });
        assert(fsNative.status === 1 && fsNative.doc?.error === FS_NATIVE_REFUSAL, `fs-native: exit ${fsNative.status} ${fsNative.stdout}`);
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  }],

  ['end to end: SIGTERM after the lock records stopped and releases', async () => {
    const w = world('e2e-signal');
    try {
      const lockDir = path.join(gitCommonDir(w.repo), LOCK_NAME);
      await withStub(() => {
        // Never answer: the run waits on the request while holding the lock.
      }, async (url) => {
        const env = worldEnv(w, url);
        const res = await runEntry(['run', '--project-root', w.repo], {
          env,
          onSpawn: (child) => {
            const started = Date.now();
            const poll = setInterval(() => {
              if (fs.existsSync(path.join(lockDir, 'owner')) || Date.now() - started > 15_000) {
                clearInterval(poll);
                child.kill('SIGTERM');
              }
            }, 50);
          },
        });
        assert(res.status === 1 && res.doc?.error === 'interrupted by SIGTERM', `signal: exit ${res.status} ${res.stdout}`);
        const runs = JSON.parse(fs.readFileSync(path.join(w.stateDir, 'runs.json'), 'utf8'));
        equal(runs.map((x) => [x.outcome, x.error]), [['stopped', 'interrupted by SIGTERM']], 'stopped record on signal');
        assert(!fs.existsSync(lockDir), 'lock not released on signal');
      });
    } finally {
      fs.rmSync(w.dir, { recursive: true, force: true });
    }
  }],
];

CASES.push(
  ...sessionCases({
    assert,
    equal,
    tempDir,
    initRepo,
    writeConfig,
    commitAll,
    fakeBin,
    childEnv,
    world,
    worldEnv,
    withStub,
    stubHandler,
    runEntry,
    e2eRows,
    shippedRow,
    jsonl,
    initEvent,
    resultEvent,
    rateLimitEvent,
    PROJECT_ID,
    TOKEN,
  }),
);

/** Run every case; return the document, or throw a ComputeError naming the first failure. */
export async function runSelfTest() {
  for (const [name, fn] of CASES) {
    try {
      await fn();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ComputeError(`self-test: ${name} — ${detail}`);
    }
  }
  return { cases: CASES.length, ok: true };
}
