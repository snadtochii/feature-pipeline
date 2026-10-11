// `cli.mjs --self-test` (CONTRACT.md §12).
//
// Exercises what no browser session proves, without a browser: the viewer's line tokenizer on
// fixed samples, the note rules (the anchor rule per kind, range validity, the excerpt cap),
// resuming a notes file (a stored note keeps its anchor; the refusals), the scope rule, file
// listing that never lists a symlink, and the reading refusals and limits — then the three
// request guards and cancel-on-empty against a server on port 0 inside this process, and the
// command's own refusals through `cli.mjs annotate` children that must exit before serving.
// Every fixture is a real file in a temp directory, and every expectation is written by hand,
// never computed by the code under test. Requests go to 127.0.0.1 only. A failing case throws
// a RunError naming it.
//
// Private to the implementation: only cli.mjs is a command.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { highlightLines } from '../../ui/highlight.js';
import { listFiles, readSource } from './files.mjs';
import { applyEdits, cleanAnnotation, startServer } from './server.mjs';
import { RunError, createSession, finishRun, readStored, restoreSession, saveSession, scopePath } from './session.mjs';

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

// Tokenizes `lines`, checks that every line's tokens join back to the line, and returns a
// lookup: `typeOf(lineIndex, substring, from)` is the one token type covering every character
// of that substring, or `mixed:<types>` when it straddles two types.
function tokenize(lines, file) {
  const tokens = highlightLines(lines, file);
  assert(tokens.length === lines.length, `${file}: ${tokens.length} token lines for ${lines.length} lines`);
  tokens.forEach((line, i) => {
    assertEqual(line.map((t) => t.text).join(''), lines[i], `${file} line ${i + 1} text`);
  });
  return (lineIndex, substring, from = 0) => {
    const line = lines[lineIndex];
    const start = line.indexOf(substring, from);
    assert(start !== -1, `${file} line ${lineIndex + 1} has no "${substring}"`);
    const types = new Set();
    let offset = 0;
    for (const token of tokens[lineIndex]) {
      const end = offset + token.text.length;
      if (end > start && offset < start + substring.length) {
        types.add(token.type);
      }
      offset = end;
    }
    return types.size === 1 ? [...types][0] : `mixed:${[...types].join(',')}`;
  };
}

function expectType(typeOf, lineIndex, substring, expected, from = 0) {
  const actual = typeOf(lineIndex, substring, from);
  assert(actual === expected, `line ${lineIndex + 1} "${substring}": expected ${expected}, got ${actual}`);
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
        resolve({ status: res.statusCode, json, text });
      });
      res.on('error', reject);
    });
    req.setTimeout(WAIT_MS, () => req.destroy(new CaseFailure(`${method} ${target}: no reply after ${WAIT_MS} ms`)));
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

