// HTTP surface for the margin viewer. Loopback only, and guarded against the two ways a
// loopback server still reaches the wider web: a page on another origin posting to it (CSRF,
// which here would mean planting notes the agent later reads as instructions) and DNS
// rebinding (a hostname resolving to 127.0.0.1 so a foreign page becomes same-origin and
// reads source through /api/file). Every request must carry the Host of this server, and
// every /api route must carry the per-run token that only the URL the server printed knows.
// A run spans rounds: Send ends a round and the server keeps serving; Finish, Cancel or a
// signal ends the run, once. A diagram session has no notes session (`session` is null): the
// notes routes and the wait answer 404, the human's edits are saved to the diagram file through
// PUT /api/diagram, and Finish ends it without reading edits. An `annotate` run with a diagram
// saves the same edits, except while a round is out (`roundOut`); each Send records the changes
// since the round's starting file, and the reply that closes the round re-reads the file the agent
// may have redrawn. Thirteen routes:
//   GET  /                    the viewer
//   GET  /api/session         { session, files, changes }
//   GET  /api/overview        the overview document; 404 when the run has none
//   GET  /api/diagram         { file, root, document, baseline? }; 404 when the run has none
//   PUT  /api/diagram         { document } -> checked and written to the diagram file:
//                             { ok, savedAt }; 400 refused, 409 changed on disk or a round out,
//                             all writing nothing; 404 without a writer
//   GET  /api/file?path=      { path, text } | { path, binary, reason }; 404 when the path is
//                             not listed or no longer exists
//   GET  /api/wait?after=     held until the round count exceeds `after` or the run ends, then
//                             { status: 'sent' | <end status>, round, out }
//   GET  /api/changes?after=  held until the change count exceeds `after` or the run ends, then
//                             { status: 'changed' | <end status>, changes }
//   PUT  /api/session         { overall, annotations } -> saved as draft; 400 with nothing
//                             applied when a new note names no candidate of the run's overview,
//                             or no box or arrow of its diagram
//   POST /api/submit          same body, then a round is sent with its diagram changes:
//                             { ok, round }; 409 when there is nothing to send
//   POST /api/reply           { round, replies?, overall? } -> the agent's replies are saved,
//                             a redrawn diagram adopted, the listing recomputed: { ok, replied };
//                             400 with nothing applied when any entry or the redraw is refused
//   POST /api/cancel          same body as PUT, then the run ends as `cancelled`: { ok, status }
//   POST /api/finish          same body as PUT, then the run ends as `finished`: { ok, status }
// Cancel and Finish answer once the end has saved the notes file, 500 when it could not. Every
// end of the run answers each held wait and change wait before the process exits, and once the
// end has begun every mutating route answers 409.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, refuseAnchors } from './annotations.mjs';
import { candidateNames } from './overview.mjs';
import { roundOut } from './session.mjs';

