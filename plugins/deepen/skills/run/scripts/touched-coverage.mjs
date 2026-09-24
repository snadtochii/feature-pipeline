#!/usr/bin/env node
// deepen touched-function coverage: `touched-coverage.mjs`.
// The contract this script implements is skills/run/references/coverage.md §2 —
// the touched-function list it reads, the V8 remap, the matching rule, the
// output document and the exit codes. This header explains mechanics, not
// policy.
//
// Usage:
//   touched-coverage.mjs --repo <abs> --coverage-dir <abs> --functions <abs> --files <abs>
//   touched-coverage.mjs --self-test
//     --repo          the run worktree
//     --coverage-dir  the directory the dev server wrote NODE_V8_COVERAGE output to
//     --functions     the touched-function list: file<TAB>line<TAB>name<TAB>side per line
//     --files         the candidate's files, one repo-relative path per line
// Output: one JSON document on stdout, keys sorted, repo-relative paths only.
// Exit: 0 answered, 1 could not compute (reason on stderr), 2 a wrong invocation.
//
// Zero dependencies: node:module's SourceMap does the remap.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SourceMap } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

class Usage extends Error {}
class CannotCompute extends Error {}

const SIDES = new Set(['server', 'browser']);

function parseArgs(argv) {
  const flags = { '--repo': null, '--coverage-dir': null, '--functions': null, '--files': null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!(key in flags) || value === undefined || flags[key] !== null) {
      throw new Usage(`unexpected argument: ${key}`);
    }
    if (!path.isAbsolute(value)) {
      throw new Usage(`${key} must be an absolute path: ${value}`);
    }
    flags[key] = value;
  }
  for (const [key, value] of Object.entries(flags)) {
    if (value === null) {
      throw new Usage(`missing ${key}`);
    }
  }
  return flags;
}

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function readText(p, what) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    throw new Usage(`${what} is unreadable: ${p}`);
  }
  if (text.includes('\r')) {
    throw new Usage(`${what} has CR line endings: ${p}`);
  }
  return text;
}

function checkRelative(file, what) {
  if (file === '' || path.isAbsolute(file) || file.split('/').includes('..')) {
    throw new Usage(`${what}: not a repo-relative path: ${file}`);
  }
}

function readFunctions(p) {
  const rows = [];
  for (const line of readText(p, '--functions').split('\n')) {
    if (line === '') {
      continue;
    }
    const fields = line.split('\t');
    if (fields.length !== 4) {
      throw new Usage(`--functions: expected 4 tab-separated fields: ${line}`);
    }
    const [file, lineNo, name, side] = fields;
    checkRelative(file, '--functions');
    if (!/^[1-9][0-9]*$/.test(lineNo) || name === '' || !SIDES.has(side)) {
      throw new Usage(`--functions: malformed row: ${line}`);
    }
    rows.push({ file, line: Number(lineNo), name, side });
  }
  return rows;
}

function readFiles(p) {
  const files = new Set();
  for (const line of readText(p, '--files').split('\n')) {
    if (line === '') {
      continue;
    }
    checkRelative(line, '--files');
    files.add(line);
  }
  return files;
}

// A character offset into a script, as V8 reports it, to a 0-based line and column.
function toLineColumn(offset, lineLengths) {
  let rest = offset;
  let line = 0;
  while (line < lineLengths.length && rest > lineLengths[line]) {
    rest -= lineLengths[line] + 1;
    line += 1;
  }
  return { line, column: rest };
}

// A source-map source to an absolute path: sourceRoot applied, resolved against the
// script's URL, query stripped, a dev server's `/@fs` prefix dropped, and a
// root-relative id that does not exist on disk retried under the repo.
function sourceToPath(source, sourceRoot, scriptUrl, repo) {
  let spec = source;
  if (sourceRoot && !/^[a-z]+:/i.test(spec)) {
    spec = sourceRoot.replace(/\/?$/, '/') + spec;
  }
  let url;
  try {
    url = new URL(spec, scriptUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:') {
    return null;
  }
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/@fs/')) {
    pathname = pathname.slice(4);
  }
  if (!fs.existsSync(pathname) && fs.existsSync(path.join(repo, pathname))) {
    pathname = path.join(repo, pathname);
  }
  return real(pathname);
}

