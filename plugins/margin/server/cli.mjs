#!/usr/bin/env node
// margin annotation server: `cli.mjs`.
//
// Usage:
//   cli.mjs annotate --root <abs-dir> [--scope <path>]... [--out <abs-file>] [--port <n>] [--token <hex>] [--no-open]
//
// Serves a read-only code viewer for the files under the scope paths and collects
// the human's annotations. The notes file named by --out is rewritten on every
// change (status `draft`); when the human presses Send it is marked `submitted`,
// one JSON summary document is printed on stdout, and the process exits.
// If --out already exists, its annotations are loaded so a review can resume, and its root
// and scope apply unless --root / --scope are given.
// Every /api call must carry the per-run token; it is random unless --token sets it, which
// lets a caller know the viewer URL before this process prints it.
//
// Exit: 0 finished (submitted, cancelled, or interrupted), 1 could not run, 2 bad invocation.
// Zero dependencies: Node 22+ built-ins only. Everything under lib/ is private.

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { listFiles, readSource, revision } from './lib/files.mjs';
import { cleanAnnotation, startServer } from './lib/server.mjs';

const USAGE = 'usage: cli.mjs annotate --root <dir> [--scope <path>]... [--out <file>] [--port <n>] [--token <hex>] [--no-open]';

function writeDoc(doc) {
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
}

function fail(message, code) {
  writeDoc({ status: 'error', error: message });
  process.exit(code);
}

function stamp() {
  return new Date().toISOString().replace(/\.\d+Z$/, '').replaceAll(':', '-');
}

function scopePath(root, raw) {
  const abs = resolve(root, raw);
  const rel = relative(root, abs);
  if (rel.startsWith('..')) {
    fail(`scope ${raw} is outside ${root}`, 2);
  }
  return rel === '' ? '.' : rel;
}

// The notes file being resumed, parsed but not yet trusted. Null when there is none.
function readStored(out) {
  if (!existsSync(out)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    return Array.isArray(parsed.annotations) ? parsed : null;
  } catch {
    return null;
  }
}

// A resumed file may have been edited by hand; it comes back in the shape the rest of this
// file assumes. Every annotation passes the server's cleaner for shape only: a note on a file
// that has since moved, or that sits outside this run's scope, is kept rather than dropped,
// because losing it silently would defeat the point of resuming.
function restoreSession(stored) {
  return {
    version: 1,
    createdAt: typeof stored.createdAt === 'string' ? stored.createdAt : new Date().toISOString(),
    overall: typeof stored.overall === 'string' ? stored.overall : '',
    annotations: stored.annotations.map((raw) => cleanAnnotation(raw, null)).filter(Boolean),
  };
}

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The URL is on stderr; opening the browser is a convenience.
  }
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: 'string' },
        scope: { type: 'string', multiple: true, default: [] },
        out: { type: 'string' },
        port: { type: 'string', default: '0' },
        token: { type: 'string' },
        'no-open': { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    fail(`${err.message}\n${USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (positionals[0] !== 'annotate') {
    fail(USAGE, 2);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`bad --port ${values.port}`, 2);
  }
  if (values.token !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(values.token)) {
    fail('bad --token: 16-128 characters of [A-Za-z0-9_-]', 2);
  }

  // On a resume the notes file is the record of what was being reviewed: its root and scope
  // apply unless the caller names them explicitly.
  const stored = values.out ? readStored(resolve(values.out)) : null;
  const root = resolve(values.root ?? (typeof stored?.root === 'string' ? stored.root : process.cwd()));
  const scopeArgs = values.scope.length > 0 ? values.scope : Array.isArray(stored?.scope) ? stored.scope : [];
  const scope = scopeArgs.map((raw) => scopePath(root, raw));
  const files = listFiles(root, scope);
  if (files.length === 0) {
    fail(`no files under ${scope.join(', ') || root}`, 1);
  }

  const out = resolve(values.out ?? join(root, 'claudedocs', 'margin', `${stamp()}.json`));
  const now = new Date().toISOString();
  const session = stored ? restoreSession(stored) : { version: 1, createdAt: now, overall: '', annotations: [] };
  Object.assign(session, { status: 'draft', root, scope, out, revision: revision(root), updatedAt: now });

  const save = () => {
    session.updatedAt = new Date().toISOString();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(session, null, 2)}\n`);
  };

  const finish = (status) => {
    session.status = status;
    const empty = session.annotations.length === 0 && session.overall.trim() === '';
    if (status === 'cancelled' && empty) {
      if (existsSync(out)) {
        unlinkSync(out);
      }
    } else {
      save();
    }
    writeDoc({ status, out: empty && status === 'cancelled' ? null : out, annotations: session.annotations.length, root, scope });
    process.exit(0);
  };

  let url;
  try {
    url = await startServer({
      port,
      token: values.token,
      session,
      files,
      readSource: (path) => readSource(root, path),
      onSave: save,
      onFinish: finish,
    });
  } catch (err) {
    fail(`could not listen on port ${port}: ${err.code ?? err.message}`, 1);
  }
  // The first draft is written only once the port is bound, so a failed start (a busy port,
  // retried on another) leaves nothing behind.
  save();

  process.stderr.write(`margin: ${url}\n  root:  ${root}\n  scope: ${scope.join(', ') || '.'} (${files.length} files)\n  notes: ${out}\n`);
  if (!values['no-open']) {
    openInBrowser(url);
  }
  process.on('SIGINT', () => finish('interrupted'));
  process.on('SIGTERM', () => finish('interrupted'));
}

await main(process.argv.slice(2));
