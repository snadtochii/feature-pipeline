// HTTP surface for the margin viewer. Loopback only, and guarded against the two ways a
// loopback server still reaches the wider web: a page on another origin posting to it (CSRF,
// which here would mean planting notes the agent later reads as instructions) and DNS
// rebinding (a hostname resolving to 127.0.0.1 so a foreign page becomes same-origin and
// reads source through /api/file). Every request must carry the Host of this server, and
// every /api route must carry the per-run token that only the URL the server printed knows.
// A run spans rounds: Send ends a round and the server keeps serving; Finish, Cancel or a
// signal ends the run, once. Eight routes:
//   GET  /                 the viewer
//   GET  /api/session      { session, files }
//   GET  /api/file?path=   { path, text } | { path, binary, reason }
//   GET  /api/wait?after=  held until the round count exceeds `after` or the run ends, then
//                          { status: 'sent' | <end status>, round, out }
//   PUT  /api/session      { overall, annotations } -> saved as draft
//   POST /api/submit       same body, then a round is sent: { ok, round }; 409 when there is
//                          nothing to send
//   POST /api/cancel       same body, then the run ends as `cancelled`
//   POST /api/finish       same body, then the run ends as `finished`
// Every end of the run answers each held wait before the process exits, and once the end has
// begun every mutating route answers 409.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits } from './annotations.mjs';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/syntax.js': ['syntax.js', 'text/javascript; charset=utf-8'],
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

// Replies `doc` to every held wait and empties the set; each promise settles once that reply
// has been handed to the socket, or the socket has closed.
function answerWaiters(waiters, doc) {
  const flushed = [...waiters].map(
    (res) =>
      new Promise((done) => {
        res.once('finish', done);
        res.once('close', done);
        sendJson(res, doc);
      }),
  );
  waiters.clear();
  return flushed;
}

// `onSend()` sends a round and returns its number, or null when there is nothing to send.
// `onEnd(status)` ends the run and returns the result document. Resolves with
// `{ url, close, end, ended }`: `end(status)` ends the run once, whoever calls it, and returns
// `ended`, which resolves with the result document after every held wait has been answered
// (capped at FLUSH_CAP_MS), or rejects when `onEnd` throws.
export function startServer({ port, token: givenToken, session, files, readSource, onSave, onSend, onEnd }) {
  const allowed = new Set(files);
  const token = givenToken ?? randomBytes(16).toString('hex');
  let origin = null; // set once the port is known
  // A wait with no `after` counts from the round the run started at, so a first wait on a
  // resumed file does not return at once for rounds an earlier run sent.
  const startRound = session.round;
  const waiters = new Set();
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

  const end = (status) => {
    if (endStarted) {
      return ended;
    }
    endStarted = true;
    closed = true;
    let doc;
    try {
      doc = onEnd(status);
    } catch (err) {
      rejectEnded(err);
      return ended;
    }
    endDoc = { status, round: session.round, out: doc.out };
    let timer;
    const cap = new Promise((done) => {
      timer = setTimeout(done, FLUSH_CAP_MS);
    });
    Promise.race([Promise.all(answerWaiters(waiters, endDoc)), cap]).then(() => {
      clearTimeout(timer);
      resolveEnded(doc);
    });
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
        return sendJson(res, { session, files });
      }
      if (req.method === 'GET' && url.pathname === '/api/file') {
        const path = url.searchParams.get('path') ?? '';
        if (!allowed.has(path)) {
          return sendJson(res, { error: `${path} is not in scope` }, 404);
        }
        return sendJson(res, readSource(path));
      }
      if (req.method === 'GET' && url.pathname === '/api/wait') {
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
        waiters.add(res);
        res.on('close', () => waiters.delete(res));
        return undefined;
      }
      const mutating =
        (req.method === 'PUT' && url.pathname === '/api/session') ||
        (req.method === 'POST' && (url.pathname === '/api/submit' || END_ROUTES[url.pathname]));
      if (!mutating) {
        return sendJson(res, { error: 'not found' }, 404);
      }
      // Checked after the body is read, so a request that was in flight when the end began
      // applies nothing either.
      const body = await readJson(req);
      if (closed) {
        return sendJson(res, { error: 'the run has ended' }, 409);
      }
      applyEdits(session, body, allowed);
      if (req.method === 'PUT') {
        onSave();
        return sendJson(res, { ok: true, updatedAt: session.updatedAt });
      }
      if (url.pathname === '/api/submit') {
        const round = onSend();
        if (round === null) {
          onSave();
          return sendJson(res, { error: 'nothing to send' }, 409);
        }
        sendJson(res, { ok: true, round });
        answerWaiters(waiters, { status: 'sent', round, out: session.out });
        return undefined;
      }
      const status = END_ROUTES[url.pathname];
      closed = true;
      // `close` follows `finish` and also fires when the client drops first, so the run ends
      // either way.
      res.on('close', () => end(status));
      return sendJson(res, { ok: true, status });
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
      resolve({ url: `${origin}/#${token}`, close, end, ended });
    });
  });
}
