// HTTP surface for the margin viewer. Loopback only. Five routes:
//   GET  /                 the viewer
//   GET  /api/session      { session, files }
//   GET  /api/file?path=   { path, text } | { path, binary, reason }
//   PUT  /api/session      { overall, annotations } -> saved as draft
//   POST /api/submit       same body, then the process finishes as `submitted`
//   POST /api/cancel       same body, then the process finishes as `cancelled`

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

// Keeps only the fields the notes file defines, so a stray client never
// writes shapes the reading skill does not expect.
function cleanAnnotation(raw, allowed) {
  const anchor = raw?.anchor ?? {};
  if (!ANCHOR_KINDS.has(anchor.kind) || typeof raw.body !== 'string') {
    return null;
  }
  const clean = {
    id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
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
  if (anchor.kind === 'file' || anchor.kind === 'range') {
    if (!allowed.has(anchor.path)) {
      return null;
    }
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

export function startServer({ port, session, files, readSource, onSave, onFinish }) {
  const allowed = new Set(files);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && STATIC[url.pathname]) {
        return await sendStatic(res, STATIC[url.pathname]);
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
    server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`));
  });
}
