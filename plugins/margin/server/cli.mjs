#!/usr/bin/env node
// margin annotation server: `cli.mjs`.
//
// Usage:
//   cli.mjs annotate --root <abs-dir> [--scope <path>]... [--out <abs-file>] [--overview <file>] [--port <n>] [--token <hex>] [--no-open]
//   cli.mjs wait <url> [--after <n>]
//   cli.mjs --self-test
//
// `annotate` serves a read-only code viewer for the files under the scope paths and collects
// the human's annotations over a run of rounds. The notes file named by --out is rewritten
// on every change (status `draft`). Each Send ends a round: the unsent notes are stamped with
// the round number and the server keeps serving on the same port with the same token. The run
// ends on Finish, Cancel or SIGINT/SIGTERM; then the notes file takes its final status, one
// JSON result document is printed on stdout, and the process exits.
// If --out already exists, its annotations and rounds are loaded so a review can resume, and
// its root and scope apply unless --root / --scope are given.
// Every /api call must carry the per-run token; it is random unless --token sets it, which
// lets a caller know the viewer URL before this process prints it.
// --overview names an overview document, checked when the run starts and served to the viewer.
//
// `wait` takes the URL `annotate` printed on stderr, blocks until the next round is sent or
// the run ends, and prints one wait document. --after is the last round the caller has seen.
//
// Exit: 0 the run ended (finished, cancelled or interrupted) or the wait returned, 1 could not
// run or the server was unreachable, 2 bad invocation.
// Zero dependencies: Node 22+ built-ins only. Everything under lib/ is private.

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { listFiles, readSource, revision } from './lib/files.mjs';
import { readOverview } from './lib/overview.mjs';
import { startServer } from './lib/server.mjs';
import { RunError, createSession, finishRun, postReplies, readStored, saveSession, scopePath, sendRound } from './lib/session.mjs';
import { TOKEN_PATTERN, parseRunUrl, waitForRound } from './lib/wait.mjs';

const WAIT_USAGE = 'usage: cli.mjs wait <url> [--after <n>]';
const USAGE = `usage: cli.mjs annotate --root <dir> [--scope <path>]... [--out <file>] [--overview <file>] [--port <n>] [--token <hex>] [--no-open]\n       ${WAIT_USAGE.slice('usage: '.length)}`;

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

function openInBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The URL is on stderr; opening the browser is a convenience.
  }
}

async function annotate(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        root: { type: 'string' },
        scope: { type: 'string', multiple: true, default: [] },
        out: { type: 'string' },
        overview: { type: 'string' },
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
  if (values.token !== undefined && !TOKEN_PATTERN.test(values.token)) {
    fail('bad --token: 16-128 characters of [A-Za-z0-9_-]', 2);
  }
  if (values.overview === '') {
    fail('bad --overview: empty', 2);
  }
  const overviewFile = values.overview === undefined ? null : resolve(values.overview);

  // On a resume the notes file is the record of what was being reviewed: its root and scope
  // apply unless the caller names them explicitly.
  const stored = values.out ? readStored(resolve(values.out)) : null;
  const root = resolve(values.root ?? (typeof stored?.root === 'string' ? stored.root : process.cwd()));
  const scopeArgs = values.scope.length > 0 ? values.scope : Array.isArray(stored?.scope) ? stored.scope : [];
  const scope = scopeArgs.map((raw) => scopePath(root, raw));
  const out = resolve(values.out ?? join(root, 'claudedocs', 'margin', `${stamp()}.json`));
  const own = overviewFile ? [out, overviewFile] : [out];
  const files = listFiles(root, scope, own);
  if (files.length === 0) {
    fail(`no files under ${scope.join(', ') || root}`, 1);
  }

  const session = createSession({ stored, out, root, scope, revision: revision(root) });
  const overview = overviewFile ? readOverview(overviewFile) : null;
  const save = () => saveSession(session);

  let run;
  try {
    run = await startServer({
      port,
      token: values.token,
      session,
      files,
      readSource: (path) => readSource(root, path),
      relist: () => listFiles(root, scope, own),
      onSave: save,
      onSend: () => sendRound(session),
      onReply: (body) => postReplies(session, body),
      onEnd: (status) => finishRun(session, status),
      overview,
    });
  } catch (err) {
    fail(`could not listen on port ${port}: ${err.code ?? err.message}`, 1);
  }
  // The one place the result document is printed: when the run ends, whichever way it ends.
  run.ended.then(
    (doc) => {
      writeDoc(doc);
      process.exit(0);
    },
    (err) => fail(String(err?.message ?? err), 1),
  );
  // Bound before the URL is printed: a caller that has seen the URL may signal the run at once.
  process.on('SIGINT', () => run.end('interrupted'));
  process.on('SIGTERM', () => run.end('interrupted'));
  // The first draft is written only once the port is bound, so a failed bind leaves nothing
  // behind.
  save();

  process.stderr.write(`margin: ${run.url}\n  root:  ${root}\n  scope: ${scope.join(', ') || '.'} (${files.length} files)\n  notes: ${out}\n`);
  if (!values['no-open']) {
    openInBrowser(run.url);
  }
}

// Checks in order: the arguments parse, the positionals are exactly `wait <url>`, the URL is a
// run URL, and --after is a whole number. Then one wait, and its document.
async function waitCmd(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { after: { type: 'string' } } });
  } catch (err) {
    fail(`${err.message}\n${WAIT_USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 2 || positionals[0] !== 'wait') {
    fail(WAIT_USAGE, 2);
  }
  const url = positionals[1];
  parseRunUrl(url);
  if (values.after !== undefined && !/^\d+$/.test(values.after)) {
    fail(`bad --after ${values.after}`, 2);
  }
  writeDoc(await waitForRound({ url, after: values.after === undefined ? undefined : Number(values.after) }));
  process.exit(0);
}

// `--self-test` is recognised only on its own; with any other argument it falls through to
// the argument parser and is a bad invocation. A rule that refuses throws a RunError, and
// this is the one place that turns it into the error document and the exit code.
async function main(argv) {
  try {
    if (argv.length === 1 && argv[0] === '--self-test') {
      writeDoc(await (await import('./lib/selftest.mjs')).runSelfTest());
      process.exit(0);
    }
    if (argv[0] === 'wait') {
      await waitCmd(argv);
      return;
    }
    await annotate(argv);
  } catch (err) {
    if (err instanceof RunError) {
      fail(err.message, err.exitCode);
    }
    throw err;
  }
}

await main(process.argv.slice(2));
