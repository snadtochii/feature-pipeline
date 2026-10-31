#!/usr/bin/env node
// margin annotation server: `cli.mjs`.
//
// Usage:
//   cli.mjs annotate --root <abs-dir> [--scope <path>]... [--out <abs-file>] [--overview <file>] [--diagram <file>] [--port <n>] [--token <hex>] [--no-open]
//   cli.mjs wait <url> [--after <n>]
//   cli.mjs measure --root <dir> [--scope <path>]... --out <file> --hotspots <file>
//   cli.mjs assemble --measurements <file> [--roles <file>] [--explorer <file> | --explorer-unavailable <reason>] --out <file>
//   cli.mjs diagram --check <file>
//   cli.mjs diagram <file> [--root <dir>] [--port <n>] [--token <hex>] [--no-open]
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
// --diagram names a diagram file, checked when the run starts and shown for editing: the human's
// edits are saved to it except while a round is out, each Send records the structural changes,
// and the reply closing a round re-reads the file the agent may have redrawn. Its boxes and
// arrows take notes, the files they link join the listing, and the notes file records its path
// and the current round's starting file, so a resume reopens it unless --diagram is given and
// diffs its next Send against the recorded starting file.
//
// `wait` takes the URL `annotate` printed on stderr, blocks until the next round is sent or
// the run ends, and prints one wait document. --after is the last round the caller has seen.
//
// `measure` lists and measures the files under the scope paths and writes the measurement
// document to --out and the hotspot table to --hotspots. `assemble` turns a measurement
// document, a roles JSON and a deepen explorer's output into the overview document --overview
// reads. Both print one success document on stdout and their warnings on stderr.
//
// `diagram --check` reads and checks one diagram file, prints one document saying whether its
// text is canonical with its entry counts, and writes nothing. `diagram <file>` without --check
// is a diagram session: the same viewer with no notes file and no rounds, showing the diagram
// and the files it links under --root (default: the git top level of the file's directory, else
// that directory), and saving the human's edits to the diagram file as they are made. It ends
// on Finish or SIGINT/SIGTERM and writes nothing but the diagram file.
//
// Exit: 0 the run or the diagram session ended (finished, cancelled or interrupted), the wait
// returned, the files were written or the diagram passed, 1 could not run or the server was
// unreachable, 2 bad invocation.
// Zero dependencies: Node 22+ built-ins only. Everything under lib/ is private.

import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { assembleOverview, readMeasurement, readOptional, serialiseOverview } from './lib/assemble.mjs';
import { diagramSessionInputs, diagramWriter, diffDiagrams, readDiagram, restoreBaseline, runListing } from './lib/diagram.mjs';
import { readSource, revision } from './lib/files.mjs';
import { measureScope } from './lib/measure.mjs';
import { readOverview } from './lib/overview.mjs';
import { startServer } from './lib/server.mjs';
import { RunError, createSession, finishRun, postReplies, readStored, saveSession, scopePath, sendRound, writeAtomic } from './lib/session.mjs';
import { TOKEN_PATTERN, parseRunUrl, waitForRound } from './lib/wait.mjs';

const WAIT_USAGE = 'usage: cli.mjs wait <url> [--after <n>]';
const MEASURE_USAGE = 'usage: cli.mjs measure --root <dir> [--scope <path>]... --out <file> --hotspots <file>';
const ASSEMBLE_USAGE = 'usage: cli.mjs assemble --measurements <file> [--roles <file>] [--explorer <file> | --explorer-unavailable <reason>] --out <file>';
const DIAGRAM_USAGE = [
  'usage: cli.mjs diagram --check <file>',
  '       cli.mjs diagram <file> [--root <dir>] [--port <n>] [--token <hex>] [--no-open]',
].join('\n');
const USAGE = [
  'usage: cli.mjs annotate --root <dir> [--scope <path>]... [--out <file>] [--overview <file>] [--diagram <file>] [--port <n>] [--token <hex>] [--no-open]',
  ...[WAIT_USAGE, MEASURE_USAGE, ASSEMBLE_USAGE, DIAGRAM_USAGE].map((line) => `       ${line.slice('usage: '.length)}`),
].join('\n');

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