function repoRelative(abs, repo) {
  const rel = path.relative(repo, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return rel.split(path.sep).join('/');
}

function loadCoverage(dir) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^coverage-.*\.json$/.test(n)).sort();
  } catch {
    throw new CannotCompute(`coverage directory is unreadable: ${dir}`);
  }
  const docs = [];
  for (const name of names) {
    try {
      docs.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch {
      // A partial dump from a killed process is skipped; zero parsed files is the failure.
    }
  }
  if (docs.length === 0) {
    throw new CannotCompute(`no coverage-*.json file parses in ${dir}`);
  }
  for (const doc of docs) {
    if (!doc || !Array.isArray(doc.result)) {
      throw new CannotCompute('coverage output is not V8 format (no result array)');
    }
  }
  return docs;
}

// Every V8 function that maps into a candidate file: { file, line (1-based), name, count }.
function mappedFunctions(docs, repo, candidateFiles) {
  const found = new Map();
  let unmapped = 0;
  let mappedScripts = 0;
  const directCache = new Map();
  // A map source to its candidate file, or null — resolved once per (script, sourceRoot, source).
  const resolved = new Map();
  const candidateOf = (source, sourceRoot, scriptUrl) => {
    const key = `${scriptUrl}\0${sourceRoot || ''}\0${source}`;
    if (!resolved.has(key)) {
      const abs = typeof source === 'string' ? sourceToPath(source, sourceRoot, scriptUrl, repo) : null;
      const file = abs === null ? null : repoRelative(abs, repo);
      resolved.set(key, file !== null && candidateFiles.has(file) ? file : null);
    }
    return resolved.get(key);
  };
  for (const doc of docs) {
    const cache = doc['source-map-cache'] || {};
    for (const script of doc.result) {
      const url = typeof script.url === 'string' ? script.url : '';
      if (url.startsWith('node:') || url.startsWith('internal')) {
        continue;
      }
      let locate;
      if (url.startsWith('file:') && cache[url] && cache[url].data && cache[url].lineLengths) {
        const entry = cache[url];
        const { sourceRoot } = entry.data;
        const sources = Array.isArray(entry.data.sources) ? entry.data.sources : [];
        // findEntry only ever returns one of `sources`, so a map none of whose sources is a
        // candidate file cannot place a function in one — skip it before decoding the mappings.
        if (!sources.some((source) => candidateOf(source, sourceRoot, url) !== null)) {
          continue;
        }
        let map;
        try {
          map = new SourceMap(entry.data);
        } catch {
          unmapped += 1;
          continue;
        }
        locate = (offset) => {
          const { line, column } = toLineColumn(offset, entry.lineLengths);
          const hit = map.findEntry(line, column);
          if (!hit || hit.originalSource === undefined) {
            return null;
          }
          const file = candidateOf(hit.originalSource, sourceRoot, url);
          return file === null ? null : { file, line: hit.originalLine + 1 };
        };
      } else if (url.startsWith('file:')) {
        const abs = real(fileURLToPath(url));
        const file = repoRelative(abs, repo);
        if (file === null || abs.split(path.sep).includes('node_modules')) {
          continue;
        }
        if (!directCache.has(abs)) {
          let lengths = null;
          try {
            lengths = fs.readFileSync(abs, 'utf8').split('\n').map((l) => l.length);
          } catch {
            lengths = null;
          }
          directCache.set(abs, lengths);
        }
        const lengths = directCache.get(abs);
        if (lengths === null) {
          unmapped += 1;
          continue;
        }
        locate = (offset) => ({ file, line: toLineColumn(offset, lengths).line + 1 });
      } else {
        // Code evaluated with no file behind it — a module runner's shape — cannot be remapped.
        unmapped += 1;
        continue;
      }
      let touchedCandidate = false;
      for (const fn of script.functions || []) {
        const range = (fn.ranges || [])[0];
        if (!range || (fn.functionName === '' && range.startOffset === 0)) {
          continue;
        }
        const where = locate(range.startOffset);
        if (where === null || !candidateFiles.has(where.file)) {
          continue;
        }
        const { file } = where;
        touchedCandidate = true;
        const key = `${file}\t${where.line}\t${fn.functionName}`;
        const prior = found.get(key);
        const count = Number(range.count) || 0;
        if (!prior || count > prior.count) {
          found.set(key, { file, line: where.line, name: fn.functionName, count });
        }
      }
      if (touchedCandidate) {
        mappedScripts += 1;
      }
    }
  }
  if (mappedScripts === 0) {
    throw new CannotCompute('no covered script maps into a candidate file');
  }
  return { v8: [...found.values()], unmapped };
}