// What a new note may point at: the listed paths, the overview's candidate names, and the
// diagram's box and arrow ids, each mapped to its label for the note's snapshot.
function anchorsAllowed(files, candidates, diagram) {
  const labels = (entries) => new Map((entries ?? []).map((entry) => [entry.id, entry.label]));
  return {
    paths: new Set(files),
    candidates,
    boxes: labels(diagram?.document?.boxes),
    arrows: labels(diagram?.document?.arrows),
  };
}

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/syntax.js': ['syntax.js', 'text/javascript; charset=utf-8'],
  '/rounds.js': ['rounds.js', 'text/javascript; charset=utf-8'],
  '/overview.js': ['overview.js', 'text/javascript; charset=utf-8'],
  '/overview-view.js': ['overview-view.js', 'text/javascript; charset=utf-8'],
  '/diagram.js': ['diagram.js', 'text/javascript; charset=utf-8'],
  '/diagram-edit.js': ['diagram-edit.js', 'text/javascript; charset=utf-8'],
  '/diagram-gestures.js': ['diagram-gestures.js', 'text/javascript; charset=utf-8'],
  '/diagram-rename.js': ['diagram-rename.js', 'text/javascript; charset=utf-8'],
  '/diagram-diff.js': ['diagram-diff.js', 'text/javascript; charset=utf-8'],
  '/diagram-view.js': ['diagram-view.js', 'text/javascript; charset=utf-8'],
  '/vendor/highlight.min.js': ['vendor/highlight.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/dockerfile.min.js': ['vendor/dockerfile.min.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MAX_BODY = 5 * 1024 * 1024;

function sendJson(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function sendStatic(res, [name, type]) {
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(await readFile(join(UI_DIR, name)));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const END_ROUTES = { '/api/cancel': 'cancelled', '/api/finish': 'finished' };
const FLUSH_CAP_MS = 1000;

// Sends one JSON reply; settles once it has been handed to the socket, or the socket has closed.
function reply(res, body, status = 200) {
  return new Promise((done) => {
    res.once('finish', done);
    res.once('close', done);
    sendJson(res, body, status);
  });
}

// Replies `doc` to every held wait whose `after` is below `round` and drops it from the map,
// which holds each waiting response with its `after`; returns one promise per reply sent.
function answerWaiters(waiters, doc, round = Infinity) {
  const flushed = [];
  for (const [res, after] of waiters) {
    if (after < round) {
      waiters.delete(res);
      flushed.push(reply(res, doc));
    }
  }
  return flushed;
}

// Settles once every promise in `pending` has, or after FLUSH_CAP_MS, whichever is sooner.
function flush(pending) {
  let timer;
  const cap = new Promise((done) => {
    timer = setTimeout(done, FLUSH_CAP_MS);
  });
  return Promise.race([Promise.all(pending), cap]).then(() => clearTimeout(timer));
}

// `files` is the listing the run starts with, and `relist(document)` returns the listing
// recomputed with the run's root and scope over the diagram document the server holds (null
// without one); every accepted reply post replaces the listing with it, and a `relist()` that
// throws keeps the previous one. `readSource(path)` returns null for a listed path that no
// longer exists. `onSend(allowed, changes, document)` sends a round, given what anchors may name
// now, the diagram's changes and the document they were diffed from (both null without a
// diagram), and returns its number, or null when there is nothing to send. `onReply(body, gate)`
// applies a reply post and returns `{ replied }`, or `{ error }` when it is refused with nothing
// applied; `gate()` runs once the post's own checks pass and returns `{ error }`, `{ baseline }`
// with a re-read redraw, or `{}`. `onEnd(status)` ends the run and returns
// the result document. Resolves with `{ url, close, end, ended, waiting, watching }`: `end(status, res?)` ends the
// run once, whoever calls it, and returns `ended`, which resolves with the result document
// after every held wait and change wait — and `res`, the Cancel or Finish request that ended
// the run, when given — has been answered (capped at FLUSH_CAP_MS), or rejects when `onEnd`
// throws, after `res` has been answered 500. `waiting()` is the number of held waits and
// `watching()` the number of held change waits. `overview` is the run's checked overview
// document, or null when it has none; it is served as is, and its candidate names are the ones
// a new candidate note may carry. `diagram` is `{ file, root, document }` for a run that shows a
// diagram, or null, plus `baseline`, the round's starting file, in an `annotate` run; it is served
// as is, a save or an adopted redraw replaces its document, and the box and arrow ids of the
// current document are the ones a new box or arrow note may carry. `saveDiagram(document)`
// saves an edited diagram and returns `{ status: 200, document }` or `{ status, error }` with
// nothing written; without it `PUT /api/diagram` answers 404. In an `annotate` run,
// `diffDiagrams(baseline, document)` gives the changes a Send records, after which the sent
// document is the baseline, and `rereadDiagram()` re-reads the file for the reply that closes a
// round out, returning `{ status: 200, document, adopt }` or `{ status: 400, error }`; an
// accepted reply adopts it as document and baseline. A null `session` is a diagram session:
// `onSave`, `onSend` and `onReply` are never called, no round is ever out, and the end document
// carries only its status.
export function startServer({ port, token: givenToken, session, files: initialFiles, readSource, onSave, onSend, onReply, onEnd, relist, overview = null, diagram: givenDiagram = null, saveDiagram = null, rereadDiagram = null, diffDiagrams = null }) {
  let diagram = givenDiagram;
  let files = initialFiles;
  const candidates = candidateNames(overview);
  let allowed = anchorsAllowed(files, candidates, diagram);
  // The run's change count: bumped once per accepted reply post, kept in memory only, so a
  // viewer reads it from `GET /api/session` and waits on `GET /api/changes` for the next one.
  let changes = 0;
  const token = givenToken ?? randomBytes(16).toString('hex');
  let origin = null; // set once the port is known
  // A wait with no `after` counts from the round the run started at, so a first wait on a
  // resumed file does not return at once for rounds an earlier run sent.
  const startRound = session ? session.round : 0;
  const waiters = new Map(); // held wait response -> its `after`
  const watchers = new Map(); // held change wait response -> its `after`
  let closed = false; // no route mutates the session once the end has begun
  let endStarted = false;
  let endDoc = null;
  let resolveEnded;
  let rejectEnded;
  const ended = new Promise((resolve, reject) => {
    resolveEnded = resolve;
    rejectEnded = reject;
  });
  ended.catch(() => {}); // a caller that never awaits `ended` must not see an unhandled rejection

  const end = (status, res = null) => {
    if (endStarted) {
      return ended;
    }
    endStarted = true;
    closed = true;
    let doc;
    try {
      doc = onEnd(status);
    } catch (err) {
      flush(res ? [reply(res, { error: String(err?.message ?? err) }, 500)] : []).then(() => rejectEnded(err));
      return ended;
    }
    endDoc = session ? { status, round: session.round, out: doc.out } : { status };
    const pending = [...answerWaiters(waiters, endDoc), ...answerWaiters(watchers, { status, changes })];
    if (res) {
      pending.push(reply(res, { ok: true, status }));
    }
    flush(pending).then(() => resolveEnded(doc));
    return ended;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin);
      if (`http://${req.headers.host}` !== origin) {
        return sendJson(res, { error: 'wrong host' }, 421);
      }
      if (req.headers.origin && req.headers.origin !== origin) {
        return sendJson(res, { error: 'cross-origin request refused' }, 403);
      }
      if (req.method === 'GET' && STATIC[url.pathname]) {
        return await sendStatic(res, STATIC[url.pathname]);
      }
      if (url.pathname.startsWith('/api/') && req.headers['x-margin-token'] !== token) {
        return sendJson(res, { error: 'missing or wrong token' }, 403);
      }
      if (req.method === 'GET' && url.pathname === '/api/session') {
        return sendJson(res, { session, files, changes });
      }
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        return overview ? sendJson(res, overview) : sendJson(res, { error: 'no overview' }, 404);
      }
      if (req.method === 'GET' && url.pathname === '/api/diagram') {
        return diagram ? sendJson(res, diagram) : sendJson(res, { error: 'no diagram' }, 404);
      }
      if (req.method === 'GET' && url.pathname === '/api/file') {
        const path = url.searchParams.get('path') ?? '';
        if (!allowed.paths.has(path)) {
          return sendJson(res, { error: `${path} is not in scope` }, 404);
        }
        const source = readSource(path);
        if (source === null) {
          return sendJson(res, { error: `${path} no longer exists` }, 404);
        }
        return sendJson(res, source);
      }
      if (req.method === 'GET' && url.pathname === '/api/changes') {
        const raw = url.searchParams.get('after');
        if (raw === null || !/^\d+$/.test(raw)) {
          return sendJson(res, { error: `bad after: ${raw ?? ''}` }, 400);
        }
        if (endDoc) {
          return sendJson(res, { status: endDoc.status, changes });
        }
        if (changes > Number(raw)) {
          return sendJson(res, { status: 'changed', changes });
        }
        watchers.set(res, Number(raw));
        res.on('close', () => watchers.delete(res));
        return undefined;
      }
      if (req.method === 'GET' && url.pathname === '/api/wait' && session) {
        const raw = url.searchParams.get('after');
        if (raw !== null && !/^\d+$/.test(raw)) {
          return sendJson(res, { error: `bad after: ${raw}` }, 400);
        }
        const after = raw === null ? startRound : Number(raw);
        if (endDoc) {
          return sendJson(res, endDoc);
        }
        if (session.round > after) {
          return sendJson(res, { status: 'sent', round: session.round, out: session.out });
        }
        waiters.set(res, after);
        res.on('close', () => waiters.delete(res));
        return undefined;
      }
      const diagramSave = req.method === 'PUT' && url.pathname === '/api/diagram' && saveDiagram !== null;
      const mutating =
        diagramSave ||
        (req.method === 'PUT' && url.pathname === '/api/session') ||
        (req.method === 'POST' && (url.pathname === '/api/submit' || url.pathname === '/api/reply' || END_ROUTES[url.pathname]));
      if (!mutating || (!session && !diagramSave && url.pathname !== '/api/finish')) {
        return sendJson(res, { error: 'not found' }, 404);
      }
      // Checked after the body is read, so a request that was in flight when the end began
      // applies nothing either.
      const body = await readJson(req);
      if (closed) {
        return sendJson(res, { error: 'the run has ended' }, 409);
      }
      if (diagramSave) {
        if (session && roundOut(session)) {
          return sendJson(res, { error: 'a round is out' }, 409);
        }
        const saved = saveDiagram(body?.document);
        if (saved.status !== 200) {
          return sendJson(res, { error: saved.error }, saved.status);
        }
        diagram = { ...diagram, document: saved.document };
        allowed = anchorsAllowed(files, candidates, diagram);
        return sendJson(res, { ok: true, savedAt: new Date().toISOString() });
      }
      if (!session) {
        end('finished', res);
        return undefined;
      }
      // A reply post carries no viewer edits. Once its replies are saved it is the round's
      // boundary: a redrawn diagram is adopted, the listing recomputed, the change count bumped
      // and held change waits woken. The reply that closes a round out re-reads the diagram file
      // first, so an invalid redraw refuses the reply with nothing applied.
      if (url.pathname === '/api/reply') {
        const closing = diagram !== null && rereadDiagram !== null && roundOut(session) && body?.round === session.round;
        let redraw = null;
        const gate = () => {
          if (!closing) {
            return {};
          }
          redraw = rereadDiagram();
          return redraw.status === 200 ? { baseline: redraw.document } : { error: redraw.error };
        };
        const result = onReply(body, gate);
        if (result.error) {
          return sendJson(res, { error: result.error }, 400);
        }
        if (redraw !== null) {
          redraw.adopt();
          diagram = { ...diagram, document: redraw.document, baseline: redraw.document };
        }
        allowed = anchorsAllowed(files, candidates, diagram);
        try {
          files = relist(diagram?.document ?? null);
          allowed = anchorsAllowed(files, candidates, diagram);
        } catch {
          // the replies are saved; the previous listing stays
        }
        changes += 1;
        sendJson(res, { ok: true, replied: result.replied });
        answerWaiters(watchers, { status: 'changed', changes }, changes);
        return undefined;
      }
      const refused = refuseAnchors(session, body, allowed);
      if (refused) {
        return sendJson(res, { error: refused }, 400);
      }
      applyEdits(session, body, allowed);
      if (req.method === 'PUT') {
        onSave();
        return sendJson(res, { ok: true, updatedAt: session.updatedAt });
      }
      if (url.pathname === '/api/submit') {
        const changes = diagram !== null && diffDiagrams !== null ? diffDiagrams(diagram.baseline, diagram.document) : null;
        const round = onSend(allowed, changes, diagram?.document ?? null);
        if (round === null) {
          onSave();
          return sendJson(res, { error: 'nothing to send' }, 409);
        }
        if (changes !== null) {
          diagram = { ...diagram, baseline: diagram.document };
        }
        sendJson(res, { ok: true, round });
        answerWaiters(waiters, { status: 'sent', round, out: session.out }, round);
        return undefined;
      }
      // The end runs before the reply, so the reply reports an end that has saved, and no
      // signal can end the run between the two.
      end(END_ROUTES[url.pathname], res);
      return undefined;
    } catch (err) {
      return sendJson(res, { error: String(err?.message ?? err) }, 500);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      const close = () =>
        new Promise((done) => {
          server.close(() => done());
          server.closeAllConnections();
        });
      resolve({ url: `${origin}/#${token}`, close, end, ended, waiting: () => waiters.size, watching: () => watchers.size });
    });
  });
}