function checkedPort(rawPort, token) {
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`bad --port ${rawPort}`, 2);
  }
  if (token !== undefined && !TOKEN_PATTERN.test(token)) {
    fail('bad --token: 16-128 characters of [A-Za-z0-9_-]', 2);
  }
  return port;
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
        diagram: { type: 'string' },
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
  const port = checkedPort(values.port, values.token);
  if (values.overview === '') {
    fail('bad --overview: empty', 2);
  }
  if (values.diagram === '') {
    fail('bad --diagram: empty', 2);
  }
  const overviewFile = values.overview === undefined ? null : resolve(values.overview);

  // On a resume the notes file is the record of what was being reviewed: its root, scope and
  // diagram apply unless the caller names them explicitly.
  const stored = values.out ? readStored(resolve(values.out)) : null;
  const root = resolve(values.root ?? (typeof stored?.root === 'string' ? stored.root : process.cwd()));
  const scopeArgs = values.scope.length > 0 ? values.scope : Array.isArray(stored?.scope) ? stored.scope : [];
  const scope = scopeArgs.map((raw) => scopePath(root, raw));
  const out = resolve(values.out ?? join(root, 'claudedocs', 'margin', `${stamp()}.json`));
  const diagramFile = values.diagram !== undefined ? resolve(values.diagram) : typeof stored?.diagram === 'string' ? resolve(stored.diagram) : null;
  const read = diagramFile ? readDiagram(diagramFile) : null;
  const document = read ? read.document : null;
  const writer = read ? diagramWriter(diagramFile, read.text) : null;
  const own = [out, overviewFile, diagramFile].filter((file) => file !== null);
  const files = runListing(root, scope, own, document);
  if (files.length === 0 && document === null) {
    fail(`no files under ${scope.join(', ') || root}`, 1);
  }

  const session = createSession({ stored, out, root, scope, revision: revision(root), diagram: diagramFile });
  session.baseline = restoreBaseline(stored, out, diagramFile, document);
  const overview = overviewFile ? readOverview(overviewFile) : null;
  const save = () => saveSession(session);
  const scopeText = scope.length > 0 ? scope.join(', ') : document ? 'diagram links' : '.';
  const diagramLine = diagramFile ? `  diagram: ${diagramFile}\n` : '';

  await serve(
    {
      port,
      token: values.token,
      session,
      files,
      readSource: (path) => readSource(root, path),
      relist: (current) => runListing(root, scope, own, current),
      onSave: save,
      onSend: (allowed, changes, sent) => sendRound(session, allowed, changes, sent),
      onReply: (body, gate) => postReplies(session, body, gate),
      onEnd: (status) => finishRun(session, status),
      overview,
      diagram: document ? { file: diagramFile, root, document, baseline: session.baseline } : null,
      saveDiagram: writer ? (edited) => writer.save(edited) : null,
      rereadDiagram: writer ? () => writer.reread() : null,
      diffDiagrams: writer ? diffDiagrams : null,
    },
    {
      noOpen: values['no-open'],
      announce: (run) => {
        // The first draft is written only once the port is bound, so a failed bind leaves
        // nothing behind.
        save();
        process.stderr.write(`margin: ${run.url}\n  root:  ${root}\n  scope: ${scopeText} (${files.length} files)\n  notes: ${out}\n${diagramLine}`);
      },
    },
  );
}

// Starts the server and serves until the run ends, printing its result document then — the one
// place it is printed, whichever way the run ends. The signal handlers are bound before
// `announce` prints the URL: a caller that has seen the URL may signal the run at once.
async function serve(options, { noOpen, announce }) {
  let run;
  try {
    run = await startServer(options);
  } catch (err) {
    fail(`could not listen on port ${options.port}: ${err.code ?? err.message}`, 1);
  }
  run.ended.then(
    (doc) => {
      writeDoc(doc);
      process.exit(0);
    },
    (err) => fail(String(err?.message ?? err), 1),
  );
  process.on('SIGINT', () => run.end('interrupted'));
  process.on('SIGTERM', () => run.end('interrupted'));
  announce(run);
  if (!noOpen) {
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

function parseVerb(argv, verb, usage, options) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options });
  } catch (err) {
    fail(`${err.message}\n${usage}`, 2);
  }
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== verb) {
    fail(usage, 2);
  }
  return parsed.values;
}

function fileFlag(values, name, verb, required) {
  if (values[name] === undefined) {
    if (required) {
      fail(`${verb} needs --${name}`, 2);
    }
    return undefined;
  }
  if (values[name] === '') {
    fail(`bad --${name}: empty`, 2);
  }
  return resolve(values[name]);
}

function reasonFlag(values, name, exclusiveWith) {
  const value = values[name];
  if (value === undefined) {
    return undefined;
  }
  if (values[exclusiveWith] !== undefined) {
    fail(`--${exclusiveWith} and --${name} are exclusive`, 2);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    fail(`bad --${name}: not one line`, 2);
  }
  const reason = value.trim().replace(/\.$/, '').trim();
  if (reason === '') {
    fail(`bad --${name}: empty`, 2);
  }
  return reason;
}

function writeOutput(file, text) {
  try {
    writeAtomic(file, text);
  } catch (err) {
    throw new RunError(`could not write ${file}: ${err?.code ?? err?.message}`, 1);
  }
}

function printWarnings(verb, warnings) {
  for (const warning of warnings) {
    process.stderr.write(`margin: ${verb}: ${warning}\n`);
  }
}

