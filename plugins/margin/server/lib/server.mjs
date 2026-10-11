// HTTP surface for the margin viewer. Loopback only, and guarded against the two ways a
// loopback server still reaches the wider web: a page on another origin posting to it (CSRF,
// which here would mean planting notes the agent later reads as instructions) and DNS
// rebinding (a hostname resolving to 127.0.0.1 so a foreign page becomes same-origin and
// reads source through /api/file). Every request must carry the Host of this server, and
// every /api route must carry the per-run token that only the URL the server printed knows.
// Six routes:
//   GET  /                 the viewer
//   GET  /api/session      { session, files }
//   GET  /api/file?path=   { path, text } | { path, binary, reason }
//   PUT  /api/session      { overall, annotations } -> saved as draft
//   POST /api/submit       same body, then the process finishes as `submitted`
//   POST /api/cancel       same body, then the process finishes as `cancelled`

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/highlight.js': ['highlight.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const ANCHOR_KINDS = new Set(['range', 'file', 'folder', 'scope']);
const INTENTS = new Set(['change', 'question']);
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

// Keeps only the fields the notes file defines, so neither a stray client nor a
// hand-edited notes file can give the reading skill a shape it does not expect.
// `allowed` is the set of listed paths a file or range note must name; null skips
// that check (a resumed note may point at a file that has since moved).
export function cleanAnnotation(raw, allowed) {
  const anchor = raw?.anchor ?? {};
  if (!ANCHOR_KINDS.has(anchor.kind) || typeof raw.body !== 'string') {
    return null;
  }
  const clean = {
    id: typeof raw.id === 'string' ? raw.id : randomUUID(),
    anchor: { kind: anchor.kind },
    intent: INTENTS.has(raw.intent) ? raw.intent : 'change',
    body: raw.body,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
  if (anchor.kind !== 'scope') {
    if (typeof anchor.path !== 'string') {
      return null;
    }
    clean.anchor.path = anchor.path;
  }
  if ((anchor.kind === 'file' || anchor.kind === 'range') && allowed && !allowed.has(anchor.path)) {
    return null;
  }
  if (anchor.kind === 'range') {
    const start = Number(anchor.start);
    const end = Number(anchor.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return null;
    }
    clean.anchor.start = start;
    clean.anchor.end = end;
    clean.anchor.excerpt = typeof anchor.excerpt === 'string' ? anchor.excerpt.slice(0, 4000) : '';
  }
  return clean;
}

function applyEdits(session, body, allowed) {
  if (typeof body.overall === 'string') {
    session.overall = body.overall;
  }
  if (Array.isArray(body.annotations)) {
    session.annotations = body.annotations.map((raw) => cleanAnnotation(raw, allowed)).filter(Boolean);
  }
}

export function startServer({ port, token: givenToken, session, files, readSource, onSave, onFinish }) {
  const allowed = new Set(files);
  const token = givenToken ?? randomBytes(16).toString('hex');
  let origin = null; // set once the port is known
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
      if (req.method === 'PUT' && url.pathname === '/api/session') {
        applyEdits(session, await readJson(req), allowed);
        onSave();
        return sendJson(res, { ok: true, updatedAt: session.updatedAt });
      }
      if (req.method === 'POST' && (url.pathname === '/api/submit' || url.pathname === '/api/cancel')) {
        applyEdits(session, await readJson(req), allowed);
        const status = url.pathname === '/api/submit' ? 'submitted' : 'cancelled';
        res.on('finish', () => onFinish(status));
        return sendJson(res, { ok: true, status });
      }
      return sendJson(res, { error: 'not found' }, 404);
    } catch (err) {
      return sendJson(res, { error: String(err?.message ?? err) }, 500);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve(`${origin}/#${token}`);
    });
  });
}
