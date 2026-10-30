// `cli.mjs --self-test` (CONTRACT.md §12).
//
// Exercises what no browser session proves, without a browser. It checks the viewer's colouring
// seam over the vendored highlight.js on a fixed TSX sample, and the routes that serve both. It
// checks the viewer's round controller over a fake server and a fake view: the anchor rule
// against the listing, the Send rule, writes running one at a time with the newest session, a
// refresh merging the server copy by ownership, Send, Finish and Cancel with each refusal, and
// the change wait's backoff, reconnection and end. It checks the note rules (the anchor rule per kind, range validity, the excerpt cap), resuming a
// notes file (a stored note keeps its anchor; rounds and note rounds restore; a file without
// rounds is round 0; the refusals), the atomic save, the sent-note lock, the agent's replies
// (kept through a viewer write and a resume, each resume refusal for them, a reply post whose
// save fails changing nothing), the scope rule, file listing that never lists a symlink, and
// the reading refusals and limits. Against a server on port 0 inside this process it checks the
// request guards, a submit that sends a round and keeps serving, finish, cancel (on empty, and
// after a sent round), `wait` returning on a submit and on the end of the run, the reply route
// (sent notes only, its refusals, all or nothing, 409 after the end), re-listing after a reply
// (a new file accepted as a `file` anchor, a deleted listed file answering 404), and the change
// wait returning on a reply and on the end. It checks the overview document: a document accepted
// with its unknown fields dropped, each shape refusal, each reading refusal and the size limit,
// the overview route behind the token and its 404 without an overview, and a listing that never
// lists the overview file. It checks the overview data: the import scan and its resolution
// against the listing and tsconfig `paths`, the line count, indent width and indentation, churn
// from dated commits in a temporary repository, the hotspot table, explorer blocks parsed and
// dropped, roles merged, each notice, and the size limit. Through `cli.mjs` children it checks
// the command's own refusals (children that must exit before serving, `wait`'s invocation
// refusals, each `--overview` refusal leaving `--out` as it was, and the `measure` and
// `assemble` refusals writing nothing) and end-to-end runs: a submit, a `wait` child, finish,
// and exactly one result document, a run ended by SIGTERM, a run serving its overview, and
// `measure` then `assemble` writing an overview the shape check accepts.
// Every fixture is a real file in a temp directory, and every expectation is written by hand,
// never computed by the code under test. Requests go to 127.0.0.1 only. A failing case throws
// a RunError naming it.
//
// Private to the implementation: only cli.mjs is a command.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { listFiles, readSource } from './files.mjs';
import { applyEdits, cleanAnnotation } from './annotations.mjs';
import { assembleOverview, readMeasurement, readOptional, serialiseOverview } from './assemble.mjs';
import { createResolver, parseJsonc, scanSpecifiers } from './imports.mjs';
import { countLines, detectWidth, indentation, measureScope } from './measure.mjs';
import { MAX_OVERVIEW_BYTES, checkOverview, readOverview } from './overview.mjs';
import { startServer } from './server.mjs';
import { RunError, createSession, finishRun, postReplies, readStored, restoreSession, saveSession, scopePath, sendRound } from './session.mjs';
import { waitForRound } from './wait.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const MAX_BYTES = 2 * 1024 * 1024;
const TOKEN = '0123456789abcdef0123456789abcdef';
const WAIT_MS = 5000;

class CaseFailure extends Error {}

function assert(condition, detail) {
  if (!condition) {
    throw new CaseFailure(detail);
  }
}

function assertEqual(actual, expected, what) {
  assert(isDeepStrictEqual(actual, expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function throwsRun(fn, exitCode, fragment) {
  try {
    fn();
  } catch (err) {
    assert(err instanceof RunError, `expected a RunError, got ${err.constructor.name}: ${err.message}`);
    assert(err.exitCode === exitCode, `expected exit ${exitCode}, got ${err.exitCode}: ${err.message}`);
    assert(err.message.includes(fragment), `expected the error to mention "${fragment}", got: ${err.message}`);
    return;
  }
  throw new CaseFailure(`expected a RunError mentioning "${fragment}", nothing was thrown`);
}

// A temp directory under its real path, so containment checks compare like with like.
async function withTemp(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'margin-selftest-')));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function isRepository(dir) {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function within(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CaseFailure(`${what}: nothing after ${WAIT_MS} ms`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// One request to the server on 127.0.0.1 with exactly the headers given; no connection reuse.
function request(port, { method = 'GET', target = '/api/session', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if ((res.headers['content-type'] ?? '').startsWith('application/json')) {
          // A throw in this listener would escape the promise and the case wrapper with it.
          try {
            json = JSON.parse(text);
          } catch (err) {
            reject(new CaseFailure(`${method} ${target}: a JSON reply that does not parse (${err.message})`));
            return;
          }
        }
        resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', json, text });
      });
      res.on('error', reject);
    });
    req.setTimeout(WAIT_MS, () => req.destroy(new CaseFailure(`${method} ${target}: no reply after ${WAIT_MS} ms`)));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// A server on port 0 over a temp root holding `a.txt`, with the session, save, send and end
// that `cli.mjs annotate` wires: `finished` settles with the result document the run would print.
function withServer(fn, { overview = null } = {}) {
  return withTemp(async (root) => {
    write(root, 'a.txt', 'a\n');
    const out = path.join(root, 'claudedocs', 'margin', 'notes.json');
    const files = listFiles(root, [], [out]);
    assertEqual(files, ['a.txt'], 'fixture listing');
    const session = createSession({ stored: null, out, root, scope: [], revision: null });
    const save = () => saveSession(session);
    const { url, close, ended, waiting, watching } = await startServer({
      port: 0,
      token: TOKEN,
      session,
      files,
      readSource: (p) => readSource(root, p),
      relist: () => listFiles(root, [], [out]),
      onSave: save,
      onSend: () => sendRound(session),
      onReply: (body) => postReplies(session, body),
      onEnd: (status) => finishRun(session, status),
      overview,
    });
    try {
      const parsed = new URL(url);
      const port = Number(parsed.port);
      assert(parsed.hostname === '127.0.0.1' && port > 0, `the server is not on a loopback port: ${url}`);
      assert(parsed.hash === `#${TOKEN}`, `the viewer URL does not carry the token: ${url}`);
      const host = `127.0.0.1:${port}`;
      return await fn({ port, host, root, out, url, session, save, ended, waiting, watching, finished: () => within(ended, 'the end of the run') });
    } finally {
      await close();
    }
  });
}

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' });
  let doc = null;
  try {
    doc = JSON.parse(res.stdout);
  } catch {
    doc = null;
  }
  return { status: res.status, signal: res.signal, stdout: res.stdout, stderr: res.stderr, doc };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOTSPOT_HEADER_LINE = 'path\tchurn\tlines\tindentation\tchurn_x_lines\tchurn_x_indentation\n';

function commitAll(root, message, daysAgo) {
  const date = `${Math.floor((Date.now() - daysAgo * DAY_MS) / 1000)} +0000`;
  execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=margin', '-c', 'user.email=margin@example.invalid', 'commit', '-q', '-m', message], {
    cwd: root,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
}

const FIXTURE_A_TS = [
  "import { b } from './b';",
  "import { c } from '@/c';",
  "import React from 'react';",
  "import { m } from './missing';",
  "import { x } from '../other/x';",
  '',
  'export function a() {',
  '  if (b) {',
  '    return c;',
  '  }',
  '  return m;',
  '}',
  '',
].join('\n');
const FIXTURE_B_TS = 'export const b = {\n  one: 1,\n};\n';

function measureFixture(root) {
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
  write(root, 'tsconfig.json', '{\n  // the alias the app uses\n  "compilerOptions": {\n    "paths": { "@/*": ["./src/lib/*"] },\n  },\n}\n');
  write(root, 'src/a.ts', 'old\n');
  write(root, 'src/b.ts', 'old\n');
  write(root, 'src/lib/c.ts', 'export const c = 1;\n');
  write(root, 'src/img.bin', Buffer.from('x\0y'));
  write(root, 'other/x.ts', 'export const x = 1;\n');
  commitAll(root, 'old', 240);
  write(root, 'src/a.ts', 'interim\n');
  write(root, 'src/b.ts', FIXTURE_B_TS);
  commitAll(root, 'interim', 2);
  write(root, 'src/a.ts', FIXTURE_A_TS);
  write(root, 'other/x.ts', 'export const x = 2;\n');
  commitAll(root, 'recent', 1);
}

function measuredFixture(root) {
  return {
    version: 1,
    root,
    scope: ['src'],
    prefix: '',
    files: [
      { path: 'src/a.ts', lines: 12, churn: 2, indentation: 5, imports: ['src/b.ts', 'src/lib/c.ts'], outside: ['react', './missing', '../other/x'] },
      { path: 'src/b.ts', lines: 3, churn: 1, indentation: 1, imports: [], outside: [] },
      { path: 'src/img.bin', lines: null, churn: 0, indentation: null, imports: [], outside: [] },
      { path: 'src/lib/c.ts', lines: 1, churn: 0, indentation: 0, imports: [], outside: [] },
    ],
  };
}

const MEASURED_FIXTURE_TSV = `${HOTSPOT_HEADER_LINE}src/a.ts\t2\t12\t5\t24\t10\nsrc/b.ts\t1\t3\t1\t3\t1\nsrc/lib/c.ts\t0\t1\t0\t0\t0\n`;

function handMeasurement() {
  return {
    version: 1,
    root: OVERVIEW_ROOT,
    scope: ['src'],
    prefix: 'apps/web/',
    files: [
      { path: 'src/a.ts', lines: 3, churn: 1, indentation: 0, imports: ['src/b.ts'], outside: ['react'] },
      { path: 'src/b.ts', lines: 1, churn: 0, indentation: 0, imports: [], outside: [] },
    ],
  };
}

function explorerBlock(name, { tier = 'speculative', files = 'src/a.ts', sites = [], est = '3' } = {}) {
  return [
    `name: ${name}`,
    `tier: ${tier}`,
    'category: in-process',
    `files: ${files}`,
    'next_change: x',
    ...sites.map((site) => `next_sites: ${site}`),
    `est_diff_lines: ${est}`,
    'deletion_test: x',
    'friction: y',
  ];
}

function explorerText(blocks) {
  return blocks.map((block) => block.join('\n')).join('\n\n');
}

function assertErrorDoc(res, exitCode, fragment, what) {
  assert(res.signal === null, `${what}: killed by ${res.signal} (still running after 10 s)`);
  assert(res.status === exitCode, `${what}: exit ${res.status}, stdout ${JSON.stringify(res.stdout)}`);
  assert(res.doc !== null && isDeepStrictEqual(Object.keys(res.doc), ['status', 'error']) && res.doc.status === 'error', `${what}: not an error document: ${JSON.stringify(res.stdout)}`);
  assert(typeof res.doc.error === 'string' && res.doc.error.includes(fragment), `${what}: error does not mention "${fragment}": ${res.doc.error}`);
  assert(res.stdout.endsWith('}\n') && !res.stdout.endsWith('\n\n'), `${what}: not one trailing newline`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves once `condition()` holds, checking every 10 ms, bounded by WAIT_MS.
function until(condition, what) {
  return within(
    new Promise((resolve) => {
      const check = () => (condition() ? resolve() : setTimeout(check, 10));
      check();
    }),
    what,
  );
}

// Whether `promise` has settled within `ms`, without waiting for it longer than that.
function isSettled(promise, ms = 100) {
  return Promise.race([promise.then(() => true, () => true), sleep(ms).then(() => false)]);
}

async function rejectsRun(promise, exitCode, fragment, what) {
  let err = null;
  try {
    await within(promise, what);
  } catch (caught) {
    err = caught;
  }
  assert(err !== null, `${what}: resolved instead of failing`);
  assert(err instanceof RunError, `${what}: expected a RunError, got ${err.constructor.name}: ${err.message}`);
  assert(err.exitCode === exitCode && err.message.includes(fragment), `${what}: expected exit ${exitCode} mentioning "${fragment}", got ${err.exitCode}: ${err.message}`);
}

// A `cli.mjs` child the self-test talks to while it runs, so it is started with async `spawn`:
// a `spawnSync` child would block this process, and with it the requests the child waits for.
function spawnCli(args) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout }));
  });
  return { child, stdout: () => stdout, stderr: () => stderr, exited: () => within(exit, `cli.mjs ${args[0]} to exit`) };
}

// The viewer URL a spawned `annotate` child prints on stderr once its port is bound.
function serverUrl(run) {
  const found = new Promise((resolve, reject) => {
    const check = () => {
      const match = /^margin: (\S+)$/m.exec(run.stderr());
      if (match) {
        resolve(match[1]);
      }
    };
    run.child.stderr.on('data', check);
    run.child.on('close', () => reject(new CaseFailure(`the server exited before printing its URL: ${run.stdout()}`)));
    check();
  });
  return within(found, 'the server URL on stderr').catch((err) => {
    throw new CaseFailure(`${err.message} (stderr: ${JSON.stringify(run.stderr().slice(0, 300))}, stdout: ${JSON.stringify(run.stdout().slice(0, 300))})`);
  });
}

// ---- the overview document (lib/overview.mjs) ------------------------------------------------

const OVERVIEW_ROOT = path.join(os.tmpdir(), 'margin-overview-root');

function overviewFixture(root) {
  return {
    version: 1,
    root,
    scope: ['src'],
    generatedAt: '2026-10-30T12:00:00Z',
    producer: 'hand-written',
    files: [
      { path: 'src/a.js', lines: 120, churn: 4, indentation: 3, kind: 'module', role: 'entry point', exports: ['main'], mixes: ['io', 'parsing'], imports: ['src/b.js'], outside: ['node:fs'], hotspot: { score: 9 } },
      { path: 'src/b.js', lines: null, churn: null, indentation: null, kind: null, role: null, exports: null, mixes: null, imports: [], outside: [] },
    ],
    candidates: [
      {
        name: 'split-parsing',
        tier: 'strong',
        category: 'in-process',
        files: ['src/a.js', 'src/b.js'],
        next_change: 'add a second input format',
        next_sites: [{ path: 'src/a.js', line: 12, what: 'the format switch', column: 4 }],
        est_diff_lines: 80,
        deletion_test: 'deleting b.js moves its parsing back into a.js',
        friction: 'a.js mixes io and parsing',
        structural_key: 'parse:a.js',
      },
    ],
    notices: ['one candidate found'],
  };
}

function expectedOverview(root) {
  return {
    version: 1,
    root,
    scope: ['src'],
    generatedAt: '2026-10-30T12:00:00Z',
    files: [
      { path: 'src/a.js', lines: 120, churn: 4, indentation: 3, kind: 'module', role: 'entry point', exports: ['main'], mixes: ['io', 'parsing'], imports: ['src/b.js'], outside: ['node:fs'] },
      { path: 'src/b.js', lines: null, churn: null, indentation: null, kind: null, role: null, exports: null, mixes: null, imports: [], outside: [] },
    ],
    candidates: [
      {
        name: 'split-parsing',
        tier: 'strong',
        category: 'in-process',
        files: ['src/a.js', 'src/b.js'],
        next_change: 'add a second input format',
        next_sites: [{ path: 'src/a.js', line: 12, what: 'the format switch' }],
        est_diff_lines: 80,
        deletion_test: 'deleting b.js moves its parsing back into a.js',
        friction: 'a.js mixes io and parsing',
      },
    ],
    notices: ['one candidate found'],
  };
}