function matches(row, fn) {
  if (row.file !== fn.file) {
    return false;
  }
  return fn.line === row.line || (fn.name === row.name && Math.abs(fn.line - row.line) <= 1);
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

export function measure({ repo, coverageDir, functionsFile, filesFile }) {
  const repoAbs = real(repo);
  const rows = readFunctions(functionsFile);
  const candidateFiles = readFiles(filesFile);
  for (const row of rows) {
    if (!candidateFiles.has(row.file)) {
      throw new Usage(`--functions: ${row.file} is not a candidate file`);
    }
  }
  const { v8, unmapped } = mappedFunctions(loadCoverage(coverageDir), repoAbs, candidateFiles);
  const claimed = new Set();
  const out = [];
  for (const row of rows) {
    if (row.side === 'browser') {
      // Claimed but never counted: V8 can load a browser function without the server running it.
      for (const fn of v8) {
        if (matches(row, fn)) {
          claimed.add(fn);
        }
      }
      out.push({ file: row.file, hit: null, line: row.line, name: row.name, origin: 'listed', side: 'browser' });
      continue;
    }
    let hit = false;
    for (const fn of v8) {
      if (matches(row, fn)) {
        claimed.add(fn);
        hit = hit || fn.count > 0;
      }
    }
    out.push({ file: row.file, hit, line: row.line, name: row.name, origin: 'listed', side: 'server' });
  }
  for (const fn of v8) {
    if (!claimed.has(fn)) {
      out.push({ file: fn.file, hit: fn.count > 0, line: fn.line, name: fn.name, origin: 'unlisted', side: 'server' });
    }
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
  const server = out.filter((f) => f.side === 'server');
  const hitCount = server.filter((f) => f.hit).length;
  return sortKeys({
    browser: out.length - server.length,
    functions: out,
    hit: hitCount,
    percent: server.length === 0 ? null : Math.round((hitCount * 1000) / server.length) / 10,
    total: server.length,
    unmapped,
  });
}

// --- self-test -----------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function vlq(n) {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let s = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v) {
      digit |= 32;
    }
    s += B64[digit];
  } while (v);
  return s;
}

// One segment per line, generated column 0 → source line i, column 0; `offset` blank lines first.
function lineMap(sourceLines, offset) {
  const parts = new Array(offset).fill('');
  let previous = 0;
  for (let i = 0; i < sourceLines; i += 1) {
    parts.push(vlq(0) + vlq(0) + vlq(i - previous) + vlq(0));
    previous = i;
  }
  return parts.join(';');
}

