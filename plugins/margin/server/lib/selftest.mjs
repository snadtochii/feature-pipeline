// `cli.mjs --self-test` (CONTRACT.md §12).
//
// Exercises what no browser session proves, without a browser. It checks the viewer's colouring
// seam over the vendored highlight.js on a fixed TSX sample, and the routes that serve both. It
// checks the viewer's round controller over a fake server and a fake view: the anchor rule
// against the listing and the overview's candidate names, the Send rule with withheld candidate
// notes left out, writes running one at a time with the newest session, a
// refresh merging the server copy by ownership, Send, Finish and Cancel with each refusal, and
// the change wait's backoff, reconnection and end. It checks the viewer's outline model: rows
// grouped by scope entry and folder, imported-by, candidate membership, bars, the anchor rule per
// row, note counts, and the route serving it. It checks the diagram model: a document rebuilt in
// canonical key order, each refusal, the canonical text and its byte-identical round trip, a
// layout that is deterministic, never moves a positioned box, ranks through cycles and keeps each
// group's members contiguous inside frames that are their bounds, places a new member of a
// positioned group beside its members without its frame meeting another group's, and the diagram file's reading
// refusals and size limit; arrow geometry (a lone arrow straight between box borders, parallel and
// opposite arrows spread apart, nested self-loops), the bounds and the fit transform, and a
// diagram session's listing of linked regular files only. It checks the viewer's diagram edits:
// each edit checked and its input untouched, removals cleaning walkthrough steps, ids, the group
// a dropped box lands in, the layouts, and the save ordering with its failures. It checks the note rules (the anchor rule per kind,
// a new candidate note outside the overview refusing the write, range validity, the excerpt cap),
// resuming a notes file (a stored note keeps its anchor; rounds and note rounds restore; a file
// without rounds is round 0; the refusals), the atomic save keeping the file's mode, the sent-note lock, a Send withholding
// the candidate notes the overview does not name, the agent's replies
// (kept through a viewer write and a resume, each resume refusal for them, a reply post whose
// save fails changing nothing), the scope rule, file listing that never lists a symlink, and
// the reading refusals and limits. Against a server on port 0 inside this process it checks the
// request guards, a submit that sends a round and keeps serving, finish, cancel (on empty, and
// after a sent round), `wait` returning on a submit and on the end of the run, the reply route
// (sent notes only, its refusals, all or nothing, 409 after the end), re-listing after a reply
// (a new file accepted as a `file` anchor, a deleted listed file answering 404), and the change
// wait returning on a reply and on the end. It checks the overview document: a document accepted
// with its unknown fields dropped, each shape refusal, each reading refusal and the size limit,
// the overview route behind the token and its 404 without an overview, candidate notes accepted
// for the overview's names and refused on every write route otherwise, and a listing that never
// lists the overview file. Against a diagram session's server, with no notes session, it checks
// the diagram route, the null session, linked-file reads, the notes routes answering 404 and
// Finish ending it, and its save route: a canonical write served afterwards, each refusal and a
// file changed on disk leaving the file as it was, a save after the end, and the 404 without a
// writer. It checks the overview data: the import scan and its resolution
// against the listing and tsconfig `paths`, the line count, indent width and indentation, churn
// from dated commits in a temporary repository, the hotspot table, explorer blocks parsed and
// dropped, roles merged, each notice, and the size limit. Through `cli.mjs` children it checks
// the command's own refusals (children that must exit before serving, `wait`'s invocation
// refusals, each `--overview` refusal leaving `--out` as it was, the `measure` and
// `assemble` refusals writing nothing, `diagram --check` exiting 0, 1 and 2 with the file
// left as it was, and a diagram session's refusals exiting before binding) and end-to-end runs:
// a diagram session's stderr block, root default and override, a save writing the canonical
// text, and its document on Finish and on SIGTERM with nothing else written, a submit, a `wait` child, finish,
// and exactly one result document, a run ended by SIGTERM, a run serving its overview and
// sending a candidate note, and
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
import { applyEdits, cleanAnnotation, refuseCandidates } from './annotations.mjs';
import { assembleOverview, readMeasurement, readOptional, serialiseOverview } from './assemble.mjs';
import { createResolver, parseJsonc, scanSpecifiers } from './imports.mjs';
import { countLines, detectWidth, indentation, measureScope } from './measure.mjs';
import { MAX_OVERVIEW_BYTES, checkOverview, readOverview } from './overview.mjs';
import { startServer } from './server.mjs';
import { RunError, createSession, finishRun, postReplies, readStored, restoreSession, saveSession, scopePath, sendRound, writeAtomic } from './session.mjs';
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
      onSend: (candidates) => sendRound(session, candidates),
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

