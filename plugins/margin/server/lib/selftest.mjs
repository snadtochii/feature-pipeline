// `cli.mjs --self-test` (CONTRACT.md §12).
//
// Exercises what no browser session proves, without a browser. It checks the viewer's colouring
// seam over the vendored highlight.js on a fixed TSX sample, and the routes that serve both. It
// checks the note rules (the anchor rule per kind, range validity, the excerpt cap), resuming a
// notes file (a stored note keeps its anchor; rounds and note rounds restore; a file without
// rounds is round 0; the refusals), the atomic save, the sent-note lock, the agent's replies
// (kept through a viewer write and a resume, each resume refusal for them, a reply post whose
// save fails changing nothing), the scope rule, file listing that never lists a symlink, and
// the reading refusals and limits. Against a server on port 0 inside this process it checks the
// request guards, a submit that sends a round and keeps serving, finish, cancel (on empty, and
// after a sent round), `wait` returning on a submit and on the end of the run, the reply route
// (sent notes only, its refusals, all or nothing, 409 after the end), re-listing after a reply
// (a new file accepted as a `file` anchor, a deleted listed file answering 404), and the change
// wait returning on a reply and on the end. Through `cli.mjs` children it checks the command's own
// refusals (children that must exit before serving, and `wait`'s invocation refusals) and one
// end-to-end run: a submit, a `wait` child, finish, and exactly one result document, plus a
// run ended by SIGTERM.
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
function withServer(fn) {
  return withTemp(async (root) => {
    write(root, 'a.txt', 'a\n');
    const out = path.join(root, 'claudedocs', 'margin', 'notes.json');
    const files = listFiles(root, [], out);
    assertEqual(files, ['a.txt'], 'fixture listing');
    const session = createSession({ stored: null, out, root, scope: [], revision: null });
    const save = () => saveSession(session);
    const { url, close, ended, waiting, watching } = await startServer({
      port: 0,
      token: TOKEN,
      session,
      files,
      readSource: (p) => readSource(root, p),
      relist: () => listFiles(root, [], out),
      onSave: save,
      onSend: () => sendRound(session),
      onReply: (body) => postReplies(session, body),
      onEnd: (status) => finishRun(session, status),
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
  return { status: res.status, signal: res.signal, stdout: res.stdout, doc };
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
    assertEqual(listFiles(root, [], notes), ['a.txt', 'sub/b.txt'], 'git listing leaves out the notes file');
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