// A server on port 0 over a temp root holding `a.txt`, with the session and save that
// `cli.mjs annotate` builds: `finished` settles with the result document the run would print.
function withServer(fn) {
  return withTemp(async (root) => {
    write(root, 'a.txt', 'a\n');
    const files = listFiles(root, []);
    assertEqual(files, ['a.txt'], 'fixture listing');
    const out = path.join(root, 'claudedocs', 'margin', 'notes.json');
    const session = createSession({ stored: null, out, root, scope: [], revision: null });
    const save = () => saveSession(session);
    let settle;
    const finished = new Promise((resolve) => {
      settle = resolve;
    });
    const { url, close } = await startServer({
      port: 0,
      token: TOKEN,
      session,
      files,
      readSource: (p) => readSource(root, p),
      onSave: save,
      onFinish: (status) => settle(finishRun({ session, status, out, root, scope: [], save })),
    });
    try {
      const parsed = new URL(url);
      const port = Number(parsed.port);
      assert(parsed.hostname === '127.0.0.1' && port > 0, `the server is not on a loopback port: ${url}`);
      assert(parsed.hash === `#${TOKEN}`, `the viewer URL does not carry the token: ${url}`);
      const host = `127.0.0.1:${port}`;
      return await fn({ port, host, root, out, save, finished: () => within(finished, 'the end of the run') });
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

const ALLOWED = new Set(['src/a.js', 'src/b/c.js']);

const CASES = [
  ['highlight: js block comment and template literal across lines', () => {
    const typeOf = tokenize(['const a = 1; /* start', 'still comment */ let b = `x', 'y` + 2;'], 'a.js');
    expectType(typeOf, 0, 'const', 'keyword');
    expectType(typeOf, 0, '/* start', 'comment');
    expectType(typeOf, 1, 'still comment */', 'comment');
    expectType(typeOf, 1, 'let', 'keyword');
    expectType(typeOf, 1, '`x', 'string');
    expectType(typeOf, 2, 'y`', 'string');
    expectType(typeOf, 2, '2', 'number');
  }],
  ['highlight: tsx tag mode and generics', () => {
    const typeOf = tokenize(
      ['const el = <div className="a" for="b">', '  {a > b ? <Item key={1} /> : null}', 'const xs: Array<string> = [];'],
      'a.tsx',
    );
    expectType(typeOf, 0, 'const', 'keyword');
    expectType(typeOf, 0, '<div', 'tag');
    expectType(typeOf, 0, '"a"', 'string');
    expectType(typeOf, 0, 'for', null);
    expectType(typeOf, 0, '>', 'tag', 30);
    expectType(typeOf, 1, '>', null);
    expectType(typeOf, 1, '<Item', 'tag');
    expectType(typeOf, 1, '/>', 'tag');
    expectType(typeOf, 1, 'null', 'keyword');
    expectType(typeOf, 2, '<', null);
    expectType(typeOf, 2, 'string', 'keyword');
    expectType(typeOf, 2, '>', null);
  }],
  ['highlight: markdown fences', () => {
    const typeOf = tokenize(['# Title', '```js', 'const x = 1;', '```', 'text `code`'], 'a.md');
    expectType(typeOf, 0, '# Title', 'keyword');
    expectType(typeOf, 1, '```js', 'string');
    expectType(typeOf, 2, 'const x = 1;', 'string');
    expectType(typeOf, 3, '```', 'string');
    expectType(typeOf, 4, 'text ', null);
    expectType(typeOf, 4, '`code`', 'string');
  }],
  ['highlight: python triple quotes', () => {
    const typeOf = tokenize(['s = """doc', 'more', '""" + x  # tail'], 'a.py');
    expectType(typeOf, 0, 's = ', null);
    expectType(typeOf, 0, '"""doc', 'string');
    expectType(typeOf, 1, 'more', 'string');
    expectType(typeOf, 2, '"""', 'string');
    expectType(typeOf, 2, ' + x  ', null);
    expectType(typeOf, 2, '# tail', 'comment');
  }],
  ['highlight: an unknown extension is one plain token per line', () => {
    const lines = ['const a = 1; // x', '"text"'];
    assertEqual(highlightLines(lines, 'a.xyz'), [[{ type: null, text: lines[0] }], [{ type: null, text: lines[1] }]], 'a.xyz tokens');
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
  ['guards: host, origin and token', () => withServer(async ({ port, host }) => {
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

    const ok = await request(port, { headers: { host, ...token } });
    assert(ok.status === 200, `a request with the token got ${ok.status}`);
    assertEqual(ok.json.files, ['a.txt'], 'listed files');
    assert(ok.json.session.overall === '', 'a write without the token reached the session');
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
      assertEqual(doc, { status: 'cancelled', out: null, annotations: 0, root, scope: [] }, 'result document');
      assertEqual(Object.keys(doc), ['status', 'out', 'annotations', 'root', 'scope'], 'result document keys');
      assert(!fs.existsSync(out), 'an empty cancel left the notes file behind');
    });
    await withServer(async ({ port, host, root, out, save, finished }) => {
      save();
      const note = { id: 'n1', anchor: { kind: 'scope' }, body: 'keep me' };
      const reply = await request(port, { method: 'POST', target: '/api/cancel', headers: { host, 'x-margin-token': TOKEN }, body: { overall: '', annotations: [note] } });
      assert(reply.status === 200, `cancel with a note got ${reply.status}`);
      assertEqual(await finished(), { status: 'cancelled', out, annotations: 1, root, scope: [] }, 'result document with a note');
      const kept = JSON.parse(fs.readFileSync(out, 'utf8'));
      assert(kept.status === 'cancelled' && kept.annotations.length === 1, `a cancel with a note saved ${JSON.stringify(kept).slice(0, 200)}`);
    });
  }],
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