// ---- the viewer's round controller (ui/rounds.js) --------------------------------------------

// Imported per case rather than at the top, so a broken module fails its cases by name. The
// import itself proves the module touches no DOM when it loads: Node has none.
const loadRounds = () => import('../../ui/rounds.js');

// An error the way the viewer's `api` throws one.
function apiError(status, message) {
  return Object.assign(new Error(message), { status });
}

const viewerSession = (annotations = [], extra = {}) => ({
  root: '/r',
  scope: [],
  out: '/r/notes.json',
  overall: '',
  round: 0,
  rounds: [],
  overallReplies: [],
  annotations,
  ...extra,
});

const viewerNote = (id, anchor = { kind: 'scope' }, extra = {}) => ({ id, anchor, intent: 'change', body: id, createdAt: 't', ...extra });

// A controller over a fake `api` and a fake view. `routes` maps "METHOD /path" to a function of
// the body and the URL that answers the reply or throws. `calls` records every request with a
// copy of its body, `events` every view callback, `sleeps` every pause the controller asked for
// (answered at once); `h.overall`, `h.composer`, `h.editing` and `h.answer` are what the view
// shows and the human answers.
async function roundsHarness(routes) {
  const { createRounds } = await loadRounds();
  const h = { overall: '', composer: null, editing: null, answer: true, calls: [], events: [], sleeps: [] };
  const api = async (method, url, body) => {
    h.calls.push([method, url, body === undefined ? undefined : structuredClone(body)]);
    const route = routes[`${method} ${url.split('?')[0]}`];
    if (!route) {
      throw apiError(404, `no route for ${method} ${url}`);
    }
    return route(body, url);
  };
  h.rounds = createRounds({
    api,
    saveDelay: 5,
    sleep: async (ms) => {
      h.sleeps.push(ms);
    },
    view: {
      overall: () => h.overall,
      composer: () => h.composer,
      editing: () => h.editing,
      closeComposer: () => {
        h.events.push('closeComposer');
        h.composer = null;
        h.editing = null;
      },
      confirm: (text) => {
        h.events.push(['confirm', text]);
        return h.answer;
      },
      saveState: (text) => h.events.push(['saveState', text]),
      notify: (text, { error = false } = {}) => h.events.push(['notify', text, error]),
      clearNotice: () => h.events.push('clearNotice'),
      dropped: (notes) => h.events.push(['dropped', notes.map((a) => a.id)]),
      renderStatus: () => h.events.push('renderStatus'),
      renderControls: () => h.events.push(['controls', h.rounds.busy, h.rounds.ended]),
      refreshed: async () => {
        h.events.push('refreshed');
      },
      showEnd: (status) => h.events.push(['showEnd', status]),
    },
  });
  h.requests = () => h.calls.map(([method, url]) => `${method} ${url}`);
  h.take = () => h.events.splice(0);
  return h;
}

// A fake server holding `session`: GET answers it with `files`, a write stores the body, and a
// submit stamps the unsent notes with the next round. `extra` replaces any route.
function roundsRoutes(session, files = ['src/a.js', 'src/b/c.js'], extra = {}) {
  const server = structuredClone(session);
  const store = (body) => {
    server.overall = body.overall;
    server.annotations = structuredClone(body.annotations);
  };
  return {
    'GET /api/session': () => ({ session: structuredClone(server), files, changes: 2 }),
    'PUT /api/session': (body) => {
      store(body);
      return { ok: true, updatedAt: '2026-01-01T00:00:00.000Z' };
    },
    'POST /api/submit': (body) => {
      store(body);
      server.round += 1;
      server.rounds.push({ round: server.round, sentAt: 't', overall: body.overall });
      for (const a of server.annotations) {
        a.round ??= server.round;
      }
      return { ok: true, round: server.round };
    },
    'POST /api/finish': () => ({ ok: true, status: 'finished' }),
    'POST /api/cancel': () => ({ ok: true, status: 'cancelled' }),
    ...extra,
  };
}

const bodyIds = (call) => call[2].annotations.map((a) => a.id);

const ALLOWED = new Set(['src/a.js', 'src/b/c.js']);