// A diagram session's server on port 0 over a temp root holding `a.txt`, as `cli.mjs diagram
// <file>` wires it: no notes session, the given listing, and `finished` settling with the
// diagram session document. With `save`, the diagram file holds `text` (the document's
// canonical text by default) and the server saves to it as the session's writer does.
function withDiagramServer(fn, { document, files, save = false, text }) {
  return withTemp(async (root) => {
    write(root, 'a.txt', 'a\n');
    const file = path.join(root, 'd.diagram.json');
    let saveDiagram = null;
    if (save) {
      const { serializeDiagram } = await loadDiagramModel();
      const { diagramWriter } = await loadDiagramReader();
      const start = text ?? serializeDiagram(document);
      write(root, 'd.diagram.json', start);
      const writer = diagramWriter(file, start);
      saveDiagram = (edited) => writer.save(edited);
    }
    const { url, close, ended } = await startServer({
      port: 0,
      token: TOKEN,
      session: null,
      files,
      readSource: (p) => readSource(root, p),
      relist: () => files,
      onEnd: (status) => ({ status, file }),
      diagram: { file, root, document },
      saveDiagram,
    });
    try {
      const port = Number(new URL(url).port);
      return await fn({ port, host: `127.0.0.1:${port}`, root, file, finished: () => within(ended, 'the end of the diagram session') });
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
const loadOverviewModel = () => import('../../ui/overview.js');
const loadDiagramModel = () => import('../../ui/diagram.js');
const loadDiagramReader = () => import('./diagram.mjs');
const loadDiagramEdit = () => import('../../ui/diagram-edit.js');

const tick =() => new Promise((resolve) => setImmediate(resolve));

// ---- the diagram model (ui/diagram.js) --------------------------------------------------------

const diagramBox = (id, extra = {}) => ({ id, label: id.toUpperCase(), kind: 'module', files: [], ...extra });
const diagramArrow = (id, from, to) => ({ id, from, to, label: '', why: '' });
const diagramOf = (parts) => ({ groups: [], boxes: [], arrows: [], walkthroughs: [], ...parts });

// Every field present somewhere, every entry's keys written out of canonical order, one box with
// both optional fields and one with neither, and a group with no members.
function diagramFixture() {
  return {
    walkthroughs: [{ steps: [{ text: 'The skill starts the server.', arrows: ['starts'] }, { arrows: [], text: 'It waits.' }], name: 'Starting a review' }],
    arrows: [{ why: 'The skill runs it in the background.', label: 'starts', to: 'cli', from: 'skill', id: 'starts' }],
    boxes: [
      { y: 84, x: 60, group: 'server', files: ['server/cli.mjs'], kind: 'process', label: 'cli.mjs', id: 'cli' },
      { files: [], kind: 'agent', label: 'annotate skill', id: 'skill' },
    ],
    groups: [{ label: 'Server', id: 'server' }, { label: 'Empty', id: 'empty' }],
  };
}

const DIAGRAM_FIXTURE_TEXT = [
  '{',
  '  "groups": [',
  '    {"id":"server","label":"Server"},',
  '    {"id":"empty","label":"Empty"}',
  '  ],',
  '  "boxes": [',
  '    {"id":"cli","label":"cli.mjs","kind":"process","files":["server/cli.mjs"],"group":"server","x":60,"y":84},',
  '    {"id":"skill","label":"annotate skill","kind":"agent","files":[]}',
  '  ],',
  '  "arrows": [',
  '    {"id":"starts","from":"skill","to":"cli","label":"starts","why":"The skill runs it in the background."}',
  '  ],',
  '  "walkthroughs": [',
  '    {',
  '      "name": "Starting a review",',
  '      "steps": [',
  '        {"arrows":["starts"],"text":"The skill starts the server."},',
  '        {"arrows":[],"text":"It waits."}',
  '      ]',
  '    }',
  '  ]',
  '}',
  '',
].join('\n');

async function assertDiagramRefuses(value, message, what) {
  const { DiagramViolation, checkDiagram } = await loadDiagramModel();
  try {
    checkDiagram(value);
  } catch (err) {
    assert(err instanceof DiagramViolation, `${what}: expected a DiagramViolation, got ${err.constructor.name}: ${err.message}`);
    assertEqual(err.message, message, what);
    return;
  }
  throw new CaseFailure(`${what}: expected "${message}", nothing was thrown`);
}

const positionsOf = (doc) => doc.boxes.map((box) => [box.id, box.x, box.y]);

function gapBetween(a, b) {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  return Math.max(dx, dy);
}

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

const ALLOWED = { paths: new Set(['src/a.js', 'src/b/c.js']), candidates: new Set(['split-parsing']) };

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
  ["viewer rounds: candidate notes follow the overview's names", async () => {
    const candidate = (id, name, extra) => viewerNote(id, { kind: 'candidate', name }, extra);
    const server = viewerSession([candidate('withheld', 'merge-io')]);
    const h = await roundsHarness(
      roundsRoutes(viewerSession(), undefined, {
        'GET /api/session': () => ({ session: structuredClone(server), files: ['src/a.js'], changes: 1 }),
      }),
    );
    await h.rounds.load();
    assert(!h.rounds.listed({ kind: 'candidate', name: 'split-parsing' }), 'a candidate is listed before the names are set');
    h.rounds.setCandidates(['split-parsing']);
    assert(h.rounds.listed({ kind: 'candidate', name: 'split-parsing' }), 'an overview candidate is not listed');
    assert(!h.rounds.listed({ kind: 'candidate', name: 'merge-io' }), 'a candidate outside the overview is listed');
    assert(!h.rounds.listed({ kind: 'candidate' }), 'a candidate anchor without a name is listed');
    assertEqual(h.rounds.unsent().map((a) => a.id), ['withheld'], 'the unsent notes');
    assert(h.rounds.withheld(h.rounds.session.annotations[0]), 'the stored note outside the overview is not withheld');
    assertEqual(h.rounds.sendable(), [], 'the sendable notes with only a withheld note');
    assert(!h.rounds.canSend(), 'Send is allowed with only a withheld note');
    assert(!h.rounds.withheld(candidate('sent', 'merge-io', { round: 1 })), 'a sent candidate note is withheld');
    h.rounds.addNote(candidate('local', 'split-parsing'));
    h.rounds.addNote(candidate('stray', 'cache-layer'));
    assertEqual(h.rounds.sendable().map((a) => a.id), ['local'], 'the sendable notes');
    assert(h.rounds.canSend(), 'Send is refused with a note on an overview candidate');
    h.take();
    await h.rounds.refresh();
    assertEqual(h.rounds.session.annotations.map((a) => a.id), ['withheld', 'local'], 'the notes after a refresh');
    assertEqual(h.take().filter((e) => Array.isArray(e) && e[0] === 'dropped'), [['dropped', ['stray']]], 'the notes a refresh dropped');
    h.rounds.setCandidates([]);
    assert(!h.rounds.listed({ kind: 'candidate', name: 'split-parsing' }), 'a candidate is listed once the names are cleared');
    assert(!h.rounds.sendHeld(), 'Send is held for a run without an overview');
    h.rounds.setCandidates(null);
    assert(!h.rounds.listed({ kind: 'candidate', name: 'split-parsing' }), 'a candidate is listed while the names are unknown');
    assert(h.rounds.sendHeld(), 'Send is not held while the names are unknown and candidate notes are unsent');
    assertEqual(h.rounds.sendable(), [], 'the sendable notes while the names are unknown');
    h.overall = 'direction';
    assert(!h.rounds.canSend(), 'Send is allowed for a new overall text while the names are unknown');
    h.take();
    await h.rounds.sendRound();
    assert(!h.requests().includes('POST /api/submit'), 'a held Send posted a round');
    h.rounds.addNote(viewerNote('scoped'));
    assert(!h.rounds.canSend(), 'Send is allowed for a scope note while candidate notes are unsent and the names unknown');
    h.rounds.deleteNote('withheld');
    h.rounds.deleteNote('local');
    assert(!h.rounds.sendHeld() && h.rounds.canSend(), 'Send stays held once no candidate note is unsent');
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
  ['viewer overview: the outline model groups rows, counts notes and serves the overview modules', async () => {
    const { buildOutline, noteCounts, CANDIDATE_COLOURS } = await loadOverviewModel();
    const entry = (p, churn, indentation, imports = []) => ({ path: p, lines: 10, churn, indentation, kind: null, role: null, exports: null, mixes: null, imports, outside: [] });
    const candidate = (name, files) => ({ name, tier: 'strong', category: 'in-process', files, next_change: 'x', next_sites: [], est_diff_lines: 1, deletion_test: 'x', friction: 'x' });
    const doc = checkOverview({
      version: 1,
      root: OVERVIEW_ROOT,
      scope: ['src'],
      generatedAt: '2026-10-30T12:00:00Z',
      files: [
        entry('src/a.js', 8, 20, ['src/b.js', 'src/lib/c.js']),
        entry('src/b.js', 2, 5),
        entry('src/lib/c.js', 4, 10, ['src/b.js']),
        entry('src/lib/deep/d.js', null, null),
        entry('tools/x.js', 0, 0),
        entry('notes.md', 0, 0),
      ],
      candidates: [candidate('one', ['src/a.js', 'src/b.js']), candidate('two', ['src/lib/c.js', 'src/a.js'])],
      notices: [],
    });
    const listing = ['notes.md', 'src/a.js', 'src/b.js', 'src/lib/c.js', 'src/lib/deep/d.js'];
    const listed = (anchor) => (anchor.kind === 'folder' ? anchor.path !== '' && anchor.path !== '.' && listing.some((p) => p.startsWith(`${anchor.path}/`)) : listing.includes(anchor.path));
    const shape = (row) =>
      row.type === 'folder'
        ? [row.type, row.path, row.name, row.depth, row.files, row.folders, row.listed]
        : [row.type, row.path, row.name, row.depth, row.folder, row.candidates, row.churnBar, row.tangleBar, row.listed, row.folderListed];
    const outline = buildOutline(doc, { listed });
    assertEqual(outline.groups.map((g) => g.entry), ['src', '.'], 'the groups');
    assertEqual(
      outline.groups[0].rows.map(shape),
      [
        ['folder', 'src', 'src', 0, 2, 1, true],
        ['file', 'src/a.js', 'a.js', 1, 'src', [0, 1], 1, 1, true, true],
        ['file', 'src/b.js', 'b.js', 1, 'src', [0], 0.25, 0.25, true, true],
        ['folder', 'src/lib', 'lib', 1, 1, 1, true],
        ['file', 'src/lib/c.js', 'c.js', 2, 'src/lib', [1], 0.5, 0.5, true, true],
        ['folder', 'src/lib/deep', 'deep', 2, 1, 0, true],
        ['file', 'src/lib/deep/d.js', 'd.js', 3, 'src/lib/deep', [], null, null, true, true],
      ],
      'the rows under src',
    );
    assertEqual(
      outline.groups[1].rows.map(shape),
      [
        ['folder', '.', '.', 0, 1, 1, false],
        ['file', 'notes.md', 'notes.md', 1, '', [], 0, 0, true, false],
        ['folder', 'tools', 'tools', 1, 1, 0, false],
        ['file', 'tools/x.js', 'x.js', 2, 'tools', [], 0, 0, false, false],
      ],
      'the rows under no scope entry',
    );
    assert(outline.groups[0].rows[1].file === doc.files[0] && outline.byPath.get('src/lib/c.js') === doc.files[2], 'a row does not carry its document entry');
    assertEqual(outline.importedBy.get('src/b.js'), ['src/a.js', 'src/lib/c.js'], 'imported-by of src/b.js');
    assertEqual(outline.importedBy.get('src/a.js'), [], 'imported-by of src/a.js');
    assertEqual(outline.candidatesOf('src/a.js'), [0, 1], 'the candidates touching src/a.js');
    assertEqual([outline.maxChurn, outline.maxIndent], [8, 20], 'the bar scales');
    assertEqual(
      buildOutline({ ...doc, scope: ['.'] }, { listed }).groups.map((g) => [g.entry, g.rows.map((r) => r.path)]),
      [['.', ['.', 'notes.md', 'src', 'src/a.js', 'src/b.js', 'src/lib', 'src/lib/c.js', 'src/lib/deep', 'src/lib/deep/d.js', 'tools', 'tools/x.js']]],
      'a scope of the root',
    );
    assertEqual(
      buildOutline({ ...doc, scope: ['src', 'src/lib'] }, { listed }).groups.map((g) => [g.entry, g.rows.map((r) => r.path)]),
      [['src', ['src', 'src/a.js', 'src/b.js']], ['src/lib', ['src/lib', 'src/lib/c.js', 'src/lib/deep', 'src/lib/deep/d.js']], ['.', ['.', 'notes.md', 'tools', 'tools/x.js']]],
      'a file under nested scope entries belongs to the longer one',
    );
    assertEqual(
      buildOutline({ ...doc, scope: ['src/a.js', 'src/lib'] }, { listed }).groups.map((g) => [g.entry, g.rows.map((r) => r.path)]),
      [['src/lib', ['src/lib', 'src/lib/c.js', 'src/lib/deep', 'src/lib/deep/d.js']], ['.', ['.', 'notes.md', 'src', 'src/a.js', 'src/b.js', 'tools', 'tools/x.js']]],
      'a file scope entry is grouped under its folder, not as a folder of its own',
    );
    const unmeasured = buildOutline({ ...doc, files: [entry('src/a.js', null, null)], candidates: [] }, { listed });
    assertEqual([unmeasured.maxChurn, unmeasured.groups[0].rows[1].churnBar], [1, null], 'a document without readings');
    assertEqual(buildOutline({ ...doc, files: [], candidates: [] }, { listed }).groups.map((g) => g.rows.map(shape)), [[['folder', 'src', 'src', 0, 0, 0, true]]], 'a document without files');
    const fixture = buildOutline(expectedOverview(OVERVIEW_ROOT), { listed: () => true });
    assertEqual(
      fixture.groups.map((g) => g.rows.map(shape)),
      [[['folder', 'src', 'src', 0, 2, 0, true], ['file', 'src/a.js', 'a.js', 1, 'src', [0], 1, 1, true, true], ['file', 'src/b.js', 'b.js', 1, 'src', [0], null, null, true, true]]],
      'the shape-check fixture',
    );
    assert(CANDIDATE_COLOURS.length > 1 && CANDIDATE_COLOURS.every((c) => /^#[0-9a-f]{6}$/.test(c)), 'the candidate palette is not a list of colours');
    const note = (anchor) => ({ id: 'n', anchor, intent: 'change', body: 'b', createdAt: 't' });
    const counts = noteCounts([
      note({ kind: 'scope' }),
      note({ kind: 'folder', path: 'src' }),
      note({ kind: 'file', path: 'src/a.js' }),
      note({ kind: 'range', path: 'src/b.js', start: 1, end: 1 }),
      note({ kind: 'range', path: 'src/b.js', start: 2, end: 3 }),
      note({ kind: 'candidate', name: 'split-parsing' }),
    ]);
    assertEqual(Object.fromEntries(counts), { 'folder:src': 1, 'file:src/a.js': 1, 'file:src/b.js': 2, 'candidate:split-parsing': 1 }, 'the note counts');
    await withServer(async ({ port, host }) => {
      const reply = await request(port, { target: '/overview.js', headers: { host } });
      assert(reply.status === 200 && reply.type.startsWith('text/javascript'), `/overview.js got ${reply.status} ${reply.type}`);
      const view = await request(port, { target: '/overview-view.js', headers: { host } });
      assert(view.status === 200 && view.type.startsWith('text/javascript'), `/overview-view.js got ${view.status} ${view.type}`);
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

    assertEqual(
      cleanAnnotation({ id: 'c1', anchor: { kind: 'candidate', name: 'split-parsing', path: 'src/a.js', start: 1 }, body: 'b', intent: 'change', createdAt: 't' }, ALLOWED),
      { id: 'c1', anchor: { kind: 'candidate', name: 'split-parsing' }, intent: 'change', body: 'b', createdAt: 't' },
      'cleaned candidate note',
    );
    assert(!keep({ kind: 'candidate', name: 'merge-io' }), 'a candidate note on a name outside the overview was kept');
    for (const name of [undefined, '', '-x', 'Split', 'a b', 42]) {
      assert(!keep({ kind: 'candidate', name }), `a candidate note named ${JSON.stringify(name)} was kept`);
    }
    assertEqual(
      cleanAnnotation({ id: 'c2', anchor: { kind: 'candidate', name: 'merge-io' }, body: 'b', createdAt: 't' }, null)?.anchor,
      { kind: 'candidate', name: 'merge-io' },
      'a candidate note read back from the file, outside the overview',
    );
    assert(cleanAnnotation({ anchor: { kind: 'candidate', name: 'Merge' }, body: 'b' }, null) === null, 'a candidate note read back with a bad name was kept');
  }],
  ['annotations: a new candidate note outside the overview refuses the write', () => {
    const session = {
      annotations: [
        { id: 's1', anchor: { kind: 'candidate', name: 'gone' }, intent: 'change', body: 'sent', createdAt: 't', round: 1 },
        { id: 'u1', anchor: { kind: 'candidate', name: 'gone' }, intent: 'change', body: 'unsent', createdAt: 't' },
      ],
    };
    const refuse = (annotations, allowed = ALLOWED) => refuseCandidates(session, { annotations }, allowed);
    const candidate = (name, extra = {}) => ({ anchor: { kind: 'candidate', name }, body: 'b', ...extra });
    assert(refuse([candidate('split-parsing'), { anchor: { kind: 'file', path: 'src/x.js' }, body: 'b' }]) === null, 'a known candidate and an unlisted file refused the write');
    assertEqual(refuse([{ anchor: { kind: 'scope' }, body: 'b' }, candidate('merge-io')]), 'entry 1: "merge-io" is not a candidate of this run\'s overview', 'one unknown candidate');
    assertEqual(
      refuse([candidate('merge-io'), candidate('split-parsing'), candidate('cache-layer', { id: 'n9' })]),
      'entry 0: "merge-io" is not a candidate of this run\'s overview; entry 2: "cache-layer" is not a candidate of this run\'s overview',
      'two unknown candidates',
    );
    assert(refuse([candidate('gone', { id: 'u1' })]) === null, 'a revision of a stored unsent candidate note refused the write');
    assert(refuse([candidate('gone', { id: 's1' })]) === null, 'an entry carrying a sent note id refused the write');
    for (const [name, shown] of [['Merge', '"Merge"'], ['', '""'], ['-x', '"-x"'], [42, '42'], [undefined, 'null']]) {
      assertEqual(refuse([candidate(name)]), `entry 0: ${shown} is not a candidate of this run's overview`, `a candidate name ${shown} that breaks the name rule`);
    }
    assert(refuse([{ anchor: { kind: 'candidate', name: 'split-parsing' }, body: 7 }]) === null, 'a known candidate with a malformed body refused the write');
    assertEqual(
      refuse([{ anchor: { kind: 'candidate', name: 'merge-io' }, body: 7 }]),
      'entry 0: "merge-io" is not a candidate of this run\'s overview',
      'an unknown candidate with a malformed body',
    );
    assert(refuseCandidates(session, { overall: 'o' }, ALLOWED) === null, 'a write without annotations was refused');
    assertEqual(
      refuse([candidate('split-parsing')], { paths: ALLOWED.paths, candidates: new Set() }),
      'entry 0: "split-parsing" is not a candidate of this run\'s overview',
      'a candidate note in a run without an overview',
    );
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
    throwsRun(
      () => restoreSession({ annotations: [{ anchor: { kind: 'candidate' }, body: 'x' }, { anchor: { kind: 'scope' }, body: 'ok' }] }, out),
      1,
      '1 of 2 notes are malformed (indices 0)',
    );
    const resumed = restoreSession({ annotations: [{ id: 'c1', anchor: { kind: 'candidate', name: 'merge-io' }, body: 'kept', createdAt: 't' }] }, out);
    applyEdits(resumed, { annotations: [{ id: 'c1', body: 'kept, revised' }] }, { paths: ALLOWED.paths, candidates: new Set() });
    assertEqual(
      resumed.annotations,
      [{ id: 'c1', anchor: { kind: 'candidate', name: 'merge-io' }, intent: 'change', body: 'kept, revised', createdAt: 't' }],
      'a resumed candidate note outside the overview after a write',
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
  ['diagram: the check accepts a document and rebuilds it in canonical key order', async () => {
    const { checkDiagram } = await loadDiagramModel();
    const input = diagramFixture();
    const checked = checkDiagram(input);
    assertEqual(checked, {
      groups: [{ id: 'server', label: 'Server' }, { id: 'empty', label: 'Empty' }],
      boxes: [
        { id: 'cli', label: 'cli.mjs', kind: 'process', files: ['server/cli.mjs'], group: 'server', x: 60, y: 84 },
        { id: 'skill', label: 'annotate skill', kind: 'agent', files: [] },
      ],
      arrows: [{ id: 'starts', from: 'skill', to: 'cli', label: 'starts', why: 'The skill runs it in the background.' }],
      walkthroughs: [{ name: 'Starting a review', steps: [{ arrows: ['starts'], text: 'The skill starts the server.' }, { arrows: [], text: 'It waits.' }] }],
    }, 'the checked document');
    assertEqual(Object.keys(checked), ['groups', 'boxes', 'arrows', 'walkthroughs'], 'top-level key order');
    assertEqual(Object.keys(checked.groups[0]), ['id', 'label'], 'group key order');
    assertEqual(Object.keys(checked.boxes[0]), ['id', 'label', 'kind', 'files', 'group', 'x', 'y'], 'positioned box key order');
    assertEqual(Object.keys(checked.boxes[1]), ['id', 'label', 'kind', 'files'], 'a box without the optional keys');
    assertEqual(Object.keys(checked.arrows[0]), ['id', 'from', 'to', 'label', 'why'], 'arrow key order');
    assertEqual(Object.keys(checked.walkthroughs[0]), ['name', 'steps'], 'walkthrough key order');
    assertEqual(Object.keys(checked.walkthroughs[0].steps[0]), ['arrows', 'text'], 'step key order');
    input.boxes[0].files.push('other.js');
    input.walkthroughs[0].steps[0].arrows.push('starts');
    assertEqual(checked.boxes[0].files, ['server/cli.mjs'], 'the checked files alias the input');
    assertEqual(checked.walkthroughs[0].steps[0].arrows, ['starts'], 'the checked step arrows alias the input');
    assertEqual(checkDiagram(diagramOf({})), diagramOf({}), 'an empty diagram');
    const loops = diagramOf({ boxes: [diagramBox('a'), diagramBox('b', { x: -40, y: 0 })], arrows: [diagramArrow('1', 'a', 'a'), diagramArrow('2', 'a', 'b'), diagramArrow('3', 'a', 'b')] });
    assertEqual(checkDiagram(structuredClone(loops)), loops, 'a self-loop, parallel arrows and a negative position');
  }],
  ['diagram: the check refuses each violation', async () => {
    const cases = [
      [() => null, 'the document is not an object'],
      [(d) => [d], 'the document is not an object'],
      [(d) => { d.title = 'x'; }, 'the document has unknown key title'],
      [(d) => { delete d.arrows; }, 'missing key arrows'],
      [(d) => { d.boxes = {}; }, 'boxes is not an array'],
      [(d) => { d.groups[0].frame = {}; }, 'groups[0] has unknown key frame'],
      [(d) => { d.boxes[1].width = 120; }, 'boxes[1] has unknown key width'],
      [(d) => { d.boxes[0] = { bogus: 1 }; }, 'boxes[0] has unknown key bogus'],
      [(d) => { d.arrows[0].kind = 'call'; }, 'arrows[0] has unknown key kind'],
      [(d) => { d.walkthroughs[0].id = 'w'; }, 'walkthroughs[0] has unknown key id'],
      [(d) => { d.walkthroughs[0].steps[1].box = 'cli'; }, 'walkthroughs[0].steps[1] has unknown key box'],
      [(d) => { d.boxes[1] = 'skill'; }, 'boxes[1] is not an object'],
      [(d) => { d.walkthroughs[0].steps[0] = null; }, 'walkthroughs[0].steps[0] is not an object'],
      [(d) => { d.groups[1].id = 'server'; }, 'groups[1].id duplicates groups[0].id'],
      [(d) => { d.boxes[1].id = 'cli'; }, 'boxes[1].id duplicates boxes[0].id'],
      [(d) => { d.arrows.push(structuredClone(d.arrows[0])); }, 'arrows[1].id duplicates arrows[0].id'],
      [(d) => { d.walkthroughs.push(structuredClone(d.walkthroughs[0])); }, 'walkthroughs[1].name duplicates walkthroughs[0].name'],
      [(d) => { d.arrows[0].from = 'nobody'; }, 'arrows[0].from names no box nobody'],
      [(d) => { d.arrows[0].to = 'nowhere'; }, 'arrows[0].to names no box nowhere'],
      [(d) => { d.boxes[1].group = 'ghost'; }, 'boxes[1].group names no group ghost'],
      [(d) => { d.walkthroughs[0].steps[0].arrows = ['starts', 'gone']; }, 'walkthroughs[0].steps[0].arrows[1] names no arrow gone'],
      [(d) => { d.boxes[0].kind = 'service'; }, 'boxes[0].kind is not one of module, process, agent, actor, store, concept'],
      [(d) => { d.boxes[0].x = 1.5; }, 'boxes[0].x is not a safe integer'],
      [(d) => { d.boxes[0].y = '84'; }, 'boxes[0].y is not a safe integer'],
      [(d) => { d.boxes[0].x = 2 ** 53; }, 'boxes[0].x is not a safe integer'],
      [(d) => { delete d.boxes[0].y; }, 'boxes[0].x and boxes[0].y must be given together'],
      [(d) => { d.boxes[1].y = 3; }, 'boxes[1].x and boxes[1].y must be given together'],
      [(d) => { d.boxes[1].id = '-skill'; }, 'boxes[1].id is not an id'],
      [(d) => { d.arrows[0].id = 'a b'; }, 'arrows[0].id is not an id'],
      [(d) => { d.groups[0].id = 3; }, 'groups[0].id is not an id'],
      [(d) => { d.groups[0].label = ''; }, 'groups[0].label is not a non-empty string'],
      [(d) => { delete d.boxes[0].label; }, 'missing key boxes[0].label'],
      [(d) => { d.arrows[0].why = null; }, 'arrows[0].why is not a string'],
      [(d) => { d.boxes[0].files = 'server/cli.mjs'; }, 'boxes[0].files is not an array'],
      [(d) => { d.boxes[0].files = ['/abs/cli.mjs']; }, 'boxes[0].files[0] is not a diagram path'],
      [(d) => { d.boxes[0].files = ['a.js', 'server/../cli.mjs']; }, 'boxes[0].files[1] is not a diagram path'],
      [(d) => { d.boxes[0].files = ['server\\cli.mjs']; }, 'boxes[0].files[0] is not a diagram path'],
      [(d) => { d.boxes[0].files = ['C:/server/cli.mjs']; }, 'boxes[0].files[0] is not a diagram path'],
      [(d) => { d.boxes[0].files = ['server/']; }, 'boxes[0].files[0] is not a diagram path'],
      [(d) => { d.boxes[0].files = ['./cli.mjs']; }, 'boxes[0].files[0] is not a diagram path'],
      [(d) => { d.boxes[0].files = ['']; }, 'boxes[0].files[0] is not a diagram path'],
      [(d) => { d.boxes[0].files = ['a.js', 'b.js', 'a.js']; }, 'boxes[0].files[2] duplicates boxes[0].files[0]'],
      [(d) => { d.walkthroughs[0].steps = []; }, 'walkthroughs[0].steps is not a non-empty array'],
      [(d) => { d.walkthroughs[0].name = ''; }, 'walkthroughs[0].name is not a non-empty string'],
      [(d) => { d.walkthroughs[0].steps[1].text = ''; }, 'walkthroughs[0].steps[1].text is not a non-empty string'],
      [(d) => { d.walkthroughs[0].steps[0].arrows = [3]; }, 'walkthroughs[0].steps[0].arrows[0] is not an id'],
      [(d) => { d.groups[0].label = ''; d.boxes[0].kind = 'service'; }, 'groups[0].label is not a non-empty string'],
      [(d) => { d.boxes[1].group = 'ghost'; d.groups[1].id = 'server'; }, 'groups[1].id duplicates groups[0].id'],
    ];
    for (const [mutate, message] of cases) {
      const doc = diagramFixture();
      const replaced = mutate(doc);
      await assertDiagramRefuses(replaced === undefined ? doc : replaced, message, message);
    }
    const text = JSON.stringify(diagramFixture());
    await assertDiagramRefuses(JSON.parse(`{"__proto__": {"polluted": true}, ${text.slice(1)}`), 'the document has unknown key __proto__', 'a top-level __proto__ key');
    await assertDiagramRefuses(JSON.parse(text.replace('"files":[],', '"__proto__":{},"files":[],')), 'boxes[1] has unknown key __proto__', 'a __proto__ key on a box');
  }],
  ['diagram: canonical serialization is fixed and round-trips byte for byte', async () => {
    const { checkDiagram, serializeDiagram } = await loadDiagramModel();
    assertEqual(serializeDiagram(checkDiagram(diagramFixture())), DIAGRAM_FIXTURE_TEXT, 'the canonical text of the fixture');
    assertEqual(serializeDiagram(diagramOf({})), '{\n  "groups": [],\n  "boxes": [],\n  "arrows": [],\n  "walkthroughs": []\n}\n', 'an empty diagram');
    const awkward = checkDiagram(diagramOf({
      groups: [{ id: 'g', label: 'Group "one"' }],
      boxes: [
        { label: 'Ünïcode\nbox', id: 'a', kind: 'store', files: ['b.js', 'a.js'], group: 'g' },
        { id: 'b', label: 'B', kind: 'actor', files: [], x: -5, y: 0 },
      ],
      walkthroughs: [{ name: 'W', steps: [{ arrows: [], text: 'one' }, { text: 'two', arrows: [] }] }, { name: 'V', steps: [{ arrows: [], text: 'v' }] }],
    }));
    const expected = [
      '{',
      '  "groups": [',
      String.raw`    {"id":"g","label":"Group \"one\""}`,
      '  ],',
      '  "boxes": [',
      String.raw`    {"id":"a","label":"Ünïcode\nbox","kind":"store","files":["b.js","a.js"],"group":"g"},`,
      '    {"id":"b","label":"B","kind":"actor","files":[],"x":-5,"y":0}',
      '  ],',
      '  "arrows": [],',
      '  "walkthroughs": [',
      '    {',
      '      "name": "W",',
      '      "steps": [',
      '        {"arrows":[],"text":"one"},',
      '        {"arrows":[],"text":"two"}',
      '      ]',
      '    },',
      '    {',
      '      "name": "V",',
      '      "steps": [',
      '        {"arrows":[],"text":"v"}',
      '      ]',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n');
    const text = serializeDiagram(awkward);
    assertEqual(text, expected, 'quotes, a line break, non-ASCII, unsorted files and two walkthroughs');
    assertEqual(serializeDiagram(checkDiagram(JSON.parse(text))), text, 'serialize → parse → serialize');
    assertEqual(serializeDiagram(checkDiagram(JSON.parse(DIAGRAM_FIXTURE_TEXT))), DIAGRAM_FIXTURE_TEXT, 'the fixture text round trip');
    const moved = { ...awkward, boxes: [{ y: 2, x: 1, group: 'g', files: [], kind: 'module', label: 'L', id: 'z' }] };
    assert(serializeDiagram(moved).includes('\n    {"id":"z","label":"L","kind":"module","files":[],"group":"g","x":1,"y":2}\n'), 'the serializer did not write a box in canonical key order');
  }],
  ['diagram: layout is deterministic and places every box when none is positioned', async () => {
    const { boxLabel, boxSize, checkDiagram, layoutDiagram } = await loadDiagramModel();
    assertEqual(boxSize({ label: 'ab' }), { w: 120, h: 46 }, 'a short label');
    assertEqual(boxSize({ label: 'x'.repeat(20) }), { w: 182, h: 46 }, 'a 20-character label');
    assertEqual(boxSize({ label: 'x'.repeat(30) }), { w: 230, h: 46 }, 'a long label');
    assertEqual(boxSize({ label: '😀'.repeat(20) }), { w: 182, h: 46 }, 'a label counted in code points');
    for (let n = 1; n <= 26; n += 1) {
      assertEqual(boxLabel({ label: 'x'.repeat(n) }), 'x'.repeat(n), `a ${n}-character label boxSize sized its box for`);
    }
    assertEqual(boxLabel({ label: 'x'.repeat(27) }), `${'x'.repeat(25)}…`, 'the shortest label wider than the widest box');
    assertEqual(boxLabel({ label: 'x'.repeat(40) }), `${'x'.repeat(25)}…`, 'a 40-character label');
    assertEqual(boxLabel({ label: '😀'.repeat(30) }), `${'😀'.repeat(25)}…`, 'a label truncated in code points');
    const chain = checkDiagram(diagramOf({
      boxes: ['a', 'b', 'c', 'd'].map((id) => diagramBox(id)),
      arrows: [diagramArrow('1', 'a', 'b'), diagramArrow('2', 'b', 'c'), diagramArrow('3', 'c', 'd')],
    }));
    const before = structuredClone(chain);
    const laid = layoutDiagram(chain);
    assertEqual(positionsOf(laid), [['a', 60, 84], ['b', 390, 84], ['c', 720, 84], ['d', 1050, 84]], 'a four-box chain');
    assertEqual(chain, before, 'the layout changed its input');
    assertEqual(layoutDiagram(chain), laid, 'a second layout of the same document');
    assertEqual(Object.keys(laid.boxes[0]), ['id', 'label', 'kind', 'files', 'x', 'y'], 'a placed box keeps canonical key order');
    const diamond = checkDiagram(diagramOf({
      boxes: ['a', 'b', 'c', 'd'].map((id) => diagramBox(id)),
      arrows: [diagramArrow('1', 'a', 'b'), diagramArrow('2', 'a', 'c'), diagramArrow('3', 'b', 'd'), diagramArrow('4', 'c', 'd'), diagramArrow('5', 'a', 'd')],
    }));
    const placed = layoutDiagram(diamond);
    assertEqual(positionsOf(placed), [['a', 60, 84], ['b', 390, 84], ['c', 390, 164], ['d', 720, 84]], 'a diamond with an arrow spanning two ranks');
    assert(placed.boxes.every((box) => Number.isInteger(box.x) && Number.isInteger(box.y)), 'a position is not an integer');
    assertEqual(layoutDiagram(diagramOf({})), diagramOf({}), 'an empty diagram');
  }],
  ['diagram: layout never moves a positioned box', async () => {
    const { boxSize, checkDiagram, layoutDiagram } = await loadDiagramModel();
    const mixed = checkDiagram(diagramOf({
      boxes: [diagramBox('a', { x: 60, y: 150 }), diagramBox('b'), diagramBox('c'), diagramBox('d', { x: 2000, y: 2000 })],
      arrows: [diagramArrow('1', 'a', 'b')],
    }));
    const laid = layoutDiagram(mixed);
    assertEqual(positionsOf(laid), [['a', 60, 150], ['b', 390, 84], ['c', 60, 244], ['d', 2000, 2000]], 'a partly positioned diagram');
    const rect = (box) => ({ x: box.x, y: box.y, ...boxSize(box) });
    for (const placedBox of laid.boxes.filter((_, i) => mixed.boxes[i].x === undefined)) {
      for (const fixed of laid.boxes.filter((_, i) => mixed.boxes[i].x !== undefined)) {
        assert(gapBetween(rect(placedBox), rect(fixed)) >= 24, `${placedBox.id} is within 24 of the positioned ${fixed.id}`);
      }
    }
    assertEqual(positionsOf(layoutDiagram(mixed, { all: true })), [['a', 60, 84], ['b', 390, 84], ['c', 60, 164], ['d', 60, 244]], 'all: true lays out every box');
    const fixed = checkDiagram(diagramOf({ boxes: [diagramBox('a', { x: 5, y: -7 }), diagramBox('b', { x: 5, y: -7 })], arrows: [diagramArrow('1', 'a', 'b')] }));
    const kept = layoutDiagram(fixed);
    assertEqual(kept, fixed, 'a fully positioned diagram');
    assert(kept !== fixed && kept.boxes[0] !== fixed.boxes[0], 'the layout returned its input rather than a copy');
  }],
  ['diagram: layout ranks through cycles and self-loops', async () => {
    const { checkDiagram, layoutDiagram } = await loadDiagramModel();
    const two = checkDiagram(diagramOf({
      boxes: [diagramBox('a'), diagramBox('b')],
      arrows: [diagramArrow('1', 'a', 'b'), diagramArrow('2', 'b', 'a'), diagramArrow('3', 'a', 'b')],
    }));
    assertEqual(positionsOf(layoutDiagram(two)), [['a', 60, 84], ['b', 390, 84]], 'a two-cycle with a parallel arrow');
    const three = checkDiagram(diagramOf({
      boxes: [diagramBox('a'), diagramBox('b'), diagramBox('c')],
      arrows: [diagramArrow('1', 'a', 'b'), diagramArrow('2', 'b', 'c'), diagramArrow('3', 'c', 'a'), diagramArrow('4', 'c', 'c')],
    }));
    assertEqual(positionsOf(layoutDiagram(three)), [['a', 60, 84], ['b', 390, 84], ['c', 720, 84]], 'a three-cycle with a self-loop');
    const alone = checkDiagram(diagramOf({ boxes: [diagramBox('a')], arrows: [diagramArrow('1', 'a', 'a')] }));
    assertEqual(positionsOf(layoutDiagram(alone)), [['a', 60, 84]], 'a box whose only arrow is to itself');
  }],
  ['diagram: group members stay contiguous and frames are their bounds', async () => {
    const { checkDiagram, groupFrames, layoutDiagram } = await loadDiagramModel();
    const grouped = checkDiagram(diagramOf({
      groups: [{ id: 'g1', label: 'One' }, { id: 'g2', label: 'Two' }, { id: 'g3', label: 'Empty' }],
      boxes: [diagramBox('a', { group: 'g2' }), diagramBox('b', { group: 'g1' }), diagramBox('c', { group: 'g2' }), diagramBox('d'), diagramBox('e', { group: 'g1' })],
      arrows: [diagramArrow('1', 'a', 'b'), diagramArrow('2', 'a', 'c'), diagramArrow('3', 'd', 'e'), diagramArrow('4', 'c', 'e')],
    }));
    const laid = layoutDiagram(grouped);
    assertEqual(positionsOf(laid), [['a', 60, 244], ['b', 390, 84], ['c', 390, 244], ['d', 60, 404], ['e', 720, 84]], 'two groups across three ranks and an ungrouped box');
    const columns = new Map();
    for (const box of laid.boxes) {
      columns.set(box.x, [...(columns.get(box.x) ?? []), box]);
    }
    for (const [x, column] of columns) {
      const runs = column.sort((p, q) => p.y - q.y).map((box) => box.group ?? '-').filter((group, i, all) => i === 0 || all[i - 1] !== group);
      assert(new Set(runs).size === runs.length, `the column at x ${x} splits a group: ${runs.join(' ')}`);
    }
    const frames = groupFrames(laid);
    assertEqual(frames, [{ id: 'g1', x: 370, y: 40, w: 490, h: 110 }, { id: 'g2', x: 40, y: 200, w: 490, h: 110 }], 'the frames, the empty group without one');
    const [one, two] = frames;
    assert(gapBetween(one, two) > 0, 'two group frames overlap');
    assertEqual(groupFrames(diagramOf({ groups: [{ id: 'g', label: 'G' }] })), [], 'a diagram without boxes');
  }],
  ['diagram: a placed box joins its positioned group without stretching the frame over another group', async () => {
    const { checkDiagram, groupFrames, layoutDiagram } = await loadDiagramModel();
    const groups = (...ids) => ids.map((id) => ({ id, label: id.toUpperCase() }));
    const frameOfGroup = (frames, id) => frames.find((frame) => frame.id === id);
    const arranged = checkDiagram(diagramOf({
      groups: groups('g', 'h'),
      boxes: [diagramBox('g1', { group: 'g', x: 1000, y: 1000 }), diagramBox('h1', { group: 'h', x: 500, y: 500 }), diagramBox('g2', { group: 'g' }), diagramBox('g3', { group: 'g' })],
      arrows: [diagramArrow('1', 'g1', 'g2')],
    }));
    const joined = layoutDiagram(arranged);
    assertEqual(positionsOf(joined), [['g1', 1000, 1000], ['h1', 500, 500], ['g2', 1000, 1080], ['g3', 1000, 1160]], 'two new members below their positioned group');
    const frames = groupFrames(joined);
    assertEqual(frameOfGroup(frames, 'g'), { id: 'g', x: 980, y: 956, w: 160, h: 270 }, 'the joined group frame');
    assert(gapBetween(frameOfGroup(frames, 'g'), frameOfGroup(frames, 'h')) > 0, 'the joined group frame meets another group');
    const blockedBelow = checkDiagram(diagramOf({
      groups: groups('g', 'h'),
      boxes: [diagramBox('g1', { group: 'g', x: 0, y: 0 }), diagramBox('h1', { group: 'h', x: 0, y: 120 }), diagramBox('g2', { group: 'g' })],
    }));
    const right = layoutDiagram(blockedBelow);
    assertEqual(positionsOf(right), [['g1', 0, 0], ['h1', 0, 120], ['g2', 220, 0]], 'a group below sends the new member to the right');
    const [g, h] = groupFrames(right);
    assert(gapBetween(g, h) > 0, 'the frame stretched over the group below');
    const boxedIn = checkDiagram(diagramOf({
      groups: groups('g', 'h', 'i', 'j', 'k'),
      boxes: [
        diagramBox('g1', { group: 'g', x: 0, y: 0 }), diagramBox('h1', { group: 'h', x: 0, y: 120 }), diagramBox('i1', { group: 'i', x: 220, y: 0 }),
        diagramBox('j1', { group: 'j', x: 0, y: -120 }), diagramBox('k1', { group: 'k', x: -220, y: 0 }), diagramBox('g2', { group: 'g' }),
      ],
    }));
    assertEqual(positionsOf(layoutDiagram(boxedIn)).at(-1), ['g2', 0, 240], 'a group boxed in on every side falls back to below, clear of every box');
    assertEqual(layoutDiagram(arranged), joined, 'a second layout of the same document');
  }],
  ['diagram: reading refusals, the size limit and the canonical flag', () => withTemp(async (dir) => {
    const { checkDiagram } = await loadDiagramModel();
    const { MAX_DIAGRAM_BYTES, readDiagram } = await loadDiagramReader();
    assert(MAX_DIAGRAM_BYTES === 2097152, `the diagram limit is ${MAX_DIAGRAM_BYTES} bytes`);
    const missing = path.join(dir, 'missing.json');
    throwsRun(() => readDiagram(missing), 1, `diagram ${missing}: not found`);
    throwsRun(() => readDiagram(path.join(dir, 'missing', 'x.json')), 1, 'not found');
    fs.mkdirSync(path.join(dir, 'folder'));
    throwsRun(() => readDiagram(path.join(dir, 'folder')), 1, 'folder: not a regular file');
    const big = write(dir, 'big.json', Buffer.alloc(MAX_DIAGRAM_BYTES + 1, ' '));
    throwsRun(() => readDiagram(big), 1, 'big.json: 2.0 MB is above the 2 MB diagram limit');
    const broken = write(dir, 'broken.json', '{');
    throwsRun(() => readDiagram(broken), 1, `diagram ${broken}: not valid JSON`);
    const shape = write(dir, 'shape.json', '[]');
    throwsRun(() => readDiagram(shape), 1, `diagram ${shape}: the document is not an object`);
    const unknown = diagramFixture();
    unknown.boxes[0].w = 120;
    const refused = write(dir, 'refused.json', JSON.stringify(unknown));
    throwsRun(() => readDiagram(refused), 1, `diagram ${refused}: boxes[0] has unknown key w`);
    const canonical = write(dir, 'canonical.diagram.json', DIAGRAM_FIXTURE_TEXT);
    assertEqual(readDiagram(canonical), { document: checkDiagram(diagramFixture()), text: DIAGRAM_FIXTURE_TEXT, canonical: true }, 'a canonical file');
    const pretty = write(dir, 'pretty.diagram.json', `${JSON.stringify(checkDiagram(diagramFixture()), null, 2)}\n`);
    assertEqual(readDiagram(pretty).canonical, false, 'a two-space JSON file');
    const bare = write(dir, 'bare.diagram.json', DIAGRAM_FIXTURE_TEXT.slice(0, -1));
    assertEqual(readDiagram(bare).canonical, false, 'canonical text without its trailing newline');
  })],
  ['diagram: arrow geometry clips to box borders, spreads parallel arrows and arcs self-loops', async () => {
    const { arrowGeometry, checkDiagram, layoutDiagram } = await loadDiagramModel();
    const placed = (arrows) => layoutDiagram(checkDiagram(diagramOf({ boxes: [diagramBox('a', { x: 0, y: 0 }), diagramBox('b', { x: 300, y: 0 })], arrows })));
    const shapes = (doc) => arrowGeometry(doc).map(({ id, d, lx, ly }) => [id, d, lx, ly]);
    assertEqual(shapes(placed([diagramArrow('l', 'a', 'b')])), [['l', 'M 120 23 L 300 23', 210, 23]], 'a lone arrow');
    assertEqual(shapes(placed([diagramArrow('x1', 'a', 'b'), diagramArrow('x2', 'a', 'b')])), [
      ['x1', 'M 120 16.6 Q 210 7 300 16.6', 210, 11.8],
      ['x2', 'M 120 29.4 Q 210 39 300 29.4', 210, 34.2],
    ], 'two parallel arrows');
    const mixed = placed([diagramArrow('p', 'a', 'b'), diagramArrow('q', 'b', 'a'), diagramArrow('s', 'a', 'a'), diagramArrow('t', 'a', 'a')]);
    const before = JSON.stringify(mixed);
    const geometry = arrowGeometry(mixed);
    assertEqual(geometry.map(({ id, from, to, d, lx, ly }) => [id, from, to, d, lx, ly]), [
      ['p', 'a', 'b', 'M 120 16.6 Q 210 7 300 16.6', 210, 11.8],
      ['q', 'b', 'a', 'M 300 29.4 Q 210 39 120 29.4', 210, 34.2],
      ['s', 'a', 'a', 'M 104 0 C 104 -36 156 16 120 16', 125.5, -13.5],
      ['t', 'a', 'a', 'M 104 0 C 104 -52 172 16 120 16', 131.5, -19.5],
    ], 'opposite arrows and two self-loops on one box');
    assertEqual(Object.keys(geometry[0]), ['id', 'from', 'to', 'd', 'lx', 'ly'], 'geometry key order');
    assertEqual(arrowGeometry(mixed), geometry, 'geometry for the same document');
    assert(JSON.stringify(mixed) === before, 'arrowGeometry changed its input');
  }],
  ['diagram: bounds cover boxes and frames, and the fit centres and clamps', async () => {
    const { checkDiagram, diagramBounds, fitTransform, layoutDiagram } = await loadDiagramModel();
    const doc = layoutDiagram(checkDiagram(diagramOf({ groups: [{ id: 'g', label: 'G' }], boxes: [diagramBox('a', { group: 'g', x: 0, y: 0 }), diagramBox('b', { x: 300, y: 0 })] })));
    const bounds = diagramBounds(doc);
    assertEqual(bounds, { x: -20, y: -44, w: 440, h: 110 }, 'bounds over a box, its frame and a box outside it');
    assertEqual(diagramBounds(checkDiagram(diagramOf({}))), null, 'bounds with no box');
    assertEqual(fitTransform(bounds, 520, 300), { x: 60, y: 139, k: 1 }, 'a fit at scale 1');
    assertEqual(fitTransform(bounds, 2000, 2000), { x: 700, y: 983.5, k: 1.5 }, 'a fit clamped to its maximum');
    assertEqual(fitTransform(bounds, 100, 100, { min: 0.5 }), { x: -50, y: 44.5, k: 0.5 }, 'a fit clamped to its minimum');
    assertEqual(fitTransform(null, 800, 600), { x: 0, y: 0, k: 1 }, 'a fit with no bounds');
    assertEqual(fitTransform(bounds, 0, 600), { x: 0, y: 0, k: 1 }, 'a fit in an empty viewport');
  }],
  ['diagram: a zoom keeps its anchor point, a pinch moves it, and a wheel notch is one capped step', async () => {
    const { wheelZoomFactor, zoomView } = await loadDiagramModel();
    const view = { x: 10, y: 20, k: 1 };
    const point = { x: 110, y: 220 };
    assertEqual(zoomView(view, 2, point), { x: -90, y: -180, k: 2 }, 'a zoom about one point');
    assertEqual(zoomView(view, 10, point), { x: -290, y: -580, k: 4 }, 'a zoom clamped to its maximum');
    assertEqual(zoomView(view, 0.01, point), { x: 90, y: 180, k: 0.2 }, 'a zoom clamped to its minimum');
    assertEqual(zoomView(view, 2, point, { x: 130, y: 240 }), { x: -70, y: -160, k: 2 }, 'a pinch whose midpoint moved');
    assertEqual(view, { x: 10, y: 20, k: 1 }, 'zoomView changed its input');
    assertEqual(wheelZoomFactor(100, 0), Math.exp(-0.1), 'a mouse-wheel notch zooming out');
    assertEqual(wheelZoomFactor(-100, 0), Math.exp(0.1), 'a mouse-wheel notch zooming in');
    assertEqual(wheelZoomFactor(3, 1), Math.exp(-0.1), 'a line-mode notch');
    assertEqual(wheelZoomFactor(2.5, 0), Math.exp(-0.025), 'a small trackpad pinch delta');
  }],
  ['diagram: a diagram session lists the linked regular files only', () => withTemp(async (root) => {
    const { checkDiagram } = await loadDiagramModel();
    const { linkedFiles } = await loadDiagramReader();
    write(root, 'a.txt', 'a\n');
    write(root, 'sub/b.txt', 'b\n');
    fs.mkdirSync(path.join(root, 'folder'));
    fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'link.txt'));
    const own = write(root, 'd.diagram.json', '{}');
    const doc = checkDiagram(diagramOf({
      boxes: [
        diagramBox('one', { files: ['sub/b.txt', 'a.txt', 'missing.txt'] }),
        diagramBox('two', { files: ['a.txt', 'folder', 'link.txt', 'd.diagram.json'] }),
      ],
    }));
    assertEqual(linkedFiles(root, doc, [own]), ['a.txt', 'sub/b.txt'], 'the linked listing');
    assertEqual(linkedFiles(root, doc), ['a.txt', 'd.diagram.json', 'sub/b.txt'], 'the linked listing with no own file');
    assertEqual(linkedFiles(root, checkDiagram(diagramOf({ boxes: [diagramBox('none')] }))), [], 'a diagram with no links');
  })],
  ['diagram session: the server serves the diagram with no notes session, and Finish ends it', async () => {
    const { checkDiagram } = await loadDiagramModel();
    const document = checkDiagram(diagramOf({ boxes: [diagramBox('a', { files: ['a.txt', 'gone.txt'] })] }));
    await withDiagramServer(async ({ port, host, root, file, finished }) => {
      const headers = { host, 'x-margin-token': TOKEN };
      const noToken = await request(port, { target: '/api/diagram', headers: { host } });
      assert(noToken.status === 403, `the diagram without the token got ${noToken.status}`);
      const served = await request(port, { target: '/api/diagram', headers });
      assertEqual([served.status, served.json], [200, { file, root, document }], 'the served diagram');
      assertEqual((await request(port, { headers })).json, { session: null, files: ['a.txt'], changes: 0 }, 'the session route in a diagram session');
      const read = await request(port, { target: '/api/file?path=a.txt', headers });
      assertEqual([read.status, read.json], [200, { path: 'a.txt', text: 'a\n' }], 'a listed link');
      const unlisted = await request(port, { target: '/api/file?path=gone.txt', headers });
      assertEqual([unlisted.status, unlisted.json], [404, { error: 'gone.txt is not in scope' }], 'an unlisted link');
      for (const [method, target] of [['PUT', '/api/session'], ['POST', '/api/submit'], ['POST', '/api/reply'], ['POST', '/api/cancel'], ['GET', '/api/wait']]) {
        const res = await request(port, { method, target, headers, body: method === 'GET' ? undefined : { annotations: [] } });
        assertEqual([res.status, res.json], [404, { error: 'not found' }], `${method} ${target} in a diagram session`);
      }
      const finish = await request(port, { method: 'POST', target: '/api/finish', headers, body: { annotations: [{ id: 'n1', anchor: { kind: 'scope' }, body: 'x' }] } });
      assertEqual([finish.status, finish.json], [200, { ok: true, status: 'finished' }], 'Finish in a diagram session');
      assertEqual(await finished(), { status: 'finished', file }, 'the diagram session document');
      const again = await request(port, { method: 'POST', target: '/api/finish', headers });
      assertEqual([again.status, again.json], [409, { error: 'the run has ended' }], 'Finish after the end');
      const changes = await request(port, { target: '/api/changes?after=0', headers });
      assertEqual(changes.json, { status: 'finished', changes: 0 }, 'the change wait after the end');
      assertEqual(fs.readdirSync(root), ['a.txt'], 'files under the root after a diagram session');
    }, { document, files: ['a.txt'] });
    await withServer(async ({ port, host }) => {
      const none = await request(port, { target: '/api/diagram', headers: { host, 'x-margin-token': TOKEN } });
      assertEqual([none.status, none.json], [404, { error: 'no diagram' }], 'the diagram route on a run without one');
      for (const asset of ['/diagram.js', '/diagram-edit.js', '/diagram-view.js']) {
        const res = await request(port, { target: asset, headers: { host } });
        assert(res.status === 200 && res.type === 'text/javascript; charset=utf-8', `${asset} got ${res.status} ${res.type}`);
      }
    });
  }],
  ['diagram edit: each operation returns a new checked document and leaves its input as it was', async () => {
    const { checkDiagram } = await loadDiagramModel();
    const edit = await loadDiagramEdit();
    const base = checkDiagram(diagramOf({
      groups: [{ id: 'g', label: 'G' }, { id: 'h', label: 'H' }],
      boxes: [diagramBox('a', { group: 'g', x: 0, y: 0 }), diagramBox('b', { x: 300, y: 0 })],
      arrows: [diagramArrow('ab', 'a', 'b')],
    }));
    const before = structuredClone(base);
    const added = edit.addBox(base, { id: 'box-1', x: 10.4, y: 20.6, label: '  New  ', group: 'h' });
    assertEqual(added.boxes[2], { id: 'box-1', label: 'New', kind: 'concept', files: [], group: 'h', x: 10, y: 21 }, 'an added box');
    assert(!('group' in edit.addBox(base, { id: 'box-2', x: 0, y: 0, label: 'X', group: 'nope' }).boxes[2]), 'an added box naming no group keeps no group');
    assert(edit.addBox(base, { id: 'a', x: 0, y: 0, label: 'X' }) === base, 'an added box reusing an id');
    assert(edit.addBox(base, { id: 'box-3', x: 0, y: 0, label: '   ' }) === base, 'an added box with a blank label');
    const renamed = edit.renameBox(base, 'a', ' Alpha ');
    assertEqual(renamed.boxes[0].label, 'Alpha', 'a renamed box');
    assert(edit.renameBox(base, 'a', '   ') === base, 'a blank box label keeps the old one');
    const kinded = edit.setKind(base, 'a', 'store');
    assertEqual(kinded.boxes[0].kind, 'store', 'a kind change');
    assert(edit.setKind(base, 'a', 'widget') === base, 'an unknown kind');
    const grouped = edit.setGroup(base, 'b', 'h');
    assertEqual(grouped.boxes[1].group, 'h', 'a box joining a group');
    const ungrouped = edit.setGroup(base, 'a', null);
    assert(!('group' in ungrouped.boxes[0]), 'a box leaving every group keeps no group key');
    assert(edit.setGroup(base, 'a', 'nope') === base, 'an unknown group');
    const moved = edit.moveBox(base, 'b', 12.5, -7.4);
    assertEqual([moved.boxes[1].x, moved.boxes[1].y], [13, -7], 'a move rounds to integers');
    const joined = edit.connect(base, { id: 'arrow-1', from: 'b', to: 'a' });
    assertEqual(joined.arrows[1], { id: 'arrow-1', from: 'b', to: 'a', label: '', why: '' }, 'a new arrow');
    const parallel = edit.connect(base, { id: 'arrow-2', from: 'a', to: 'b' });
    assertEqual(parallel.arrows.map((arrow) => arrow.id), ['ab', 'arrow-2'], 'a parallel arrow');
    assert(edit.connect(base, { id: 'arrow-3', from: 'a', to: 'a' }) === base, 'a self-loop');
    assert(edit.connect(base, { id: 'arrow-3', from: 'a', to: 'zz' }) === base, 'an arrow to an unknown box');
    assert(edit.connect(base, { id: 'ab', from: 'b', to: 'a' }) === base, 'an arrow reusing an id');
    const labelled = edit.relabelArrow(base, 'ab', ' calls ');
    assertEqual(labelled.arrows[0].label, 'calls', 'a relabelled arrow');
    assertEqual(edit.relabelArrow(labelled, 'ab', '  ').arrows[0].label, '', 'an arrow label cleared');
    for (const [result, what] of [
      [edit.renameBox(base, 'zz', 'x'), 'rename'], [edit.setKind(base, 'zz', 'store'), 'kind'], [edit.setGroup(base, 'zz', 'g'), 'group'],
      [edit.moveBox(base, 'zz', 1, 1), 'move'], [edit.removeBox(base, 'zz'), 'box removal'], [edit.relabelArrow(base, 'zz', 'x'), 'relabel'],
      [edit.removeArrow(base, 'zz'), 'arrow removal'], [edit.moveBox(base, 'a', 0, 0), 'a move to where the box is'],
    ]) {
      assert(result === base, `a ${what} that does not apply returned a new document`);
    }
    for (const result of [added, renamed, kinded, grouped, ungrouped, moved, joined, parallel, labelled]) {
      assertEqual(checkDiagram(result), result, 'an edited document the check does not accept as it is');
    }
    assertEqual(base, before, 'an operation changed its input');
  }],
  ['diagram edit: removing a box or an arrow drops its arrows from every walkthrough step', async () => {
    const { checkDiagram } = await loadDiagramModel();
    const edit = await loadDiagramEdit();
    const base = checkDiagram(diagramOf({
      boxes: [diagramBox('a'), diagramBox('b'), diagramBox('c')],
      arrows: [diagramArrow('loop', 'a', 'a'), diagramArrow('ab1', 'a', 'b'), diagramArrow('ab2', 'a', 'b'), diagramArrow('bc', 'b', 'c')],
      walkthroughs: [{ name: 'W', steps: [{ arrows: ['loop', 'ab1'], text: 'one' }, { arrows: ['ab2', 'bc'], text: 'two' }] }],
    }));
    const before = structuredClone(base);
    const noA = edit.removeBox(base, 'a');
    assertEqual(noA.boxes.map((box) => box.id), ['b', 'c'], 'the boxes left');
    assertEqual(noA.arrows.map((arrow) => arrow.id), ['bc'], 'the self-loop and both parallel arrows go with their box');
    assertEqual(noA.walkthroughs, [{ name: 'W', steps: [{ arrows: [], text: 'one' }, { arrows: ['bc'], text: 'two' }] }], 'the steps after a box removal');
    const noBc = edit.removeArrow(base, 'bc');
    assertEqual(noBc.arrows.map((arrow) => arrow.id), ['loop', 'ab1', 'ab2'], 'the arrows after an arrow removal');
    assertEqual(noBc.walkthroughs[0].steps.map((step) => step.arrows), [['loop', 'ab1'], ['ab2']], 'the steps after an arrow removal');
    const bare = edit.removeArrow(noA, 'bc');
    assertEqual(bare.walkthroughs, [{ name: 'W', steps: [{ arrows: [], text: 'one' }, { arrows: [], text: 'two' }] }], 'every step kept with no arrows');
    for (const result of [noA, noBc, bare]) {
      assertEqual(checkDiagram(result), result, 'a document after a removal the check does not accept as it is');
    }
    assertEqual(base, before, 'a removal changed its input');
  }],
  ['diagram edit: ids never repeat, drops resolve the group, and the layouts', async () => {
    const { checkDiagram, layoutDiagram } = await loadDiagramModel();
    const edit = await loadDiagramEdit();
    const ids = edit.createIds(diagramOf({
      boxes: [diagramBox('box-007'), diagramBox('box-x'), diagramBox('box-3'), diagramBox('arrow-2')],
      arrows: [diagramArrow('arrow-3', 'box-3', 'box-x')],
    }));
    assertEqual([ids.next('box'), ids.next('box'), ids.next('arrow'), ids.next('arrow')], ['box-8', 'box-9', 'arrow-4', 'arrow-5'], 'the ids handed out');
    const empty = edit.createIds(diagramOf({}));
    assertEqual([empty.next('box'), empty.next('arrow')], ['box-1', 'arrow-1'], 'the first ids of an empty diagram');

    const frames = [{ id: 'g', x: 0, y: 0, w: 100, h: 100 }, { id: 'h', x: 50, y: 50, w: 100, h: 100 }];
    assertEqual(edit.groupAt(frames, { x: 75, y: 75 }), 'h', 'overlapping frames take the last');
    assertEqual(edit.groupAt(frames, { x: 10, y: 10 }), 'g', 'a point in one frame');
    assertEqual(edit.groupAt(frames, { x: 500, y: 500 }), null, 'a point in no frame');
    const doc = checkDiagram(diagramOf({
      groups: [{ id: 'g', label: 'G' }, { id: 'h', label: 'H' }],
      boxes: [diagramBox('a', { group: 'g', x: 0, y: 0 }), diagramBox('c', { group: 'g', x: 0, y: 100 }), diagramBox('b', { x: 400, y: 0 })],
    }));
    assertEqual(edit.dropGroup(doc, 'a', { x: 500, y: 500 }, frames), 'g', 'a drop outside every frame keeps the group');
    assertEqual(edit.dropGroup(doc, 'b', { x: 500, y: 500 }, frames), null, 'an ungrouped drop outside every frame');
    assertEqual(edit.dropGroup(doc, 'b', { x: 10, y: 10 }, frames), 'g', 'an ungrouped box dropped in a frame joins it');
    assertEqual(edit.dropGroup(doc, 'a', { x: 120, y: 120 }, frames), 'h', 'a drop into another group');
    // c alone: x 0..120, y 100..146, so the frame is 20 wider each side and 24 taller above.
    assertEqual(edit.dropFrames(doc, 'a'), [{ id: 'g', x: -20, y: 56, w: 160, h: 110 }], 'the frames without the dragged box');

    const loose = checkDiagram(diagramOf({ boxes: [diagramBox('p', { x: 900, y: 900 }), diagramBox('q')], arrows: [diagramArrow('pq', 'p', 'q')] }));
    const frozen = edit.freeze(loose);
    assert(frozen.boxes.every((box) => Number.isSafeInteger(box.x) && Number.isSafeInteger(box.y)), 'freeze left a box unpositioned');
    assertEqual([frozen.boxes[0].x, frozen.boxes[0].y], [900, 900], 'freeze moved a positioned box');
    assertEqual(edit.relayout(loose), layoutDiagram(loose, { all: true }), 'the re-layout');
    assertEqual(edit.freeze(diagramOf({})), diagramOf({}), 'freezing an empty diagram');
  }],
  ['diagram edit: the saver keeps one save in flight and sends the newest document next', async () => {
    const { createSaver } = await loadDiagramEdit();
    const calls = [];
    const send = (doc) => new Promise((resolve, reject) => calls.push({ doc, resolve, reject }));
    const failure = (message, status) => Object.assign(new Error(message), { status });
    const phases = [];
    const saver = createSaver(send, { saved: 'v0', onChange: (state) => phases.push(state.phase) });
    assertEqual([saver.state.phase, saver.state.saved], ['idle', 'v0'], 'the saver before any save');
    saver.save('v1');
    saver.save('v2');
    saver.save('v3');
    assertEqual(calls.map((call) => call.doc), ['v1'], 'saves while one is in flight');
    const flushed = saver.flush();
    assert(!(await isSettled(flushed)), 'flush settled with a save in flight');
    calls[0].resolve({ ok: true });
    await tick();
    assertEqual(calls.map((call) => call.doc), ['v1', 'v3'], 'the newest document sent next');
    assert(!(await isSettled(flushed)), 'flush settled with the newest document in flight');
    calls[1].resolve({ ok: true });
    const idle = await within(flushed, 'the flush');
    assertEqual([idle.phase, idle.saved], ['idle', 'v3'], 'the state once every save landed');
    assertEqual(phases, ['saving', 'saving', 'idle'], 'the phases heard');

    saver.save('v4');
    saver.save('v5');
    calls[2].reject(failure('boxes[0] has unknown key w', 400));
    await tick();
    assertEqual(calls.length, 3, 'a 400 sent the waiting document');
    assertEqual([saver.state.phase, saver.state.status, saver.state.error, saver.state.saved], ['failed', 400, 'boxes[0] has unknown key w', 'v3'], 'the state after a 400');
    saver.retry();
    await tick();
    assertEqual(calls.length, 3, 'a retry after a 400 sent something');

    saver.save('v6');
    saver.save('v7');
    calls[3].reject(failure('disk full', 500));
    await tick();
    assertEqual(calls.length, 4, 'a 500 sent the waiting document at once');
    assertEqual((await within(saver.flush(), 'the flush after a 500')).phase, 'failed', 'a flush after a 500');
    saver.retry();
    await tick();
    assertEqual(calls[4].doc, 'v7', 'the retry sends the newest unsaved document');
    calls[4].resolve({ ok: true });
    await tick();
    assertEqual([saver.state.phase, saver.state.saved], ['idle', 'v7'], 'the state after the retry');

    saver.save('v8');
    calls[5].reject(failure('offline', 0));
    await tick();
    saver.save('v9');
    assertEqual(calls[6].doc, 'v9', 'the next edit after an unreachable server sends its own document');
    calls[6].resolve({ ok: true });
    await tick();
    assertEqual(saver.state.saved, 'v9', 'the last saved document');
  }],
  ["session: an atomic write keeps the file's permission bits and leaves no temporary file", () => withTemp((dir) => {
    const file = write(dir, 'kept.json', 'old\n');
    for (const mode of [0o600, 0o640]) {
      fs.chmodSync(file, mode);
      writeAtomic(file, `mode ${mode}\n`);
      assertEqual([fs.readFileSync(file, 'utf8'), fs.statSync(file).mode & 0o777], [`mode ${mode}\n`, mode], `an atomic write over a ${mode.toString(8)} file`);
    }
    const fresh = path.join(dir, 'sub', 'fresh.json');
    writeAtomic(fresh, 'new\n');
    assertEqual(fs.readFileSync(fresh, 'utf8'), 'new\n', 'an atomic write creating its file');
    assertEqual(fs.readdirSync(dir).sort(), ['kept.json', 'sub'], 'files beside the written file');
    assertEqual(fs.readdirSync(path.join(dir, 'sub')), ['fresh.json'], 'files beside the created file');
  })],
  ['diagram session: a save checks the document, writes its canonical text and serves it', async () => {
    const { checkDiagram } = await loadDiagramModel();
    const document = checkDiagram(diagramFixture());
    await withDiagramServer(async ({ port, host, root, file }) => {
      const headers = { host, 'x-margin-token': TOKEN };
      const edited = diagramFixture();
      Object.assign(edited.boxes[1], { label: 'skill', x: 400, y: 84 });
      const noToken = await request(port, { method: 'PUT', target: '/api/diagram', headers: { host }, body: { document: edited } });
      assertEqual(noToken.status, 403, 'a save without the token');
      assert(fs.readFileSync(file, 'utf8') === JSON.stringify(diagramFixture()), 'a save without the token wrote the file');
      const saved = await request(port, { method: 'PUT', target: '/api/diagram', headers, body: { document: edited } });
      assert(saved.status === 200 && saved.json.ok === true && !Number.isNaN(Date.parse(saved.json.savedAt)), `a save got ${saved.status} ${saved.text}`);
      const expected = DIAGRAM_FIXTURE_TEXT.replace(
        '    {"id":"skill","label":"annotate skill","kind":"agent","files":[]}',
        '    {"id":"skill","label":"skill","kind":"agent","files":[],"x":400,"y":84}',
      );
      assert(fs.readFileSync(file, 'utf8') === expected, `the saved file is not the canonical text: ${fs.readFileSync(file, 'utf8')}`);
      const served = await request(port, { target: '/api/diagram', headers });
      assertEqual(served.json.document.boxes[1], { id: 'skill', label: 'skill', kind: 'agent', files: [], x: 400, y: 84 }, 'the served document after a save');
      edited.boxes[1].label = 'again';
      const second = await request(port, { method: 'PUT', target: '/api/diagram', headers, body: { document: edited } });
      assertEqual(second.status, 200, 'a second save over the text the session wrote');
      assert(fs.readFileSync(file, 'utf8').includes('{"id":"skill","label":"again",'), 'the second save is not on disk');
      assertEqual(fs.readdirSync(root).sort(), ['a.txt', 'd.diagram.json'], 'files under the root after saves');
    }, { document, files: ['a.txt'], save: true, text: JSON.stringify(diagramFixture()) });
  }],
  ['diagram session: a refused save, a file changed on disk and the end write nothing; without a writer the route is 404', async () => {
    const { checkDiagram } = await loadDiagramModel();
    const document = checkDiagram(diagramFixture());
    await withDiagramServer(async ({ port, host, root, file, finished }) => {
      const headers = { host, 'x-margin-token': TOKEN };
      fs.chmodSync(file, 0o640);
      const unknown = diagramFixture();
      unknown.boxes[0].w = 1;
      const unnamed = diagramFixture();
      unnamed.arrows[0].to = 'nowhere';
      const big = diagramFixture();
      big.arrows[0].why = 'x'.repeat(MAX_BYTES);
      for (const [body, error, what] of [
        [{}, 'document is not an object', 'no document'],
        [null, 'document is not an object', 'a null body'],
        [{ document: [] }, 'document is not an object', 'an array'],
        [{ document: null }, 'document is not an object', 'a null document'],
        [{ document: unknown }, 'boxes[0] has unknown key w', 'an unknown key'],
        [{ document: unnamed }, 'arrows[0].to names no box nowhere', 'a reference to no box'],
        [{ document: big }, 'diagram too large', 'an oversized document'],
      ]) {
        const res = await request(port, { method: 'PUT', target: '/api/diagram', headers, body });
        assertEqual([res.status, res.json], [400, { error }], `a save of ${what}`);
      }
      assert(fs.readFileSync(file, 'utf8') === DIAGRAM_FIXTURE_TEXT, 'a refused save changed the file');
      assertEqual(fs.statSync(file).mode & 0o777, 0o640, 'the file mode after refused saves');
      assertEqual(fs.readdirSync(root).sort(), ['a.txt', 'd.diagram.json'], 'files under the root after refused saves');

      const valid = { document: diagramFixture() };
      fs.writeFileSync(file, `${DIAGRAM_FIXTURE_TEXT} `);
      const changed = await request(port, { method: 'PUT', target: '/api/diagram', headers, body: valid });
      assertEqual([changed.status, changed.json], [409, { error: 'the diagram file changed on disk' }], 'a save over a file changed on disk');
      assert(fs.readFileSync(file, 'utf8') === `${DIAGRAM_FIXTURE_TEXT} `, 'a save overwrote a file changed on disk');
      fs.rmSync(file);
      const gone = await request(port, { method: 'PUT', target: '/api/diagram', headers, body: valid });
      assertEqual([gone.status, gone.json], [409, { error: 'the diagram file changed on disk' }], 'a save over a deleted file');
      assert(!fs.existsSync(file), 'a save recreated a deleted diagram file');

      const finish = await request(port, { method: 'POST', target: '/api/finish', headers });
      assertEqual(finish.json, { ok: true, status: 'finished' }, 'Finish');
      await finished();
      const late = await request(port, { method: 'PUT', target: '/api/diagram', headers, body: valid });
      assertEqual([late.status, late.json], [409, { error: 'the run has ended' }], 'a save after the end');
      assertEqual(fs.readdirSync(root), ['a.txt'], 'files under the root after the end');
    }, { document, files: ['a.txt'], save: true });
    await withDiagramServer(async ({ port, host, root }) => {
      const res = await request(port, { method: 'PUT', target: '/api/diagram', headers: { host, 'x-margin-token': TOKEN }, body: { document: diagramFixture() } });
      assertEqual([res.status, res.json], [404, { error: 'not found' }], 'a save in a diagram session without a writer');
      assertEqual(fs.readdirSync(root), ['a.txt'], 'files under the root without a writer');
    }, { document, files: ['a.txt'] });
    await withServer(async ({ port, host }) => {
      const res = await request(port, { method: 'PUT', target: '/api/diagram', headers: { host, 'x-margin-token': TOKEN }, body: { document: diagramFixture() } });
      assertEqual([res.status, res.json], [404, { error: 'not found' }], 'a save in an annotate run');
    });
  }],
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
  ["server: candidate notes against the run's overview", async () => {
    const candidate = (id, name) => ({ id, anchor: { kind: 'candidate', name }, body: id });
    await withServer(async ({ port, host, out, session }) => {
      const headers = { host, 'x-margin-token': TOKEN };
      const put = await request(port, { method: 'PUT', target: '/api/session', headers, body: { annotations: [candidate('c1', 'split-parsing')] } });
      assert(put.status === 200, `a known candidate note got ${put.status}`);
      assertEqual(session.annotations.map((a) => a.anchor), [{ kind: 'candidate', name: 'split-parsing' }], 'stored anchors after a known candidate note');
      const saved = fs.readFileSync(out, 'utf8');
      const body = { annotations: [candidate('c1', 'split-parsing'), candidate('c2', 'merge-io'), { id: 'f1', anchor: { kind: 'file', path: 'a.txt' }, body: 'f1' }] };
      for (const target of ['/api/session', '/api/submit', '/api/cancel', '/api/finish']) {
        const refused = await request(port, { method: target === '/api/session' ? 'PUT' : 'POST', target, headers, body });
        assert(refused.status === 400, `${target} with an unknown candidate got ${refused.status}`);
        assertEqual(refused.json, { error: 'entry 1: "merge-io" is not a candidate of this run\'s overview' }, `${target} refusal`);
        assertEqual(session.annotations.map((a) => a.id), ['c1'], `notes after ${target} was refused`);
        assert(fs.readFileSync(out, 'utf8') === saved, `a refused ${target} rewrote the notes file`);
      }
      assert(session.round === 0, `a refused submit moved the round count to ${session.round}`);
      const sent = await request(port, { method: 'POST', target: '/api/submit', headers, body: { annotations: [candidate('c1', 'split-parsing')] } });
      assertEqual(sent.json, { ok: true, round: 1 }, 'a submit with a known candidate note');
      assertEqual(session.annotations.map((a) => [a.id, a.round]), [['c1', 1]], 'notes after the submit');
      const file = await request(port, { target: '/api/file?path=a.txt', headers });
      assert(file.status === 200, `a listed file on an overview run got ${file.status}`);
    }, { overview: checkOverview(overviewFixture(OVERVIEW_ROOT)) });
    await withServer(async ({ port, host, session }) => {
      const headers = { host, 'x-margin-token': TOKEN };
      const refused = await request(port, { method: 'PUT', target: '/api/session', headers, body: { annotations: [candidate('c1', 'split-parsing')] } });
      assert(refused.status === 400, `a candidate note without an overview got ${refused.status}`);
      assertEqual(refused.json, { error: 'entry 0: "split-parsing" is not a candidate of this run\'s overview' }, 'the refusal without an overview');
      assertEqual(session.annotations, [], 'notes after the refusal without an overview');
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
      sendRound(blocked, new Set());
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
  ['rounds: a Send withholds candidate notes the overview does not name', () => withTemp((dir) => {
    const note = (id, anchor) => ({ id, anchor, intent: 'change', body: id, createdAt: `c-${id}` });
    const session = createSession({ stored: null, out: path.join(dir, 'notes.json'), root: dir, scope: [], revision: null });
    session.annotations = [
      note('h1', { kind: 'candidate', name: 'merge-io' }),
      note('k1', { kind: 'candidate', name: 'split-parsing' }),
      note('f1', { kind: 'file', path: 'src/a.js' }),
    ];
    assert(sendRound(session, new Set(['split-parsing'])) === 1, 'the Send did not send round 1');
    assertEqual(session.annotations.map((a) => [a.id, a.round]), [['k1', 1], ['f1', 1], ['h1', undefined]], 'notes after a Send withholding one');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'));
    assertEqual(saved.annotations.map((a) => [a.id, a.round ?? null]), [['k1', 1], ['f1', 1], ['h1', null]], 'saved notes after a Send withholding one');
    assert(sendRound(session, new Set(['split-parsing'])) === null, 'a Send with only a withheld note and the same overall sent a round');
    assert(session.round === 1, `a Send with only a withheld note moved the round count to ${session.round}`);
    const bare = createSession({ stored: null, out: path.join(dir, 'bare.json'), root: dir, scope: [], revision: null });
    bare.annotations = [note('k2', { kind: 'candidate', name: 'split-parsing' }), note('s2', { kind: 'scope' })];
    assert(sendRound(bare, new Set()) === 1, 'a Send without candidate names did not send the scope note');
    assertEqual(bare.annotations.map((a) => [a.id, a.round]), [['s2', 1], ['k2', undefined]], 'notes after a Send without candidate names');
    const taken = path.join(dir, 'taken');
    fs.mkdirSync(taken);
    const failing = createSession({ stored: null, out: taken, root: dir, scope: [], revision: null });
    failing.annotations = [note('h3', { kind: 'candidate', name: 'merge-io' }), note('f3', { kind: 'file', path: 'src/a.js' })];
    let threw = false;
    try {
      sendRound(failing, new Set(['split-parsing']));
    } catch {
      threw = true;
    }
    assert(threw, 'a Send whose save fails did not throw');
    assertEqual(failing.annotations.map((a) => [a.id, a.round]), [['h3', undefined], ['f3', undefined]], 'notes after a Send withholding one whose save failed');
    assert(failing.round === 0 && failing.rounds.length === 0, `a Send whose save failed left round ${failing.round} and ${failing.rounds.length} rounds`);
  })],
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
      'import {',
      '  h,',
      "  // don't",
      '  /* i */ i,',
      "} from './hi';",
      "// import './line-comment';",
      "/* import './block-comment'; */",
      "const u = 'http://host/*'; import './after-url';",
      'const t = `// not a comment`; import "./after-template";',
    ].join('\r\n');
    assertEqual(scanSpecifiers(text), ['./a', './bc', './d', './e', './types', './side-effect', './lazy', './g', './hi', './after-url', './after-template'], 'scanned specifiers');
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
    assertEqual(detectWidth(['  a\n    b\n    c\n']), 2, 'a width halved while the half starts half as many lines');
    assertEqual(detectWidth(['    a\n    b\n    c\n  d\n']), 4, 'a half on one stray line does not halve');
    assertEqual(detectWidth(['/**\n * doc\n */\nf() {\n    a\n    b\n    c\n  d\n}\n']), 4, 'doc-comment lines below a stray half do not halve');
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
      (([first, ...rest]) => [...rest, first])(explorerBlock('out-of-order', { files: 'src/b.ts' })),
      (([, ...rest]) => ['Name: capital', ...rest])(explorerBlock('capital')),
      explorerBlock('bulleted').map((line) => `- ${line}`),
      (([, ...rest]) => ['**name:** bold', ...rest])(explorerBlock('bold')),
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
    }, {
      name: 'out-of-order',
      tier: 'speculative',
      category: 'in-process',
      files: ['src/b.ts'],
      next_change: 'x',
      next_sites: [],
      est_diff_lines: 3,
      deletion_test: 'x',
      friction: 'y',
    }], 'the parsed candidates');
    assertEqual(warnings, [
      'dropped explorer block "bad-site": next_sites line 1 is not <path>:<line> — <what>',
      'dropped explorer block "stranger": names other/x.ts, which is not in the scope',
      'dropped explorer block "wrong-case": tier is not one of strong, worth-exploring, speculative',
      'dropped explorer block "split-a": repeats the name of an earlier block',
      'dropped explorer block "approx": est_diff_lines ~200 is not a whole number',
      'dropped explorer block "off-files": next_sites[0].path is not one of the candidate\'s files',
      'dropped explorer block "lonely": missing tier',
      'dropped explorer block block 10: missing name',
      'dropped explorer block block 11: missing name',
      'dropped explorer block block 12: missing name',
    ], 'the drop warnings');
    assertEqual(dropped, 10, 'the dropped count');
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
    const noBlock = 'No deepening candidates: the explorer output holds no candidate block and no notes: line.';
    const unparsed = notices({ rolesText: 'nope', explorerText: '' });
    assert(unparsed.length === 2 && unparsed[0].startsWith('File roles are unavailable: the roles input is not valid JSON (') && unparsed[1] === noBlock, `notices for roles that do not parse and an empty explorer output: ${JSON.stringify(unparsed)}`);
    assertEqual(notices({ rolesText: '{}', explorerText: 'Here are my findings.\n\n- notes: none' }), [noBlock], 'explorer output with neither a block nor a notes: line');
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
  ['cli: diagram --check exits 0, 1 and 2 and leaves the file as it was', () => withTemp((dir) => {
    const good = write(dir, 'good.diagram.json', DIAGRAM_FIXTURE_TEXT);
    const expected = { status: 'ok', file: good, canonical: true, groups: 2, boxes: 2, arrows: 1, walkthroughs: 1 };
    for (const args of [['diagram', '--check', good], ['diagram', good, '--check']]) {
      const res = runCli(args);
      assert(res.status === 0, `${args.join(' ')} exited ${res.status}: ${res.stdout}`);
      assertEqual(res.doc, expected, `the diagram document for ${args.join(' ')}`);
      assertEqual(Object.keys(res.doc), ['status', 'file', 'canonical', 'groups', 'boxes', 'arrows', 'walkthroughs'], 'diagram document key order');
      assert(res.stdout.endsWith('}\n') && !res.stdout.endsWith('\n\n'), 'the diagram document has not one trailing newline');
      assertEqual(res.stderr, '', 'diagram stderr');
    }
    const pretty = write(dir, 'pretty.diagram.json', `${JSON.stringify(JSON.parse(DIAGRAM_FIXTURE_TEXT), null, 2)}\n`);
    assertEqual(runCli(['diagram', '--check', pretty]).doc, { ...expected, file: pretty, canonical: false }, 'a valid file that is not canonical');
    const missing = path.join(dir, 'missing.diagram.json');
    assertErrorDoc(runCli(['diagram', '--check', missing]), 1, `diagram ${missing}: not found`, 'a missing diagram file');
    const unknown = diagramFixture();
    unknown.arrows[0].weight = 2;
    const refused = write(dir, 'refused.diagram.json', JSON.stringify(unknown));
    assertErrorDoc(runCli(['diagram', '--check', refused]), 1, `diagram ${refused}: arrows[0] has unknown key weight`, 'a refused diagram file');
    for (const [args, fragment] of [
      [['diagram', '--check', '--no-open', good], '--check takes no other flag'],
      [['diagram', '--check'], 'usage: cli.mjs diagram --check <file>'],
      [['diagram', '--check', good, good], 'usage: cli.mjs diagram --check <file>'],
      [['diagram', '--check', ''], 'bad <file>: empty'],
      [['diagram', '--check=yes', good], "'--check' does not take an argument"],
      [['diagram', '--check', '--wide', good], "'--wide'"],
    ]) {
      assertErrorDoc(runCli(args), 2, fragment, args.join(' '));
    }
    assert(fs.readFileSync(good, 'utf8') === DIAGRAM_FIXTURE_TEXT, 'diagram --check changed the file');
    assertEqual(fs.readdirSync(dir).sort(), ['good.diagram.json', 'pretty.diagram.json', 'refused.diagram.json'], 'files after diagram --check');
  })],
  ['cli: a diagram session serves the file under its root and prints one document when it ends', () => withTemp(async (dir) => {
    const repo = path.join(dir, 'repo');
    write(repo, 'a.txt', 'a\n');
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
    const fixture = diagramFixture();
    fixture.boxes[0].files = ['a.txt', 'server/cli.mjs'];
    const text = JSON.stringify(fixture);
    const file = write(repo, 'docs/d.diagram.json', text);
    const sessionArgs = (target, ...flags) => ['diagram', target, '--port', '0', '--token', TOKEN, '--no-open', ...flags];
    const server = spawnCli(sessionArgs(file));
    try {
      const url = await serverUrl(server);
      const port = Number(new URL(url).port);
      const headers = { host: `127.0.0.1:${port}`, 'x-margin-token': TOKEN };
      assertEqual(server.stderr(), `margin: ${url}\n  root:    ${repo}\n  diagram: ${file} (1 linked files)\n`, 'the diagram session stderr block');
      const served = await request(port, { target: '/api/diagram', headers });
      assertEqual([served.json.file, served.json.root], [file, repo], 'the served diagram file and root');
      assertEqual((await request(port, { headers })).json.files, ['a.txt'], 'the diagram session listing');
      fixture.boxes[1].label = 'the skill';
      const save = await request(port, { method: 'PUT', target: '/api/diagram', headers, body: { document: fixture } });
      assertEqual([save.status, save.json.ok], [200, true], 'a save through the diagram session');
      const finish = await request(port, { method: 'POST', target: '/api/finish', headers });
      assertEqual(finish.json, { ok: true, status: 'finished' }, 'finish reply');
      const exit = await server.exited();
      assert(exit.code === 0, `the diagram session exited ${exit.code ?? exit.signal}: ${exit.stdout}`);
      assertEqual(JSON.parse(exit.stdout), { status: 'finished', file }, 'the diagram session document');
      assert(exit.stdout.endsWith('}\n') && !exit.stdout.endsWith('\n\n'), 'the diagram session document has not one trailing newline');
    } finally {
      server.child.kill('SIGKILL');
    }
    const savedText = DIAGRAM_FIXTURE_TEXT
      .replace('"files":["server/cli.mjs"]', '"files":["a.txt","server/cli.mjs"]')
      .replace('"label":"annotate skill"', '"label":"the skill"');
    assert(fs.readFileSync(file, 'utf8') === savedText, `the diagram file after a save is not its canonical text: ${fs.readFileSync(file, 'utf8')}`);
    assert(text !== savedText, 'the diagram file was canonical before its save');
    assertEqual(fs.readdirSync(repo).sort(), ['.git', 'a.txt', 'docs'], 'files under the root after a diagram session');
    assertEqual(fs.readdirSync(path.join(repo, 'docs')), ['d.diagram.json'], 'files beside the diagram after a diagram session');

    const plain = path.join(dir, 'plain');
    const loose = write(plain, 'x.diagram.json', DIAGRAM_FIXTURE_TEXT);
    assert(!isRepository(plain), `${plain} is inside a git repository`);
    const docs = path.join(repo, 'docs');
    for (const [args, root] of [[sessionArgs(loose), plain], [sessionArgs(file, '--root', docs), docs]]) {
      const run = spawnCli(args);
      try {
        const url = await serverUrl(run);
        assertEqual(run.stderr(), `margin: ${url}\n  root:    ${root}\n  diagram: ${args[1]} (0 linked files)\n`, `the stderr block of ${args.join(' ')}`);
        run.child.kill('SIGTERM');
        const exit = await run.exited();
        assert(exit.code === 0, `${args.join(' ')} exited ${exit.code ?? exit.signal} on SIGTERM: ${exit.stdout}`);
        assertEqual(JSON.parse(exit.stdout), { status: 'interrupted', file: args[1] }, `the document of ${args.join(' ')} on SIGTERM`);
      } finally {
        run.child.kill('SIGKILL');
      }
    }
    assert(fs.readFileSync(loose, 'utf8') === DIAGRAM_FIXTURE_TEXT, 'a diagram session with no save changed the diagram file');
    assertEqual(fs.readdirSync(plain), ['x.diagram.json'], 'files beside a diagram no save touched');
  })],
  ['cli: diagram session refusals exit before binding a port', () => withTemp((dir) => {
    const good = write(dir, 'good.diagram.json', DIAGRAM_FIXTURE_TEXT);
    const unknown = diagramFixture();
    unknown.arrows[0].weight = 2;
    const refused = write(dir, 'refused.diagram.json', JSON.stringify(unknown));
    const invalid = runCli(['diagram', refused, '--port', '0', '--no-open']);
    assertErrorDoc(invalid, 1, `diagram ${refused}: arrows[0] has unknown key weight`, 'a diagram session on a refused file');
    assertEqual(invalid.stderr, '', 'stderr of a refused diagram session');
    assertErrorDoc(runCli(['diagram', good, '--root', good, '--port', '0', '--no-open']), 1, `root ${good} is not a directory`, '--root naming a file');
    for (const [args, fragment] of [
      [['diagram', '--check', '--port', '0', good], '--check takes no other flag'],
      [['diagram', '--check', '--root', dir, good], '--check takes no other flag'],
      [['diagram', '--check', '--token', TOKEN, good], '--check takes no other flag'],
      [['diagram', good, good, '--no-open'], 'usage: cli.mjs diagram --check <file>'],
      [['diagram', '', '--no-open'], 'bad <file>: empty'],
      [['diagram', good, '--root', '', '--no-open'], 'bad --root: empty'],
      [['diagram', good, '--port', '70000', '--no-open'], 'bad --port 70000'],
      [['diagram', good, '--token', 'short', '--no-open'], 'bad --token'],
      [['diagram', good, '--scope', 'x', '--no-open'], "'--scope'"],
      [['diagram', good, '--out', 'x', '--no-open'], "'--out'"],
    ]) {
      assertErrorDoc(runCli(args), 2, fragment, JSON.stringify(args));
    }
    assert(fs.readFileSync(good, 'utf8') === DIAGRAM_FIXTURE_TEXT, 'a refused diagram session changed the file');
    assertEqual(fs.readdirSync(dir).sort(), ['good.diagram.json', 'refused.diagram.json'], 'files after the diagram session refusals');
  })],
  ['cli: --explorer-unavailable gives its reason as the candidates notice; its refusals write nothing', () => withTemp((dir) => {
    const root = path.join(dir, 'repo');
    fs.mkdirSync(root);
    measureFixture(root);
    const measurements = path.join(dir, 'measurements.json');
    const measured = runCli(['measure', '--root', root, '--scope', 'src', '--out', measurements, '--hotspots', path.join(dir, 'hotspots.tsv')]);
    assert(measured.status === 0, `measure exited ${measured.status}: ${measured.stdout}`);
    const roles = write(dir, 'roles.json', '{"src/a.ts": {"kind": "util", "role": "entry", "exports": ["a"], "mixes": []}}');
    const out = path.join(dir, 'overview.json');
    const assembled = runCli(['assemble', '--measurements', measurements, '--roles', roles, '--explorer-unavailable', ' candidates need the deepen plugin, which is not installed. ', '--out', out]);
    assertEqual(assembled.doc, { status: 'ok', out, files: 4, candidates: 0, dropped: 0, notices: 1 }, 'the assemble document');
    const overview = readOverview(out);
    assertEqual(overview.notices, ['No deepening candidates: candidates need the deepen plugin, which is not installed.'], 'the notice from the given reason');
    assertEqual([overview.files[0].kind, overview.files[0].role], ['util', 'entry'], 'roles merged beside the given reason');

    const bare = path.join(dir, 'bare.json');
    runCli(['assemble', '--measurements', measurements, '--explorer-unavailable', 'the explorer failed: it timed out', '--out', bare]);
    assertEqual(readOverview(bare).notices, [
      'File roles are unavailable: no roles file was given.',
      'No deepening candidates: the explorer failed: it timed out.',
    ], 'the notices without roles and with a given reason');

    const kept = fs.readFileSync(out, 'utf8');
    const explorer = write(dir, 'explorer.txt', 'notes: none\n');
    const missing = path.join(dir, 'missing.json');
    for (const [flags, fragment] of [
      [['--explorer-unavailable='], 'bad --explorer-unavailable: empty'],
      [['--explorer-unavailable', ' . '], 'bad --explorer-unavailable: empty'],
      [['--explorer-unavailable', 'one\ntwo'], 'bad --explorer-unavailable: not one line'],
      [['--explorer-unavailable', 'one\rtwo'], 'bad --explorer-unavailable: not one line'],
      [['--explorer', explorer, '--explorer-unavailable', 'gone'], '--explorer and --explorer-unavailable are exclusive'],
    ]) {
      for (const source of [measurements, missing]) {
        const args = ['assemble', '--measurements', source, ...flags, '--out', out];
        assertErrorDoc(runCli(args), 2, fragment, JSON.stringify(args));
        assert(fs.readFileSync(out, 'utf8') === kept, `${JSON.stringify(args)} rewrote --out`);
      }
    }
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
      const notes = [
        { id: 'n1', anchor: { kind: 'scope' }, body: 'one' },
        { id: 'c1', anchor: { kind: 'candidate', name: 'split-parsing' }, body: 'take it' },
      ];
      const sent = await request(port, { method: 'POST', target: '/api/submit', headers, body: { annotations: notes } });
      assertEqual(sent.json, { ok: true, round: 1 }, 'submit reply');
      const stored = JSON.parse(fs.readFileSync(out, 'utf8')).annotations.map((a) => [a.id, a.anchor, a.round]);
      assertEqual(stored, [['n1', { kind: 'scope' }, 1], ['c1', { kind: 'candidate', name: 'split-parsing' }, 1]], 'notes file after a submit with a candidate note');
      const replied = await request(port, { method: 'POST', target: '/api/reply', headers, body: { round: 1, replies: [{ id: 'n1', body: 'noted' }] } });
      assertEqual(replied.json, { ok: true, replied: 1 }, 'reply answer');
      assertEqual((await request(port, { headers })).json.files, ['a.txt'], 'listing after a reply on an overview run');
      const finish = await request(port, { method: 'POST', target: '/api/finish', headers });
      assertEqual(finish.json, { ok: true, status: 'finished' }, 'finish reply');
      const exit = await server.exited();
      assert(exit.code === 0, `the server exited ${exit.code ?? exit.signal}: ${exit.stdout}`);
      assertEqual(JSON.parse(exit.stdout), { status: 'finished', out, annotations: 2, rounds: 1, root, scope: [] }, 'result document on an overview run');
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