function selfTest() {
  const dir = real(fs.mkdtempSync(path.join(os.tmpdir(), 'deepen-touched-coverage-test.')));
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const calc = 'export function add(a, b) {\n  return a + b;\n}\nexport function sub(a, b) {\n  return a - b;\n}\n';
    fs.writeFileSync(path.join(repo, 'src/calc.ts'), calc);
    const plain = 'export function mul(a, b) {\n  return a * b;\n}\n';
    fs.writeFileSync(path.join(repo, 'src/plain.mjs'), plain);
    const widget = 'export function render() {}\n';
    fs.writeFileSync(path.join(repo, 'src/widget.ts'), widget);

    // The transformed module a dev server evaluates: two header lines, then the source.
    const sourceLines = calc.split('\n');
    const generated = ['// header 1', '// header 2', ...sourceLines].join('\n');
    const genUrl = pathToFileURL(path.join(dir, 'served/calc.js')).href;
    const offsetOf = (text, needle) => text.indexOf(needle);
    const coverageDir = path.join(dir, 'coverage');
    fs.mkdirSync(coverageDir);
    const doc = {
      result: [
        {
          url: genUrl,
          functions: [
            { functionName: '', ranges: [{ startOffset: 0, endOffset: generated.length, count: 1 }] },
            { functionName: 'add', ranges: [{ startOffset: offsetOf(generated, 'function add'), endOffset: 60, count: 3 }] },
            { functionName: 'sub', ranges: [{ startOffset: offsetOf(generated, 'function sub'), endOffset: 100, count: 0 }] },
          ],
        },
        {
          url: pathToFileURL(path.join(repo, 'src/plain.mjs')).href,
          functions: [
            { functionName: '', ranges: [{ startOffset: 0, endOffset: plain.length, count: 1 }] },
            { functionName: 'mul', ranges: [{ startOffset: offsetOf(plain, 'function mul'), endOffset: 40, count: 2 }] },
          ],
        },
        {
          // Loaded by the server but never run there: stays the listed browser row, not an unlisted miss.
          url: pathToFileURL(path.join(repo, 'src/widget.ts')).href,
          functions: [
            { functionName: '', ranges: [{ startOffset: 0, endOffset: widget.length, count: 1 }] },
            { functionName: 'render', ranges: [{ startOffset: offsetOf(widget, 'function render'), endOffset: 26, count: 0 }] },
          ],
        },
        { url: '', functions: [{ functionName: 'evaluated', ranges: [{ startOffset: 5, endOffset: 9, count: 1 }] }] },
        { url: 'node:internal/main', functions: [{ functionName: 'x', ranges: [{ startOffset: 1, endOffset: 2, count: 1 }] }] },
      ],
      'source-map-cache': {
        [genUrl]: {
          lineLengths: generated.split('\n').map((l) => l.length),
          data: {
            version: 3,
            sources: [`file:///@fs${path.join(repo, 'src/calc.ts')}`],
            sourceRoot: '',
            names: [],
            mappings: lineMap(sourceLines.length, 2),
          },
        },
      },
    };
    fs.writeFileSync(path.join(coverageDir, 'coverage-1-1-0.json'), JSON.stringify(doc));
    const functionsFile = path.join(dir, 'touched-functions.tsv');
    fs.writeFileSync(functionsFile, 'src/calc.ts\t1\tadd\tserver\nsrc/calc.ts\t4\tsub\tserver\nsrc/widget.ts\t1\trender\tbrowser\n');
    const filesFile = path.join(dir, 'files');
    fs.writeFileSync(filesFile, 'src/calc.ts\nsrc/plain.mjs\nsrc/widget.ts\n');

    const got = JSON.stringify(measure({ repo, coverageDir, functionsFile, filesFile }));
    const expected = JSON.stringify({
      browser: 1,
      functions: [
        { file: 'src/calc.ts', hit: true, line: 1, name: 'add', origin: 'listed', side: 'server' },
        { file: 'src/calc.ts', hit: false, line: 4, name: 'sub', origin: 'listed', side: 'server' },
        { file: 'src/plain.mjs', hit: true, line: 1, name: 'mul', origin: 'unlisted', side: 'server' },
        { file: 'src/widget.ts', hit: null, line: 1, name: 'render', origin: 'listed', side: 'browser' },
      ],
      hit: 2,
      percent: 66.7,
      total: 3,
      unmapped: 1,
    });
    if (got !== expected) {
      process.stdout.write(`self-test: FAIL — expected\n${expected}\ngot\n${got}\n`);
      return 1;
    }
    let refused = false;
    try {
      measure({ repo, coverageDir: path.join(dir, 'empty'), functionsFile, filesFile });
    } catch (error) {
      refused = error instanceof CannotCompute;
    }
    if (!refused) {
      process.stdout.write('self-test: FAIL — an unreadable coverage directory did not exit 1\n');
      return 1;
    }
    process.stdout.write('self-test: ok — coverage.md §2 reproduced (2/3 server functions, 66.7%)\n');
    return 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.length === 1 && argv[0] === '--self-test') {
    return selfTest();
  }
  try {
    const flags = parseArgs(argv);
    const report = measure({
      repo: flags['--repo'],
      coverageDir: flags['--coverage-dir'],
      functionsFile: flags['--functions'],
      filesFile: flags['--files'],
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`touched-coverage: ${error.message}\n`);
    if (error instanceof Usage) {
      process.stderr.write('usage: touched-coverage.mjs --repo <abs> --coverage-dir <abs> --functions <abs> --files <abs>\n       touched-coverage.mjs --self-test\n');
      return 2;
    }
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