const CASES = [
  ['highlight: the vendored highlight.js loads and colours TSX across lines', async () => {
    // Imported here rather than at the top, so a missing or broken vendored file fails this
    // case by name instead of the whole run.
    const { highlightLines } = await import('../../ui/syntax.js');
    const lines = ['/* block', '   comment */', 'const s = `a ${x}', 'b`;', 'interface P { n: number }', 'const el = <Item key={1} />;'];
    const tokens = highlightLines(lines, 'a.tsx');
    assert(tokens.length === lines.length, `a.tsx: ${tokens.length} token lines for ${lines.length} lines`);
    tokens.forEach((line, i) => {
      assertEqual(line.map((t) => t.text).join(''), lines[i], `a.tsx line ${i + 1} text`);
    });
    const classOf = (i, text) => tokens[i].find((t) => t.text === text)?.className;
    const expect = (i, text, className) => {
      assert(classOf(i, text) === className, `a.tsx line ${i + 1} "${text}": expected ${className}, got ${classOf(i, text)}`);
    };
    expect(0, '/* block', 'hljs-comment');
    expect(1, '   comment */', 'hljs-comment');
    expect(2, 'const', 'hljs-keyword');
    expect(2, '`a ', 'hljs-string');
    expect(2, '${x}', 'hljs-string hljs-subst');
    expect(3, 'b`', 'hljs-string');
    expect(4, 'interface', 'hljs-keyword');
    expect(5, 'Item', 'language-xml hljs-tag hljs-name');
    assertEqual(highlightLines(['FROM node:22'], 'Dockerfile')[0][0], { className: 'hljs-keyword', text: 'FROM' }, 'Dockerfile FROM');
    assertEqual(
      highlightLines(['const a = 1; // x', ''], 'a.xyz'),
      [[{ className: null, text: 'const a = 1; // x' }], []],
      'an unknown extension renders plain',
    );
    await withServer(async ({ port, host }) => {
      for (const target of ['/syntax.js', '/vendor/highlight.min.js', '/vendor/dockerfile.min.js']) {
        const reply = await request(port, { target, headers: { host } });
        assert(reply.status === 200 && reply.type.startsWith('text/javascript'), `${target} got ${reply.status} ${reply.type}`);
      }
      const unlisted = await request(port, { target: '/vendor/LICENSE', headers: { host } });
      assert(unlisted.status === 404, `/vendor/LICENSE got ${unlisted.status}`);
    });
  }],
  ['viewer rounds: load, the anchor rule against the listing, the Send rule and the static route', async () => {
    const h = await roundsHarness(roundsRoutes(viewerSession()));
    const session = await h.rounds.load();
    assertEqual(session.round, 0, 'the loaded round');
    assertEqual(h.rounds.files, ['src/a.js', 'src/b/c.js'], 'the loaded listing');
    const listed = (anchor) => h.rounds.listed(anchor);
    assert(listed({ kind: 'scope' }), 'a scope anchor is not listed');
    for (const folder of ['src', 'src/b']) {
      assert(listed({ kind: 'folder', path: folder }), `the folder ${folder} is not listed`);
    }
    for (const folder of ['', '.', 'sr', 'src/a.js']) {
      assert(!listed({ kind: 'folder', path: folder }), `the folder "${folder}" is listed`);
    }
    assert(listed({ kind: 'file', path: 'src/a.js' }) && listed({ kind: 'range', path: 'src/b/c.js', start: 1, end: 1 }), 'a listed file is not listed');
    assert(!listed({ kind: 'file', path: 'src/x.js' }), 'an unlisted file is listed');
    assert(!h.rounds.canSend(), 'Send is allowed with nothing to send');
    h.overall = '  ';
    assert(!h.rounds.canSend(), 'Send is allowed for a blank overall text');
    h.overall = 'direction';
    assert(h.rounds.overallChanged() && h.rounds.canSend(), 'Send is refused for a new overall text');
    h.overall = '';
    h.rounds.addNote(viewerNote('n1'));
    h.rounds.updateNote('n1', { body: 'edited' });
    assertEqual(h.rounds.unsent().map((a) => a.body), ['edited'], 'an unsent note after an edit');
    assert(h.rounds.canSend(), 'Send is refused with an unsent note');
    h.rounds.deleteNote('n1');
    assertEqual(h.rounds.session.annotations, [], 'the notes after a delete');
    assertEqual(h.requests(), ['GET /api/session'], 'the requests');
    await withServer(async ({ port, host }) => {
      const reply = await request(port, { target: '/rounds.js', headers: { host } });
      assert(reply.status === 200 && reply.type.startsWith('text/javascript'), `/rounds.js got ${reply.status} ${reply.type}`);
    });
  }],
  ['viewer rounds: writes run one at a time, each carrying the session as it stands at its turn', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const h = await roundsHarness(
      roundsRoutes(viewerSession(), undefined, {
        'PUT /api/session': async () => {
          await gate;
          return { ok: true, updatedAt: '2026-01-01T00:00:00.000Z' };
        },
      }),
    );
    await h.rounds.load();
    h.rounds.addNote(viewerNote('n1'));
    h.overall = 'first';
    h.rounds.scheduleSave();
    assertEqual(h.take(), [['saveState', 'saving…']], 'the events of a scheduled save');
    await until(() => h.calls.length === 2, 'the debounced save');
    const sending = h.rounds.sendRound();
    h.overall = 'newest';
    await sleep(30);
    assertEqual(h.requests(), ['GET /api/session', 'PUT /api/session'], 'the requests while the save is held');
    release();
    await sending;
    assertEqual(h.requests(), ['GET /api/session', 'PUT /api/session', 'POST /api/submit', 'GET /api/session'], 'the requests after the Send');
    assertEqual(h.calls[1][2].overall, 'first', 'the overall text the save carried');
    assertEqual(h.calls[2][2], { overall: 'newest', annotations: [viewerNote('n1')] }, 'the body of the Send queued behind the save');
    const events = h.take();
    assertEqual(events[0], 'clearNotice', 'the first event of a Send');
    assertEqual(events[1], ['controls', true, false], 'the controls while sending');
    assert(events[2][0] === 'saveState' && events[2][1].startsWith('saved '), `the save's indicator: ${JSON.stringify(events[2])}`);
    assert(events[3][0] === 'saveState' && events[3][1].startsWith('round 1 sent '), `the Send's indicator: ${JSON.stringify(events[3])}`);
    assertEqual(events.slice(-2), ['refreshed', ['controls', false, false]], 'the last events of a Send');

    // A Send cancels a save still waiting for its delay: only the Send writes.
    const quiet = await roundsHarness(roundsRoutes(viewerSession()));
    await quiet.rounds.load();
    quiet.rounds.addNote(viewerNote('n2'));
    quiet.rounds.scheduleSave();
    await quiet.rounds.sendRound();
    await sleep(30);
    assertEqual(quiet.requests(), ['GET /api/session', 'POST /api/submit', 'GET /api/session'], 'the requests of a Send over a scheduled save');
  }],
  ['viewer rounds: a refresh takes the server copy in by ownership', async () => {
    let server = viewerSession();
    let files = ['src/a.js', 'src/b/c.js'];
    const h = await roundsHarness(
      roundsRoutes(viewerSession(), undefined, {
        'GET /api/session': () => ({ session: structuredClone(server), files, changes: 4 }),
      }),
    );
    await h.rounds.load();
    for (const note of [
      viewerNote('kept'),
      viewerNote('gone', { kind: 'file', path: 'src/b/c.js' }),
      viewerNote('stored', { kind: 'file', path: 'src/b/c.js' }),
      viewerNote('sentNow'),
    ]) {
      h.rounds.addNote(note);
    }
    h.overall = 'local overall';
    h.editing = 'sentNow';
    const reply = { body: 'answer', round: 1, createdAt: 't' };
    server = viewerSession([viewerNote('sentNow', { kind: 'scope' }, { body: 'as sent', round: 1, replies: [reply] }), viewerNote('stored', { kind: 'file', path: 'src/b/c.js' })], {
      overall: 'server overall',
      round: 1,
      rounds: [{ round: 1, sentAt: 't', overall: 'server overall' }],
      overallReplies: [reply],
    });
    files = ['src/a.js'];
    h.take();
    await h.rounds.refresh();
    const merged = h.rounds.session;
    assertEqual(merged.annotations.map((a) => a.id), ['sentNow', 'kept', 'stored'], 'the merged notes');
    assertEqual(merged.annotations[0], server.annotations[0], 'a sent note as the server holds it');
    assertEqual([merged.overall, merged.round, merged.overallReplies], ['local overall', 1, [reply]], 'the merged overall text, round and overall replies');
    assertEqual(h.rounds.files, ['src/a.js'], 'the refreshed listing');
    assertEqual(h.take(), ['closeComposer', ['saveState', 'saving…'], 'clearNotice', ['dropped', ['gone']], 'refreshed'], 'the events of a refresh');
    await until(() => h.calls.length === 3, 'the save that levels the server');
    assertEqual(bodyIds(h.calls[2]), ['sentNow', 'kept', 'stored'], 'the notes the levelling save carried');
    assertEqual(h.calls[2][2].overall, 'local overall', 'the overall text the levelling save carried');
    h.rounds.updateNote('sentNow', { body: 'forged' });
    h.rounds.deleteNote('sentNow');
    assertEqual(h.rounds.session.annotations[0].body, 'as sent', 'a sent note after an edit and a delete');

    // Copies that agree on what is unsent need no save.
    server = { ...server, overall: 'local overall', annotations: [server.annotations[0], viewerNote('kept'), server.annotations[1]] };
    h.take();
    await h.rounds.refresh();
    await sleep(30);
    assertEqual(h.take(), ['clearNotice', 'refreshed'], 'the events of a refresh that changes nothing');
    assertEqual(h.calls.length, 4, 'the requests after a refresh that changes nothing');
  }],
  ['viewer rounds: Send commits an open composer note, and each refusal', async () => {
    const h = await roundsHarness(roundsRoutes(viewerSession()));
    await h.rounds.load();
    h.composer = { dirty: () => false, commit: () => assert(false, 'a clean composer was committed') };
    await h.rounds.sendRound();
    assertEqual(h.requests(), ['GET /api/session'], 'the requests of a Send with nothing to send');
    h.composer = {
      dirty: () => true,
      commit: () => {
        h.rounds.addNote(viewerNote('c1'));
        h.composer = null;
      },
    };
    await h.rounds.sendRound();
    assertEqual(bodyIds(h.calls[1]), ['c1'], 'the notes a Send with only an open composer note carried');

    for (const [error, expected] of [
      [apiError(409, 'nothing to send'), ['notify', 'Nothing new to send.', false]],
      [apiError(500, 'boom'), ['notify', 'Send failed: boom', true]],
    ]) {
      const refused = await roundsHarness(roundsRoutes(viewerSession(), undefined, { 'POST /api/submit': () => { throw error; } }));
      await refused.rounds.load();
      refused.rounds.addNote(viewerNote('n1'));
      await refused.rounds.sendRound();
      assertEqual(refused.take(), ['clearNotice', ['controls', true, false], expected, ['controls', false, false]], `the events of a Send refused ${error.status}`);
    }

    const ending = await roundsHarness(roundsRoutes(viewerSession(), undefined, { 'POST /api/submit': () => { throw apiError(409, 'the run has ended'); } }));
    await ending.rounds.load();
    ending.rounds.addNote(viewerNote('n1'));
    await ending.rounds.sendRound();
    assertEqual(
      ending.take(),
      ['clearNotice', ['controls', true, false], ['controls', true, false], ['notify', 'The review has ended.', false], ['controls', true, false]],
      'the events of a Send refused because the run is ending',
    );
    assert(ending.rounds.busy, 'the controls came back while the run is ending');
    ending.rounds.scheduleSave();
    await sleep(30);
    assertEqual(ending.take(), [], 'the events of a save while the run is ending');
    assertEqual(ending.requests(), ['GET /api/session', 'POST /api/submit'], 'the requests while the run is ending');
    await ending.rounds.refresh();
    assertEqual(ending.take(), ['refreshed'], 'the events of a refresh while the run is ending');

    const saveEnding = await roundsHarness(roundsRoutes(viewerSession(), undefined, { 'PUT /api/session': () => { throw apiError(409, 'the run has ended'); } }));
    await saveEnding.rounds.load();
    await saveEnding.rounds.save();
    assertEqual(saveEnding.take(), [['controls', true, false], ['notify', 'The review has ended.', false]], 'the events of a save refused because the run is ending');
    const saveFails = await roundsHarness(roundsRoutes(viewerSession(), undefined, { 'PUT /api/session': () => { throw apiError(500, 'disk full'); } }));
    await saveFails.rounds.load();
    await saveFails.rounds.save();
    assertEqual(saveFails.take(), [['saveState', 'save failed: disk full']], 'the events of a failed save');
  }],
  ['viewer rounds: Finish and Cancel ask first, end the run once, and report a failure', async () => {
    const sent = viewerSession([viewerNote('s1', { kind: 'scope' }, { round: 1 })], { round: 1, rounds: [{ round: 1, sentAt: 't', overall: 'sent text' }] });
    const h = await roundsHarness(roundsRoutes(sent));
    await h.rounds.load();
    h.overall = 'sent text';
    h.answer = false;
    await h.rounds.finishRun();
    assertEqual(h.take(), [['confirm', 'Finish the review?']], 'the Finish dialog with nothing unsent');
    h.rounds.addNote(viewerNote('u1'));
    h.overall = 'edited';
    await h.rounds.finishRun();
    assertEqual(
      h.take(),
      [['confirm', 'Finish the review? Kept in the notes file but not sent to the agent: 1 unsent note and the overall direction edit.']],
      'the Finish dialog with unsent work',
    );
    assertEqual(h.requests(), ['GET /api/session'], 'the requests of a dismissed Finish');
    h.answer = true;
    await h.rounds.finishRun();
    assertEqual(h.calls[1].slice(0, 2), ['POST', '/api/finish'], 'the Finish request');
    assertEqual([h.calls[1][2].overall, bodyIds(h.calls[1])], ['edited', ['s1', 'u1']], 'the Finish body');
    assertEqual(h.take().slice(1), ['clearNotice', ['controls', true, false], ['showEnd', 'finished']], 'the events of a Finish');
    assert(h.rounds.ended, 'the run is not ended after a Finish');
    h.rounds.scheduleSave();
    await sleep(30);
    assertEqual([h.take(), h.calls.length], [[], 2], 'the events and requests of a save after the end');

    const cancel = await roundsHarness(roundsRoutes(viewerSession()));
    await cancel.rounds.load();
    cancel.composer = { dirty: () => true, commit: () => assert(false, 'Cancel committed the open composer') };
    await cancel.rounds.cancelRun();
    assertEqual(
      cancel.take(),
      [
        ['confirm', 'Cancel the review? The unsent notes are discarded: the agent never receives them, and the review ends. The note you are writing is discarded too.'],
        'closeComposer',
        'clearNotice',
        ['controls', true, false],
        ['showEnd', 'cancelled'],
      ],
      'the events of a Cancel over an open composer note',
    );

    const failing = await roundsHarness(roundsRoutes(viewerSession(), undefined, { 'POST /api/finish': () => { throw apiError(500, 'could not save'); } }));
    await failing.rounds.load();
    await failing.rounds.finishRun();
    assertEqual(failing.take().slice(1), ['clearNotice', ['controls', true, false], ['notify', 'Finish failed: could not save', true], ['controls', false, false]], 'the events of a failed Finish');
    assert(!failing.rounds.ended, 'a failed Finish ended the run');
    const ended = await roundsHarness(roundsRoutes(viewerSession(), undefined, { 'POST /api/cancel': () => { throw apiError(409, 'the run has ended'); } }));
    await ended.rounds.load();
    await ended.rounds.cancelRun();
    assertEqual(
      ended.take().slice(1),
      ['closeComposer', 'clearNotice', ['controls', true, false], ['controls', true, false], ['notify', 'The review has ended.', false]],
      'the events of a Cancel refused because the run is ending',
    );
    assert(!ended.rounds.ended, 'a refused Cancel raised the end overlay');

    // A change wait held across the Finish answers with the end too; the overlay comes up once.
    let answerWait;
    const held = new Promise((resolve) => {
      answerWait = resolve;
    });
    const both = await roundsHarness(roundsRoutes(viewerSession(), undefined, { 'GET /api/changes': () => held }));
    await both.rounds.load();
    const watching = both.rounds.watchChanges();
    await both.rounds.finishRun();
    answerWait({ status: 'finished', changes: 2 });
    await within(watching, 'the change wait after a Finish');
    assertEqual(both.events.filter((e) => e[0] === 'showEnd'), [['showEnd', 'finished']], 'the end overlays raised');
  }],
  ['viewer rounds: the change wait refreshes, backs off, reconnects and ends', async () => {
    const changes = [
      { status: 'changed', changes: 3 },
      'lost',
      { status: 'changed', changes: 4 },
      { status: 'changed', changes: 5 },
      { status: 'changed', changes: 6 },
      'lost',
      { status: 'finished', changes: 6 },
    ];
    let sessionCalls = 0;
    const h = await roundsHarness(
      roundsRoutes(viewerSession(), undefined, {
        'GET /api/session': () => {
          sessionCalls += 1;
          if (sessionCalls === 4) {
            throw apiError(500, 'down');
          }
          if (sessionCalls === 5) {
            throw apiError(0, 'unreachable');
          }
          return { session: viewerSession(), files: ['src/a.js'], changes: sessionCalls === 1 ? 2 : 5 };
        },
        'GET /api/changes': () => {
          const next = changes.shift();
          if (next === 'lost') {
            throw apiError(0, 'unreachable');
          }
          return next;
        },
      }),
    );
    await h.rounds.load();
    await within(h.rounds.watchChanges(), 'the change wait');
    assertEqual(
      h.requests(),
      [
        'GET /api/session',
        'GET /api/changes?after=2',
        'GET /api/session',
        'GET /api/changes?after=5',
        'GET /api/session',
        'GET /api/changes?after=5',
        'GET /api/session',
        'GET /api/changes?after=5',
        'GET /api/session',
        'GET /api/session',
        'GET /api/changes?after=5',
        'GET /api/session',
        'GET /api/changes?after=5',
        'GET /api/session',
        'GET /api/changes?after=5',
      ],
      'the requests of the change wait',
    );
    const [first, ...rest] = h.sleeps;
    assert(first > 900 && first <= 1000 && rest[3] > 900 && rest[3] <= 1000, `the pauses after a change: ${JSON.stringify(h.sleeps)}`);
    assertEqual([rest[0], rest[1], rest[2], rest[4]], [1000, 2000, 4000, 1000], 'the backoff after each failure');
    const events = h.events.filter((e) => e !== 'refreshed' && e !== 'clearNotice');
    assertEqual(
      events,
      [
        'renderStatus',
        'renderStatus',
        ['notify', 'The page could not refresh: down — retrying', true],
        'renderStatus',
        'renderStatus',
        'renderStatus',
        'renderStatus',
        ['showEnd', 'finished'],
      ],
      'the status events of the change wait',
    );
    assert(h.rounds.ended && h.rounds.connection === '', `the state after the end: ended ${h.rounds.ended}, connection "${h.rounds.connection}"`);
  }],
  ['annotations: anchor rule per kind', () => {
    const keep = (anchor) => cleanAnnotation({ anchor, body: 'b' }, ALLOWED) !== null;
    assert(keep({ kind: 'scope' }), 'a scope note with no path was dropped');
    assert(keep({ kind: 'folder', path: 'src/b' }), 'a folder note over a listed file was dropped');
    for (const folder of ['src/none', '.', '', 'src/b/', 'src/a.js']) {
      assert(!keep({ kind: 'folder', path: folder }), `a folder note on "${folder}" was kept`);
    }
    assert(!keep({ kind: 'folder' }), 'a folder note with no path was kept');
    for (const kind of ['file', 'range']) {
      assert(keep({ kind, path: 'src/a.js', start: 1, end: 1 }), `a ${kind} note on a listed file was dropped`);
      assert(!keep({ kind, path: 'src/x.js', start: 1, end: 1 }), `a ${kind} note on an unlisted file was kept`);
      assert(!keep({ kind, start: 1, end: 1 }), `a ${kind} note with no path was kept`);
    }
    assert(!keep({ kind: 'line', path: 'src/a.js' }), 'an unknown kind was kept');
    assert(cleanAnnotation({ anchor: { kind: 'scope' }, body: 42 }, ALLOWED) === null, 'a non-string body was kept');
    assert(cleanAnnotation(null, ALLOWED) === null, 'a null note was kept');

    const filled = cleanAnnotation({ anchor: { kind: 'scope' }, body: 'b', intent: 'x' }, ALLOWED);
    assert(typeof filled.id === 'string' && filled.id !== '', 'a missing id was not filled');
    assert(typeof filled.createdAt === 'string' && filled.createdAt !== '', 'a missing createdAt was not filled');
    assert(filled.intent === 'change', `an unknown intent became ${filled.intent}`);
    assertEqual(filled.anchor, { kind: 'scope' }, 'scope anchor');

    const stripped = cleanAnnotation(
      { id: 'n1', anchor: { kind: 'file', path: 'src/a.js', extra: 1 }, body: 'b', intent: 'question', createdAt: 't', junk: true },
      ALLOWED,
    );
    assertEqual(stripped, { id: 'n1', anchor: { kind: 'file', path: 'src/a.js' }, intent: 'question', body: 'b', createdAt: 't' }, 'cleaned note');
    assertEqual(Object.keys(stripped), ['id', 'anchor', 'intent', 'body', 'createdAt'], 'cleaned note keys');
  }],
  ['annotations: range validity and excerpt cap', () => {
    const range = (fields) => cleanAnnotation({ anchor: { kind: 'range', path: 'src/a.js', ...fields }, body: 'b' }, ALLOWED);
    assertEqual(range({ start: '3', end: '5' })?.anchor, { kind: 'range', path: 'src/a.js', start: 3, end: 5, excerpt: '' }, 'string bounds');
    for (const [start, end] of [[0, 1], [5, 3], [1.5, 2], ['x', 2], [1, undefined]]) {
      assert(range({ start, end }) === null, `range ${start}-${end} was kept`);
    }
    const long = range({ start: 1, end: 1, excerpt: 'e'.repeat(4001) });
    assert(long.anchor.excerpt === 'e'.repeat(4000), `a 4001-character excerpt became ${long.anchor.excerpt.length} characters`);
    assert(range({ start: 1, end: 1, excerpt: 'e'.repeat(4000) }).anchor.excerpt.length === 4000, 'a 4000-character excerpt was cut');
    assert(range({ start: 1, end: 1, excerpt: 7 }).anchor.excerpt === '', 'a non-string excerpt was kept');
  }],
  ['resume: a stored note keeps its anchor through a full-array write', () => {
    const stored = {
      annotations: [{ id: 's1', anchor: { kind: 'file', path: 'old/gone.js' }, intent: 'change', body: 'first', createdAt: '2026-01-01T00:00:00Z' }],
    };
    const session = restoreSession(stored, '/notes.json');
    assertEqual(session.annotations[0]?.anchor, { kind: 'file', path: 'old/gone.js' }, 'resumed anchor outside the listing');
    applyEdits(
      session,
      { annotations: [{ id: 's1', anchor: { kind: 'file', path: 'src/a.js' }, intent: 'question', body: 'second', createdAt: 'other' }] },
      ALLOWED,
    );
    assertEqual(
      session.annotations,
      [{ id: 's1', anchor: { kind: 'file', path: 'old/gone.js' }, intent: 'question', body: 'second', createdAt: '2026-01-01T00:00:00Z' }],
      'note after the write',
    );
  }],
  ['resume: a new out-of-scope note is dropped, a removed id is deleted', () => {
    const session = restoreSession(
      {
        overall: 'before',
        annotations: [
          { id: 's1', anchor: { kind: 'scope' }, body: 'one' },
          { id: 's2', anchor: { kind: 'file', path: 'src/a.js' }, body: 'two' },
        ],
      },
      '/notes.json',
    );
    applyEdits(
      session,
      {
        overall: 'after',
        annotations: [
          { id: 's1', body: 'one, revised' },
          { id: 'n1', anchor: { kind: 'file', path: 'outside.js' }, body: 'dropped' },
          { id: 'n2', anchor: { kind: 'folder', path: 'src/b' }, body: 'kept' },
        ],
      },
      ALLOWED,
    );
    assertEqual(session.annotations.map((a) => a.id), ['s1', 'n2'], 'ids after the write');
    assert(session.annotations[0].body === 'one, revised', 'the stored note was not revised');
    assert(session.overall === 'after', 'the overall comment was not written');
  }],
  ['resume: refusals in-process', () => withTemp((dir) => {
    for (const [content, fragment] of [
      ['{', 'is not valid JSON'],
      ['{"a":1}', 'no annotations array'],
      ['[]', 'no annotations array'],
      ['null', 'no annotations array'],
      ['{"annotations": 1}', 'no annotations array'],
    ]) {
      const out = write(dir, 'notes.json', content);
      throwsRun(() => readStored(out), 1, fragment);
    }
    const out = write(dir, 'notes.json', '{"annotations": []}');
    assertEqual(readStored(out), { annotations: [] }, 'an empty notes file');
    throwsRun(
      () => restoreSession({ annotations: [{ anchor: { kind: 'scope' }, body: 'ok' }, { anchor: { kind: 'bogus' }, body: 'x' }] }, out),
      1,
      '1 of 2 notes are malformed (indices 1)',
    );
    const absent = path.join(dir, 'absent.json');
    assert(readStored(absent) === null, 'an absent notes file did not start fresh');
    assert(!fs.existsSync(absent), 'reading an absent notes file created it');
  })],
  ['scope: paths outside the root are refused', () => withTemp((root) => {
    for (const raw of ['../x', '..', 'sub/../..', path.dirname(root), `${root}-sibling`, path.parse(root).root]) {
      throwsRun(() => scopePath(root, raw), 2, 'is outside');
    }
    for (const raw of ['.', '', root, `${root}/`]) {
      assert(scopePath(root, raw) === '.', `scope "${raw}" did not resolve to the root`);
    }
    assert(scopePath(root, path.join(root, 'sub', 'x')) === path.join('sub', 'x'), 'an absolute path inside the root was not made relative');
    assert(scopePath(root, 'sub/./x') === path.join('sub', 'x'), 'a relative path was not normalised');
  })],
  ['listing: walk skips symlinks', () => withTemp((root) => {
    write(root, 'a.txt', 'a\n');
    write(root, 'sub/b.txt', 'b\n');
    fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'link.txt'));
    fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'linkdir'));
    assert(!isRepository(root), `${root} is inside a git repository, so the walk is not what runs`);
    assertEqual(listFiles(root, []), ['a.txt', 'sub/b.txt'], 'walk listing');
    assertEqual(listFiles(root, ['sub']), ['sub/b.txt'], 'walk listing under a scope');
  })],
  ['listing: git branch skips symlinks', () => withTemp((root) => {
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    write(root, 'a.txt', 'a\n');
    write(root, 'sub/b.txt', 'b\n');
    fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'link.txt'));
    fs.symlinkSync(path.join(root, 'sub'), path.join(root, 'linkdir'));
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
    assert(fs.realpathSync(top) === root, `git sees ${top} as the repository, not ${root}`);
    const others = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n');
    assert(others.includes('link.txt'), 'git does not list the symlink, so the filter is not what drops it');
    assertEqual(listFiles(root, []), ['a.txt', 'sub/b.txt'], 'git listing');
    const notes = write(root, 'claudedocs/margin/notes.json', '{}\n');
    assertEqual(listFiles(root, [], [notes]), ['a.txt', 'sub/b.txt'], 'git listing leaves out the notes file');
  })],
  ['reading: refusals and limits', () => withTemp((root) => withTemp((outside) => {
    write(outside, 'secret.txt', 'secret\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    const refused = { binary: true, reason: 'not a regular file inside the root' };
    assertEqual(readSource(root, 'link.txt'), { path: 'link.txt', ...refused }, 'a symlink out of the root');
    const escape = path.join('..', path.basename(outside), 'secret.txt');
    assertEqual(readSource(root, escape), { path: escape, ...refused }, 'a relative path out of the root');

    write(root, 'big.txt', Buffer.alloc(MAX_BYTES + 1, 'a'));
    const big = readSource(root, 'big.txt');
    assert(big.binary === true && big.reason.includes('above the 2 MB viewer limit'), `an oversize file read as ${JSON.stringify(big).slice(0, 120)}`);
    write(root, 'edge.txt', Buffer.alloc(MAX_BYTES, 'a'));
    assert(readSource(root, 'edge.txt').text?.length === MAX_BYTES, 'a file of exactly the limit was refused');

    const nulAt = (index) => {
      const buffer = Buffer.alloc(9000, 'a');
      buffer[index] = 0;
      return buffer;
    };
    write(root, 'bin.dat', nulAt(10));
    assertEqual(readSource(root, 'bin.dat'), { path: 'bin.dat', binary: true, reason: 'binary file' }, 'a NUL at byte 10');
    write(root, 'late.dat', nulAt(8000));
    assert(typeof readSource(root, 'late.dat').text === 'string', 'a NUL past the first 8000 bytes was read as binary');
    write(root, 'u.txt', 'héllo\n');
    assertEqual(readSource(root, 'u.txt'), { path: 'u.txt', text: 'héllo\n' }, 'a UTF-8 file');
  }))],
  ['overview: the shape check accepts a document and drops unknown fields', () => {
    assertEqual(checkOverview(overviewFixture(OVERVIEW_ROOT)), expectedOverview(OVERVIEW_ROOT), 'the checked document');
    const empty = { version: 1, root: OVERVIEW_ROOT, scope: ['.'], generatedAt: '2026-10-30T12:00:00.123Z', files: [], candidates: [], notices: [] };
    assertEqual(checkOverview(structuredClone(empty)), empty, 'a document with no files, candidates or notices');
    const mixed = overviewFixture(OVERVIEW_ROOT);
    Object.assign(mixed.files[0], { churn: null, role: null, mixes: null });
    assertEqual(checkOverview(mixed).files[0], { ...expectedOverview(OVERVIEW_ROOT).files[0], churn: null, role: null, mixes: null }, 'a file with some fields null and the rest set');
    const doc = overviewFixture(OVERVIEW_ROOT);
    doc.candidates[0].next_sites = [];
    assertEqual(checkOverview(doc).candidates[0].next_sites, [], 'a candidate with no next sites');
    const planted = JSON.parse(`{"__proto__": {"polluted": true}, ${JSON.stringify(overviewFixture(OVERVIEW_ROOT)).slice(1)}`);
    const checked = checkOverview(planted);
    assert(Object.getPrototypeOf(checked) === Object.prototype && checked.polluted === undefined, 'a __proto__ key reached the checked document');
  }],
  ['overview: the shape check refuses each violation', () => {
    const cases = [
      [() => null, 'overview: the document is not an object'],
      [(d) => [d], 'the document is not an object'],
      [(d) => { delete d.generatedAt; }, 'missing key generatedAt'],
      [(d) => { d.generatedAt = 'yesterday'; }, 'generatedAt is not an ISO 8601 UTC timestamp'],
      [(d) => { d.generatedAt = '3'; }, 'generatedAt is not an ISO 8601 UTC timestamp'],
      [(d) => { d.generatedAt = '2026-10-30'; }, 'generatedAt is not an ISO 8601 UTC timestamp'],
      [(d) => { d.generatedAt = '2026-10-30T12:00:00+02:00'; }, 'generatedAt is not an ISO 8601 UTC timestamp'],
      [(d) => { d.generatedAt = '2026-13-30T12:00:00Z'; }, 'generatedAt is not an ISO 8601 UTC timestamp'],
      [(d) => { d.version = 2; }, 'version is not the number 1'],
      [(d) => { d.root = 'work/repo'; }, 'root is not an absolute path'],
      [(d) => { d.scope = ['../elsewhere']; }, 'scope[0] is not . or a root-relative path'],
      [(d) => { d.files[1].path = 'src/../b.js'; }, 'files[1].path is not a root-relative path'],
      [(d) => { d.files[0].path = '/src/a.js'; }, 'files[0].path is not a root-relative path'],
      [(d) => { d.files[0].path = 'src\\a.js'; }, 'files[0].path is not a root-relative path'],
      [(d) => { d.files[1].path = 'src/a.js'; }, 'files[1].path duplicates files[0].path'],
      [(d) => { d.files[0].imports = ['src/c.js']; }, 'files[0].imports[0] is not an overview file'],
      [(d) => { d.files[0].imports = ['src/b.js', 'src/b.js']; }, 'files[0].imports[1] duplicates files[0].imports[0]'],
      [(d) => { d.files[0].lines = -1; }, 'files[0].lines is not a non-negative integer or null'],
      [(d) => { delete d.files[1].role; }, 'missing key files[1].role'],
      [(d) => { d.files[0].outside = null; }, 'files[0].outside is not an array of non-empty strings'],
      [(d) => { d.candidates.push(structuredClone(d.candidates[0])); }, 'candidates[1].name duplicates candidates[0].name'],
      [(d) => { d.candidates[0].name = 'Split Parsing'; }, 'candidates[0].name is not a name of lowercase letters, digits and hyphens'],
      [(d) => { d.candidates[0].tier = 'maybe'; }, 'candidates[0].tier is not one of strong, worth-exploring, speculative'],
      [(d) => { d.candidates[0].category = 'external'; }, 'candidates[0].category is not one of in-process, local-substitutable, remote-owned, true-external'],
      [(d) => { d.candidates[0].files = []; }, 'candidates[0].files is not a non-empty array'],
      [(d) => { d.candidates[0].files = ['src/c.js']; }, 'candidates[0].files[0] is not an overview file'],
      [(d) => { d.candidates[0].files = ['src/a.js', 'src/b.js', 'src/a.js']; }, 'candidates[0].files[2] duplicates candidates[0].files[0]'],
      [(d) => { d.candidates[0].files = ['src/b.js']; }, "candidates[0].next_sites[0].path is not one of the candidate's files"],
      [(d) => { d.candidates[0].next_sites[0].line = 0; }, 'candidates[0].next_sites[0].line is not an integer of at least 1'],
      [(d) => { d.candidates[0].next_sites[0].line = '3'; }, 'candidates[0].next_sites[0].line is not an integer of at least 1'],
      [(d) => { d.candidates[0].est_diff_lines = 1.5; }, 'candidates[0].est_diff_lines is not a non-negative integer'],
      [(d) => { d.candidates[0].friction = ''; }, 'candidates[0].friction is not a non-empty string'],
      [(d) => { d.notices = [3]; }, 'notices is not an array of non-empty strings'],
    ];
    for (const [mutate, fragment] of cases) {
      const doc = overviewFixture(OVERVIEW_ROOT);
      const replaced = mutate(doc);
      throwsRun(() => checkOverview(replaced === undefined ? doc : replaced), 1, fragment);
    }
    throwsRun(() => checkOverview(null, 'overview /x.json'), 1, 'overview /x.json: the document is not an object');
  }],
  ['overview: reading refusals and the size limit', () => withTemp((dir) => {
    assert(MAX_OVERVIEW_BYTES === 2097152, `the overview limit is ${MAX_OVERVIEW_BYTES} bytes`);
    const missing = path.join(dir, 'missing.json');
    throwsRun(() => readOverview(missing), 1, `overview ${missing}: not found`);
    throwsRun(() => readOverview(path.join(dir, 'missing', 'x.json')), 1, 'not found');
    fs.mkdirSync(path.join(dir, 'folder'));
    throwsRun(() => readOverview(path.join(dir, 'folder')), 1, 'folder: not a regular file');
    const big = write(dir, 'big.json', Buffer.alloc(MAX_OVERVIEW_BYTES + 1, ' '));
    throwsRun(() => readOverview(big), 1, 'big.json: 2.0 MB is above the 2 MB overview limit');
    const edge = write(dir, 'edge.json', Buffer.alloc(MAX_OVERVIEW_BYTES, 'a'));
    throwsRun(() => readOverview(edge), 1, 'edge.json: not valid JSON');
    const broken = write(dir, 'broken.json', '{');
    throwsRun(() => readOverview(broken), 1, `overview ${broken}: not valid JSON`);
    const shape = write(dir, 'shape.json', '[]');
    throwsRun(() => readOverview(shape), 1, `overview ${shape}: the document is not an object`);
    const good = write(dir, 'good.json', JSON.stringify(overviewFixture(OVERVIEW_ROOT)));
    assertEqual(readOverview(good), expectedOverview(OVERVIEW_ROOT), 'a valid overview file');
  })],
  ['overview: the route serves the document behind the token, 404 without one', async () => {
    await withServer(async ({ port, host }) => {
      const noToken = await request(port, { target: '/api/overview', headers: { host } });
      assert(noToken.status === 403, `the overview without the token got ${noToken.status}`);
      const served = await request(port, { target: '/api/overview', headers: { host, 'x-margin-token': TOKEN } });
      assert(served.status === 200, `the overview with the token got ${served.status}`);
      assertEqual(served.json, expectedOverview(OVERVIEW_ROOT), 'the served overview');
      const session = await request(port, { headers: { host, 'x-margin-token': TOKEN } });
      assertEqual(Object.keys(session.json), ['session', 'files', 'changes'], 'session route keys on an overview run');
    }, { overview: checkOverview(overviewFixture(OVERVIEW_ROOT)) });
    await withServer(async ({ port, host }) => {
      const noToken = await request(port, { target: '/api/overview', headers: { host } });
      assert(noToken.status === 403, `the overview route without the token and without an overview got ${noToken.status}`);
      const none = await request(port, { target: '/api/overview', headers: { host, 'x-margin-token': TOKEN } });
      assert(none.status === 404, `the overview route without an overview got ${none.status}`);
      assertEqual(none.json, { error: 'no overview' }, 'the reply without an overview');
    });
  }],
  ["listing: the run's overview file is never listed", () => withTemp((root) => withTemp((outside) => {
    write(root, 'a.txt', 'a\n');
    const notes = write(root, 'claudedocs/margin/notes.json', '{}\n');
    const overview = write(root, 'claudedocs/margin/notes.overview.json', '{}\n');
    const away = write(outside, 'overview.json', '{}\n');
    assert(!isRepository(root), `${root} is inside a git repository, so the walk is not what runs`);
    assertEqual(listFiles(root, []), ['a.txt', 'claudedocs/margin/notes.json', 'claudedocs/margin/notes.overview.json'], 'walk listing with nothing left out');
    assertEqual(listFiles(root, [], [notes, overview]), ['a.txt'], 'walk listing leaves out the notes and overview files');
    assertEqual(listFiles(root, ['claudedocs'], [notes, overview]), [], 'walk listing of a scope holding only the run files');
    assertEqual(listFiles(root, [], [notes, away]), ['a.txt', 'claudedocs/margin/notes.overview.json'], 'walk listing with an overview outside the root');
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    assertEqual(listFiles(root, [], [notes, overview]), ['a.txt'], 'git listing leaves out the notes and overview files');
  }))],
  ['guards: host, origin and token', () => withServer(async ({ port, host, ended }) => {
    const token = { 'x-margin-token': TOKEN };
    const foreignHost = await request(port, { headers: { host: `localhost:${port}`, ...token } });
    assert(foreignHost.status === 421, `a foreign Host got ${foreignHost.status}`);
    assertEqual(foreignHost.json, { error: 'wrong host' }, 'foreign Host reply');
    const staticForeignHost = await request(port, { target: '/', headers: { host: `localhost:${port}` } });
    assert(staticForeignHost.status === 421, `the viewer page under a foreign Host got ${staticForeignHost.status}`);
    const foreignOrigin = await request(port, { headers: { host, origin: 'http://evil.example', ...token } });
    assert(foreignOrigin.status === 403, `a foreign Origin got ${foreignOrigin.status}`);
    const noToken = await request(port, { headers: { host } });
    assert(noToken.status === 403, `a request without the token got ${noToken.status}`);
    const wrongToken = await request(port, { headers: { host, 'x-margin-token': 'f'.repeat(32) } });
    assert(wrongToken.status === 403, `a request with a wrong token got ${wrongToken.status}`);
    const writeNoToken = await request(port, { method: 'PUT', headers: { host }, body: { overall: 'planted', annotations: [] } });
    assert(writeNoToken.status === 403, `a write without the token got ${writeNoToken.status}`);
    const finishNoToken = await request(port, { method: 'POST', target: '/api/finish', headers: { host } });
    assert(finishNoToken.status === 403, `a finish without the token got ${finishNoToken.status}`);
    const waitNoToken = await request(port, { target: '/api/wait', headers: { host } });
    assert(waitNoToken.status === 403, `a wait without the token got ${waitNoToken.status}`);
    const replyNoToken = await request(port, { method: 'POST', target: '/api/reply', headers: { host }, body: { round: 1, overall: 'planted' } });
    assert(replyNoToken.status === 403, `a reply without the token got ${replyNoToken.status}`);
    const changesNoToken = await request(port, { target: '/api/changes?after=0', headers: { host } });
    assert(changesNoToken.status === 403, `a change wait without the token got ${changesNoToken.status}`);
    assert(!(await isSettled(ended)), 'a finish without the token ended the run');

    const ok = await request(port, { headers: { host, ...token } });
    assert(ok.status === 200, `a request with the token got ${ok.status}`);
    assertEqual(ok.json.files, ['a.txt'], 'listed files');
    assert(ok.json.changes === 0, `a fresh run reports ${ok.json.changes} changes`);
    assert(ok.json.session.overall === '', 'a write without the token reached the session');
    assertEqual(ok.json.session.overallReplies, [], 'overall replies after a reply without the token');
    const sameOrigin = await request(port, { headers: { host, origin: `http://${host}`, ...token } });
    assert(sameOrigin.status === 200, `a same-origin request got ${sameOrigin.status}`);
    const file = await request(port, { target: '/api/file?path=a.txt', headers: { host, ...token } });
    assertEqual(file.json, { path: 'a.txt', text: 'a\n' }, 'a listed file');
    const unlisted = await request(port, { target: '/api/file?path=..%2Fa.txt', headers: { host, ...token } });
    assert(unlisted.status === 404, `an unlisted path got ${unlisted.status}`);
    const page = await request(port, { target: '/', headers: { host } });
    assert(page.status === 200 && page.text.includes('<html'), `the viewer page without a token got ${page.status}`);
  })],
  ['cancel: no notes and a blank overall comment deletes the notes file', async () => {
    await withServer(async ({ port, host, root, out, save, finished }) => {
      save();
      assert(JSON.parse(fs.readFileSync(out, 'utf8')).status === 'draft', 'the first save is not a draft');
      const reply = await request(port, { method: 'POST', target: '/api/cancel', headers: { host, 'x-margin-token': TOKEN }, body: { overall: '  ', annotations: [] } });
      assert(reply.status === 200, `cancel got ${reply.status}`);
      assertEqual(reply.json, { ok: true, status: 'cancelled' }, 'cancel reply');
      const doc = await finished();
      assertEqual(doc, { status: 'cancelled', out: null, annotations: 0, rounds: 0, root, scope: [] }, 'result document');
      assertEqual(Object.keys(doc), ['status', 'out', 'annotations', 'rounds', 'root', 'scope'], 'result document keys');
      assert(!fs.existsSync(out), 'an empty cancel left the notes file behind');
    });
    await withServer(async ({ port, host, root, out, save, finished }) => {
      save();
      const note = { id: 'n1', anchor: { kind: 'scope' }, body: 'keep me' };
      const reply = await request(port, { method: 'POST', target: '/api/cancel', headers: { host, 'x-margin-token': TOKEN }, body: { overall: '', annotations: [note] } });
      assert(reply.status === 200, `cancel with a note got ${reply.status}`);
      assertEqual(await finished(), { status: 'cancelled', out, annotations: 1, rounds: 0, root, scope: [] }, 'result document with a note');
      const kept = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert(kept.status === 'cancelled' && kept.annotations.length === 1, `a cancel with a note saved ${JSON.stringify(kept).slice(0, 200)}`);
    });
    await withServer(async ({ port, host, root, out, finished }) => {
      const headers = { host, 'x-margin-token': TOKEN };
      const sent = await request(port, { method: 'POST', target: '/api/submit', headers, body: { overall: 'x', annotations: [] } });
      assertEqual(sent.json, { ok: true, round: 1 }, 'a round with only an overall comment');
      const reply = await request(port, { method: 'POST', target: '/api/cancel', headers, body: { overall: ' ', annotations: [] } });
      assert(reply.status === 200, `cancel after a round got ${reply.status}`);
      assertEqual(await finished(), { status: 'cancelled', out, annotations: 0, rounds: 1, root, scope: [] }, 'result document after a round');
      const kept = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert(kept.status === 'cancelled' && kept.round === 1, `a cancel after a round saved ${JSON.stringify(kept).slice(0, 200)}`);
    });
  }],
  ['save: an atomic save replaces the file and leaves no temporary file', () => withTemp((dir) => {
    const out = path.join(dir, 'notes.json');
    const session = createSession({ stored: null, out, root: dir, scope: [], revision: null });
    for (const overall of ['one', 'two', 'three']) {
      session.overall = overall;
      saveSession(session);
    }
    assertEqual(fs.readdirSync(dir), ['notes.json'], 'files after three saves');
    assert(JSON.parse(fs.readFileSync(out, 'utf8')).overall === 'three', 'the notes file does not hold the last save');
    const parent = path.join(dir, 'sub');
    const taken = path.join(parent, 'taken');
    fs.mkdirSync(taken, { recursive: true });
    const blocked = createSession({ stored: null, out: taken, root: dir, scope: [], revision: null });
    let threw = false;
    try {
      saveSession(blocked);
    } catch {
      threw = true;
    }
    assert(threw, 'a save over a directory did not throw');
    assertEqual(fs.readdirSync(parent), ['taken'], 'files beside a failed save');
    blocked.annotations = [{ id: 'n1', anchor: { kind: 'scope' }, intent: 'change', body: 'b', createdAt: 'c' }];
    blocked.overall = 'o';
    const before = JSON.stringify({ round: blocked.round, rounds: blocked.rounds, annotations: blocked.annotations });
    let sendThrew = false;
    try {
      sendRound(blocked);
    } catch {
      sendThrew = true;
    }
    assert(sendThrew, 'a send whose save fails did not throw');
    assertEqual(JSON.stringify({ round: blocked.round, rounds: blocked.rounds, annotations: blocked.annotations }), before, 'the session after a send whose save failed');
  })],
  ['rounds: a sent note is locked', () => {
    const note = (id, body, extra = {}) => ({ id, anchor: { kind: 'scope' }, intent: 'change', body, createdAt: `c-${id}`, ...extra });
    const session = restoreSession(
      { rounds: [{ round: 1, sentAt: 't1', overall: '' }], annotations: [note('s1', 'sent', { round: 1 }), note('u1', 'unsent')] },
      '/notes.json',
    );
    applyEdits(
      session,
      {
        annotations: [
          { id: 'u1', body: 'unsent, revised' },
          { id: 's1', anchor: { kind: 'file', path: 'src/a.js' }, body: 'rewritten' },
          { id: 'n1', anchor: { kind: 'scope' }, body: 'new', createdAt: 'c-n1', round: 1 },
        ],
      },
      ALLOWED,
    );
    assertEqual(
      session.annotations,
      [note('s1', 'sent', { round: 1 }), note('u1', 'unsent, revised'), note('n1', 'new')],
      'notes after a write over a sent note',
    );
    applyEdits(session, { annotations: [] }, ALLOWED);
    assertEqual(session.annotations, [note('s1', 'sent', { round: 1 })], 'notes after a write that leaves the sent note out');
  }],
  ['rounds: a submit keeps the server alive and sends the next round', () => withServer(async ({ port, host, out, ended }) => {
    const headers = { host, 'x-margin-token': TOKEN };
    const submit = (body) => request(port, { method: 'POST', target: '/api/submit', headers, body });
    const one = { id: 'n1', anchor: { kind: 'scope' }, body: 'one' };
    const two = { id: 'n2', anchor: { kind: 'scope' }, body: 'two' };
    const first = await submit({ overall: 'first pass', annotations: [one] });
    assert(first.status === 200, `the first submit got ${first.status}`);
    assertEqual(first.json, { ok: true, round: 1 }, 'first submit reply');
    const afterFirst = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert(afterFirst.status === 'draft' && afterFirst.round === 1, `the file after a submit is ${afterFirst.status} at round ${afterFirst.round}`);
    assert(afterFirst.rounds.length === 1, `${afterFirst.rounds.length} rounds recorded after one submit`);
    const [entry] = afterFirst.rounds;
    assert(entry.round === 1 && typeof entry.sentAt === 'string' && entry.overall === 'first pass', `round entry ${JSON.stringify(entry)}`);
    assert(afterFirst.annotations[0].round === 1, 'the sent note carries no round');
    const alive = await request(port, { headers });
    assert(alive.status === 200, `the session after a submit got ${alive.status}`);
    assert(!(await isSettled(ended)), 'a submit ended the run');

    const second = await submit({ overall: 'first pass', annotations: [one, two] });
    assertEqual(second.json, { ok: true, round: 2 }, 'second submit reply');
    const afterSecond = JSON.parse(fs.readFileSync(out, 'utf8'));
    assertEqual(afterSecond.annotations.map((a) => [a.id, a.round]), [['n1', 1], ['n2', 2]], 'note rounds after two submits');

    const third = await submit({ overall: 'first pass ', annotations: [one, two] });
    assert(third.status === 409, `a submit with nothing new got ${third.status}`);
    assertEqual(third.json, { error: 'nothing to send' }, 'nothing-to-send reply');
    const afterThird = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert(afterThird.round === 2 && afterThird.overall === 'first pass ', `a refused submit left round ${afterThird.round}, overall ${JSON.stringify(afterThird.overall)}`);

    const finish = await request(port, { method: 'POST', target: '/api/finish', headers });
    assert(finish.status === 200, `finish got ${finish.status}`);
    await within(ended, 'the end of the run');
  })],
  ['finish: ends the run with the result document', () => withServer(async ({ port, host, root, out, finished }) => {
    const headers = { host, 'x-margin-token': TOKEN };
    const sent = await request(port, { method: 'POST', target: '/api/submit', headers, body: { annotations: [{ id: 'n1', anchor: { kind: 'scope' }, body: 'one' }] } });
    assertEqual(sent.json, { ok: true, round: 1 }, 'submit reply');
    const reply = await request(port, { method: 'POST', target: '/api/finish', headers });
    assert(reply.status === 200, `finish got ${reply.status}`);
    assertEqual(reply.json, { ok: true, status: 'finished' }, 'finish reply');
    const doc = await finished();
    assertEqual(doc, { status: 'finished', out, annotations: 1, rounds: 1, root, scope: [] }, 'result document');
    assertEqual(Object.keys(doc), ['status', 'out', 'annotations', 'rounds', 'root', 'scope'], 'result document keys');
    const saved = fs.readFileSync(out, 'utf8');
    assert(JSON.parse(saved).status === 'finished', 'the notes file is not finished');
    const late = await request(port, { method: 'PUT', headers, body: { overall: 'late', annotations: [] } });
    assert(late.status === 409, `a write after the end got ${late.status}`);
    assertEqual(late.json, { error: 'the run has ended' }, 'late write reply');
    assert(fs.readFileSync(out, 'utf8') === saved, 'a write after the end changed the notes file');
  })],
  ['finish: an end that cannot save answers 500 and fails the run', () => withServer(async ({ port, host, out, save, ended }) => {
    save();
    fs.rmSync(out);
    fs.mkdirSync(out);
    const reply = await request(port, { method: 'POST', target: '/api/finish', headers: { host, 'x-margin-token': TOKEN } });
    assert(reply.status === 500 && typeof reply.json?.error === 'string', `a finish whose save failed got ${reply.status} ${reply.text}`);
    let failed = false;
    try {
      await within(ended, 'the end of the run');
    } catch {
      failed = true;
    }
    assert(failed, 'the run ended although its notes file could not be saved');
  })],
  ['wait: returns on submit and on finish', async () => {
    await withServer(async ({ port, host, url, out, waiting, finished }) => {
      const headers = { host, 'x-margin-token': TOKEN };
      const badAfter = await request(port, { target: '/api/wait?after=x', headers });
      assert(badAfter.status === 400, `a wait with a bad after got ${badAfter.status}`);
      assertEqual(badAfter.json, { error: 'bad after: x' }, 'bad after reply');

      const first = waitForRound({ url });
      assert(!(await isSettled(first, 200)), 'a wait returned before any round was sent');
      await request(port, { method: 'POST', target: '/api/submit', headers, body: { annotations: [{ id: 'n1', anchor: { kind: 'scope' }, body: 'one' }] } });
      assertEqual(await within(first, 'the wait on a submit'), { status: 'sent', round: 1, out }, 'wait document on a submit');
      assertEqual(await within(waitForRound({ url, after: 0 }), 'a wait after a sent round'), { status: 'sent', round: 1, out }, 'wait document for a round already sent');

      const held = waitForRound({ url, after: 1 });
      const ahead = waitForRound({ url, after: 2 });
      await until(() => waiting() === 2, 'two held waits');
      await request(port, { method: 'POST', target: '/api/submit', headers, body: { annotations: [{ id: 'n2', anchor: { kind: 'scope' }, body: 'two' }] } });
      assertEqual(await within(held, 'the wait on the second submit'), { status: 'sent', round: 2, out }, 'wait document on the second submit');
      assert(!(await isSettled(ahead, 200)), 'a wait after round 2 returned on round 2');
      await request(port, { method: 'POST', target: '/api/finish', headers });
      assertEqual(await within(ahead, 'the wait on finish'), { status: 'finished', round: 2, out }, 'wait document on finish');
      await finished();
    });
    // The `wait` verb end to end: a child is let go only once the server holds its request.
    await withServer(async ({ port, host, url, out, waiting, finished }) => {
      const headers = { host, 'x-margin-token': TOKEN };
      const onSend = spawnCli(['wait', url]);
      try {
        await until(() => waiting() === 1, 'the wait child held on the server');
        await request(port, { method: 'POST', target: '/api/submit', headers, body: { annotations: [{ id: 'n1', anchor: { kind: 'scope' }, body: 'one' }] } });
        const sentExit = await onSend.exited();
        assert(sentExit.code === 0, `the wait child exited ${sentExit.code ?? sentExit.signal} on a submit: ${sentExit.stdout}`);
        assertEqual(JSON.parse(sentExit.stdout), { status: 'sent', round: 1, out }, 'wait child document on a submit');
      } finally {
        onSend.child.kill('SIGKILL');
      }
      const onFinish = spawnCli(['wait', url, '--after', '1']);
      try {
        await until(() => waiting() === 1, 'the second wait child held on the server');
        await request(port, { method: 'POST', target: '/api/finish', headers });
        const finishExit = await onFinish.exited();
        assert(finishExit.code === 0, `the wait child exited ${finishExit.code ?? finishExit.signal} on finish: ${finishExit.stdout}`);
        assertEqual(JSON.parse(finishExit.stdout), { status: 'finished', round: 1, out }, 'wait child document on finish');
      } finally {
        onFinish.child.kill('SIGKILL');
      }
      await finished();
    });
    const closedPort = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    await rejectsRun(waitForRound({ url: `http://127.0.0.1:${closedPort}/#${TOKEN}` }), 1, 'unreachable', 'a wait on a closed port');
    const valid = `http://127.0.0.1:1/#${TOKEN}`;
    assertErrorDoc(runCli(['wait', `http://localhost:1/#${TOKEN}`]), 2, 'bad run URL', 'wait on a non-loopback URL');
    assertErrorDoc(runCli(['wait']), 2, 'usage: cli.mjs wait', 'wait with no URL');
    assertErrorDoc(runCli(['wait', valid, 'extra']), 2, 'usage: cli.mjs wait', 'wait with an extra argument');
    assertErrorDoc(runCli(['wait', valid, '--after', 'x']), 2, 'bad --after x', 'wait with a bad --after');
  }],
  ['resume: rounds and note rounds restore; a file without them is round 0', () => withTemp((dir) => {
    const out = path.join(dir, 'notes.json');
    const note = (id, round) => ({ id, anchor: { kind: 'scope' }, intent: 'change', body: id, createdAt: `c-${id}`, ...(round === undefined ? {} : { round }) });
    const rounds = [{ round: 1, sentAt: 't1', overall: 'a' }, { round: 2, sentAt: 't2', overall: 'b' }];
    const resumed = createSession({ stored: { status: 'finished', round: 7, rounds, annotations: [note('a', 1), note('b', 2), note('c')] }, out, root: dir, scope: [], revision: null });
    assert(resumed.round === 2 && resumed.status === 'draft', `a resumed run starts at round ${resumed.round} as ${resumed.status}`);
    assertEqual(resumed.rounds, rounds, 'resumed rounds');
    assertEqual(resumed.annotations, [note('a', 1), note('b', 2), note('c')], 'resumed notes');

    const earlier = createSession({ stored: { status: 'submitted', overall: 'o', annotations: [note('x')] }, out, root: dir, scope: [], revision: null });
    assert(earlier.round === 0, `a file without rounds resumes at round ${earlier.round}`);
    assertEqual(earlier.rounds, [], 'rounds of a file without them');
    assertEqual(earlier.annotations, [note('x')], 'notes of a file without rounds');

    throwsRun(() => restoreSession({ rounds: [{ round: 2, sentAt: 't', overall: '' }], annotations: [] }, out), 1, 'rounds entry 0 is malformed');
    throwsRun(() => restoreSession({ rounds: [{ round: 1, overall: '' }], annotations: [] }, out), 1, 'rounds entry 0 is malformed');
    throwsRun(() => restoreSession({ rounds: [{ round: 1, sentAt: 't' }], annotations: [] }, out), 1, 'rounds entry 0 is malformed');
    throwsRun(() => restoreSession({ rounds: {}, annotations: [] }, out), 1, 'rounds is not a list');
    for (const bad of [3, 0, 1.5, '1']) {
      throwsRun(() => restoreSession({ rounds, annotations: [note('z', bad)] }, out), 1, '1 of 1 notes are malformed (indices 0)');
    }
  })],
  ['replies: a reply survives a viewer write and a resume', () => withTemp((dir) => {
    const out = path.join(dir, 'notes.json');
    const note = (id, extra = {}) => ({ id, anchor: { kind: 'scope' }, intent: 'change', body: id, createdAt: `c-${id}`, ...extra });
    const reply = (body, round) => ({ body, round, createdAt: `r-${body}` });
    const rounds = [{ round: 1, sentAt: 't1', overall: '' }, { round: 2, sentAt: 't2', overall: '' }];
    const replied = note('s1', { round: 1, replies: [reply('done', 1), reply('again', 2)] });
    const session = createSession({
      stored: {
        overallReplies: [reply('summary', 1)],
        rounds,
        annotations: [note('s1', { round: 1, replies: [{ ...reply('done', 1), extra: true }, reply('again', 2)] }), note('s2', { round: 2, replies: [] }), note('u1')],
      },
      out,
      root: dir,
      scope: [],
      revision: null,
    });
    assertEqual(session.overallReplies, [reply('summary', 1)], 'resumed overall replies');
    assertEqual(session.annotations, [replied, note('s2', { round: 2 }), note('u1')], 'resumed notes with replies');
    assertEqual(Object.keys(session.annotations[0]), ['id', 'anchor', 'intent', 'body', 'createdAt', 'round', 'replies'], 'resumed note keys');
    assertEqual(Object.keys(session).slice(0, 7), ['version', 'createdAt', 'overall', 'overallReplies', 'round', 'rounds', 'annotations'], 'resumed session keys');

    applyEdits(
      session,
      {
        annotations: [
          { id: 's1', body: 'rewritten', replies: [] },
          { id: 'u1', body: 'u1, revised', replies: [reply('forged', 1)] },
          { id: 'n1', anchor: { kind: 'scope' }, body: 'new', createdAt: 'c-n1', round: 1, replies: [reply('forged', 1)] },
        ],
      },
      ALLOWED,
    );
    assertEqual(
      session.annotations,
      [replied, note('s2', { round: 2 }), note('u1', { body: 'u1, revised' }), note('n1', { body: 'new' })],
      'notes after a viewer write carrying replies',
    );
    saveSession(session);
    const again = restoreSession(readStored(out), out);
    assertEqual(again.overallReplies, [reply('summary', 1)], 'overall replies after a save and a resume');
    assertEqual(again.annotations, [replied, note('s2', { round: 2 }), note('u1', { body: 'u1, revised' }), note('n1', { body: 'new' })], 'notes after a save and a resume');

    const earlier = restoreSession({ rounds, annotations: [note('a', { round: 1 })] }, out);
    assertEqual(earlier.overallReplies, [], 'overall replies of a file without them');
    assertEqual(earlier.annotations, [note('a', { round: 1 })], 'notes of a file without replies');

    const malformed = '1 of 1 notes are malformed (indices 0)';
    for (const bad of [
      note('z', { replies: [reply('x', 1)] }),
      note('z', { round: 2, replies: [reply('x', 1)] }),
      note('z', { round: 1, replies: [reply('x', 3)] }),
      note('z', { round: 1, replies: [{ body: 5, round: 1, createdAt: 'c' }] }),
      note('z', { round: 1, replies: [{ body: 'x', round: 1 }] }),
      note('z', { round: 1, replies: {} }),
    ]) {
      throwsRun(() => restoreSession({ rounds, annotations: [bad] }, out), 1, malformed);
    }
    throwsRun(() => restoreSession({ rounds, overallReplies: {}, annotations: [] }, out), 1, 'overallReplies is not a list');
    throwsRun(() => restoreSession({ rounds, overallReplies: [reply('x', 0)], annotations: [] }, out), 1, 'overallReplies entry 0 is malformed');
    throwsRun(() => restoreSession({ rounds, overallReplies: [reply('x', 1), reply('y', 3)], annotations: [] }, out), 1, 'overallReplies entry 1 is malformed');

    const taken = path.join(dir, 'taken');
    fs.mkdirSync(taken);
    const blocked = createSession({ stored: { rounds: [rounds[0]], annotations: [note('s1', { round: 1 })] }, out: taken, root: dir, scope: [], revision: null });
    const before = JSON.stringify({ overallReplies: blocked.overallReplies, annotations: blocked.annotations });
    let threw = false;
    try {
      postReplies(blocked, { round: 1, replies: [{ id: 's1', body: 'x' }], overall: 'y' });
    } catch {
      threw = true;
    }
    assert(threw, 'a reply post whose save fails did not throw');
    assertEqual(JSON.stringify({ overallReplies: blocked.overallReplies, annotations: blocked.annotations }), before, 'the session after a reply post whose save failed');
  })],
  ['reply: the reply route appends to sent notes only', () => withServer(async ({ port, host, out, finished }) => {
    const headers = { host, 'x-margin-token': TOKEN };
    const post = (body) => request(port, { method: 'POST', target: '/api/reply', headers, body });
    const stored = () => JSON.parse(fs.readFileSync(out, 'utf8'));
    const shape = (replies) => replies?.map(({ body, round }) => ({ body, round }));
    const n1 = { id: 'n1', anchor: { kind: 'scope' }, body: 'one' };
    const n2 = { id: 'n2', anchor: { kind: 'scope' }, body: 'two' };
    const sent = await request(port, { method: 'POST', target: '/api/submit', headers, body: { annotations: [n1] } });
    assertEqual(sent.json, { ok: true, round: 1 }, 'submit reply');
    const put = await request(port, { method: 'PUT', headers, body: { annotations: [n1, n2] } });
    assert(put.status === 200, `a write of an unsent note got ${put.status}`);

    const ok = await post({ round: 1, replies: [{ id: 'n1', body: 'done' }], overall: 'summary' });
    assert(ok.status === 200, `a reply got ${ok.status} ${ok.text}`);
    assertEqual(ok.json, { ok: true, replied: 1 }, 'reply answer');
    const saved = stored();
    const [first, second] = saved.annotations;
    assertEqual(shape(first.replies), [{ body: 'done', round: 1 }], 'n1 replies in the file');
    assertEqual(Object.keys(first.replies[0]), ['body', 'round', 'createdAt'], 'reply keys');
    assert(typeof first.replies[0].createdAt === 'string' && first.replies[0].createdAt !== '', 'a reply carries no createdAt');
    assertEqual(shape(saved.overallReplies), [{ body: 'summary', round: 1 }], 'overall replies in the file');
    assert(second.id === 'n2' && second.replies === undefined, 'the unsent note gained a reply');

    await request(port, { method: 'PUT', headers, body: { annotations: [{ ...n1, body: 'rewritten', replies: [] }, n2] } });
    assertEqual(stored().annotations[0], first, 'n1 after a viewer write echoing it');

    const before = fs.readFileSync(out, 'utf8');
    for (const [body, error] of [
      [{ round: 1, replies: [{ id: 'n2', body: 'x' }] }, 'entry 0: note n2 is not sent'],
      [{ round: 1, replies: [{ id: 'n1', body: 'x' }, { id: 'nope', body: 'y' }] }, 'entry 1: no note nope'],
      [{ round: 0, replies: [{ id: 'n1', body: 'x' }] }, 'bad round: 0'],
      [{ round: 2, replies: [{ id: 'n1', body: 'x' }] }, 'bad round: 2'],
      [{ replies: [{ id: 'n1', body: 'x' }] }, 'bad round: none'],
      [{ round: 1, replies: [{ id: 'n1', body: '  ' }] }, 'entry 0: body is blank or not a string'],
      [{ round: 1, replies: [{ body: 'x' }, 'n1'] }, 'entry 0: id is not a string; entry 1: id is not a string'],
      [{ round: 1 }, 'nothing to reply'],
      [{ round: 1, overall: ' ' }, 'overall reply is blank or not a string'],
      [{ round: 1, replies: {} }, 'replies is not a list'],
      [{ round: 1, replies: null, overall: 'x' }, 'replies is not a list'],
    ]) {
      const refused = await post(body);
      assert(refused.status === 400, `${JSON.stringify(body)} got ${refused.status}`);
      assertEqual(refused.json, { error }, `${JSON.stringify(body)} answer`);
      assert(fs.readFileSync(out, 'utf8') === before, `${JSON.stringify(body)} changed the notes file`);
    }

    const round2 = await request(port, { method: 'POST', target: '/api/submit', headers, body: { annotations: [n1, n2] } });
    assertEqual(round2.json, { ok: true, round: 2 }, 'second submit reply');
    const late = await post({ round: 1, replies: [{ id: 'n2', body: 'x' }] });
    assertEqual([late.status, late.json], [400, { error: 'entry 0: note n2 was sent after round 1' }], 'a reply for round 1 to a note sent in round 2');
    const twice = await post({ round: 2, replies: [{ id: 'n2', body: 'a' }, { id: 'n2', body: 'b' }, { id: 'n1', body: 'c' }] });
    assertEqual(twice.json, { ok: true, replied: 3 }, 'a reply naming one id twice');
    const [one, two] = stored().annotations;
    assertEqual(shape(one.replies), [{ body: 'done', round: 1 }, { body: 'c', round: 2 }], 'n1 replies after round 2');
    assertEqual(shape(two.replies), [{ body: 'a', round: 2 }, { body: 'b', round: 2 }], 'n2 replies after round 2');

    await request(port, { method: 'POST', target: '/api/finish', headers });
    await finished();
    const ended = await post({ round: 2, overall: 'too late' });
    assertEqual([ended.status, ended.json], [409, { error: 'the run has ended' }], 'a reply after the end');
    assertEqual(shape(stored().overallReplies), [{ body: 'summary', round: 1 }], 'overall replies after the end');
  })],
  ['listing: a reply re-lists; a deleted listed file answers 404', () => withServer(async ({ port, host, root, session }) => {
    const headers = { host, 'x-margin-token': TOKEN };
    const listed = async () => (await request(port, { headers })).json.files;
    const put = (annotations) => request(port, { method: 'PUT', headers, body: { annotations } });
    const post = (body) => request(port, { method: 'POST', target: '/api/reply', headers, body });
    const file = (p) => request(port, { target: `/api/file?path=${encodeURIComponent(p)}`, headers });
    const ids = () => session.annotations.map((a) => a.id);
    const scopeNote = { id: 's', anchor: { kind: 'scope' }, body: 'add b.txt' };
    const onA = { id: 'a1', anchor: { kind: 'file', path: 'a.txt' }, body: 'on a' };
    const onB = { id: 'b1', anchor: { kind: 'file', path: 'b.txt' }, body: 'on b' };
    assert(!isRepository(root), `${root} is inside a git repository, so the walk is not what runs`);

    write(root, 'b.txt', 'b\n');
    write(root, 'd/x.txt', 'x\n');
    assertEqual(await listed(), ['a.txt'], 'listing before a reply');
    await put([scopeNote, onA, onB]);
    assertEqual(ids(), ['s', 'a1'], 'notes kept before a reply');
    const sent = await request(port, { method: 'POST', target: '/api/submit', headers, body: { annotations: [scopeNote, onA] } });
    assertEqual(sent.json, { ok: true, round: 1 }, 'submit reply');

    const replied = await post({ round: 1, replies: [{ id: 's', body: 'added b.txt' }] });
    assertEqual(replied.json, { ok: true, replied: 1 }, 'reply answer');
    // The notes file sits under the root and the fixture is no repository: the walk finds it,
    // and the listing leaves it out.
    assertEqual(await listed(), ['a.txt', 'b.txt', 'd/x.txt'], 'listing after a reply');
    await put([scopeNote, onA, onB]);
    assertEqual(ids(), ['s', 'a1', 'b1'], 'notes kept after a reply');

    fs.rmSync(path.join(root, 'a.txt'));
    fs.rmSync(path.join(root, 'd'), { recursive: true });
    write(root, 'd', 'now a file\n');
    for (const p of ['a.txt', 'd/x.txt']) {
      const gone = await file(p);
      assertEqual([gone.status, gone.json], [404, { error: `${p} no longer exists` }], `${p} once gone`);
    }
    await post({ round: 1, replies: [{ id: 's', body: 'removed a.txt' }] });
    assertEqual(await listed(), ['b.txt', 'd'], 'listing after the second reply');
    const dropped = await file('a.txt');
    assertEqual([dropped.status, dropped.json], [404, { error: 'a.txt is not in scope' }], 'a.txt once the listing dropped it');
    assertEqual(session.annotations.find((a) => a.id === 'a1')?.anchor, { kind: 'file', path: 'a.txt' }, 'a stored anchor after the re-list');
  })],
  ['changes: a held change wait returns on a reply and on the end', () => withServer(async ({ port, host, watching, finished }) => {
    const headers = { host, 'x-margin-token': TOKEN };
    const changesAfter = (after) => request(port, { target: after === undefined ? '/api/changes' : `/api/changes?after=${after}`, headers });
    const post = (body) => request(port, { method: 'POST', target: '/api/reply', headers, body });
    assert((await request(port, { headers })).json.changes === 0, 'a fresh run does not report 0 changes');
    for (const [after, shown] of [[undefined, ''], ['x', 'x'], ['-1', '-1']]) {
      const bad = await changesAfter(after);
      assertEqual([bad.status, bad.json], [400, { error: `bad after: ${shown}` }], `a change wait with after ${JSON.stringify(after)}`);
    }
    await request(port, { method: 'POST', target: '/api/submit', headers, body: { annotations: [{ id: 'n1', anchor: { kind: 'scope' }, body: 'one' }] } });

    const held = changesAfter(0);
    await until(() => watching() === 1, 'a held change wait');
    const refused = await post({ round: 1, replies: [{ id: 'nope', body: 'x' }] });
    assert(refused.status === 400, `a refused reply got ${refused.status}`);
    assert(!(await isSettled(held)) && watching() === 1, 'a refused reply answered a held change wait');
    await post({ round: 1, replies: [{ id: 'n1', body: 'done' }] });
    assertEqual((await within(held, 'the change wait on a reply')).json, { status: 'changed', changes: 1 }, 'change document on a reply');
    assertEqual((await changesAfter(0)).json, { status: 'changed', changes: 1 }, 'a change wait below the count');
    assert((await request(port, { headers })).json.changes === 1, 'the session does not report 1 change');

    const ahead = changesAfter(1);
    await until(() => watching() === 1, 'a change wait at the count');
    assert(!(await isSettled(ahead)), 'a change wait at the count returned');
    await request(port, { method: 'POST', target: '/api/finish', headers });
    assertEqual((await within(ahead, 'the change wait on finish')).json, { status: 'finished', changes: 1 }, 'change document on finish');
    assertEqual((await changesAfter(5)).json, { status: 'finished', changes: 1 }, 'a change wait after the end');
    await finished();
  })],
  ['imports: specifiers scanned from every import form, in order', () => {
    const text = [
      "import a from './a';",
      'import {',
      '  b,',
      '  c,',
      '} from "./bc";',
      "export { d } from './d';",
      "export * from './e';",
      "import type { T } from './types';",
      "import './side-effect';",
      "const f = await import('./lazy');",
      'const g = require("./g");',
      "x.import('./not-this');",
      "const s = 'from nowhere';",
    ].join('\r\n');
    assertEqual(scanSpecifiers(text), ['./a', './bc', './d', './e', './types', './side-effect', './lazy', './g'], 'scanned specifiers');
  }],
  ['imports: relative, extension, index and .js to .ts resolution against the listing', () => withTemp((root) => {
    const resolver = createResolver(root, ['src/a.ts', 'src/b.ts', 'src/dir/index.tsx', 'src/js.ts', 'src/raw.css', 'lib.mjs']);
    const text = ["./b", "./dir", "./js.js", "./raw.css?raw", "./a", "../lib.mjs", "../../up", "./b.ts", "./missing", "pkg/sub", "node:fs", "#internal"]
      .map((spec) => `import '${spec}';`).join('\n');
    assertEqual(resolver.resolveImports('src/a.ts', text), {
      imports: ['src/b.ts', 'src/dir/index.tsx', 'src/js.ts', 'src/raw.css', 'lib.mjs'],
      outside: ['../../up', './missing', 'pkg/sub', 'node:fs', '#internal'],
    }, 'resolved imports');
    assertEqual(resolver.warnings, [], 'warnings without a tsconfig');
  })],
  ['imports: tsconfig paths with and without baseUrl, extends, comments and trailing commas', () => withTemp((root) => {
    assertEqual(parseJsonc('{"a": "x//y /* z */", /* c */ "b": [1, 2,], // end\n "c": "q\\"//", "d": ",}",}'), { a: 'x//y /* z */', b: [1, 2], c: 'q"//', d: ',}' }, 'parsed JSONC');
    write(root, 'tsconfig.json', '{\n  // root\n  "compilerOptions": {\n    /* aliases */\n    "paths": {\n      "@/*": ["./src/*"],\n      "@/lib/*": ["./missing/*", "./fallback/*"],\n      "exact": ["./src/exact.ts"],\n    },\n  },\n}\n');
    write(root, 'web/tsconfig.json', '{"extends": "../tsconfig", "compilerOptions": {"baseUrl": "."}}');
    write(root, 'cycle/tsconfig.json', '{"extends": "./tsconfig.json", "compilerOptions": {"paths": {"~/*": ["./*"]}}}');
    write(root, 'broken/tsconfig.json', '{ nope');
    write(root, 'escape/tsconfig.json', '{"extends": "../../elsewhere.json"}');
    const resolver = createResolver(root, ['src/a.ts', 'src/exact.ts', 'src/lib/l.ts', 'fallback/f.ts', 'web/k.ts', 'web/src/w.ts', 'cycle/c.ts', 'cycle/d.ts', 'broken/x.ts', 'escape/e.ts']);
    const imports = (specs) => specs.map((spec) => `import '${spec}';`).join('\n');
    assertEqual(resolver.resolveImports('src/a.ts', imports(['@/exact', '@/lib/f', '@/lib/l', 'exact', 'exact/more'])), {
      imports: ['src/exact.ts', 'fallback/f.ts'],
      outside: ['@/lib/l', 'exact/more'],
    }, 'the root config: longest prefix, targets in order, exact pattern');
    assertEqual(resolver.resolveImports('web/k.ts', imports(['@/w'])), { imports: ['web/src/w.ts'], outside: [] }, 'an inherited paths under the extending config baseUrl');
    assertEqual(resolver.resolveImports('cycle/c.ts', imports(['~/d'])), { imports: ['cycle/d.ts'], outside: [] }, 'a config whose extends is a cycle keeps its own paths');
    assertEqual(resolver.resolveImports('broken/x.ts', imports(['@/exact'])), { imports: ['src/exact.ts'], outside: [] }, 'an unparseable config counts as absent');
    assertEqual(resolver.resolveImports('escape/e.ts', imports(['@/exact'])), { imports: [], outside: ['@/exact'] }, 'a config without paths');
    const expected = [
      'tsconfig cycle/tsconfig.json: extends ./tsconfig.json skipped, it forms a cycle',
      'tsconfig broken/tsconfig.json: ignored, it could not be parsed',
      'tsconfig escape/tsconfig.json: extends ../../elsewhere.json skipped, it resolves outside the root',
    ];
    assert(resolver.warnings.length === expected.length && expected.every((fragment, i) => resolver.warnings[i].startsWith(fragment)), `tsconfig warnings: ${JSON.stringify(resolver.warnings)}`);
  })],
  ['imports: an extends through a symlinked folder out of the root is skipped', () => withTemp((root) => withTemp((outside) => {
    write(outside, 'base.json', '{"compilerOptions": {"paths": {"@/*": ["./*"]}}}');
    fs.symlinkSync(outside, path.join(root, 'cfg'));
    write(root, 'tsconfig.json', '{"extends": "./cfg/base.json"}');
    const resolver = createResolver(root, ['a.ts', 'b.ts']);
    assertEqual(resolver.resolveImports('a.ts', "import '@/b';"), { imports: [], outside: ['@/b'] }, 'no alias read from out of the root');
    assertEqual(resolver.warnings, ['tsconfig tsconfig.json: extends ./cfg/base.json skipped, it resolves outside the root'], 'the skipped extends');
  }))],
  ['measure: line count, indent width and indentation', () => {
    assertEqual(['', 'a', 'a\n', 'a\n\n', 'a\r\nb'].map(countLines), [0, 1, 1, 2, 2], 'line counts');
    assertEqual(detectWidth(['  a\n    b\n    c\n']), 2, 'a width halved while the half occurs');
    assertEqual(detectWidth(['    a\n        b\n']), 4, 'a tie won by the smaller width');
    assertEqual(detectWidth(['a\n\tb\n   \n']), 1, 'no space-indented line');
    assertEqual(indentation('a\n\t  x\n\n    \n    y\r\n', 2), 4, 'tabs plus spaces over the width, blank lines skipped');
  }],
  ['measure: lines, churn in a six-month window, imports and the hotspot table on a git repository', () => withTemp((root) => {
    measureFixture(root);
    const measured = measureScope({ root, scope: ['src'] });
    assertEqual(measured.document, measuredFixture(root), 'the measurement document');
    assertEqual(measured.tsv, MEASURED_FIXTURE_TSV, 'the hotspot table');
    assertEqual(measured.warnings, [], 'warnings');
    assertEqual(measured.summary, { files: 4, churn: 'git' }, 'the summary');
    throwsRun(() => measureScope({ root, scope: ['nothing'] }), 1, 'no files under nothing');
  })],
  ['measure: a root below the git top level, outside git, and without commits', () => withTemp((dir) => {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    measureFixture(repo);
    const below = measureScope({ root: path.join(repo, 'src'), scope: [] }).document;
    assertEqual(below.prefix, 'src/', 'the prefix below the top level');
    assertEqual(below.scope, ['.'], 'the scope of a run without --scope');
    assertEqual(below.files.map((file) => [file.path, file.churn]), [['a.ts', 2], ['b.ts', 1], ['img.bin', 0], ['lib/c.ts', 0]], 'churn below the top level');
    assertEqual(below.files[0].outside, ['@/c', 'react', './missing', '../other/x'], 'a tsconfig above the root is not read');

    const plain = path.join(dir, 'plain');
    write(plain, 'a.txt', 'x\n  y\n');
    write(plain, 'b.js', "require('./a.txt');\n");
    assert(!isRepository(plain), `${plain} is inside a git repository, so the walk is not what runs`);
    const outside = measureScope({ root: plain, scope: [] });
    assertEqual(outside.document, {
      version: 1,
      root: plain,
      scope: ['.'],
      prefix: null,
      files: [
        { path: 'a.txt', lines: 2, churn: null, indentation: 1, imports: [], outside: [] },
        { path: 'b.js', lines: 1, churn: null, indentation: 0, imports: ['a.txt'], outside: [] },
      ],
    }, 'the measurement outside git');
    assertEqual(outside.tsv, `${HOTSPOT_HEADER_LINE}a.txt\t0\t2\t1\t0\t0\nb.js\t0\t1\t0\t0\t0\n`, 'the hotspot table outside git');
    assertEqual(outside.summary, { files: 2, churn: null }, 'the summary outside git');

    execFileSync('git', ['init', '-q'], { cwd: plain, stdio: 'ignore' });
    const fresh = measureScope({ root: plain, scope: [] }).document;
    assertEqual([fresh.prefix, fresh.files.map((file) => file.churn)], ['', [0, 0]], 'a repository with no commits');
  })],
  ['assemble: explorer blocks parsed, malformed ones dropped with their names', () => {
    const good = [
      'name: split-a',
      'tier: strong',
      'category: in-process',
      'files: apps/web/src/a.ts, ./src/b.ts,src/a.ts',
      'structural_key: a',
      'next_change: add a mode',
      'next_sites: apps/web/src/a.ts:2 — the switch',
      'next_sites: src/b.ts:1 – the export',
      'est_diff_lines: 40',
      'deletion_test: vanishes',
      'friction: tangled',
      'adr_conflict: none',
    ];
    const blocks = [
      good,
      explorerBlock('bad-site', { sites: ['src/a.ts line 2'] }),
      explorerBlock('stranger', { files: 'other/x.ts' }),
      explorerBlock('wrong-case', { tier: 'Strong' }),
      good,
      explorerBlock('approx', { est: '~200' }),
      explorerBlock('off-files', { sites: ['src/b.ts:1 — x'] }),
      ['name: lonely'],
      ['pin: none — nothing pinned', 'notes: none'],
    ];
    const text = ['```', explorerText(blocks), '```'].join('\n').replaceAll('\n', '\r\n');
    const { document, warnings, dropped } = assembleOverview({ measurement: handMeasurement(), rolesText: '{}', explorerText: text });
    assertEqual(document.candidates, [{
      name: 'split-a',
      tier: 'strong',
      category: 'in-process',
      files: ['src/a.ts', 'src/b.ts'],
      next_change: 'add a mode',
      next_sites: [{ path: 'src/a.ts', line: 2, what: 'the switch' }, { path: 'src/b.ts', line: 1, what: 'the export' }],
      est_diff_lines: 40,
      deletion_test: 'vanishes',
      friction: 'tangled',
    }], 'the parsed candidates');
    assertEqual(warnings, [
      'dropped explorer block "bad-site": next_sites line 1 is not <path>:<line> — <what>',
      'dropped explorer block "stranger": names other/x.ts, which is not in the scope',
      'dropped explorer block "wrong-case": tier is not one of strong, worth-exploring, speculative',
      'dropped explorer block "split-a": repeats the name of an earlier block',
      'dropped explorer block "approx": est_diff_lines ~200 is not a whole number',
      'dropped explorer block "off-files": next_sites[0].path is not one of the candidate\'s files',
      'dropped explorer block "lonely": missing tier',
    ], 'the drop warnings');
    assertEqual(dropped, 7, 'the dropped count');
    assertEqual(document.notices, [], 'notices when a candidate survives');
    assertEqual(document.files.map((file) => [file.kind, file.role, file.exports, file.mixes]), [[null, null, null, null], [null, null, null, null]], 'role fields from an empty roles object');
  }],
  ['assemble: roles merged; missing or malformed inputs give notices', () => withTemp((dir) => {
    const roles = '```json\n{"src/a.ts": {"kind": "module", "role": "entry", "exports": ["a", "a"], "mixes": "io"}, "apps/web/src/b.ts": {"kind": ""}, "nowhere.ts": {}, "__proto__": {"kind": "x"}}\n```';
    const merged = assembleOverview({ measurement: handMeasurement(), rolesText: roles, explorerText: 'notes: none' });
    assertEqual(merged.document.files, [
      { path: 'src/a.ts', lines: 3, churn: 1, indentation: 0, kind: 'module', role: 'entry', exports: ['a'], mixes: null, imports: ['src/b.ts'], outside: ['react'] },
      { path: 'src/b.ts', lines: 1, churn: 0, indentation: 0, kind: null, role: null, exports: null, mixes: null, imports: [], outside: [] },
    ], 'the merged files');
    assertEqual(merged.warnings, [
      'roles: src/a.ts.mixes is not an array of non-empty strings, set to null',
      'roles: src/b.ts.kind is not a non-empty string, set to null',
      'roles: ignored nowhere.ts, which is not in the scope',
      'roles: ignored __proto__, which is not in the scope',
    ], 'the roles warnings');
    assertEqual(merged.document.notices, [], 'notes: none gives no notice');
    assert(merged.document.files.every((file) => Object.getPrototypeOf(file) === Object.prototype), 'a roles __proto__ key reached a file entry');

    const notices = (inputs) => assembleOverview({ measurement: handMeasurement(), ...inputs }).document.notices;
    assertEqual(notices({ rolesReason: 'no roles file was given', explorerReason: 'no explorer file was given' }), [
      'File roles are unavailable: no roles file was given.',
      'No deepening candidates: no explorer file was given.',
    ], 'notices for missing inputs');
    assertEqual(notices({ rolesText: '[1]', explorerText: 'notes: scope too small' }), [
      'File roles are unavailable: the roles input is not a JSON object.',
      'Explorer: scope too small',
    ], 'notices for a roles array and explorer notes');
    const unparsed = notices({ rolesText: 'nope', explorerText: '' });
    assert(unparsed.length === 1 && unparsed[0].startsWith('File roles are unavailable: the roles input is not valid JSON ('), `notices for roles that do not parse: ${JSON.stringify(unparsed)}`);
    assertEqual(notices({ rolesText: '{}', explorerText: explorerText([explorerBlock('stranger', { files: 'other/x.ts' })]) }), ['1 explorer candidate dropped as malformed.'], 'one block, dropped');
    assertEqual(notices({ rolesText: '{}', explorerText: explorerText([['name: a'], ['name: b']]) }), ['2 explorer candidates dropped as malformed.'], 'two blocks, both dropped');

    const tampered = handMeasurement();
    tampered.files[0].imports = ['src/zz.ts'];
    throwsRun(() => assembleOverview({ measurement: tampered, rolesText: '{}', explorerText: '' }), 1, 'assembled overview: files[0].imports[0] is not an overview file');
    const big = assembleOverview({ measurement: handMeasurement(), rolesText: JSON.stringify({ 'src/a.ts': { role: 'r'.repeat(MAX_OVERVIEW_BYTES) } }), explorerText: '' }).document;
    throwsRun(() => serialiseOverview(big, '/x/overview.json'), 1, 'overview /x/overview.json: 2.0 MB is above the 2 MB overview limit');

    const missing = path.join(dir, 'missing.json');
    assertEqual(readOptional(undefined, 'roles'), { reason: 'no roles file was given' }, 'an optional input not given');
    assertEqual(readOptional(missing, 'explorer'), { reason: `explorer file ${missing}: not found` }, 'an optional input not found');
    assertEqual(readOptional(write(dir, 'e.txt', 'notes: none\n'), 'explorer'), { text: 'notes: none\n' }, 'an optional input read');
    throwsRun(() => readMeasurement(missing), 1, `measurements ${missing}: not found`);
    for (const [content, fragment] of [
      ['{', 'not valid JSON'],
      ['[]', 'not a JSON object'],
      ['{"version": 2}', 'version is not 1'],
      ['{"version": 1, "root": "rel", "scope": [], "files": []}', 'root is not an absolute path'],
      [`{"version": 1, "root": ${JSON.stringify(dir)}, "scope": [], "files": [{}]}`, 'files[0] is not an object with a string path'],
    ]) {
      throwsRun(() => readMeasurement(write(dir, 'm.json', content)), 1, fragment);
    }
  })],
  ['cli: measure then assemble writes an overview the shape check accepts', () => withTemp((dir) => {
    const root = path.join(dir, 'repo');
    fs.mkdirSync(root);
    measureFixture(root);
    const measurements = path.join(dir, 'out', 'measurements.json');
    const hotspots = path.join(dir, 'out', 'hotspots.tsv');
    const measured = runCli(['measure', '--root', root, '--scope', 'src', '--out', measurements, '--hotspots', hotspots]);
    assert(measured.status === 0, `measure exited ${measured.status}: ${measured.stdout}`);
    assertEqual(measured.doc, { status: 'ok', out: measurements, hotspots, files: 4, churn: 'git' }, 'the measure document');
    assertEqual(measured.stderr, '', 'measure stderr');
    assertEqual(JSON.parse(fs.readFileSync(measurements, 'utf8')), measuredFixture(root), 'the measurement file');
    assertEqual(fs.readFileSync(hotspots, 'utf8'), MEASURED_FIXTURE_TSV, 'the hotspot file');

    const explorer = write(dir, 'explorer.txt', `${explorerText([
      explorerBlock('split-a', { tier: 'strong', files: 'src/a.ts,src/b.ts', sites: ['src/a.ts:8 — the branch', 'src/b.ts:2 — the field'], est: '30' }),
      explorerBlock('stranger', { files: 'other/x.ts' }),
      ['notes: none'],
    ])}\n`);
    const roles = write(dir, 'roles.json', '{"src/a.ts": {"kind": "module", "role": "entry", "exports": ["a"], "mixes": []}}');
    const out = path.join(dir, 'out', 'overview.json');
    const assembled = runCli(['assemble', '--measurements', measurements, '--roles', roles, '--explorer', explorer, '--out', out]);
    assert(assembled.status === 0, `assemble exited ${assembled.status}: ${assembled.stdout}`);
    assertEqual(assembled.doc, { status: 'ok', out, files: 4, candidates: 1, dropped: 1, notices: 0 }, 'the assemble document');
    assertEqual(assembled.stderr, 'margin: assemble: dropped explorer block "stranger": names other/x.ts, which is not in the scope\n', 'assemble stderr');
    const overview = readOverview(out);
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(overview.generatedAt), `generatedAt is not toISOString output: ${overview.generatedAt}`);
    const nulls = { kind: null, role: null, exports: null, mixes: null };
    const files = measuredFixture(root).files.map((file) => ({ ...file, ...nulls }));
    Object.assign(files[0], { kind: 'module', role: 'entry', exports: ['a'], mixes: [] });
    assertEqual(overview, {
      version: 1,
      root,
      scope: ['src'],
      generatedAt: overview.generatedAt,
      files,
      candidates: [{
        name: 'split-a',
        tier: 'strong',
        category: 'in-process',
        files: ['src/a.ts', 'src/b.ts'],
        next_change: 'x',
        next_sites: [{ path: 'src/a.ts', line: 8, what: 'the branch' }, { path: 'src/b.ts', line: 2, what: 'the field' }],
        est_diff_lines: 30,
        deletion_test: 'x',
        friction: 'y',
      }],
      notices: [],
    }, 'the assembled overview');

    const bare = path.join(dir, 'out', 'bare.json');
    const fallback = runCli(['assemble', '--measurements', measurements, '--out', bare]);
    assertEqual(fallback.doc, { status: 'ok', out: bare, files: 4, candidates: 0, dropped: 0, notices: 2 }, 'assemble without roles or explorer');
    assertEqual(readOverview(bare).notices, ['File roles are unavailable: no roles file was given.', 'No deepening candidates: no explorer file was given.'], 'the notices without roles or explorer');
  })],
  ['cli: measure and assemble refusals write nothing', () => withTemp((dir) => {
    const root = path.join(dir, 'root');
    write(root, 'a.txt', 'a\n');
    const out = path.join(dir, 'out.json');
    const hotspots = path.join(dir, 'hotspots.tsv');
    for (const [args, code, fragment] of [
      [['measure', '--out', out, '--hotspots', hotspots], 2, 'measure needs --root'],
      [['measure', '--root', root, '--out', out], 2, 'measure needs --hotspots'],
      [['measure', '--root', root, '--out=', '--hotspots', hotspots], 2, 'bad --out: empty'],
      [['measure', 'extra', '--root', root, '--out', out, '--hotspots', hotspots], 2, 'usage: cli.mjs measure'],
      [['measure', '--root', root, '--out', out, '--hotspots', out], 2, 'bad --hotspots: same file as --out'],
      [['measure', '--root', root, '--scope', '../x', '--out', out, '--hotspots', hotspots], 2, 'is outside'],
      [['measure', '--root', root, '--scope', 'nothing', '--out', out, '--hotspots', hotspots], 1, 'no files under nothing'],
      [['assemble', '--out', out], 2, 'assemble needs --measurements'],
      [['assemble', '--measurements', path.join(dir, 'm.json'), '--roles=', '--out', out], 2, 'bad --roles: empty'],
      [['assemble', '--measurements', path.join(dir, 'missing.json'), '--out', out], 1, 'missing.json: not found'],
    ]) {
      assertErrorDoc(runCli(args), code, fragment, args.join(' '));
      assert(!fs.existsSync(out) && !fs.existsSync(hotspots), `${args.join(' ')} wrote an output`);
    }
    const kept = '{"kept": true}\n';
    fs.writeFileSync(out, kept);
    const notJson = write(dir, 'broken.json', '{');
    assertErrorDoc(runCli(['assemble', '--measurements', notJson, '--out', out]), 1, 'not valid JSON', 'a measurement file that is not JSON');
    const tampered = handMeasurement();
    tampered.root = root;
    tampered.files[0].imports = ['src/zz.ts'];
    const dangling = write(dir, 'dangling.json', JSON.stringify(tampered));
    assertErrorDoc(runCli(['assemble', '--measurements', dangling, '--out', out]), 1, 'assembled overview: files[0].imports[0] is not an overview file', 'a measurement with a dangling import');
    assert(fs.readFileSync(out, 'utf8') === kept, 'a refused assemble rewrote --out');
    assertEqual(fs.readdirSync(root), ['a.txt'], 'files under the root after the refusals');
  })],
  ['cli: a run survives a submit and prints one document on finish', () => withTemp(async (dir) => {
    const root = path.join(dir, 'root');
    write(root, 'a.txt', 'a\n');
    const out = path.join(dir, 'notes.json');
    const annotateArgs = (file) => ['annotate', '--root', root, '--out', file, '--port', '0', '--token', TOKEN, '--no-open'];
    const server = spawnCli(annotateArgs(out));
    try {
      const url = await serverUrl(server);
      const port = Number(new URL(url).port);
      const headers = { host: `127.0.0.1:${port}`, 'x-margin-token': TOKEN };
      const sent = await request(port, { method: 'POST', target: '/api/submit', headers, body: { annotations: [{ id: 'n1', anchor: { kind: 'scope' }, body: 'one' }] } });
      assertEqual(sent.json, { ok: true, round: 1 }, 'submit reply');
      const alive = await request(port, { headers });
      assert(alive.status === 200, `the session after a submit got ${alive.status}`);
      const finish = await request(port, { method: 'POST', target: '/api/finish', headers });
      assertEqual(finish.json, { ok: true, status: 'finished' }, 'finish reply');
      const serverExit = await server.exited();
      assert(serverExit.code === 0, `the server exited ${serverExit.code ?? serverExit.signal}: ${serverExit.stdout}`);
      let doc = null;
      try {
        doc = JSON.parse(serverExit.stdout);
      } catch {
        throw new CaseFailure(`the server's stdout is not one JSON document: ${JSON.stringify(serverExit.stdout)}`);
      }
      assertEqual(doc, { status: 'finished', out, annotations: 1, rounds: 1, root, scope: [] }, 'result document');
    } finally {
      server.child.kill('SIGKILL');
    }
    const other = path.join(dir, 'other.json');
    const interrupted = spawnCli(annotateArgs(other));
    try {
      await serverUrl(interrupted);
      interrupted.child.kill('SIGTERM');
      const exit = await interrupted.exited();
      assert(exit.code === 0, `a SIGTERM run exited ${exit.code ?? exit.signal}: ${exit.stdout}`);
      assertEqual(JSON.parse(exit.stdout), { status: 'interrupted', out: other, annotations: 0, rounds: 0, root, scope: [] }, 'result document on SIGTERM');
    } finally {
      interrupted.child.kill('SIGKILL');
    }
  })],
  ['cli: resume and scope refusals write nothing', () => withTemp((dir) => {
    const root = path.join(dir, 'root');
    write(root, 'a.txt', 'a\n');
    const out = path.join(dir, 'notes.json');
    const args = ['annotate', '--root', root, '--out', out, '--port', '0', '--no-open'];
    for (const [content, fragment] of [
      ['{', 'is not valid JSON'],
      ['{"annotations": 1}', 'no annotations array'],
      ['{"annotations":[{"anchor":{"kind":"scope"},"body":"ok"},{"anchor":{"kind":"bogus"},"body":"x"}]}', '1 of 2 notes are malformed (indices 1)'],
    ]) {
      fs.writeFileSync(out, content);
      assertErrorDoc(runCli(args), 1, fragment, `--out holding ${content.slice(0, 24)}`);
      assert(fs.readFileSync(out).equals(Buffer.from(content)), `--out holding ${content.slice(0, 24)} was rewritten`);
    }
    const resumedScope = '{"annotations": [], "scope": ["../outside"]}';
    fs.writeFileSync(out, resumedScope);
    assertErrorDoc(runCli(args), 2, 'is outside', 'a resumed scope outside the root');
    assert(fs.readFileSync(out).equals(Buffer.from(resumedScope)), 'a resumed scope outside the root rewrote --out');
    fs.rmSync(out);
    assertErrorDoc(runCli(['annotate', '--root', root, '--scope', '../outside', '--port', '0', '--no-open']), 2, 'is outside', 'a scope outside the root');
    assertEqual(fs.readdirSync(root), ['a.txt'], 'files under the root after the refusals');
    assertErrorDoc(runCli(['--self-test', 'extra']), 2, 'usage: cli.mjs annotate', '--self-test with another argument');
  })],
  ['cli: overview refusals write nothing', () => withTemp((dir) => {
    const root = path.join(dir, 'root');
    write(root, 'a.txt', 'a\n');
    const out = path.join(dir, 'notes.json');
    const notes = '{"annotations": []}';
    fs.writeFileSync(out, notes);
    const args = (overview) => ['annotate', '--root', root, '--out', out, '--overview', overview, '--port', '0', '--no-open'];
    for (const [name, content, fragment] of [
      ['missing.json', null, 'missing.json: not found'],
      ['broken.json', '{', 'broken.json: not valid JSON'],
      ['shape.json', JSON.stringify({ ...overviewFixture(root), version: 2 }), 'shape.json: version is not the number 1'],
    ]) {
      const overview = path.join(dir, name);
      if (content !== null) {
        fs.writeFileSync(overview, content);
      }
      assertErrorDoc(runCli(args(overview)), 1, fragment, `--overview ${name}`);
      assert(fs.readFileSync(out).equals(Buffer.from(notes)), `--overview ${name} rewrote --out`);
    }
    assertErrorDoc(runCli(['annotate', '--root', root, '--out', out, '--overview=', '--port', '0', '--no-open']), 2, 'bad --overview: empty', 'an empty --overview');
    assertErrorDoc(runCli(['annotate', '--root', root, '--out', out, '--port', '0', '--no-open', '--overview']), 2, 'usage: cli.mjs annotate', '--overview with no value');
    assert(fs.readFileSync(out).equals(Buffer.from(notes)), 'a bad --overview invocation rewrote --out');
    fs.rmSync(out);
    assertErrorDoc(runCli(['annotate', '--root', root, '--overview', path.join(dir, 'broken.json'), '--port', '0', '--no-open']), 1, 'not valid JSON', 'a fresh run with a bad overview');
    assertEqual(fs.readdirSync(root), ['a.txt'], 'files under the root after the overview refusals');
  })],
  ['cli: an overview run serves the document and keeps it out of the listing', () => withTemp(async (dir) => {
    const root = path.join(dir, 'root');
    write(root, 'a.txt', 'a\n');
    const overviewFile = write(root, 'claudedocs/margin/notes.overview.json', JSON.stringify(overviewFixture(root)));
    const out = path.join(dir, 'notes.json');
    const server = spawnCli(['annotate', '--root', root, '--out', out, '--overview', overviewFile, '--port', '0', '--token', TOKEN, '--no-open']);
    try {
      const url = await serverUrl(server);
      const port = Number(new URL(url).port);
      const headers = { host: `127.0.0.1:${port}`, 'x-margin-token': TOKEN };
      const served = await request(port, { target: '/api/overview', headers });
      assert(served.status === 200, `the overview route got ${served.status}`);
      assertEqual(served.json, expectedOverview(root), 'the served overview');
      assertEqual((await request(port, { headers })).json.files, ['a.txt'], 'listing on an overview run');
      const sent = await request(port, { method: 'POST', target: '/api/submit', headers, body: { annotations: [{ id: 'n1', anchor: { kind: 'scope' }, body: 'one' }] } });
      assertEqual(sent.json, { ok: true, round: 1 }, 'submit reply');
      const replied = await request(port, { method: 'POST', target: '/api/reply', headers, body: { round: 1, replies: [{ id: 'n1', body: 'noted' }] } });
      assertEqual(replied.json, { ok: true, replied: 1 }, 'reply answer');
      assertEqual((await request(port, { headers })).json.files, ['a.txt'], 'listing after a reply on an overview run');
      const finish = await request(port, { method: 'POST', target: '/api/finish', headers });
      assertEqual(finish.json, { ok: true, status: 'finished' }, 'finish reply');
      const exit = await server.exited();
      assert(exit.code === 0, `the server exited ${exit.code ?? exit.signal}: ${exit.stdout}`);
      assertEqual(JSON.parse(exit.stdout), { status: 'finished', out, annotations: 1, rounds: 1, root, scope: [] }, 'result document on an overview run');
    } finally {
      server.child.kill('SIGKILL');
    }
  })],
];

/** Run every case; return the document, or throw a RunError naming the first failure. */
export async function runSelfTest() {
  // Git reads these from the environment; a hook or a contributor's shell must not point the
  // listing cases at another repository or another configuration.
  for (const name of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_CEILING_DIRECTORIES']) {
    delete process.env[name];
  }
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = os.devNull;
  for (const [name, fn] of CASES) {
    try {
      await fn();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new RunError(`self-test: ${name} — ${detail}`, 1);
    }
  }
  return { cases: CASES.length, ok: true };
}