function measureCmd(argv) {
  const values = parseVerb(argv, 'measure', MEASURE_USAGE, {
    root: { type: 'string' },
    scope: { type: 'string', multiple: true, default: [] },
    out: { type: 'string' },
    hotspots: { type: 'string' },
  });
  const root = fileFlag(values, 'root', 'measure', true);
  const out = fileFlag(values, 'out', 'measure', true);
  const hotspots = fileFlag(values, 'hotspots', 'measure', true);
  if (hotspots === out) {
    fail('bad --hotspots: same file as --out', 2);
  }
  const scope = values.scope.map((raw) => scopePath(root, raw));
  const { document, tsv, warnings, summary } = measureScope({ root, scope, ownFiles: [out, hotspots] });
  writeOutput(out, `${JSON.stringify(document, null, 2)}\n`);
  writeOutput(hotspots, tsv);
  printWarnings('measure', warnings);
  writeDoc({ status: 'ok', out, hotspots, ...summary });
  process.exit(0);
}

function assembleCmd(argv) {
  const values = parseVerb(argv, 'assemble', ASSEMBLE_USAGE, {
    measurements: { type: 'string' },
    roles: { type: 'string' },
    explorer: { type: 'string' },
    'explorer-unavailable': { type: 'string' },
    out: { type: 'string' },
  });
  const measurements = fileFlag(values, 'measurements', 'assemble', true);
  const out = fileFlag(values, 'out', 'assemble', true);
  const rolesFile = fileFlag(values, 'roles', 'assemble', false);
  const explorerFile = fileFlag(values, 'explorer', 'assemble', false);
  const explorerUnavailable = reasonFlag(values, 'explorer-unavailable', 'explorer');
  const roles = readOptional(rolesFile, 'roles');
  const explorer = explorerUnavailable === undefined ? readOptional(explorerFile, 'explorer') : { reason: explorerUnavailable };
  const measurement = readMeasurement(measurements);
  const { document, warnings, dropped } = assembleOverview({
    measurement,
    rolesText: roles.text,
    rolesReason: roles.reason,
    explorerText: explorer.text,
    explorerReason: explorer.reason,
  });
  writeOutput(out, serialiseOverview(document, out));
  printWarnings('assemble', warnings);
  writeDoc({ status: 'ok', out, files: document.files.length, candidates: document.candidates.length, dropped, notices: document.notices.length });
  process.exit(0);
}

const SESSION_FLAGS = ['root', 'port', 'token', 'no-open'];

// A diagram session (CONTRACT §1): the file is read and checked, the root resolved and the
// linked files listed, all before the port is bound. Writes only the diagram file, on a save.
async function diagramSession(values, raw) {
  const port = checkedPort(values.port ?? '0', values.token);
  const givenRoot = fileFlag(values, 'root', 'diagram', false);
  const { document, text, file, root, files } = diagramSessionInputs(resolve(raw), givenRoot);
  const writer = diagramWriter(file, text);
  await serve(
    {
      port,
      token: values.token,
      session: null,
      files,
      readSource: (path) => readSource(root, path),
      relist: () => files,
      onEnd: (status) => ({ status, file }),
      diagram: { file, root, document },
      saveDiagram: (edited) => writer.save(edited),
    },
    {
      noOpen: values['no-open'],
      announce: (run) => {
        process.stderr.write(`margin: ${run.url}\n  root:    ${root}\n  diagram: ${file} (${files.length} linked files)\n`);
      },
    },
  );
}

// Checks in order: the arguments parse, the positionals are exactly `diagram <file>`, --check
// is not given with a session flag, and <file> is non-empty. With --check, the read and the
// shape check, and its document; without it, a diagram session.
async function diagramCmd(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        check: { type: 'boolean' },
        root: { type: 'string' },
        port: { type: 'string' },
        token: { type: 'string' },
        'no-open': { type: 'boolean' },
      },
    });
  } catch (err) {
    fail(`${err.message}\n${DIAGRAM_USAGE}`, 2);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 2 || positionals[0] !== 'diagram') {
    fail(DIAGRAM_USAGE, 2);
  }
  if (values.check && SESSION_FLAGS.some((name) => values[name] !== undefined)) {
    fail('--check takes no other flag', 2);
  }
  if (positionals[1] === '') {
    fail('bad <file>: empty', 2);
  }
  if (!values.check) {
    await diagramSession(values, positionals[1]);
    return;
  }
  const file = resolve(positionals[1]);
  const { document, canonical } = readDiagram(file);
  writeDoc({
    status: 'ok',
    file,
    canonical,
    groups: document.groups.length,
    boxes: document.boxes.length,
    arrows: document.arrows.length,
    walkthroughs: document.walkthroughs.length,
  });
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
    if (argv[0] === 'measure') {
      measureCmd(argv);
      return;
    }
    if (argv[0] === 'assemble') {
      assembleCmd(argv);
      return;
    }
    if (argv[0] === 'diagram') {
      await diagramCmd(argv);
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
